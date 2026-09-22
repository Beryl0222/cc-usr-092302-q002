import assert from "node:assert/strict";
import test from "node:test";
import { makeContext, ACTORS } from "./helpers.js";
import { PURPOSE, MODALITY, RISK } from "../src/vocabulary.js";
import { orgWorklist } from "../src/read-models.js";

const { grassDoctor, expert } = ACTORS;

function minimalExam(service, examId, patientId, { modality = MODALITY.ECG, purpose = PURPOSE.LOW_RISK_SCREENING } = {}) {
  service.requestExamination({
    examId, patientId, orgId: "org-fuping-county", modality, purpose, clinician: grassDoctor,
  });
  service.recordDeployment({ examId, deviceId: "d", protocolId: "p", protocolVersion: "1", actor: grassDoctor });
  service.indexImage({
    examId, imageId: `${examId}-img`, storageUri: `pacs://${examId}`, checksum: `cs-${examId}`,
    acquiredAt: "t", actor: grassDoctor,
  });
}

test("危急分层自动升级该患者，其他人仍在队列中且队列不冻结", () => {
  const { service } = makeContext();
  minimalExam(service, "exam-a", "pat-a"); // 普通患者
  minimalExam(service, "exam-b", "pat-b"); // 将出危急
  minimalExam(service, "exam-c", "pat-c"); // 普通患者

  service.recordInterpretation({
    examId: "exam-b", interpretationId: "rb", imageIds: ["exam-b-img"],
    findings: { st_elevation: true }, recommendation: "急诊造影", actor: expert,
  });
  service.stratifyRisk({ examId: "exam-b", riskLevel: RISK.CRITICAL, rationale: "广泛前壁ST段抬高", actor: grassDoctor });

  const wl = orgWorklist(service.store, "org-fuping-county");
  assert.equal(wl.frozen, false);
  assert.equal(wl.total, 3, "危急不冻结队列：三个检查都在");

  const ids = wl.items.map((i) => i.exam_id);
  assert.deepEqual(ids, ["exam-b", "exam-a", "exam-c"], "危急患者排最前，其余保持到达顺序");

  const critical = wl.items[0];
  assert.equal(critical.critical_active, true);
  assert.equal(critical.awaiting, "CRITICAL_AWAITING_ACK");

  // 其他机构不受影响
  const other = orgWorklist(service.store, "org-other-town");
  assert.equal(other.total, 0);
});

test("危急回执后升级解除；同一患者不会重复升级", () => {
  const { service } = makeContext();
  minimalExam(service, "exam-b", "pat-b");
  service.stratifyRisk({ examId: "exam-b", riskLevel: RISK.CRITICAL, rationale: "危急", actor: grassDoctor });
  service.acknowledgeEscalation({ examId: "exam-b", actor: grassDoctor });

  const state = service.examState("exam-b");
  assert.equal(state.critical.active, false);
  assert.equal(state.critical.acknowledged, true);

  // active 期间的重复升级被拒；回执后若出现新危急信号允许再次升级
  service.stratifyRisk({ examId: "exam-b", riskLevel: RISK.CRITICAL, rationale: "再次危急", actor: grassDoctor });
  assert.equal(service.examState("exam-b").critical.active, true);
  assert.throws(() => service.escalateCritical({ examId: "exam-b", signals: ["x"], reason: "r", actor: grassDoctor }),
    (e) => e.code === "DUPLICATE_EVENT");
});

test("危急升级期间其他患者的检查流程可以照常推进（无写阻塞）", () => {
  const { service } = makeContext();
  minimalExam(service, "exam-a", "pat-a");
  minimalExam(service, "exam-b", "pat-b");
  service.stratifyRisk({ examId: "exam-a", riskLevel: RISK.CRITICAL, rationale: "心梗征象", actor: grassDoctor });

  // pat-b 照常判读、签署
  service.recordInterpretation({
    examId: "exam-b", interpretationId: "rb", imageIds: ["exam-b-img"], findings: { ok: true }, actor: expert,
  });
  service.signOff({ examId: "exam-b", clinician: grassDoctor, scope: "低危随访" });
  assert.equal(service.examState("exam-b").signOff.clinicianId, grassDoctor.id);
});

test("高风险（非危急）排序优先但不产生升级标记", () => {
  const { service } = makeContext();
  minimalExam(service, "exam-a", "pat-a");
  minimalExam(service, "exam-b", "pat-b");
  service.stratifyRisk({ examId: "exam-b", riskLevel: RISK.HIGH, rationale: "钙化积分高", actor: grassDoctor });
  const wl = orgWorklist(service.store, "org-fuping-county");
  assert.deepEqual(wl.items.map((i) => i.exam_id), ["exam-b", "exam-a"]);
  assert.equal(wl.items[0].critical_active, false);
});
