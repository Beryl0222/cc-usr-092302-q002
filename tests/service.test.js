import assert from "node:assert/strict";
import test from "node:test";
import { ReferralService, DomainError } from "../src/service.js";
import { EventStore } from "../src/store.js";
import {
  MODALITY, PATHWAY, ROLE, PURPOSE, URGENCY, RISK_LEVEL, KIND,
} from "../src/kinds.js";
import {
  foldCase, institutionQueue, patientView, referralTimeline, disclosureLedger,
} from "../src/projections.js";

const FP = "org-fuping-county-hospital"; // 富平县医院（中心/牵头）
const TOWNSHIP = "org-liuqu-township"; // 基层机构
const PCI_CENTER = "org-xian-cardiac-center"; // 接收：上级介入中心

function makeService() {
  const store = new EventStore({ clock: () => "2026-09-22T12:00:00+08:00" });
  let n = 0;
  const id = (p) => `${p}-${(++n).toString(36)}`;
  return { svc: new ReferralService({ store, id }), store, id };
}

const device = {
  device_id: "dev-ct-01", modality: MODALITY.CARDIAC_CT, model: "CT-64",
};
const protocol = { name: "coronary-cta", version: "v3.2" };

function seedCase(svc, caseId, {
  modality = MODALITY.CARDIAC_CT,
  pathway = PATHWAY.LOW_RISK_SCREENING,
  origin = TOWNSHIP,
  at0 = "2026-09-22T08:00:00+08:00",
} = {}) {
  svc.requestExamination(caseId, {
    patient_id: "P-1", origin_org_id: origin, modality, pathway,
    reason: "胸闷筛查", clinician_id: "dr-basic", requested_at: at0,
  });
  svc.prepareAcquisition(caseId, {
    device: { ...device, modality }, protocol,
    technologist_id: "tech-1", prepared_at: "2026-09-22T08:10:00+08:00",
  });
}

test("全链路：申请→采集→判读→签署→授权→转诊→回执→预约→交接→处置可一次还原", () => {
  const { svc, store } = makeService();
  const cid = "case-full";
  seedCase(svc, cid);

  svc.uploadImages(cid, {
    upload_id: "up-1", connectivity: "ONLINE", uploaded_at: "2026-09-22T08:30:00+08:00",
    images: [
      { image_id: "img-1", checksum: "sha256:a", bytes: 1024, stage: "REST" },
      { image_id: "img-2", checksum: "sha256:b", bytes: 2048, stage: "STRESS" },
    ],
  });

  svc.recordInterpretation(cid, {
    report_id: "rpt-1", reader_id: "dr-reader", reader_role: ROLE.CENTER_READER,
    image_ids: ["img-1", "img-2"], impression: "未见显著狭窄",
    recommendation: "年度随访", interpreted_at: "2026-09-22T09:30:00+08:00",
  });

  // 影像建议不能直接转诊，必须先由基层临床医生签署
  assert.throws(
    () => svc.createReferral(cid, {
      referral_id: "ref-1", receiving_org_id: PCI_CENTER, purpose: PURPOSE.SPECIALIST_CONSULT,
      urgency: URGENCY.ROUTINE,
    }),
    (e) => e.code === "NO_SIGNED_DECISION"
  );

  svc.signClinicalDecision(cid, {
    decision_id: "dec-1", clinician_id: "dr-basic", role: ROLE.PRIMARY_CLINICIAN,
    decision: "建议专科会诊确认", at: "2026-09-22T10:00:00+08:00",
  });

  svc.grantConsent(cid, {
    consent_id: "con-1", purpose: PURPOSE.SPECIALIST_CONSULT, receiving_org_id: PCI_CENTER,
    granted_at: "2026-09-22T10:05:00+08:00",
  });
  svc.createReferral(cid, {
    referral_id: "ref-1", receiving_org_id: PCI_CENTER,
    purpose: PURPOSE.SPECIALIST_CONSULT, urgency: URGENCY.ROUTINE,
    rationale: "影像提示需专科确认", at: "2026-09-22T10:10:00+08:00",
  });

  const share = svc.shareReferralPacket(cid, {
    referral_id: "ref-1", share_id: "sh-1", at: "2026-09-22T10:12:00+08:00",
  });
  // 专科会诊最小披露：申请+影像+当前报告+签署；不含风险、测量
  const sectionNames = [...new Set(share.payload.sections.map((s) => s.section))].sort();
  assert.deepEqual(sectionNames, ["current_report", "images", "request", "signed_decision"]);

  svc.issueReceipt(cid, {
    referral_id: "ref-1", actor_org_id: PCI_CENTER, by: "dr-pci",
    at: "2026-09-22T10:20:00+08:00",
  });
  svc.acknowledgeReferral(cid, {
    referral_id: "ref-1", actor_org_id: PCI_CENTER, by: "dr-pci", decision: "ACCEPTED",
    appointment: { scheduled_at: "2026-09-24T09:00:00+08:00", location: "门诊302" },
    contact: { name: "王护士", channel: "029-123/工位12" },
    at: "2026-09-22T10:25:00+08:00",
  });
  svc.handover(cid, {
    referral_id: "ref-1", actor_org_id: PCI_CENTER, receiving_clinician_id: "dr-pci",
    at: "2026-09-24T09:05:00+08:00",
  });
  svc.recordDisposition(cid, {
    referral_id: "ref-1", disposition: "药物治疗+6月复查", by: "dr-pci",
    at: "2026-09-24T09:40:00+08:00",
  });

  // 患者视图：预约与联系人来自接收机构确认
  const pv = patientView(store, cid).referrals[0];
  assert.equal(pv.status, "CLOSED");
  assert.equal(pv.appointment.scheduled_at, "2026-09-24T09:00:00+08:00");
  assert.equal(pv.contact.name, "王护士");

  // 一次转诊可还原影像→判读→交接→处置全链
  const timeline = referralTimeline(store, cid, "ref-1");
  const kinds = timeline.map((t) => t.kind);
  assert.ok(kinds.includes(KIND.IMAGES_INDEXED));
  assert.ok(kinds.includes(KIND.INTERPRETATION_RECORDED));
  assert.ok(kinds.includes(KIND.REFERRAL_HANDED_OVER));
  assert.ok(kinds.includes(KIND.FINAL_DISPOSITION_RECORDED));

  const state = foldCase(store, cid);
  assert.equal(state.acquisition.protocol.version, "v3.2", "影像可回溯到协议版本");
  assert.equal(state.disposition.disposition, "药物治疗+6月复查");
});

test("责任链：越权初判/越权签署被拒；无症状高危链强制风险分层", () => {
  const { svc } = makeService();
  const cid = "case-chain";
  seedCase(svc, cid, { pathway: PATHWAY.ASYMPTOMATIC_HIGH_RISK });
  svc.uploadImages(cid, {
    upload_id: "up-1", images: [{ image_id: "img-1", checksum: "sha256:a" }],
    uploaded_at: "2026-09-22T08:30:00+08:00",
  });

  // 低危链读者（中心判读）不能在高危链初判
  assert.throws(
    () => svc.recordInterpretation(cid, {
      report_id: "rpt-x", reader_id: "r", reader_role: ROLE.CENTER_READER,
      image_ids: ["img-1"], impression: "x",
    }),
    (e) => e.code === "ROLE_NOT_IN_CHAIN"
  );

  svc.recordInterpretation(cid, {
    report_id: "rpt-1", reader_id: "dr-cardio", reader_role: ROLE.CARDIOLOGY_SPECIALIST,
    image_ids: ["img-1"], impression: "钙化积分高", interpreted_at: "2026-09-22T09:00:00+08:00",
  });

  // 未风险分层，高危链不能签署
  assert.throws(
    () => svc.signClinicalDecision(cid, {
      decision_id: "dec-x", clinician_id: "dr-basic", role: ROLE.PRIMARY_CLINICIAN,
      decision: "转诊",
    }),
    (e) => e.code === "RISK_STRATIFICATION_REQUIRED"
  );

  svc.stratifyRisk(cid, {
    level: RISK_LEVEL.HIGH, factors: ["LDL 高", "家族史"], by: "dr-cardio",
    at: "2026-09-22T09:20:00+08:00",
  });

  // 影像专家不能代行临床签署
  assert.throws(
    () => svc.signClinicalDecision(cid, {
      decision_id: "dec-y", clinician_id: "dr-cardio", role: ROLE.CARDIOLOGY_SPECIALIST,
      decision: "转诊",
    }),
    (e) => e.code === "NOT_A_SIGNER"
  );

  svc.signClinicalDecision(cid, {
    decision_id: "dec-1", clinician_id: "dr-basic", role: ROLE.PRIMARY_CLINICIAN,
    decision: "转上级评估", at: "2026-09-22T09:30:00+08:00",
  });
});

test("CT-FFR 补充判断走独立责任链：意见仅供参考、不能在别链出具", () => {
  const { svc, store } = makeService();
  const cid = "case-ffr";
  seedCase(svc, cid, { pathway: PATHWAY.CT_FFR_SUPPLEMENT });
  svc.uploadImages(cid, {
    upload_id: "up-1", images: [{ image_id: "img-1", checksum: "sha256:a" }],
    uploaded_at: "2026-09-22T08:30:00+08:00",
  });
  svc.recordInterpretation(cid, {
    report_id: "rpt-base", reader_id: "dr-img", reader_role: ROLE.CARDIAC_IMAGING_SPECIALIST,
    image_ids: ["img-1"], impression: "LAD 中度狭窄", interpreted_at: "2026-09-22T09:00:00+08:00",
  });

  // 低危筛查链里不能冒出 CT-FFR 意见（用另一病例验证路径隔离）
  const other = "case-low";
  seedCase(svc, other, { pathway: PATHWAY.LOW_RISK_SCREENING });
  svc.uploadImages(other, {
    upload_id: "up-o", images: [{ image_id: "img-o", checksum: "sha256:z" }],
    uploaded_at: "2026-09-22T08:30:00+08:00",
  });
  svc.recordInterpretation(other, {
    report_id: "rpt-o", reader_id: "dr-r", reader_role: ROLE.CENTER_READER,
    image_ids: ["img-o"], impression: "ok", interpreted_at: "2026-09-22T09:00:00+08:00",
  });
  assert.throws(
    () => svc.addSupplementalOpinion(other, {
      report_id: "rpt-o-ffr", parent_report_id: "rpt-o",
      reader_id: "a1", reader_role: ROLE.CT_FFR_ANALYST,
      image_ids: ["img-o"], ctffr: { lad: 0.72 },
    }),
    (e) => e.code === "PATHWAY_MISMATCH"
  );

  // FFR 链：分析员可补充
  svc.addSupplementalOpinion(cid, {
    report_id: "rpt-ffr", parent_report_id: "rpt-base",
    reader_id: "analyst-1", reader_role: ROLE.CT_FFR_ANALYST,
    image_ids: ["img-1"], ctffr: { lad_ffr: 0.78, ischemia_indeterminate: true },
    impression: "FFR 处于灰区", recommendation: "结合运动试验",
    interpreted_at: "2026-09-22T11:00:00+08:00",
  });

  const state = foldCase(store, cid);
  const ffr = [...state.reports.get("rpt-ffr").versions].pop();
  assert.equal(ffr.ctffr.lad_ffr, 0.78);

  // 补充意见本身不构成签署：无临床决定仍不能转诊
  assert.throws(
    () => svc.createReferral(cid, {
      referral_id: "ref-x", receiving_org_id: PCI_CENTER,
      purpose: PURPOSE.SPECIALIST_CONSULT, urgency: URGENCY.ROUTINE,
    }),
    (e) => e.code === "NO_SIGNED_DECISION"
  );
});

test("专家更正：追加版本、保留原意见，当前判读为最新版本", () => {
  const { svc, store } = makeService();
  const cid = "case-correct";
  seedCase(svc, cid);
  svc.uploadImages(cid, {
    upload_id: "up-1", images: [{ image_id: "img-1", checksum: "sha256:a" }],
    uploaded_at: "2026-09-22T08:30:00+08:00",
  });
  svc.recordInterpretation(cid, {
    report_id: "rpt-1", reader_id: "dr-reader", reader_role: ROLE.CENTER_READER,
    image_ids: ["img-1"], impression: "狭窄 30%",
    interpreted_at: "2026-09-22T09:00:00+08:00",
  });
  svc.correctInterpretation(cid, {
    target_report_id: "rpt-1", reader_id: "dr-reader", reader_role: ROLE.CENTER_READER,
    impression: "狭窄 60%（初判漏看偏心斑块）", reason: "复核发现偏心斑块",
    corrected_at: "2026-09-22T12:30:00+08:00",
  });

  const rpt = foldCase(store, cid).reports.get("rpt-1");
  assert.equal(rpt.versions.length, 2, "原意见保留，更正作为新版本");
  assert.equal(rpt.versions[1].supersedesEventId, rpt.versions[0].eventId);
  assert.equal(rpt.versions[1].impression, "狭窄 60%（初判漏看偏心斑块）");

  const timeline = referralTimeline(store, cid);
  const kinds = timeline.map((t) => t.kind);
  assert.ok(kinds.indexOf(KIND.INTERPRETATION_RECORDED) < kinds.indexOf(KIND.INTERPRETATION_CORRECTED));
});

test("重复上传：相同校验和去重，不产生新影像索引", () => {
  const { svc, store } = makeService();
  const cid = "case-dup";
  seedCase(svc, cid);
  const first = svc.uploadImages(cid, {
    upload_id: "up-1", images: [{ image_id: "img-1", checksum: "sha256:a" }],
    uploaded_at: "2026-09-22T08:30:00+08:00",
  });
  assert.equal(first.accepted.length, 1);

  // 网络重试：同 upload_id 再发一次——幂等
  const retry = svc.uploadImages(cid, {
    upload_id: "up-1", images: [{ image_id: "img-1", checksum: "sha256:a" }],
    uploaded_at: "2026-09-22T08:30:00+08:00",
  });
  assert.equal(retry.indexed, null);
  assert.ok(retry.deduplicated);

  // 另一批次带了相同内容（image_id 不同但 checksum 相同）
  svc.uploadImages(cid, {
    upload_id: "up-2", images: [{ image_id: "img-copy", checksum: "sha256:a" }],
    uploaded_at: "2026-09-22T09:00:00+08:00",
  });
  const c = foldCase(store, cid);
  assert.equal(c.images.size, 1);
  assert.equal(c.duplicateUploads.length, 2);
  assert.equal(c.images.get("img-1").uploads.length, 1, "重复影像不重复挂接");
});

test("断网补传：现场先采的影像恢复网络后入库，临床顺序仍先于判读", () => {
  const { svc, store } = makeService();
  const cid = "case-offline2";
  seedCase(svc, cid);
  // 基层 08:25 现场采集，12:00 落库时钟下网络恢复补传；判读在之后
  const r = svc.uploadImages(cid, {
    upload_id: "up-bf", connectivity: "BACKFILL",
    uploaded_at: "2026-09-22T08:25:00+08:00", // 现场实际发生时间
    images: [{ image_id: "img-bf", checksum: "sha256:bf" }],
  });
  assert.equal(r.indexed.backfill, true);
  svc.recordInterpretation(cid, {
    report_id: "rpt-bf", reader_id: "dr-reader", reader_role: ROLE.CENTER_READER,
    image_ids: ["img-bf"], impression: "补传影像可读，无显著狭窄",
    interpreted_at: "2026-09-22T12:00:00+08:00",
  });

  const timeline = referralTimeline(store, cid);
  assert.ok(
    timeline.findIndex((t) => t.kind === KIND.IMAGES_INDEXED) <
    timeline.findIndex((t) => t.kind === KIND.INTERPRETATION_RECORDED),
    "临床顺序中影像先于判读"
  );
  const imgEntry = timeline.find((t) => t.kind === KIND.IMAGES_INDEXED);
  assert.equal(imgEntry.backfill, true);
  assert.equal(imgEntry.arrivedLater, true, "时间线标明该事件晚到（补传）");
});

test("危急信号：仅该患者置顶升级，机构队列其余患者不被冻结", () => {
  const { svc, store } = makeService();
  seedCase(svc, "case-a", { origin: TOWNSHIP });
  seedCase(svc, "case-b", { origin: TOWNSHIP });
  seedCase(svc, "case-other-org", { origin: "org-another-township" });

  svc.uploadImages("case-a", {
    upload_id: "ua", images: [{ image_id: "ia", checksum: "sha256:a" }],
    uploaded_at: "2026-09-22T08:30:00+08:00",
  });
  svc.raiseCriticalSignal("case-a", {
    reason: "STEMI 征象（心电图ST段抬高）", by: "dr-reader",
    escalate_to: [PCI_CENTER], at: "2026-09-22T08:31:00+08:00",
  });
  // case-b 处于待判读，是同机构队列中的普通患者
  svc.uploadImages("case-b", {
    upload_id: "ub", images: [{ image_id: "ib", checksum: "sha256:b" }],
    uploaded_at: "2026-09-22T08:40:00+08:00",
  });

  const q = institutionQueue(store, TOWNSHIP);
  assert.equal(q.total, 2, "队列只含本机构两例");
  assert.equal(q.criticalCount, 1);
  assert.equal(q.items[0].caseId, "case-a", "危急患者置顶");
  assert.ok(q.items[0].critical);
  const b = q.items.find((i) => i.caseId === "case-b");
  assert.equal(b.stage, "ACQUIRED");
  assert.equal(b.critical, null, "其他患者不被标记");

  // 关键：其他患者的工作流照常推进，队列没有被冻结
  svc.recordInterpretation("case-b", {
    report_id: "rpt-b", reader_id: "dr-reader", reader_role: ROLE.CENTER_READER,
    image_ids: ["ib"], impression: "低危，随访", interpreted_at: "2026-09-22T09:00:00+08:00",
  });
  assert.equal(foldCase(store, "case-b").reports.size, 1);

  // 处置落定后危急闭环
  svc.signClinicalDecision("case-a", {
    decision_id: "dec-a", clinician_id: "dr-basic", role: ROLE.PRIMARY_CLINICIAN,
    decision: "急诊转运",
    clinical_basis: "床旁心电图 ST 段抬高，按 STEMI 流程处理",
    at: "2026-09-22T08:35:00+08:00",
  });
  svc.grantConsent("case-a", {
    consent_id: "con-a", purpose: PURPOSE.EMERGENCY_CARE, receiving_org_id: PCI_CENTER,
    granted_at: "2026-09-22T08:36:00+08:00",
  });
  svc.createReferral("case-a", {
    referral_id: "ref-a", receiving_org_id: PCI_CENTER, purpose: PURPOSE.EMERGENCY_CARE,
    urgency: URGENCY.EMERGENCY, at: "2026-09-22T08:37:00+08:00",
  });
});

test("急症窗口：可凭纯临床依据先行签署转诊，资料后补，不耽误转诊窗口", () => {
  const { svc, store } = makeService();
  const cid = "case-emergency";
  seedCase(svc, cid); // 仅有申请，影像/判读未达

  assert.throws(
    () => svc.signClinicalDecision(cid, {
      decision_id: "dec-x", clinician_id: "dr-basic", role: ROLE.PRIMARY_CLINICIAN,
      decision: "立即转运",
    }),
    (e) => e.code === "NO_REPORT_TO_SIGN",
    "无判读且无临床说明时不能空签"
  );

  svc.signClinicalDecision(cid, {
    decision_id: "dec-1", clinician_id: "dr-basic", role: ROLE.PRIMARY_CLINICIAN,
    decision: "按 STEMI 立即急诊转运，影像后补",
    clinical_basis: "床旁心电图 ST 段抬高 + 持续胸痛 40 分钟",
    at: "2026-09-22T08:35:00+08:00",
  });
  svc.grantConsent(cid, {
    consent_id: "con-1", purpose: PURPOSE.EMERGENCY_CARE, receiving_org_id: PCI_CENTER,
    granted_at: "2026-09-22T08:36:00+08:00",
  });
  svc.createReferral(cid, {
    referral_id: "ref-1", receiving_org_id: PCI_CENTER, purpose: PURPOSE.EMERGENCY_CARE,
    urgency: URGENCY.EMERGENCY, rationale: "STEMI 时间窗", at: "2026-09-22T08:37:00+08:00",
  });

  const state0 = foldCase(store, cid);
  const referral = state0.referrals.get("ref-1");
  assert.deepEqual(referral.pendingSections.sort(), ["current_report", "images", "risk"].sort());

  // 先发已有的最小资料：申请 + 签署决定
  const firstShare = svc.shareReferralPacket(cid, {
    referral_id: "ref-1", share_id: "sh-0", at: "2026-09-22T08:38:00+08:00",
  });
  assert.deepEqual(
    [...new Set(firstShare.payload.sections.map((s) => s.section))].sort(),
    ["request", "signed_decision"]
  );

  // 补充资料到达后增量披露
  svc.uploadImages(cid, {
    upload_id: "up-1", connectivity: "BACKFILL", uploaded_at: "2026-09-22T08:20:00+08:00",
    images: [{ image_id: "img-1", checksum: "sha256:a" }],
  });
  const secondShare = svc.shareReferralPacket(cid, {
    referral_id: "ref-1", share_id: "sh-1", at: "2026-09-22T08:45:00+08:00",
  });
  assert.equal(secondShare.payload.supplement, true);
  assert.deepEqual(
    [...new Set(secondShare.payload.sections.map((s) => s.section))],
    ["images"]
  );
});

test("授权撤回：进入诊疗前停止共享；进入病历后仅留痕", () => {
  const { svc, store } = makeService();

  // 场景 1：交接前撤回 → 停止共享，再披露被拒
  const cid = "case-withdraw-early";
  seedCase(svc, cid);
  svc.uploadImages(cid, {
    upload_id: "up-1", images: [{ image_id: "img-1", checksum: "sha256:a" }],
    uploaded_at: "2026-09-22T08:30:00+08:00",
  });
  svc.recordInterpretation(cid, {
    report_id: "rpt-1", reader_id: "dr-reader", reader_role: ROLE.CENTER_READER,
    image_ids: ["img-1"], impression: "ok", interpreted_at: "2026-09-22T09:00:00+08:00",
  });
  svc.signClinicalDecision(cid, {
    decision_id: "dec-1", clinician_id: "dr-basic", role: ROLE.PRIMARY_CLINICIAN,
    decision: "会诊", at: "2026-09-22T10:00:00+08:00",
  });
  svc.grantConsent(cid, {
    consent_id: "con-1", purpose: PURPOSE.SPECIALIST_CONSULT, receiving_org_id: PCI_CENTER,
    granted_at: "2026-09-22T10:05:00+08:00",
  });
  svc.createReferral(cid, {
    referral_id: "ref-1", receiving_org_id: PCI_CENTER, purpose: PURPOSE.SPECIALIST_CONSULT,
    urgency: URGENCY.ROUTINE, at: "2026-09-22T10:10:00+08:00",
  });
  svc.shareReferralPacket(cid, {
    referral_id: "ref-1", share_id: "sh-1", at: "2026-09-22T10:12:00+08:00",
  });
  const w = svc.withdrawConsent(cid, {
    consent_id: "con-1", at: "2026-09-22T10:30:00+08:00",
  });
  assert.equal(w.enteredCare, false);
  assert.equal(w.events.length, 2, "撤回 + 停止共享各一事件");

  assert.throws(
    () => svc.shareReferralPacket(cid, { referral_id: "ref-1", share_id: "sh-2" }),
    (e) => e.code === "CONSENT_WITHDRAWN"
  );
  const ledger = disclosureLedger(store, cid)[0];
  assert.equal(ledger.trace, "授权撤回，共享已停止");
  assert.ok(ledger.revokedAt);

  // 场景 2：已交接进入病历后撤回 → 只留痕，不产生 SHARING_REVOKED
  const cid2 = "case-withdraw-late";
  seedCase(svc, cid2);
  svc.uploadImages(cid2, {
    upload_id: "up-1", images: [{ image_id: "img-1", checksum: "sha256:q" }],
    uploaded_at: "2026-09-22T08:30:00+08:00",
  });
  svc.recordInterpretation(cid2, {
    report_id: "rpt-1", reader_id: "dr-reader", reader_role: ROLE.CENTER_READER,
    image_ids: ["img-1"], impression: "ok", interpreted_at: "2026-09-22T09:00:00+08:00",
  });
  svc.signClinicalDecision(cid2, {
    decision_id: "dec-1", clinician_id: "dr-basic", role: ROLE.PRIMARY_CLINICIAN,
    decision: "会诊", at: "2026-09-22T10:00:00+08:00",
  });
  svc.grantConsent(cid2, {
    consent_id: "con-1", purpose: PURPOSE.SPECIALIST_CONSULT, receiving_org_id: PCI_CENTER,
    granted_at: "2026-09-22T10:05:00+08:00",
  });
  svc.createReferral(cid2, {
    referral_id: "ref-1", receiving_org_id: PCI_CENTER, purpose: PURPOSE.SPECIALIST_CONSULT,
    urgency: URGENCY.ROUTINE, at: "2026-09-22T10:10:00+08:00",
  });
  svc.shareReferralPacket(cid2, {
    referral_id: "ref-1", share_id: "sh-1", at: "2026-09-22T10:12:00+08:00",
  });
  svc.acknowledgeReferral(cid2, {
    referral_id: "ref-1", actor_org_id: PCI_CENTER, by: "dr-pci", decision: "ACCEPTED",
    appointment: { scheduled_at: "2026-09-23T09:00:00+08:00" },
    contact: { name: "李护士", channel: "工位8" },
    at: "2026-09-22T11:00:00+08:00",
  });
  svc.handover(cid2, {
    referral_id: "ref-1", actor_org_id: PCI_CENTER, receiving_clinician_id: "dr-pci",
    at: "2026-09-23T09:05:00+08:00",
  });
  const w2 = svc.withdrawConsent(cid2, {
    consent_id: "con-1", at: "2026-09-23T10:00:00+08:00",
  });
  assert.equal(w2.enteredCare, true);
  assert.equal(w2.events.length, 1, "仅撤回留痕，不撤销已入病历的共享");
  assert.equal(disclosureLedger(store, cid2)[0].trace, "已进入病历，撤回仅留痕");

  // 患者视图如实展示两种撤回状态
  assert.equal(patientView(store, cid).consents[0].inMedicalRecord, false);
  assert.equal(patientView(store, cid2).consents[0].inMedicalRecord, true);
});

test("最小披露：授权超范围被拒；术前规划只含测量等必要段落", () => {
  const { svc, store } = makeService();
  const cid = "case-preop";
  seedCase(svc, cid, { pathway: PATHWAY.PREOP_MEASUREMENT });
  svc.uploadImages(cid, {
    upload_id: "up-1", images: [{ image_id: "img-1", checksum: "sha256:a" }],
    uploaded_at: "2026-09-22T08:30:00+08:00",
  });
  svc.recordInterpretation(cid, {
    report_id: "rpt-1", reader_id: "dr-img", reader_role: ROLE.CARDIAC_IMAGING_SPECIALIST,
    image_ids: ["img-1"], impression: "瓣环测量完成",
    measurements: { annulus_mm: 23.4, lvot_mm: 20.1 },
    interpreted_at: "2026-09-22T09:00:00+08:00",
  });

  // 补充分析目的只需 申请+影像；患者若被要求授权更多段落 → 拒绝
  assert.throws(
    () => svc.grantConsent(cid, {
      consent_id: "con-bad", purpose: PURPOSE.SUPPLEMENTAL_ANALYSIS,
      sections: ["request", "images", "current_report", "signed_decision"],
    }),
    (e) => e.code === "CONSENT_SCOPE_EXCESSIVE"
  );

  svc.signClinicalDecision(cid, {
    decision_id: "dec-1", clinician_id: "dr-basic", role: ROLE.PRIMARY_CLINICIAN,
    decision: "术前规划转诊", at: "2026-09-22T09:30:00+08:00",
  });
  svc.grantConsent(cid, {
    consent_id: "con-1", purpose: PURPOSE.PREOP_PLANNING, receiving_org_id: PCI_CENTER,
    granted_at: "2026-09-22T09:35:00+08:00",
  });
  svc.createReferral(cid, {
    referral_id: "ref-1", receiving_org_id: PCI_CENTER, purpose: PURPOSE.PREOP_PLANNING,
    urgency: URGENCY.ROUTINE, at: "2026-09-22T09:40:00+08:00",
  });
  const share = svc.shareReferralPacket(cid, {
    referral_id: "ref-1", share_id: "sh-1", at: "2026-09-22T09:42:00+08:00",
  });
  // 术前规划：申请+影像+当前报告+测量；不含签署决定、风险
  assert.deepEqual(
    [...new Set(share.payload.sections.map((s) => s.section))].sort(),
    ["current_report", "images", "measurements", "request"]
  );
});

test("预约状态以接收机构为准：拒收清除预约，改约由接收方更新，基层不能代发", () => {
  const { svc, store } = makeService();
  const cid = "case-appt";
  seedCase(svc, cid);
  svc.uploadImages(cid, {
    upload_id: "up-1", images: [{ image_id: "img-1", checksum: "sha256:a" }],
    uploaded_at: "2026-09-22T08:30:00+08:00",
  });
  svc.recordInterpretation(cid, {
    report_id: "rpt-1", reader_id: "dr-reader", reader_role: ROLE.CENTER_READER,
    image_ids: ["img-1"], impression: "ok", interpreted_at: "2026-09-22T09:00:00+08:00",
  });
  svc.signClinicalDecision(cid, {
    decision_id: "dec-1", clinician_id: "dr-basic", role: ROLE.PRIMARY_CLINICIAN,
    decision: "会诊", at: "2026-09-22T10:00:00+08:00",
  });
  svc.grantConsent(cid, {
    consent_id: "con-1", purpose: PURPOSE.SPECIALIST_CONSULT, receiving_org_id: PCI_CENTER,
    granted_at: "2026-09-22T10:05:00+08:00",
  });
  svc.createReferral(cid, {
    referral_id: "ref-1", receiving_org_id: PCI_CENTER, purpose: PURPOSE.SPECIALIST_CONSULT,
    urgency: URGENCY.ROUTINE, at: "2026-09-22T10:10:00+08:00",
  });
  svc.shareReferralPacket(cid, {
    referral_id: "ref-1", share_id: "sh-1", at: "2026-09-22T10:12:00+08:00",
  });

  // 基层机构不能冒充接收方确认
  assert.throws(
    () => svc.acknowledgeReferral(cid, {
      referral_id: "ref-1", actor_org_id: TOWNSHIP, by: "dr-basic", decision: "ACCEPTED",
      appointment: { scheduled_at: "2026-09-23T09:00:00+08:00" },
      contact: { name: "x", channel: "y" },
    }),
    (e) => e.code === "NOT_RECEIVING_ORG"
  );

  svc.acknowledgeReferral(cid, {
    referral_id: "ref-1", actor_org_id: PCI_CENTER, by: "dr-pci", decision: "ACCEPTED",
    appointment: { scheduled_at: "2026-09-23T09:00:00+08:00", location: "门诊302" },
    contact: { name: "王护士", channel: "工位12" },
    at: "2026-09-22T11:00:00+08:00",
  });
  let pv = patientView(store, cid).referrals[0];
  assert.equal(pv.appointment.scheduled_at, "2026-09-23T09:00:00+08:00");

  // 接收方改约
  svc.acknowledgeReferral(cid, {
    referral_id: "ref-1", actor_org_id: PCI_CENTER, by: "scheduler-2", decision: "ACCEPTED",
    update: true,
    appointment: { scheduled_at: "2026-09-25T14:00:00+08:00", location: "门诊305", status: "RESCHEDULED" },
    contact: { name: "赵护士", channel: "工位15" },
    at: "2026-09-22T15:00:00+08:00",
  });
  pv = patientView(store, cid).referrals[0];
  assert.equal(pv.appointment.scheduled_at, "2026-09-25T14:00:00+08:00");
  assert.equal(pv.appointment.status, "RESCHEDULED");
  assert.equal(pv.contact.name, "赵护士");

  // 接收方拒收 → 患者看到的预约必须清空并显示原因
  svc.acknowledgeReferral(cid, {
    referral_id: "ref-1", actor_org_id: PCI_CENTER, by: "dr-pci", decision: "REJECTED",
    reason: "本院胸痛门诊停诊，建议改约市一院",
    at: "2026-09-22T16:00:00+08:00",
  });
  pv = patientView(store, cid).referrals[0];
  assert.equal(pv.status, "REJECTED");
  assert.equal(pv.appointment, null);
  assert.equal(pv.contact, null);
  assert.match(pv.rejectedReason, /停诊/);
});

test("回执只确认实际收到的资料段落", () => {
  const { svc, store } = makeService();
  const cid = "case-receipt";
  seedCase(svc, cid);
  svc.uploadImages(cid, {
    upload_id: "up-1", images: [{ image_id: "img-1", checksum: "sha256:a" }],
    uploaded_at: "2026-09-22T08:30:00+08:00",
  });
  svc.recordInterpretation(cid, {
    report_id: "rpt-1", reader_id: "dr-reader", reader_role: ROLE.CENTER_READER,
    image_ids: ["img-1"], impression: "ok", interpreted_at: "2026-09-22T09:00:00+08:00",
  });
  svc.signClinicalDecision(cid, {
    decision_id: "dec-1", clinician_id: "dr-basic", role: ROLE.PRIMARY_CLINICIAN,
    decision: "会诊", at: "2026-09-22T10:00:00+08:00",
  });
  svc.grantConsent(cid, {
    consent_id: "con-1", purpose: PURPOSE.SPECIALIST_CONSULT, receiving_org_id: PCI_CENTER,
    granted_at: "2026-09-22T10:05:00+08:00",
  });
  svc.createReferral(cid, {
    referral_id: "ref-1", receiving_org_id: PCI_CENTER, purpose: PURPOSE.SPECIALIST_CONSULT,
    urgency: URGENCY.ROUTINE, at: "2026-09-22T10:10:00+08:00",
  });
  svc.shareReferralPacket(cid, {
    referral_id: "ref-1", share_id: "sh-1", at: "2026-09-22T10:12:00+08:00",
  });
  // 回执声称收到一个从未披露的段落 → 被过滤
  const rcpt = svc.issueReceipt(cid, {
    referral_id: "ref-1", actor_org_id: PCI_CENTER, by: "dr-pci",
    confirmed_sections: ["request:nonexistent", "request:x"],
    at: "2026-09-22T10:20:00+08:00",
  });
  assert.deepEqual(rcpt.payload.confirmed_sections, []);

  // 不带清单时确认全部已披露段落
  const rcpt2 = svc.issueReceipt(cid, {
    referral_id: "ref-1", receipt_id: "rcpt-auto",
    actor_org_id: PCI_CENTER, by: "dr-pci", at: "2026-09-22T10:21:00+08:00",
  });
  assert.ok(rcpt2.payload.confirmed_sections.length >= 4);
});

test("心电模态与设备协议版本同样全程留痕", () => {
  const { svc, store } = makeService();
  const cid = "case-ecg";
  svc.requestExamination(cid, {
    patient_id: "P-9", origin_org_id: TOWNSHIP, modality: MODALITY.ECG,
    pathway: PATHWAY.ASYMPTOMATIC_HIGH_RISK, reason: "心悸", clinician_id: "dr-basic",
    requested_at: "2026-09-22T08:00:00+08:00",
  });
  svc.prepareAcquisition(cid, {
    device: { device_id: "dev-ecg-7", modality: MODALITY.ECG, model: "ECG-12" },
    protocol: { name: "rest-12lead", version: "v1.4" },
    technologist_id: "tech-9", prepared_at: "2026-09-22T08:05:00+08:00",
  });
  // 模态不匹配的设备登记被拒
  assert.throws(
    () => svc.prepareAcquisition(cid, {
      device: { device_id: "dev-ct-x", modality: MODALITY.CARDIAC_CT },
      protocol, technologist_id: "tech-9",
    }),
    (e) => e.code === "MODALITY_MISMATCH"
  );
  svc.uploadImages(cid, {
    upload_id: "up-1", images: [{ image_id: "ecg-1", checksum: "sha256:e" }],
    uploaded_at: "2026-09-22T08:10:00+08:00",
  });
  const c = foldCase(store, cid);
  assert.equal(c.acquisition.device.device_id, "dev-ecg-7");
  assert.equal(c.acquisition.protocol.version, "v1.4");
  const img = c.images.get("ecg-1");
  assert.ok(img.firstIndexEventId);
  assert.equal(img.backfill, false);
});
