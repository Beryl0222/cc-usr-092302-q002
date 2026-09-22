// 可运行的场景演示：node examples/fuping-scenario.mjs
// 展示一位无症状高危患者从基层 CT 到省医院处置的完整事件链，
// 包含断网补传、专家更正、危急升级不冻结队列、签署闸门与最小披露。
import {
  ImagingService, EventStore, ReceiverDirectory,
  PURPOSE, MODALITY, RISK, ROLE, orgWorklist, patientAppointmentView,
} from "../src/index.js";

const clock = (() => { let t = Date.parse("2026-09-22T08:00:00+08:00"); return () => new Date(t).toISOString(); })();
const service = new ImagingService({ store: new EventStore({ clock }), directory: new ReceiverDirectory(), clock });

const grass = { id: "dr-wang", role: ROLE.REFERRING_CLINICIAN, orgId: "org-fuping-township-12" };
const expert = { id: "expert-li", role: ROLE.IMAGING_EXPERT, orgId: "org-fuping-county" };
const center = { id: "dr-sun", role: ROLE.RECEIVING_CLINICIAN, orgId: "org-provincial-center" };
const patient = { id: "pat-zhang", role: ROLE.PATIENT };

// 同机构另一位普通患者，用来证明危急升级不冻结队列
service.requestExamination({ examId: "ecg-ordinary", patientId: "pat-li", orgId: grass.orgId, modality: MODALITY.ECG, purpose: PURPOSE.LOW_RISK_SCREENING, clinician: grass });

// 主角：基层发起无症状高危 CT
const examId = "cta-zhang-01", referralId = "ref-zhang-01";
service.requestExamination({ examId, patientId: patient.id, orgId: grass.orgId, modality: MODALITY.CARDIAC_CT, purpose: PURPOSE.ASYMPTOMATIC_HIGH_RISK, clinician: grass });
service.recordDeployment({ examId, deviceId: "ct-car-2", deviceName: "基层CT车", protocolId: "cardiac-cta", protocolVersion: "4.1", actor: grass });
service.indexImage({ examId, imageId: "cta-1", storageUri: "pacs://township12/cta-1", checksum: "sha256:aaa", seriesUid: "1.2.840.10.1", acquiredAt: "2026-09-22T07:40:00+08:00", actor: grass });
// 第二序列断网两小时后补传：保留原始时间，打 backfilled
service.indexImage({ examId, imageId: "cta-2", storageUri: "pacs://township12/cta-2", checksum: "sha256:bbb", seriesUid: "1.2.840.10.2", acquiredAt: "2026-09-22T07:42:00+08:00", actor: grass, occurredAt: "2026-09-22T07:42:00+08:00", backfill: true });

service.recordInterpretation({ examId, interpretationId: "read-1", imageIds: ["cta-1", "cta-2"], findings: { LAD: "狭窄约85%" }, recommendation: "建议急诊造影", actor: expert });
// 专家复核后更正：read-1 高估，追加新版本而非覆盖
service.correctInterpretation({ examId, interpretationVersion: 1, interpretationId: "read-2", findings: { LAD: "狭窄约70%" }, recommendation: "建议冠脉造影", actor: expert });
service.stratifyRisk({ examId, riskLevel: RISK.CRITICAL, rationale: "LAD重度狭窄伴缺血症状", actor: grass });
service.acknowledgeEscalation({ examId, actor: grass });
service.signOff({ examId, clinician: grass, scope: "高危识别与造影转诊，基于read-2" });

// 授权 -> 转诊 -> 最小披露 -> 受理 -> 预约 -> 交接 -> 处置
service.grantConsent({ referralId, patientId: patient.id, purpose: PURPOSE.ASYMPTOMATIC_HIGH_RISK, receiverOrgId: center.orgId, categories: ["REQUEST", "PROTOCOL", "IMAGE_INDEX", "LATEST_REPORT", "SUPPLEMENT", "RISK", "CRITICAL", "SIGN_OFF"], examIds: [examId], actor: patient });
service.openReferral({ referralId, examIds: [examId], receiverOrgId: center.orgId, reason: "CT提示LAD重度狭窄", riskLevel: RISK.CRITICAL, actor: grass });
const disclosure = service.makeDisclosure({ referralId, actor: grass });
service.acceptReferral({ referralId, actor: center });
service.directory.register(center.orgId, { name: "省人民医院心内二科", contact: "0913-12345" });
service.directory.addSlot(center.orgId, "slot-0923-10", "2026-09-23T10:00:00+08:00", "0913-12345");
service.offerAppointment({ referralId, slotId: "slot-0923-10", actor: center });
service.confirmAppointment({ referralId, actor: patient });
service.acknowledgeHandoff({ referralId, actor: center });
service.recordDisposition({ referralId, outcome: "造影示LAD 75%，PCI术后稳定", recordLocator: "emr://provincial/enc-7781", actor: center });

const wl = orgWorklist(service.store, grass.orgId);
console.log("机构队列（共%d项，frozen=%s）：%s", wl.total, wl.frozen, wl.items.map((i) => `${i.exam_id}/${i.awaiting}`).join("，"));
console.log("披露类别（最小必要）：%s", disclosure.payload.categories.join("、"));
console.log("患者预约视图：%j", patientAppointmentView(service, service.directory, referralId));
const timeline = service.referralTimeline(referralId);
console.log("转诊时间线（%s，%s）：", timeline.chain_label, timeline.status);
for (const e of timeline.entries) {
  console.log("  v%s%s %s by %s @ %s%s", e.version, e.supersedes_version ? `(取代v${e.supersedes_version})` : "", e.kind, e.actor_id, e.at, e.backfilled ? " [断网补传]" : "");
}
