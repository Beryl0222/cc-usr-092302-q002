import assert from "node:assert/strict";
import test from "node:test";
import { makeContext, ACTORS, FULL_CATEGORIES } from "./helpers.js";
import { PURPOSE, MODALITY, RISK, KIND, REFERRAL_STATUS } from "../src/vocabulary.js";
import { orgWorklist, patientAppointmentView, referralSummary } from "../src/read-models.js";

const { grassDoctor, expert, receiver } = ACTORS;
const patient = ACTORS.patient("pat-e2e");

test("端到端：从一次转诊可还原影像、判读、交接与最终处置（含断网补传影像）", () => {
  const ctx = makeContext();
  const { service, directory } = ctx;
  const examId = "exam-e2e";
  const referralId = "ref-e2e";

  // 基层机构（富平县医院覆盖的24家之一）发起高危识别 CT 检查
  service.requestExamination({
    examId, patientId: "pat-e2e", orgId: "org-township-07",
    modality: MODALITY.CARDIAC_CT, purpose: PURPOSE.ASYMPTOMATIC_HIGH_RISK, clinician: grassDoctor,
  });
  service.recordDeployment({ examId, deviceId: "ct-avocado-2", deviceName: "基层CT车", protocolId: "cardiac-cta", protocolVersion: "4.1", actor: grassDoctor });
  service.indexImage({
    examId, imageId: "img-1", storageUri: "pacs://township-07/img-1", checksum: "cs-1",
    seriesUid: "1.2.840.10", acquiredAt: "2026-09-22T07:40:00+08:00", actor: grassDoctor,
  });
  // 第二序列断网，晚两小时补传
  service.indexImage({
    examId, imageId: "img-2", storageUri: "pacs://township-07/img-2", checksum: "cs-2",
    seriesUid: "1.2.840.11", acquiredAt: "2026-09-22T07:42:00+08:00", actor: grassDoctor,
    occurredAt: "2026-09-22T07:42:00+08:00", backfill: true,
  });

  // 县医院影像中心判读 + 补充意见 + 风险分层
  service.recordInterpretation({
    examId, interpretationId: "read-1", imageIds: ["img-1", "img-2"],
    findings: { lad: "混合斑块，管腔狭窄约70%" }, recommendation: "建议冠脉造影评估", actor: expert,
  });
  service.addSupplement({
    examId, interpretationVersion: 1, supplementId: "sup-1",
    body: "结合钙化分布，建议薄层复核", actor: expert,
  });
  service.stratifyRisk({ examId, riskLevel: RISK.HIGH, rationale: "无症状但LAD重度狭窄可能", actor: grassDoctor });
  service.signOff({ examId, clinician: grassDoctor, scope: "高危识别与造影转诊" });

  // 授权与转诊
  service.grantConsent({
    referralId, patientId: "pat-e2e", purpose: PURPOSE.ASYMPTOMATIC_HIGH_RISK,
    receiverOrgId: "org-provincial-center", categories: FULL_CATEGORIES, examIds: [examId], actor: patient,
  });
  service.openReferral({
    referralId, examIds: [examId], receiverOrgId: "org-provincial-center",
    reason: "CT提示LAD重度狭窄，需造影明确", riskLevel: RISK.HIGH, actor: grassDoctor,
  });
  service.makeDisclosure({ referralId, actor: grassDoctor });
  service.acceptReferral({ referralId, actor: receiver });

  directory.register("org-provincial-center", { name: "省人民医院心内二科", contact: "0913-12345" });
  directory.addSlot("org-provincial-center", "slot-9", "2026-09-23T10:00:00+08:00", "0913-12345");
  service.offerAppointment({ referralId, slotId: "slot-9", actor: receiver });
  service.confirmAppointment({ referralId, actor: patient });
  service.acknowledgeHandoff({ referralId, actor: receiver });
  service.recordDisposition({
    referralId, outcome: "造影示LAD 75%，行PCI，术后稳定",
    recordLocator: "emr://provincial/enc-7781", actor: receiver,
  });

  // 还原：一次转诊的时间线覆盖四个环节
  const timeline = service.referralTimeline(referralId);
  const kinds = timeline.entries.map((e) => e.kind);
  for (const expected of [
    KIND.EXAMINATION_REQUESTED, KIND.DEPLOYMENT_RECORDED, KIND.IMAGE_INDEXED,
    KIND.INTERPRETATION_RECORDED, KIND.SUPPLEMENT_RECORDED, KIND.RISK_STRATIFIED,
    KIND.CLINICAL_SIGN_OFF, KIND.CONSENT_GRANTED, KIND.REFERRAL_OPENED,
    KIND.REFERRAL_DISCLOSURE_MADE, KIND.REFERRAL_ACCEPTED, KIND.APPOINTMENT_OFFERED,
    KIND.APPOINTMENT_CONFIRMED, KIND.HANDOFF_ACKNOWLEDGED, KIND.DISPOSITION_RECORDED,
  ]) {
    assert.ok(kinds.includes(expected), `时间线缺少 ${expected}`);
  }
  // 断网补传的影像在时间线上可见且带补传标记
  const backfilled = timeline.entries.filter((e) => e.backfilled);
  assert.equal(backfilled.length, 1);
  assert.equal(backfilled[0].payload.image_id, "img-2");

  const summary = referralSummary(service, referralId);
  assert.equal(summary.status, REFERRAL_STATUS.CLOSED);
  assert.equal(summary.chain_label, "无症状高危识别");
  assert.deepEqual(summary.disposition, { outcome: "造影示LAD 75%，行PCI，术后稳定", record_locator: "emr://provincial/enc-7781" });

  // 协议版本可从影像/判读链路一路追溯
  const exam = service.examState(examId);
  assert.equal(exam.deployment.protocolVersion, "4.1");
  assert.equal(exam.interpretations[0].supplements[0].supplementId, "sup-1");
});

test("预约一致性：患者所见时间与联系人随接收机构实际状态变化", () => {
  const { service, directory } = makeContext();
  const examId = "exam-appt", referralId = "ref-appt";
  service.requestExamination({
    examId, patientId: "pat-e2e", orgId: "org-township-07",
    modality: MODALITY.ECG, purpose: PURPOSE.LOW_RISK_SCREENING, clinician: grassDoctor,
  });
  service.recordDeployment({ examId, deviceId: "ecg-1", protocolId: "p", protocolVersion: "1", actor: grassDoctor });
  service.indexImage({ examId, imageId: "img", storageUri: "u", checksum: "c", acquiredAt: "t", actor: grassDoctor });
  service.recordInterpretation({ examId, interpretationId: "r", imageIds: ["img"], findings: { ecg: "正常" }, actor: expert });
  service.signOff({ examId, clinician: grassDoctor, scope: "随访" });
  service.grantConsent({
    referralId, patientId: "pat-e2e", purpose: PURPOSE.LOW_RISK_SCREENING,
    receiverOrgId: "org-county", categories: FULL_CATEGORIES, examIds: [examId], actor: patient,
  });
  service.openReferral({ referralId, examIds: [examId], receiverOrgId: "org-county", reason: "随访", actor: grassDoctor });
  service.makeDisclosure({ referralId, actor: grassDoctor });

  const countyReceiver = { ...receiver, orgId: "org-county" };
  service.acceptReferral({ referralId, actor: countyReceiver });
  directory.register("org-county", { name: "县医院门诊", contact: "0913-111" });
  directory.addSlot("org-county", "slot-a", "2026-09-25T09:00:00+08:00", "0913-111");
  service.offerAppointment({ referralId, slotId: "slot-a", actor: countyReceiver });

  // 待确认期间机构新增另一个号源（目录版本前进）：旧要约失效，必须重发
  directory.addSlot("org-county", "slot-b", "2026-09-26T09:00:00+08:00", "0913-111");
  let view = patientAppointmentView(service, directory, referralId);
  assert.equal(view.consistency, "STALE");
  assert.equal(view.appointment, null, "不向患者展示过期时间");

  // 重新给出要约后可确认
  service.offerAppointment({ referralId, slotId: "slot-b", actor: countyReceiver });
  service.confirmAppointment({ referralId, actor: patient });
  view = patientAppointmentView(service, directory, referralId);
  assert.equal(view.consistency, "CURRENT");
  assert.equal(view.appointment.scheduled_at, "2026-09-26T09:00:00+08:00");
  assert.equal(view.appointment.contact, "0913-111");

  // 已确认后机构修改该号源联系人：患者视图立即显示失效
  directory.updateSlot("org-county", "slot-b", { contact: "0913-999" });
  view = patientAppointmentView(service, directory, referralId);
  assert.equal(view.consistency, "STALE");

  // 恢复联系人后重新一致（机构联系患者重新告知后可更新事件；此处直接验证目录恢复路径）
  directory.updateSlot("org-county", "slot-b", { contact: "0913-111" });
  view = patientAppointmentView(service, directory, referralId);
  assert.equal(view.consistency, "CURRENT");

  // 机构暂停受理：立即失效
  directory.setAccepting("org-county", false);
  view = patientAppointmentView(service, directory, referralId);
  assert.equal(view.consistency, "STALE");
});

test("非指定接收机构不能回执交接", () => {
  const { service, directory } = makeContext();
  const examId = "exam-x", referralId = "ref-x";
  service.requestExamination({
    examId, patientId: "pat-e2e", orgId: "org-township-07",
    modality: MODALITY.ECG, purpose: PURPOSE.LOW_RISK_SCREENING, clinician: grassDoctor,
  });
  service.recordDeployment({ examId, deviceId: "d", protocolId: "p", protocolVersion: "1", actor: grassDoctor });
  service.indexImage({ examId, imageId: "i", storageUri: "u", checksum: "c", acquiredAt: "t", actor: grassDoctor });
  service.recordInterpretation({ examId, interpretationId: "r", imageIds: ["i"], findings: {}, actor: expert });
  service.signOff({ examId, clinician: grassDoctor, scope: "s" });
  service.grantConsent({
    referralId, patientId: "pat-e2e", purpose: PURPOSE.LOW_RISK_SCREENING,
    receiverOrgId: "org-provincial-center", categories: FULL_CATEGORIES, examIds: [examId], actor: patient,
  });
  service.openReferral({ referralId, examIds: [examId], receiverOrgId: "org-provincial-center", reason: "r", actor: grassDoctor });
  service.makeDisclosure({ referralId, actor: grassDoctor });
  service.acceptReferral({ referralId, actor: receiver });
  directory.register("org-provincial-center", { contact: "c" });
  directory.addSlot("org-provincial-center", "s1", "2026-09-26T09:00:00+08:00");
  service.offerAppointment({ referralId, slotId: "s1", actor: receiver });
  service.confirmAppointment({ referralId, actor: patient });

  const impostor = { ...receiver, orgId: "org-other-hospital" };
  assert.throws(() => service.acknowledgeHandoff({ referralId, actor: impostor }),
    (e) => e.code === "RECEIVER_MISMATCH");
});
