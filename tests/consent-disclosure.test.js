import assert from "node:assert/strict";
import test from "node:test";
import { makeContext, ACTORS, FULL_CATEGORIES, CATEGORY } from "./helpers.js";
import { PURPOSE, MODALITY, RISK, REFERRAL_STATUS } from "../src/vocabulary.js";

const { grassDoctor, expert, receiver } = ACTORS;
const patient = ACTORS.patient("pat-c");

function signedExam(service, { examId, purpose, modality = MODALITY.CARDIAC_CT, signer = grassDoctor, patientId = "pat-c", ffr = false }) {
  service.requestExamination({
    examId, patientId, orgId: "org-fuping-county", modality, purpose, clinician: grassDoctor,
  });
  service.recordDeployment({ examId, deviceId: "d", protocolId: "p", protocolVersion: "9", actor: grassDoctor });
  service.indexImage({ examId, imageId: `${examId}-img`, storageUri: `pacs://${examId}`, checksum: `cs-${examId}`, acquiredAt: "t", actor: grassDoctor });
  service.recordInterpretation({
    examId, interpretationId: `${examId}-r1`, imageIds: [`${examId}-img`],
    findings: { stenosis: 50 }, recommendation: "中度", actor: expert,
  });
  if (ffr) {
    service.recordInterpretation({
      examId, interpretationId: `${examId}-ffr`, imageIds: [`${examId}-img`],
      findings: { ffr_min: 0.8 }, recommendation: "无显著缺血", actor: ACTORS.ffrAnalyst, adjunct: true,
    });
  }
  service.signOff({ examId, clinician: signer, scope: "签署" });
}

function runReferral(service, referralId, { purpose, examIds, categories, patientId = "pat-c" }) {
  service.grantConsent({
    referralId, patientId, purpose, receiverOrgId: "org-provincial-center",
    categories, examIds, actor: ACTORS.patient(patientId),
  });
  // 转诊发起与跨院披露始终由基层医生执行；各链签署人差异在 signedExam 中体现。
  service.openReferral({
    referralId, examIds, receiverOrgId: "org-provincial-center",
    reason: "转诊评估", riskLevel: RISK.MEDIUM, actor: grassDoctor,
  });
  const disclosure = service.makeDisclosure({ referralId, actor: grassDoctor });
  service.acceptReferral({ referralId, actor: receiver });
  return disclosure;
}

test("最小披露：低危筛查包不含影像索引与危急信息", () => {
  const { service } = makeContext();
  signedExam(service, { examId: "e-low", purpose: PURPOSE.LOW_RISK_SCREENING, modality: MODALITY.ECG });
  const disclosure = runReferral(service, "ref-1", {
    purpose: PURPOSE.LOW_RISK_SCREENING, examIds: ["e-low"], categories: FULL_CATEGORIES,
  });
  const cats = disclosure.payload.categories;
  assert.ok(cats.includes(CATEGORY.LATEST_REPORT) && cats.includes(CATEGORY.SIGN_OFF));
  assert.ok(!cats.includes(CATEGORY.IMAGE_INDEX), "低危随访无需影像定位");
  assert.ok(!cats.includes(CATEGORY.ADJUNCT_REPORT));
});

test("最小披露：高危识别包含影像索引但不搭车CT-FFR", () => {
  const { service } = makeContext();
  signedExam(service, { examId: "e-hr", purpose: PURPOSE.ASYMPTOMATIC_HIGH_RISK });
  const disclosure = runReferral(service, "ref-2", {
    purpose: PURPOSE.ASYMPTOMATIC_HIGH_RISK, examIds: ["e-hr"], categories: FULL_CATEGORIES,
  });
  assert.ok(disclosure.payload.categories.includes(CATEGORY.IMAGE_INDEX));
  assert.ok(!disclosure.payload.categories.includes(CATEGORY.ADJUNCT_REPORT));
});

test("CT-FFR包成对包含解剖学判读与附属分析", () => {
  const { service } = makeContext();
  signedExam(service, { examId: "e-ffr", purpose: PURPOSE.CT_FFR_ADJUNCT, signer: receiver, ffr: true });
  const disclosure = runReferral(service, "ref-3", {
    purpose: PURPOSE.CT_FFR_ADJUNCT, examIds: ["e-ffr"], categories: FULL_CATEGORIES, signer: receiver,
  });
  const cats = disclosure.payload.categories;
  assert.ok(cats.includes(CATEGORY.LATEST_REPORT));
  assert.ok(cats.includes(CATEGORY.ADJUNCT_REPORT));
  assert.ok(cats.includes(CATEGORY.IMAGE_INDEX));
});

test("患者授权类别是披露的第二道闸：未授权的类别不发送", () => {
  const { service } = makeContext();
  signedExam(service, { examId: "e-hr", purpose: PURPOSE.ASYMPTOMATIC_HIGH_RISK });
  service.grantConsent({
    referralId: "ref-4", patientId: "pat-c", purpose: PURPOSE.ASYMPTOMATIC_HIGH_RISK,
    receiverOrgId: "org-provincial-center",
    // 患者只授权报告和签署，不授权影像索引
    categories: [CATEGORY.REQUEST, CATEGORY.LATEST_REPORT, CATEGORY.SIGN_OFF],
    examIds: ["e-hr"], actor: patient,
  });
  service.openReferral({
    referralId: "ref-4", examIds: ["e-hr"], receiverOrgId: "org-provincial-center",
    reason: "r", actor: grassDoctor,
  });
  const disclosure = service.makeDisclosure({ referralId: "ref-4", actor: grassDoctor });
  assert.ok(!disclosure.payload.categories.includes(CATEGORY.IMAGE_INDEX));
});

test("撤回尚未用于诊疗的授权：转诊作废、已披露资料须停止共享并由接收方确认处置", () => {
  const { service } = makeContext();
  signedExam(service, { examId: "e-hr", purpose: PURPOSE.ASYMPTOMATIC_HIGH_RISK });
  runReferral(service, "ref-5", {
    purpose: PURPOSE.ASYMPTOMATIC_HIGH_RISK, examIds: ["e-hr"], categories: FULL_CATEGORIES,
  });
  const result = service.withdrawConsent({ referralId: "ref-5", reason: "患者改变主意", actor: patient });
  assert.equal(result.consequence, "STOP_SHARING");
  assert.equal(result.purgeRequired, true);
  const state = service.referralState("ref-5");
  assert.equal(state.status, REFERRAL_STATUS.REVOKED);

  // 撤回后任何继续共享/受理/预约都被拒绝
  assert.throws(() => service.acceptReferral({ referralId: "ref-5", actor: receiver }),
    (e) => e.code === "CONSENT_WITHDRAWN");

  // 接收机构确认停止共享并处置资料
  service.confirmSharingDiscontinued({ referralId: "ref-5", actor: receiver });
  assert.equal(service.referralState("ref-5").sharingStopped, true);
  assert.equal(service.referralState("ref-5").purgeRequired, false);
});

test("进入病历后的撤回不能抹除决定：保持CLOSED，留下可追溯留痕", () => {
  const { service, directory } = makeContext();
  signedExam(service, { examId: "e-pre", purpose: PURPOSE.PREOPERATIVE_MEASUREMENT, signer: receiver });
  runReferral(service, "ref-6", {
    purpose: PURPOSE.PREOPERATIVE_MEASUREMENT, examIds: ["e-pre"], categories: FULL_CATEGORIES, signer: receiver,
  });
  directory.register("org-provincial-center", { contact: "护士站 0913-xxx" });
  directory.addSlot("org-provincial-center", "slot-1", "2026-09-24T09:00:00+08:00", "护士站 0913-xxx");
  service.offerAppointment({ referralId: "ref-6", slotId: "slot-1", actor: receiver });
  service.confirmAppointment({ referralId: "ref-6", actor: patient });
  service.acknowledgeHandoff({ referralId: "ref-6", actor: receiver });
  service.recordDisposition({
    referralId: "ref-6", outcome: "已完成术前评估，安排手术",
    recordLocator: "emr://provincial/rec-66", actor: receiver,
  });

  const result = service.withdrawConsent({ referralId: "ref-6", reason: "事后反悔", actor: patient });
  assert.equal(result.consequence, "RETAINED_IN_RECORD");
  const state = service.referralState("ref-6");
  assert.equal(state.status, REFERRAL_STATUS.CLOSED, "已入病历的决定不回退");
  assert.equal(state.withdrawalAfterRecord, true);
  assert.ok(state.consent.withdrawnAt, "撤回事件本身留痕");
});

test("交接后、病历形成前撤回：禁止再披露，但诊疗继续并仍需处置留痕", () => {
  const { service, directory } = makeContext();
  signedExam(service, { examId: "e-pre2", purpose: PURPOSE.PREOPERATIVE_MEASUREMENT, signer: receiver });
  runReferral(service, "ref-7", {
    purpose: PURPOSE.PREOPERATIVE_MEASUREMENT, examIds: ["e-pre2"], categories: FULL_CATEGORIES, signer: receiver,
  });
  directory.register("org-provincial-center", { contact: "护士站 0913-xxx" });
  directory.addSlot("org-provincial-center", "slot-1", "2026-09-24T09:00:00+08:00", "护士站");
  service.offerAppointment({ referralId: "ref-7", slotId: "slot-1", actor: receiver });
  service.confirmAppointment({ referralId: "ref-7", actor: patient });
  service.acknowledgeHandoff({ referralId: "ref-7", actor: receiver });

  const result = service.withdrawConsent({ referralId: "ref-7", reason: "不想继续", actor: patient });
  assert.equal(result.consequence, "WITHDRAWN_IN_CARE");
  const state = service.referralState("ref-7");
  assert.equal(state.status, REFERRAL_STATUS.IN_CARE, "已在诊疗中不回退状态");
  assert.equal(state.withdrawalInCare, true);
  // 最终处置仍须记录并留痕
  service.recordDisposition({ referralId: "ref-7", outcome: "保守治疗", recordLocator: "emr://x/7", actor: receiver });
  assert.equal(service.referralState("ref-7").status, REFERRAL_STATUS.CLOSED);
});

test("授权不覆盖的检查/错误接收机构不能发起转诊", () => {
  const { service } = makeContext();
  signedExam(service, { examId: "e-low", purpose: PURPOSE.LOW_RISK_SCREENING, modality: MODALITY.ECG });
  service.grantConsent({
    referralId: "ref-8", patientId: "pat-c", purpose: PURPOSE.LOW_RISK_SCREENING,
    receiverOrgId: "org-provincial-center", categories: FULL_CATEGORIES, examIds: [], actor: patient,
  });
  assert.throws(() => service.openReferral({
    referralId: "ref-8", examIds: ["e-low"], receiverOrgId: "org-provincial-center",
    reason: "r", actor: grassDoctor,
  }), (e) => e.code === "CONSENT_REQUIRED");

  service.grantConsent({
    referralId: "ref-9", patientId: "pat-c", purpose: PURPOSE.LOW_RISK_SCREENING,
    receiverOrgId: "org-city-hospital", categories: FULL_CATEGORIES, examIds: ["e-low"], actor: patient,
  });
  assert.throws(() => service.openReferral({
    referralId: "ref-9", examIds: ["e-low"], receiverOrgId: "org-provincial-center",
    reason: "r", actor: grassDoctor,
  }), (e) => e.code === "RECEIVER_MISMATCH");
});
