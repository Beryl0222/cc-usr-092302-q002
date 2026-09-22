import assert from "node:assert/strict";
import test from "node:test";
import { makeContext, ACTORS } from "./helpers.js";
import { PURPOSE, MODALITY } from "../src/vocabulary.js";
import { DomainError } from "../src/errors.js";

const { grassDoctor, expert } = ACTORS;

function openExam(service, examId = "exam-v", patientId = "pat-v") {
  service.requestExamination({
    examId, patientId, orgId: "org-fuping-county",
    modality: MODALITY.CARDIAC_CT, purpose: PURPOSE.ASYMPTOMATIC_HIGH_RISK, clinician: grassDoctor,
  });
  service.recordDeployment({ examId, deviceId: "ct-1", protocolId: "p", protocolVersion: "1", actor: grassDoctor });
}

test("断网补传：晚到事件拿到新版本号但保留原始发生时间并打 backfilled 标记", () => {
  const { service } = makeContext();
  openExam(service);

  // 08:00 网络正常时先索引 A
  const a = service.indexImage({
    examId: "exam-v", imageId: "img-a", storageUri: "pacs://a", checksum: "cs-a",
    acquiredAt: "2026-09-22T07:50:00+08:00", actor: grassDoctor, occurredAt: "2026-09-22T08:00:00+08:00",
  });

  // 07:55 在断网期间采集的 B，08:20 网络恢复后补传
  const b = service.indexImage({
    examId: "exam-v", imageId: "img-b", storageUri: "pacs://b", checksum: "cs-b",
    acquiredAt: "2026-09-22T07:55:00+08:00", actor: grassDoctor,
    occurredAt: "2026-09-22T07:55:00+08:00", backfill: true,
  });

  assert.equal(a.version, 3); // request=1, deployment=2, 影像A=3
  assert.equal(b.version, a.version + 1, "补传按到达顺序获得新版本号");
  assert.equal(b.backfilled, true);
  assert.equal(b.occurred_at, "2026-09-22T07:55:00+08:00");
  assert.ok(Date.parse(b.recorded_at) > Date.parse(b.occurred_at), "入库时间晚于业务发生时间");

  const events = service.store.readStream("exam:exam-v");
  const versions = events.map((e) => e.version);
  assert.deepEqual(versions, [...versions].sort((x, y) => x - y), "流版本严格单调");
});

test("未声明 backfill 的迟到事件被拒绝，防止时间线被悄悄改写", () => {
  const { service } = makeContext();
  openExam(service);
  service.indexImage({
    examId: "exam-v", imageId: "img-a", storageUri: "pacs://a", checksum: "cs-a",
    acquiredAt: "t", actor: grassDoctor, occurredAt: "2026-09-22T09:00:00+08:00",
  });
  assert.throws(() => service.indexImage({
    examId: "exam-v", imageId: "img-late", storageUri: "pacs://l", checksum: "cs-l",
    acquiredAt: "t", actor: grassDoctor, occurredAt: "2026-09-22T08:00:00+08:00",
  }), (e) => e.code === "LATE_EVENT");
});

test("同一事件重传（相同event_id）幂等：不产生第二版本，返回已存事件", () => {
  const { service } = makeContext();
  openExam(service);
  const first = service.indexImage({
    eventId: "evt-upload-1", examId: "exam-v", imageId: "img-a",
    storageUri: "pacs://a", checksum: "cs-a", acquiredAt: "t", actor: grassDoctor,
  });
  const retry = service.indexImage({
    eventId: "evt-upload-1", examId: "exam-v", imageId: "img-a",
    storageUri: "pacs://a", checksum: "cs-a", acquiredAt: "t", actor: grassDoctor,
  });
  assert.equal(retry.event_id, first.event_id);
  assert.equal(service.store.streamVersion("exam:exam-v"), 3); // request, deployment, 一次索引
  const state = service.examState("exam-v");
  assert.equal(state.images.size, 1);
});

test("换了event_id的同一文件（同校验和）按重复上传拒绝", () => {
  const { service } = makeContext();
  openExam(service);
  service.indexImage({ eventId: "e1", examId: "exam-v", imageId: "img-a", storageUri: "u", checksum: "SAME", actor: grassDoctor });
  assert.throws(() => service.indexImage({
    eventId: "e2", examId: "exam-v", imageId: "img-a-copy", storageUri: "u2", checksum: "SAME", actor: grassDoctor,
  }), (e) => e.code === "DUPLICATE_IMAGE");
  assert.equal(service.examState("exam-v").images.size, 1);
});

test("专家更正：追加新版本，旧版保留并标记被取代；只能更正当前有效版本", () => {
  const { service } = makeContext();
  openExam(service);
  service.indexImage({ examId: "exam-v", imageId: "img-a", storageUri: "u", checksum: "cs-a", actor: grassDoctor });
  service.recordInterpretation({
    examId: "exam-v", interpretationId: "r1", imageIds: ["img-a"],
    findings: { stenosis: 40 }, recommendation: "轻度", actor: expert,
  });
  service.recordInterpretation({
    examId: "exam-v", interpretationId: "r2", imageIds: ["img-a"],
    findings: { stenosis: 70 }, recommendation: "重度，建议造影", actor: expert,
  });
  // 专家认为 r2 是错的，发起更正
  const corrected = service.correctInterpretation({
    examId: "exam-v", interpretationVersion: 2, interpretationId: "r3",
    findings: { stenosis: 45 }, recommendation: "轻中度", actor: expert,
  });
  assert.equal(corrected.kind, "INTERPRETATION_CORRECTED");
  assert.equal(corrected.supersedes_version, 2);

  const state = service.examState("exam-v");
  assert.equal(state.interpretations.length, 3);
  assert.equal(state.interpretations[0].supersededBy, 2, "r1 已被 r2 取代（链保持完整）");
  assert.equal(state.interpretations[1].supersededBy, 3, "r2 被更正取代");
  assert.equal(state.interpretations[2].supersededBy, null);
  assert.equal(state.interpretations[2].correctedFrom, 2);
  assert.equal(state.latestInterpretationVersion, 3);
  // 旧意见仍在流里可追溯
  assert.ok(service.store.readStream("exam:exam-v").some((e) => e.payload?.interpretation_id === "r2"));

  // 不能再更正已经被取代的 v2
  assert.throws(() => service.correctInterpretation({
    examId: "exam-v", interpretationVersion: 2, interpretationId: "r4", findings: {}, actor: expert,
  }), (e) => e.code === "STALE_CORRECTION");
});

test("不能签署已被更正取代的旧判读", () => {
  const { service } = makeContext();
  openExam(service);
  service.indexImage({ examId: "exam-v", imageId: "img-a", storageUri: "u", checksum: "cs-a", actor: grassDoctor });
  service.recordInterpretation({ examId: "exam-v", interpretationId: "r1", imageIds: ["img-a"], findings: { a: 1 }, actor: expert });
  service.correctInterpretation({ examId: "exam-v", interpretationVersion: 1, interpretationId: "r2", findings: { a: 2 }, actor: expert });
  assert.throws(() => service.signOff({
    examId: "exam-v", clinician: grassDoctor, scope: "s", interpretationVersion: 1,
  }), (e) => e.code === "STALE_CORRECTION");
  service.signOff({ examId: "exam-v", clinician: grassDoctor, scope: "s" }); // 默认签最新版
  assert.equal(service.examState("exam-v").signOff.interpretationVersion, 2);
});

test("乐观并发：expectedVersion 不匹配时拒绝写入", () => {
  const { service } = makeContext();
  openExam(service);
  // 直接对存储层验证并发语义
  assert.throws(() => service.store.append({
    eventId: "x1", kind: "IMAGE_INDEXED", occurredAt: "2026-09-22T09:00:00+08:00",
    subjectId: "pat-v", streamId: "exam:exam-v", actor: grassDoctor, payload: {},
  }, { expectedVersion: 99 }), (e) => e.code === "CONCURRENT_WRITE");
});
