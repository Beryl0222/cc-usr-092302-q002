import assert from "node:assert/strict";
import test from "node:test";
import { makeContext, ACTORS, FULL_CATEGORIES, CATEGORY } from "./helpers.js";
import { ImagingService } from "../src/imaging-service.js";
import { PURPOSE, MODALITY, RISK, ROLE } from "../src/vocabulary.js";
import { DomainError } from "../src/errors.js";

const { grassDoctor, expert, ffrAnalyst, receiver } = ACTORS;

function createExam(service, { examId, purpose, modality, patientId = "pat-1", clinician = grassDoctor }) {
  service.requestExamination({
    examId, patientId, orgId: "org-fuping-county", modality, purpose, clinician,
  });
  service.recordDeployment({
    examId, deviceId: "dev-1", protocolId: "proto-ecg", protocolVersion: "3.2", actor: clinician,
  });
  service.indexImage({
    examId, imageId: `${examId}-img-1`, storageUri: `pacs://${examId}/1`,
    checksum: `cs-${examId}-1`, seriesUid: `series-${examId}`, acquiredAt: "2026-09-22T07:30:00+08:00",
    actor: clinician,
  });
  service.recordInterpretation({
    examId, interpretationId: `${examId}-read-1`, imageIds: [`${examId}-img-1`],
    findings: { summary: "窦性心律" }, recommendation: "随访", actor: expert,
  });
}

test("低危筛查链：影像专家意见未经基层医生签署不能转诊，签署后可以", () => {
  const { service } = makeContext();
  createExam(service, { examId: "exam-low", purpose: PURPOSE.LOW_RISK_SCREENING, modality: MODALITY.ECG });
  service.grantConsent({
    referralId: "ref-low", patientId: "pat-1", purpose: PURPOSE.LOW_RISK_SCREENING,
    receiverOrgId: "org-provincial-center", categories: FULL_CATEGORIES, examIds: ["exam-low"],
    actor: ACTORS.patient("pat-1"),
  });

  assert.throws(
    () => service.openReferral({
      referralId: "ref-low", examIds: ["exam-low"], receiverOrgId: "org-provincial-center",
      reason: "胸闷", riskLevel: RISK.LOW, actor: grassDoctor,
    }),
    (e) => e instanceof DomainError && e.code === "SIGN_OFF_REQUIRED",
  );

  service.signOff({ examId: "exam-low", clinician: grassDoctor, scope: "低危筛查结论与随访建议" });
  const opened = service.openReferral({
    referralId: "ref-low", examIds: ["exam-low"], receiverOrgId: "org-provincial-center",
    reason: "胸闷", riskLevel: RISK.LOW, actor: grassDoctor,
  });
  assert.equal(opened.kind, "REFERRAL_OPENED");
});

test("影像专家和CT-FFR分析者永远不能临床签署", () => {
  const { service } = makeContext();
  createExam(service, { examId: "exam-hr", purpose: PURPOSE.ASYMPTOMATIC_HIGH_RISK, modality: MODALITY.CARDIAC_CT });
  assert.throws(() => service.signOff({ examId: "exam-hr", clinician: expert, scope: "x" }),
    (e) => e.code === "SIGNER_ROLE");

  const preop = "exam-preop";
  createExam(service, { examId: preop, purpose: PURPOSE.PREOPERATIVE_MEASUREMENT, modality: MODALITY.CARDIAC_CT, patientId: "pat-2" });
  assert.throws(() => service.signOff({ examId: preop, clinician: grassDoctor, scope: "x" }),
    // 术前测量只能由接收方临床医生签署，基层医生也不行
    (e) => e.code === "SIGNER_ROLE");
  service.signOff({ examId: preop, clinician: receiver, scope: "术前测量数据用于瓣膜方案" });
  assert.equal(service.examState(preop).signOff.clinicianId, receiver.id);
});

test("无症状高危链：造影可走此链，基层与接收医生均可签署", () => {
  const { service } = makeContext();
  createExam(service, { examId: "exam-angio", purpose: PURPOSE.ASYMPTOMATIC_HIGH_RISK, modality: MODALITY.CORONARY_ANGIOGRAPHY, patientId: "pat-3" });
  service.signOff({ examId: "exam-angio", clinician: grassDoctor, scope: "高危识别转诊" });
  assert.equal(service.examState("exam-angio").signOff.role, ROLE.REFERRING_CLINICIAN);
});

test("CT-FFR链：必须先解剖学判读再附属分析，二者成对，且只有接收医生能签署", () => {
  const { service } = makeContext();
  const examId = "exam-ffr";
  service.requestExamination({
    examId, patientId: "pat-4", orgId: "org-fuping-county",
    modality: MODALITY.CARDIAC_CT, purpose: PURPOSE.CT_FFR_ADJUNCT, clinician: grassDoctor,
  });
  service.recordDeployment({ examId, deviceId: "ct-9", protocolId: "proto-ct", protocolVersion: "5.0", actor: grassDoctor });
  service.indexImage({
    examId, imageId: `${examId}-img`, storageUri: "pacs://ffr/1", checksum: "cs-ffr",
    seriesUid: "s-ffr", acquiredAt: "2026-09-22T07:30:00+08:00", actor: grassDoctor,
  });

  // 没有解剖学判读时，附属分析不能先行
  assert.throws(() => service.recordInterpretation({
    examId, interpretationId: "ffr-only", imageIds: [`${examId}-img`],
    findings: { ffr_min: 0.72 }, recommendation: "缺血可能", actor: ffrAnalyst, adjunct: true,
  }), (e) => e.code === "CHAIN_MISMATCH");

  service.recordInterpretation({
    examId, interpretationId: "anat-1", imageIds: [`${examId}-img`],
    findings: { lad_stenosis_pct: 65 }, recommendation: "中度狭窄", actor: expert,
  });
  // CT-FFR 链上，分析者不能用"普通判读"绕过附属定位，解剖学判读只能由影像专家出具
  assert.throws(() => service.recordInterpretation({
    examId, interpretationId: "analyst-anat", imageIds: [`${examId}-img`],
    findings: {}, actor: ffrAnalyst, adjunct: false,
  }), (e) => e.code === "CHAIN_MISMATCH");

  service.recordInterpretation({
    examId, interpretationId: "ffr-1", imageIds: [`${examId}-img`],
    findings: { ffr_min: 0.72 }, recommendation: "缺血可能，建议造影", actor: ffrAnalyst, adjunct: true,
  });
  // 分析者不能签署
  assert.throws(() => service.signOff({ examId, clinician: ffrAnalyst, scope: "x" }), (e) => e.code === "SIGNER_ROLE");
  service.signOff({ examId, clinician: receiver, scope: "结合CT-FFR的造影转诊决定" });
  assert.equal(service.examState(examId).signOff.clinicianId, receiver.id);
});

test("责任链不允许的模态在申请阶段即被拒绝", () => {
  const { service } = makeContext();
  assert.throws(() => service.requestExamination({
    examId: "bad", patientId: "p", orgId: "o", modality: MODALITY.CORONARY_ANGIOGRAPHY,
    purpose: PURPOSE.CT_FFR_ADJUNCT, clinician: grassDoctor,
  }), (e) => e.code === "CHAIN_MISMATCH");
});

test("一次转诊不能混用不同责任链的检查", () => {
  const { service } = makeContext();
  createExam(service, { examId: "e-low", purpose: PURPOSE.LOW_RISK_SCREENING, modality: MODALITY.ECG });
  service.signOff({ examId: "e-low", clinician: grassDoctor, scope: "s" });
  createExam(service, { examId: "e-pre", purpose: PURPOSE.PREOPERATIVE_MEASUREMENT, modality: MODALITY.CARDIAC_CT });
  service.signOff({ examId: "e-pre", clinician: receiver, scope: "s" });
  service.grantConsent({
    referralId: "ref-mix", patientId: "pat-1", purpose: PURPOSE.LOW_RISK_SCREENING,
    receiverOrgId: "org-provincial-center", categories: FULL_CATEGORIES, examIds: ["e-low", "e-pre"],
    actor: ACTORS.patient("pat-1"),
  });
  assert.throws(() => service.openReferral({
    referralId: "ref-mix", examIds: ["e-low", "e-pre"], receiverOrgId: "org-provincial-center",
    reason: "混合", actor: grassDoctor,
  }), (e) => e.code === "CHAIN_MISMATCH");
});
