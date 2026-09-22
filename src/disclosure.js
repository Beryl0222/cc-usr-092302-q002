import { DomainError, ERR } from "./errors.js";
import { PURPOSE, RISK } from "./vocabulary.js";

// 可披露的资料类别。跨院转诊只挑当前目的真正需要的类别——宁少勿多。
export const CATEGORY = Object.freeze({
  REQUEST: "REQUEST", // 检查申请
  PROTOCOL: "PROTOCOL", // 设备与协议版本
  IMAGE_INDEX: "IMAGE_INDEX", // 影像定位索引（不是影像本体）
  LATEST_REPORT: "LATEST_REPORT", // 当前有效判读（被更正的旧版不跨院发送）
  ADJUNCT_REPORT: "ADJUNCT_REPORT", // 附属分析（仅 CT-FFR 链）
  SUPPLEMENT: "SUPPLEMENT", // 针对当前判读的补充意见
  RISK: "RISK",
  CRITICAL: "CRITICAL",
  SIGN_OFF: "SIGN_OFF", // 临床医生签署
});

// 每个责任链"当前目的所需的最少资料"白名单。
const ALLOWED_BY_PURPOSE = Object.freeze({
  // 低危筛查的随访/转诊：只需结论性报告与签署，不需要原始影像定位。
  [PURPOSE.LOW_RISK_SCREENING]: [CATEGORY.REQUEST, CATEGORY.PROTOCOL, CATEGORY.LATEST_REPORT, CATEGORY.RISK, CATEGORY.SIGN_OFF],
  // 高危识别：接收方需要复核影像，给出索引；含危急经过。
  [PURPOSE.ASYMPTOMATIC_HIGH_RISK]: [
    CATEGORY.REQUEST, CATEGORY.PROTOCOL, CATEGORY.IMAGE_INDEX, CATEGORY.LATEST_REPORT,
    CATEGORY.SUPPLEMENT, CATEGORY.RISK, CATEGORY.CRITICAL, CATEGORY.SIGN_OFF,
  ],
  // 术前测量：需要 CT/造影影像定位与测量结论。
  [PURPOSE.PREOPERATIVE_MEASUREMENT]: [
    CATEGORY.REQUEST, CATEGORY.PROTOCOL, CATEGORY.IMAGE_INDEX, CATEGORY.LATEST_REPORT,
    CATEGORY.SUPPLEMENT, CATEGORY.SIGN_OFF,
  ],
  // CT-FFR：解剖学判读 + 附属 FFR 分析成对出现，其余非必要资料不送。
  [PURPOSE.CT_FFR_ADJUNCT]: [
    CATEGORY.REQUEST, CATEGORY.PROTOCOL, CATEGORY.IMAGE_INDEX,
    CATEGORY.LATEST_REPORT, CATEGORY.ADJUNCT_REPORT, CATEGORY.SIGN_OFF,
  ],
});

function activeImages(exam) {
  return [...exam.images.values()].filter((i) => !i.suppressed);
}

// 依据白名单把一次检查折叠结果裁剪成披露条目。返回 { categories, items }。
export function buildExamPackEntry(exam, purpose) {
  const allowed = new Set(ALLOWED_BY_PURPOSE[purpose] ?? []);
  const items = [];
  const categories = [];
  const add = (category, item) => {
    if (!allowed.has(category)) return;
    categories.push(category);
    items.push({ category, exam_id: exam.examId, ...item });
  };

  add(CATEGORY.REQUEST, { modality: exam.modality, requested_at: exam.requestedAt, clinician_id: exam.requestingClinicianId });
  if (exam.deployment) {
    add(CATEGORY.PROTOCOL, {
      device_id: exam.deployment.deviceId,
      protocol_id: exam.deployment.protocolId,
      protocol_version: exam.deployment.protocolVersion,
    });
  }

  const images = activeImages(exam);
  if (images.length > 0) {
    add(CATEGORY.IMAGE_INDEX, {
      images: images.map((i) => ({ image_id: i.imageId, storage_uri: i.storageUri, checksum: i.checksum, acquired_at: i.acquiredAt })),
    });
  }

  // 两条谱系各自取"当前有效版本"（被更正/再判读取代的旧版不外发）。
  const latest = [...exam.interpretations].reverse().find((i) => !i.adjunct && i.supersededBy === null);
  const latestAdjunct = [...exam.interpretations].reverse().find((i) => i.adjunct && i.supersededBy === null);

  if (latest) {
    add(CATEGORY.LATEST_REPORT, {
      interpretation_version: latest.version,
      findings: latest.findings,
      recommendation: latest.recommendation,
      interpreter_id: latest.interpreterId,
      corrected_from: latest.correctedFrom ?? null, // 仅留指针，旧版内容不外发
      supplements: allowed.has(CATEGORY.SUPPLEMENT) ? latest.supplements : [],
    });
  }
  if (latestAdjunct) {
    add(CATEGORY.ADJUNCT_REPORT, {
      interpretation_version: latestAdjunct.version,
      findings: latestAdjunct.findings,
      recommendation: latestAdjunct.recommendation,
      interpreter_id: latestAdjunct.interpreterId,
    });
  }

  if (exam.risk) add(CATEGORY.RISK, { risk_level: exam.risk.level, rationale: exam.risk.rationale });
  if (exam.critical?.acknowledged || exam.critical?.active) {
    add(CATEGORY.CRITICAL, {
      signals: exam.critical.signals,
      escalated_at: exam.critical.escalatedAt,
      acknowledged_at: exam.critical.acknowledgedAt,
    });
  }
  if (exam.signOff) {
    add(CATEGORY.SIGN_OFF, {
      clinician_id: exam.signOff.clinicianId,
      scope: exam.signOff.scope,
      interpretation_version: exam.signOff.interpretationVersion,
      signed_at: exam.signOff.at,
    });
  }

  return { examId: exam.examId, categories: [...new Set(categories)], items };
}

// 整份转诊的最小披露包：patient_id 是唯一跨院身份字段；不含无关检查、不搭车低危资料。
export function buildDisclosurePack({ referralId, patientId, purpose, examStates }) {
  if (!ALLOWED_BY_PURPOSE[purpose]) throw new DomainError(ERR.BAD_INPUT, `未知责任链: ${purpose}`);
  const entries = examStates.map((exam) => {
    if (exam.purpose !== purpose) {
      throw new DomainError(ERR.CHAIN_MISMATCH, "披露包不能夹带其他责任链的检查", {
        referralId, packPurpose: purpose, examPurpose: exam.purpose, examId: exam.examId,
      });
    }
    if (!exam.signOff) {
      throw new DomainError(ERR.SIGN_OFF_REQUIRED, "未经临床医生签署的检查不能跨院披露", { examId: exam.examId });
    }
    return buildExamPackEntry(exam, purpose);
  });

  // CT-FFR 链：附属分析必须能指回同次检查的解剖学判读，否则不构成可发送的包。
  if (purpose === PURPOSE.CT_FFR_ADJUNCT) {
    for (const entry of entries) {
      if (!entry.categories.includes(CATEGORY.LATEST_REPORT) || !entry.categories.includes(CATEGORY.ADJUNCT_REPORT)) {
        throw new DomainError(ERR.BAD_INPUT, "CT-FFR 披露包必须同时包含解剖学判读与 FFR 附属分析", { examId: entry.examId });
      }
    }
  }

  return {
    referral_id: referralId,
    patient_id: patientId, // 最小身份字段；不附带与本次目的无关的档案信息
    purpose,
    entries,
    categories: [...new Set(entries.flatMap((e) => e.categories))],
    items: entries.flatMap((e) => e.items),
  };
}

export function isCriticalRisk(level) {
  return level === RISK.CRITICAL || level === RISK.HIGH;
}
