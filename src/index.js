// 影像联动与转诊服务的公共入口。
export { ImagingService } from "./imaging-service.js";
export { EventStore } from "./event-store.js";
export { ReceiverDirectory } from "./receiver-directory.js";
export { validate as validateEnvelope, buildEnvelope } from "./envelope.js";
export { validate as validateBaselineEnvelope } from "./contract.js";
export {
  KIND, PURPOSE, MODALITY, RISK, CONSENT, REFERRAL_STATUS, ROLE, CHAIN_LABEL,
} from "./vocabulary.js";
export { CHAIN_POLICY, policyFor, assertCanSign } from "./chains.js";
export { CATEGORY, buildDisclosurePack } from "./disclosure.js";
export { foldExam, foldReferral } from "./projections.js";
export { orgWorklist, patientAppointmentView, referralSummary } from "./read-models.js";
export { DomainError, ERR } from "./errors.js";
