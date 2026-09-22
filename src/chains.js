import { DomainError, ERR } from "./errors.js";
import { MODALITY, PURPOSE, ROLE } from "./vocabulary.js";

// 四条责任链的策略表：谁能申请哪种检查、谁能判读、谁有资格临床签署。
// 共同底线（所有链一致）：影像/分析意见只是建议，转诊与处置必须有具备资质的
// 临床医生签署；影像专家、CT-FFR 分析者的角色永远不出现在 signOffRoles 中。
export const CHAIN_POLICY = Object.freeze({
  [PURPOSE.LOW_RISK_SCREENING]: Object.freeze({
    purpose: PURPOSE.LOW_RISK_SCREENING,
    label: "低危筛查",
    modalities: Object.freeze([MODALITY.ECG, MODALITY.CARDIAC_CT]),
    interpreterRoles: Object.freeze([ROLE.IMAGING_EXPERT]),
    // 低危结论（含"建议随访/无需转诊"）由基层申请医生签署负责。
    signOffRoles: Object.freeze([ROLE.REFERRING_CLINICIAN]),
    adjunct: false, // 结论可独立成立
    requiresBaseRead: false,
  }),

  [PURPOSE.ASYMPTOMATIC_HIGH_RISK]: Object.freeze({
    purpose: PURPOSE.ASYMPTOMATIC_HIGH_RISK,
    label: "无症状高危识别",
    modalities: Object.freeze([MODALITY.ECG, MODALITY.CARDIAC_CT, MODALITY.CORONARY_ANGIOGRAPHY]),
    interpreterRoles: Object.freeze([ROLE.IMAGING_EXPERT]),
    // 高危识别由基层医生发起签署并承担转诊责任，接收医生在受理环节共同负责。
    signOffRoles: Object.freeze([ROLE.REFERRING_CLINICIAN, ROLE.RECEIVING_CLINICIAN]),
    adjunct: false,
    requiresBaseRead: false,
  }),

  [PURPOSE.PREOPERATIVE_MEASUREMENT]: Object.freeze({
    purpose: PURPOSE.PREOPERATIVE_MEASUREMENT,
    label: "术前测量",
    modalities: Object.freeze([MODALITY.CARDIAC_CT, MODALITY.CORONARY_ANGIOGRAPHY]),
    interpreterRoles: Object.freeze([ROLE.IMAGING_EXPERT]),
    // 测量服务于手术决策，由接收方（实施手术的机构）临床医生签署。
    signOffRoles: Object.freeze([ROLE.RECEIVING_CLINICIAN]),
    adjunct: false,
    requiresBaseRead: false,
  }),

  [PURPOSE.CT_FFR_ADJUNCT]: Object.freeze({
    purpose: PURPOSE.CT_FFR_ADJUNCT,
    label: "CT-FFR补充判断",
    modalities: Object.freeze([MODALITY.CARDIAC_CT]),
    interpreterRoles: Object.freeze([ROLE.IMAGING_EXPERT, ROLE.CT_FFR_ANALYST]),
    signOffRoles: Object.freeze([ROLE.RECEIVING_CLINICIAN]),
    // 补充判断：必须挂靠在同一次 CT 的解剖学判读上，不能单独作为转诊依据。
    adjunct: true,
    requiresBaseRead: true,
  }),
});

export function policyFor(purpose) {
  const policy = CHAIN_POLICY[purpose];
  if (!policy) throw new DomainError(ERR.BAD_INPUT, `未知责任链: ${purpose}`);
  return policy;
}

export function assertModalityAllowed(purpose, modality) {
  const policy = policyFor(purpose);
  if (!policy.modalities.includes(modality)) {
    throw new DomainError(
      ERR.CHAIN_MISMATCH,
      `${policy.label}责任链不接受 ${modality} 检查`,
      { purpose, modality, allowed: [...policy.modalities] },
    );
  }
}

export function assertInterpreterRole(purpose, role) {
  const policy = policyFor(purpose);
  if (!policy.interpreterRoles.includes(role)) {
    throw new DomainError(
      ERR.CHAIN_MISMATCH,
      `${role} 不能在「${policy.label}」责任链出具判读`,
      { purpose, role, allowed: [...policy.interpreterRoles] },
    );
  }
}

// 签署闸门：只有临床医生能签，且必须是该责任链认可的临床医生。
// 影像建议（无论专家意见还是 CT-FFR 数值）都不能越过这道闸。
export function assertCanSign(purpose, actor) {
  const policy = policyFor(purpose);
  if (!policy.signOffRoles.includes(actor.role)) {
    throw new DomainError(
      ERR.SIGNER_ROLE,
      `「${policy.label}」的临床签署只能由 ${policy.signOffRoles.join("/")} 完成，${actor.role} 的意见不能替代医生签署`,
      { purpose, actorRole: actor.role, acceptable: [...policy.signOffRoles] },
    );
  }
}
