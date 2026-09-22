// 事件类型与责任链定义。
// 事件信封沿用基线契约：event_id / kind / occurred_at / subject_id / version。

export const KIND = Object.freeze({
  EXAMINATION_REQUESTED: "EXAMINATION_REQUESTED", // 检查申请
  ACQUISITION_PREPARED: "ACQUISITION_PREPARED", // 设备与协议版本登记
  IMAGES_INDEXED: "IMAGES_INDEXED", // 影像首次入库索引
  IMAGE_UPLOAD_DEDUPLICATED: "IMAGE_UPLOAD_DEDUPLICATED", // 重复上传被识别
  INTERPRETATION_RECORDED: "INTERPRETATION_RECORDED", // 结构化判读
  SUPPLEMENTAL_OPINION_ADDED: "SUPPLEMENTAL_OPINION_ADDED", // 补充意见（含 CT-FFR）
  INTERPRETATION_CORRECTED: "INTERPRETATION_CORRECTED", // 专家更正
  RISK_STRATIFIED: "RISK_STRATIFIED", // 风险分层
  CRITICAL_SIGNAL_RAISED: "CRITICAL_SIGNAL_RAISED", // 危急信号（仅升级该患者）
  CLINICAL_DECISION_SIGNED: "CLINICAL_DECISION_SIGNED", // 临床医生签署
  CONSENT_GRANTED: "CONSENT_GRANTED", // 患者授权
  CONSENT_WITHDRAWN: "CONSENT_WITHDRAWN", // 授权撤回
  SHARING_REVOKED: "SHARING_REVOKED", // 尚未用于诊疗的共享被停止
  REFERRAL_CREATED: "REFERRAL_CREATED", // 转诊创建（含最小披露范围）
  REFERRAL_PACKET_SHARED: "REFERRAL_PACKET_SHARED", // 资料实际披露
  RECEIPT_ISSUED: "RECEIPT_ISSUED", // 回执
  RECEIVING_ACK_ACCEPTED: "RECEIVING_ACK_ACCEPTED", // 接收机构确认并预约
  RECEIVING_ACK_REJECTED: "RECEIVING_ACK_REJECTED", // 接收机构拒收
  REFERRAL_HANDED_OVER: "REFERRAL_HANDED_OVER", // 交接完成（资料进入诊疗）
  FINAL_DISPOSITION_RECORDED: "FINAL_DISPOSITION_RECORDED", // 最终处置
});

export const MODALITY = Object.freeze({
  ECG: "ECG", // 心电
  CARDIAC_CT: "CARDIAC_CT", // 心脏 CT
  CORONARY_ANGIOGRAPHY: "CORONARY_ANGIOGRAPHY", // 冠脉造影
});

// 四条业务场景保持各自独立的责任链。
export const PATHWAY = Object.freeze({
  LOW_RISK_SCREENING: "LOW_RISK_SCREENING", // 低危筛查
  ASYMPTOMATIC_HIGH_RISK: "ASYMPTOMATIC_HIGH_RISK", // 无症状高危识别
  PREOP_MEASUREMENT: "PREOP_MEASUREMENT", // 术前测量
  CT_FFR_SUPPLEMENT: "CT_FFR_SUPPLEMENT", // CT-FFR 补充判断
});

export const ROLE = Object.freeze({
  PRIMARY_CLINICIAN: "PRIMARY_CLINICIAN", // 基层临床医生
  IMAGING_TECHNOLOGIST: "IMAGING_TECHNOLOGIST", // 影像技师
  CENTER_READER: "CENTER_READER", // 中心判读医师
  CARDIOLOGY_SPECIALIST: "CARDIOLOGY_SPECIALIST", // 心血管专科专家
  CARDIAC_IMAGING_SPECIALIST: "CARDIAC_IMAGING_SPECIALIST", // 心脏影像专家
  CT_FFR_ANALYST: "CT_FFR_ANALYST", // CT-FFR 分析（技师/软件复核）
  RECEIVING_CLINICIAN: "RECEIVING_CLINICIAN", // 接收机构临床医生
});

// 每个场景：谁可以初判、谁可以补充、谁有权签署、签署前还缺什么。
// 判读角色与签署角色刻意分开——任何影像建议都不能替代临床医生签署。
export const PATHWAY_CHAIN = Object.freeze({
  [PATHWAY.LOW_RISK_SCREENING]: {
    label: "低危筛查",
    readers: [ROLE.CENTER_READER],
    supplementalReaders: [],
    signers: [ROLE.PRIMARY_CLINICIAN],
    requiresRiskStratification: false,
  },
  [PATHWAY.ASYMPTOMATIC_HIGH_RISK]: {
    label: "无症状高危识别",
    readers: [ROLE.CARDIOLOGY_SPECIALIST],
    supplementalReaders: [ROLE.CENTER_READER],
    signers: [ROLE.PRIMARY_CLINICIAN],
    requiresRiskStratification: true,
  },
  [PATHWAY.PREOP_MEASUREMENT]: {
    label: "术前测量",
    readers: [ROLE.CARDIAC_IMAGING_SPECIALIST],
    supplementalReaders: [ROLE.CENTER_READER],
    signers: [ROLE.PRIMARY_CLINICIAN, ROLE.RECEIVING_CLINICIAN],
    requiresRiskStratification: false,
  },
  [PATHWAY.CT_FFR_SUPPLEMENT]: {
    label: "CT-FFR 补充判断",
    readers: [ROLE.CARDIAC_IMAGING_SPECIALIST],
    supplementalReaders: [ROLE.CT_FFR_ANALYST, ROLE.CENTER_READER],
    signers: [ROLE.PRIMARY_CLINICIAN],
    requiresRiskStratification: false,
  },
});

export const RISK_LEVEL = Object.freeze({
  LOW: "LOW",
  INTERMEDIATE: "INTERMEDIATE",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL",
});

export const URGENCY = Object.freeze({
  ROUTINE: "ROUTINE",
  URGENT: "URGENT",
  EMERGENCY: "EMERGENCY",
});

// 转诊目的决定可披露资料的允许清单（最小必要原则）。
export const PURPOSE = Object.freeze({
  EMERGENCY_CARE: "EMERGENCY_CARE", // 急症救治
  SPECIALIST_CONSULT: "SPECIALIST_CONSULT", // 专科会诊
  PREOP_PLANNING: "PREOP_PLANNING", // 术前规划
  SUPPLEMENTAL_ANALYSIS: "SUPPLEMENTAL_ANALYSIS", // 补充分析（如 CT-FFR）
});

export const PURPOSE_SECTIONS = Object.freeze({
  [PURPOSE.EMERGENCY_CARE]: [
    "request", "images", "current_report", "risk", "signed_decision",
  ],
  [PURPOSE.SPECIALIST_CONSULT]: [
    "request", "images", "current_report", "signed_decision",
  ],
  [PURPOSE.PREOP_PLANNING]: [
    "request", "images", "current_report", "measurements",
  ],
  [PURPOSE.SUPPLEMENTAL_ANALYSIS]: [
    "request", "images",
  ],
});

export const CONNECTIVITY = Object.freeze({
  ONLINE: "ONLINE",
  BACKFILL: "BACKFILL", // 基层断网恢复后补传
});
