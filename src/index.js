// 影像联动与转诊服务统一入口。
export { EventStore, compareClinical } from "./store.js";
export { ReferralService, DomainError } from "./service.js";
export {
  foldCase,
  institutionQueue,
  patientView,
  referralTimeline,
  disclosureLedger,
  activeReportVersion,
  activeReportEvents,
} from "./projections.js";
export {
  KIND, MODALITY, PATHWAY, PATHWAY_CHAIN, ROLE, RISK_LEVEL, URGENCY,
  PURPOSE, PURPOSE_SECTIONS, CONNECTIVITY,
} from "./kinds.js";
export { validate, validateEnvelope } from "./envelope.js";
