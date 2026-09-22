import { randomUUID } from "node:crypto";
import { EventStore } from "./event-store.js";
import { DomainError, ERR } from "./errors.js";
import { KIND, PURPOSE, ROLE, RISK, REFERRAL_STATUS, CONSENT, CHAIN_LABEL } from "./vocabulary.js";
import { assertCanSign, assertInterpreterRole, assertModalityAllowed, policyFor } from "./chains.js";
import { foldExam, foldReferral } from "./projections.js";
import { buildDisclosurePack, CATEGORY } from "./disclosure.js";

const requireText = (value, label) => {
  if (typeof value !== "string" || value.trim() === "") throw new DomainError(ERR.BAD_INPUT, `${label}不能为空`);
  return value;
};
const requireAt = (value, label) => {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new DomainError(ERR.BAD_INPUT, `${label}不是合法时间`);
  return value;
};

// 影像联动与转诊应用服务。
// 每个写方法是一次"命令 -> 校验责任链/授权/版本 -> 追加事件"的事务。
export class ImagingService {
  #store;
  #directory;
  #clock;

  constructor({ store, directory, clock = () => new Date().toISOString() } = {}) {
    this.#store = store ?? new EventStore({ clock });
    this.#directory = directory;
    this.#clock = clock;
  }

  get store() { return this.#store; }
  get directory() { return this.#directory; }

  #id(id) { return id ?? randomUUID(); }
  #at(at) { return requireAt(at ?? this.#clock(), "occurredAt"); }

  examStream(examId) { return `exam:${examId}`; }
  referralStream(referralId) { return `referral:${referralId}`; }

  #appendExam(examId, patientId, kind, actor, payload, { chain, expectedVersion, backfill, eventId, occurredAt, causationId, supersedesVersion }) {
    return this.#store.append({
      eventId: this.#id(eventId),
      kind,
      occurredAt: this.#at(occurredAt),
      subjectId: requireText(patientId, "patientId"),
      streamId: this.examStream(examId),
      actor,
      chain,
      payload,
      causationId,
      supersedesVersion,
    }, { expectedVersion, backfill });
  }

  examState(examId) {
    const events = this.#store.readStream(this.examStream(examId));
    if (events.length === 0) throw new DomainError(ERR.UNKNOWN_STREAM, `检查不存在: ${examId}`, { examId });
    return foldExam(events);
  }

  referralState(referralId) {
    const events = this.#store.readStream(this.referralStream(referralId));
    if (events.length === 0) throw new DomainError(ERR.UNKNOWN_STREAM, `转诊不存在: ${referralId}`, { referralId });
    return foldReferral(events);
  }

  // ---- 检查申请 -------------------------------------------------------

  requestExamination({ eventId, examId, patientId, orgId, modality, purpose, clinician, occurredAt }) {
    requireText(examId, "examId");
    requireText(orgId, "orgId");
    requireText(patientId, "patientId");
    if (!Object.values(PURPOSE).includes(purpose)) throw new DomainError(ERR.BAD_INPUT, `未知责任链: ${purpose}`);
    if (clinician?.role !== ROLE.REFERRING_CLINICIAN) {
      throw new DomainError(ERR.SIGNER_ROLE, "检查申请只能由基层临床医生发起", { role: clinician?.role });
    }
    assertModalityAllowed(purpose, modality);
    const streamId = this.examStream(examId);
    if (this.#store.streamVersion(streamId) > 0) throw new DomainError(ERR.DUPLICATE_EVENT, "检查申请已存在", { examId });

    return this.#appendExam(examId, patientId, KIND.EXAMINATION_REQUESTED, clinician, {
      exam_id: examId, patient_id: patientId, org_id: orgId, modality, purpose, clinician_id: clinician.id,
    }, { chain: purpose, expectedVersion: 0, eventId, occurredAt }).event;
  }

  // ---- 设备与协议版本 -------------------------------------------------

  recordDeployment({ eventId, examId, deviceId, deviceName, protocolId, protocolVersion, actor, occurredAt, backfill = false }) {
    const exam = this.examState(examId);
    if (exam.deployment) throw new DomainError(ERR.DUPLICATE_EVENT, "设备与协议已登记；版本升级请走新检查申请", { examId });
    [deviceId, protocolId, protocolVersion].forEach((v, i) => requireText(v, ["deviceId", "protocolId", "protocolVersion"][i]));
    return this.#appendExam(examId, exam.patientId, KIND.DEPLOYMENT_RECORDED, actor, {
      device_id: deviceId, device_name: deviceName ?? null, protocol_id: protocolId, protocol_version: protocolVersion,
    }, { chain: exam.purpose, eventId, occurredAt, backfill }).event;
  }

  // ---- 影像索引（断网补传 / 重复上传） --------------------------------

  indexImage({ eventId, examId, imageId, storageUri, checksum, seriesUid, acquiredAt, actor, occurredAt, backfill = false }) {
    const exam = this.examState(examId);
    requireText(imageId, "imageId");
    requireText(checksum, "checksum");
    requireText(storageUri, "storageUri");

    // 断网重试优先按 event_id 幂等回放（存储层不产生新版本），
    // 先于内容指纹检查，保证"同一次上传的重试"永远是同一个结果。
    if (eventId) {
      const existing = this.#store.getEvent(eventId);
      if (existing) return existing;
    }
    // 同一检查的重复上传：相同校验和只认第一次索引；
    // 这里拦截"换了 event_id 的同一份文件"。
    if (exam.checksums.has(checksum)) {
      throw new DomainError(ERR.DUPLICATE_IMAGE, "该影像已在本次检查中索引，重复上传不再生成新版本", {
        examId, checksum, existingImageId: exam.checksums.get(checksum),
      });
    }
    return this.#appendExam(examId, exam.patientId, KIND.IMAGE_INDEXED, actor, {
      image_id: imageId, storage_uri: storageUri, checksum, series_uid: seriesUid ?? null, acquired_at: acquiredAt ?? null,
    }, { chain: exam.purpose, eventId, occurredAt, backfill }).event;
  }

  suppressImage({ eventId, examId, imageId, reason, actor, occurredAt }) {
    const exam = this.examState(examId);
    if (!exam.images.has(imageId)) throw new DomainError(ERR.UNKNOWN_STREAM, `影像不存在: ${imageId}`);
    return this.#appendExam(examId, exam.patientId, KIND.IMAGE_SUPPRESSED, actor, {
      image_id: imageId, reason: requireText(reason, "reason"),
    }, { chain: exam.purpose, eventId, occurredAt }).event;
  }

  // ---- 结构化判读 / 补充意见 / 专家更正 -------------------------------

  #activeImagesOrThrow(exam, imageIds) {
    for (const id of imageIds) {
      const img = exam.images.get(id);
      if (!img) throw new DomainError(ERR.BAD_INPUT, `判读引用了不存在的影像: ${id}`);
      if (img.suppressed) throw new DomainError(ERR.BAD_INPUT, `判读不能引用已撤回影像: ${id}`);
    }
  }

  recordInterpretation({ eventId, examId, interpretationId, imageIds, findings, recommendation, actor, occurredAt, backfill = false, adjunct = false }) {
    const exam = this.examState(examId);
    assertInterpreterRole(exam.purpose, actor.role);
    if (!Array.isArray(imageIds) || imageIds.length === 0) throw new DomainError(ERR.BAD_INPUT, "判读必须引用至少一份影像");
    this.#activeImagesOrThrow(exam, imageIds);
    if (!findings || typeof findings !== "object") throw new DomainError(ERR.BAD_INPUT, "结构化判读 findings 必填");

    const policy = policyFor(exam.purpose);
    if (adjunct && !policy.adjunct) throw new DomainError(ERR.CHAIN_MISMATCH, "只有 CT-FFR 补充判断链允许附属分析", { purpose: exam.purpose });
    if (adjunct) {
      if (actor.role !== ROLE.CT_FFR_ANALYST) {
        throw new DomainError(ERR.CHAIN_MISMATCH, "附属分析只能由 CT-FFR 分析者出具", { role: actor.role });
      }
      // 附属分析必须挂靠在同次 CT 已有的、当前有效的解剖学判读上。
      const hasBase = exam.interpretations.some((i) => !i.adjunct && i.supersededBy === null);
      if (!hasBase) throw new DomainError(ERR.CHAIN_MISMATCH, "CT-FFR 附属分析须先有同次 CT 的解剖学判读");
    } else if (policy.adjunct) {
      // CT-FFR 链上的解剖学判读由影像专家负责，分析者不能用"普通判读"绕过附属定位。
      if (actor.role !== ROLE.IMAGING_EXPERT) {
        throw new DomainError(ERR.CHAIN_MISMATCH, "该链的解剖学判读只能由影像专家出具", { role: actor.role });
      }
    }

    return this.#appendExam(examId, exam.patientId, KIND.INTERPRETATION_RECORDED, actor, {
      interpretation_id: requireText(interpretationId, "interpretationId"),
      image_ids: imageIds, findings, recommendation: recommendation ?? null, adjunct,
    }, { chain: exam.purpose, eventId, occurredAt, backfill }).event;
  }

  addSupplement({ eventId, examId, interpretationVersion, supplementId, body, actor, occurredAt, backfill = false }) {
    const exam = this.examState(examId);
    if (actor.role !== ROLE.IMAGING_EXPERT) throw new DomainError(ERR.SIGNER_ROLE, "补充意见只能由影像专家给出", { role: actor.role });
    const target = exam.interpretations.find((i) => i.version === interpretationVersion);
    if (!target) throw new DomainError(ERR.BAD_INPUT, `判读版本不存在: ${interpretationVersion}`);
    return this.#appendExam(examId, exam.patientId, KIND.SUPPLEMENT_RECORDED, actor, {
      supplement_id: requireText(supplementId, "supplementId"),
      interpretation_version: interpretationVersion,
      body: requireText(body, "body"),
    }, { chain: exam.purpose, eventId, occurredAt, backfill, causationId: target.interpretationId }).event;
  }

  // 专家更正：不覆盖旧意见，而是追加新版本，旧版本标记被取代但永久留痕。
  correctInterpretation({ eventId, examId, interpretationVersion, interpretationId, findings, recommendation, actor, occurredAt }) {
    const exam = this.examState(examId);
    assertInterpreterRole(exam.purpose, actor.role);
    if (actor.role !== ROLE.IMAGING_EXPERT) throw new DomainError(ERR.SIGNER_ROLE, "专家更正只能由影像专家发起", { role: actor.role });
    const target = exam.interpretations.find((i) => i.version === interpretationVersion);
    if (!target) throw new DomainError(ERR.BAD_INPUT, `待更正的判读版本不存在: ${interpretationVersion}`);
    // 必须更正其所属谱系（解剖学判读 / 附属分析）的当前有效版本；
    // 附属分析由分析者负责，专家更正走不到那里（角色闸在前）。
    if (target.supersededBy !== null) {
      throw new DomainError(ERR.STALE_CORRECTION, "只能更正当前有效判读版本；请基于最新版本再更正", {
        examId, given: interpretationVersion, supersededBy: target.supersededBy,
      });
    }
    if (!findings || typeof findings !== "object") throw new DomainError(ERR.BAD_INPUT, "更正 findings 必填");
    return this.#appendExam(examId, exam.patientId, KIND.INTERPRETATION_CORRECTED, actor, {
      interpretation_id: requireText(interpretationId, "interpretationId"),
      interpretation_version: interpretationVersion,
      image_ids: target.imageIds,
      findings, recommendation: recommendation ?? target.recommendation,
    }, { chain: exam.purpose, eventId, occurredAt, supersedesVersion: interpretationVersion }).event;
  }

  // ---- 风险分层与危急升级 ---------------------------------------------

  stratifyRisk({ eventId, examId, riskLevel, rationale, actor, occurredAt }) {
    const exam = this.examState(examId);
    if (!Object.values(RISK).includes(riskLevel)) throw new DomainError(ERR.BAD_INPUT, `未知风险等级: ${riskLevel}`);
    const first = this.#appendExam(examId, exam.patientId, KIND.RISK_STRATIFIED, actor, {
      risk_level: riskLevel, rationale: requireText(rationale, "rationale"),
    }, { chain: exam.purpose, eventId, occurredAt });

    // 危急信号：只升级这一位患者（检查流），其他患者/机构队列照常流动。
    if (riskLevel === RISK.CRITICAL && !(exam.critical?.active)) {
      this.#appendExam(examId, exam.patientId, KIND.CRITICAL_SIGNAL_ESCALATED, actor, {
        signals: ["RISK_CRITICAL"], reason: rationale,
      }, { chain: exam.purpose, occurredAt, causationId: first.event.event_id });
    }
    return first.event;
  }

  escalateCritical({ eventId, examId, signals, reason, actor, occurredAt }) {
    const exam = this.examState(examId);
    if (exam.critical?.active) throw new DomainError(ERR.DUPLICATE_EVENT, "该患者危急升级仍在进行中", { examId });
    if (!Array.isArray(signals) || signals.length === 0) throw new DomainError(ERR.BAD_INPUT, "危急信号不能为空");
    return this.#appendExam(examId, exam.patientId, KIND.CRITICAL_SIGNAL_ESCALATED, actor, {
      signals, reason: requireText(reason, "reason"),
    }, { chain: exam.purpose, eventId, occurredAt }).event;
  }

  acknowledgeEscalation({ eventId, examId, actor, occurredAt }) {
    const exam = this.examState(examId);
    if (!exam.critical) throw new DomainError(ERR.BAD_INPUT, "没有待回执的危急升级");
    if (actor.role !== ROLE.REFERRING_CLINICIAN && actor.role !== ROLE.RECEIVING_CLINICIAN) {
      throw new DomainError(ERR.SIGNER_ROLE, "危急回执只能由临床医生确认", { role: actor.role });
    }
    return this.#appendExam(examId, exam.patientId, KIND.ESCALATION_ACKNOWLEDGED, actor, {}, {
      chain: exam.purpose, eventId, occurredAt,
    }).event;
  }

  // ---- 临床医生签署（影像建议不能替代） -------------------------------

  signOff({ eventId, examId, clinician, scope, interpretationVersion, occurredAt }) {
    const exam = this.examState(examId);
    assertCanSign(exam.purpose, clinician);
    // 默认签署解剖学判读的当前有效版本（附属分析不单独作为签署对象）。
    const activeBase = [...exam.interpretations].reverse().find((i) => !i.adjunct && i.supersededBy === null);
    const version = interpretationVersion ?? activeBase?.version;
    const target = exam.interpretations.find((i) => i.version === version);
    if (!target) throw new DomainError(ERR.BAD_INPUT, `签署所依据的判读版本不存在: ${version}`);
    if (target.supersededBy !== null) {
      throw new DomainError(ERR.STALE_CORRECTION, "不能签署已被更正取代的判读版本", { version, latest: exam.latestInterpretationVersion });
    }
    requireText(scope, "scope");
    return this.#appendExam(examId, exam.patientId, KIND.CLINICAL_SIGN_OFF, clinician, {
      clinician_id: clinician.id, scope, interpretation_version: version,
    }, { chain: exam.purpose, eventId, occurredAt }).event;
  }

  // ---- 患者授权 -------------------------------------------------------

  #appendReferral(referralId, patientId, kind, actor, payload, { chain, expectedVersion, eventId, occurredAt }) {
    return this.#store.append({
      eventId: this.#id(eventId),
      kind,
      occurredAt: this.#at(occurredAt),
      subjectId: requireText(patientId, "patientId"),
      streamId: this.referralStream(referralId),
      actor,
      chain,
      payload,
    }, { expectedVersion });
  }

  grantConsent({ eventId, referralId, patientId, purpose, receiverOrgId, categories, examIds, actor, occurredAt }) {
    requireText(referralId, "referralId");
    if (!actor || actor.role !== ROLE.PATIENT || actor.id !== patientId) {
      throw new DomainError(ERR.CONSENT_REQUIRED, "授权只能由患者本人（或其法定代理人）作出");
    }
    if (!Object.values(PURPOSE).includes(purpose)) throw new DomainError(ERR.BAD_INPUT, `未知责任链: ${purpose}`);
    if (!Array.isArray(categories) || categories.length === 0) throw new DomainError(ERR.BAD_INPUT, "授权类别不能为空");
    const allowed = new Set(Object.values(CATEGORY));
    for (const c of categories) if (!allowed.has(c)) throw new DomainError(ERR.BAD_INPUT, `未知授权类别: ${c}`);
    if (this.#store.streamVersion(this.referralStream(referralId)) > 0) {
      throw new DomainError(ERR.DUPLICATE_EVENT, "该转诊已有授权记录", { referralId });
    }
    return this.#appendReferral(referralId, patientId, KIND.CONSENT_GRANTED, actor, {
      referral_id: referralId, patient_id: patientId, purpose,
      receiver_org_id: requireText(receiverOrgId, "receiverOrgId"),
      categories, exam_ids: Array.isArray(examIds) ? examIds : [],
    }, { chain: purpose, expectedVersion: 0, eventId, occurredAt }).event;
  }

  // 撤回授权：返回事件与处置语义（是否须停止共享、是否仅留痕）。
  withdrawConsent({ eventId, referralId, reason, actor, occurredAt }) {
    const state = this.referralState(referralId);
    if (actor?.role !== ROLE.PATIENT || actor.id !== state.patientId) {
      throw new DomainError(ERR.CONSENT_REQUIRED, "撤回只能由患者本人作出");
    }
    if (state.consent?.status === CONSENT.WITHDRAWN) throw new DomainError(ERR.DUPLICATE_EVENT, "授权已经撤回");
    const event = this.#appendReferral(referralId, state.patientId, KIND.CONSENT_WITHDRAWN, actor, {
      referral_id: referralId, patient_id: state.patientId, reason: requireText(reason, "reason"),
    }, { chain: state.purpose, eventId, occurredAt }).event;

    const next = this.referralState(referralId);
    return {
      event,
      consequence: next.disposition
        ? "RETAINED_IN_RECORD" // 已进入病历：留痕，不回退
        : next.handoff
          ? "WITHDRAWN_IN_CARE" // 已用于诊疗：禁止再披露，等待处置留痕
          : "STOP_SHARING", // 尚未用于诊疗：停止共享，已发资料须处置
      purgeRequired: next.purgeRequired,
    };
  }

  // 接收机构确认已按撤回要求停止共享并处置未入病历资料。
  confirmSharingDiscontinued({ eventId, referralId, actor, occurredAt }) {
    const state = this.referralState(referralId);
    if (state.status !== REFERRAL_STATUS.REVOKED || !state.purgeRequired) {
      throw new DomainError(ERR.BAD_INPUT, "当前转诊没有待处置的共享资料");
    }
    if (actor.role !== ROLE.RECEIVING_CLINICIAN || actor.orgId !== state.receiverOrgId) {
      throw new DomainError(ERR.RECEIVER_MISMATCH, "只能由指定接收机构确认停止共享");
    }
    return this.#appendReferral(referralId, state.patientId, KIND.SHARING_DISCONTINUED, actor, {
      referral_id: referralId, patient_id: state.patientId, receiver_org_id: state.receiverOrgId,
    }, { chain: state.purpose, eventId, occurredAt }).event;
  }

  // ---- 转诊 -----------------------------------------------------------

  #referralExams(referral) {
    return referral.examIds.map((id) => this.examState(id));
  }

  openReferral({ eventId, referralId, examIds, receiverOrgId, reason, riskLevel, actor, occurredAt }) {
    requireText(referralId, "referralId");
    requireText(receiverOrgId, "receiverOrgId");
    if (actor?.role !== ROLE.REFERRING_CLINICIAN) throw new DomainError(ERR.SIGNER_ROLE, "转诊只能由基层临床医生发起");
    if (!Array.isArray(examIds) || examIds.length === 0) throw new DomainError(ERR.BAD_INPUT, "转诊必须至少包含一项检查");

    const exams = examIds.map((id) => this.examState(id));
    const purpose = exams[0].purpose;
    for (const exam of exams) {
      if (exam.purpose !== purpose) throw new DomainError(ERR.CHAIN_MISMATCH, "一次转诊只能走一条责任链", { purposes: exams.map((e) => e.purpose) });
      if (!exam.signOff) throw new DomainError(ERR.SIGN_OFF_REQUIRED, "影像意见未经临床医生签署，不能发起转诊", { examId: exam.examId });
      if (exam.patientId !== exams[0].patientId) throw new DomainError(ERR.BAD_INPUT, "转诊不能混合不同患者的检查");
    }

    // 授权前置：必须存在患者针对该接收机构、覆盖这些检查的有效授权。
    const consentEvents = this.#store.readStream(this.referralStream(referralId));
    const consent = foldReferral(consentEvents).consent;
    if (!consent || consent.status !== CONSENT.GRANTED) throw new DomainError(ERR.CONSENT_REQUIRED, "发起转诊前必须取得患者有效授权");
    if (consent.receiverOrgId !== receiverOrgId) throw new DomainError(ERR.RECEIVER_MISMATCH, "授权的接收机构与转诊目标不一致");
    for (const id of examIds) if (!consent.examIds.includes(id)) throw new DomainError(ERR.CONSENT_REQUIRED, `授权未覆盖检查 ${id}`);

    const effectiveRisk = riskLevel ?? exams.reduce((max, e) => {
      const order = [RISK.LOW, RISK.MEDIUM, RISK.HIGH, RISK.CRITICAL];
      return e.risk && order.indexOf(e.risk.level) > order.indexOf(max) ? e.risk.level : max;
    }, RISK.LOW);

    return this.#appendReferral(referralId, exams[0].patientId, KIND.REFERRAL_OPENED, actor, {
      referral_id: referralId, patient_id: exams[0].patientId, purpose,
      from_org_id: exams[0].orgId, receiver_org_id: receiverOrgId,
      exam_ids: examIds, reason: requireText(reason, "reason"), risk_level: effectiveRisk,
    }, { chain: purpose, eventId, occurredAt }).event;
  }

  makeDisclosure({ eventId, referralId, actor, occurredAt }) {
    const referral = this.referralState(referralId);
    if (referral.consent?.status === CONSENT.WITHDRAWN) throw new DomainError(ERR.CONSENT_WITHDRAWN, "授权已撤回，禁止继续披露");
    if (actor.role !== ROLE.REFERRING_CLINICIAN) throw new DomainError(ERR.SIGNER_ROLE, "只有转诊医生可以执行跨院披露");
    const exams = this.#referralExams(referral);
    const fullPack = buildDisclosurePack({
      referralId, patientId: referral.patientId, purpose: referral.purpose, examStates: exams,
    });
    // 最小必要的第二道闸：实际披露 = 目的白名单 ∩ 患者授权类别。
    const consented = new Set(referral.consent.categories);
    const items = fullPack.items.filter((i) => consented.has(i.category));
    const categories = [...new Set(items.map((i) => i.category))];

    // CT-FFR 链的解剖学判读与附属分析必须成对，缺一即不能作为该目的发送。
    if (referral.purpose === PURPOSE.CT_FFR_ADJUNCT
      && (!categories.includes(CATEGORY.LATEST_REPORT) || !categories.includes(CATEGORY.ADJUNCT_REPORT))) {
      throw new DomainError(ERR.CONSENT_REQUIRED, "CT-FFR 转诊须同时获得解剖学判读与附属分析的披露授权");
    }

    const pack = { ...fullPack, categories, items };
    return this.#appendReferral(referralId, referral.patientId, KIND.REFERRAL_DISCLOSURE_MADE, actor, {
      referral_id: referralId, categories, pack,
    }, { chain: referral.purpose, eventId, occurredAt }).event;
  }

  acceptReferral({ eventId, referralId, actor, occurredAt }) {
    const referral = this.referralState(referralId);
    if (referral.consent?.status === CONSENT.WITHDRAWN) throw new DomainError(ERR.CONSENT_WITHDRAWN, "授权已撤回，不能受理");
    if (actor.role !== ROLE.RECEIVING_CLINICIAN) throw new DomainError(ERR.RECEIVER_MISMATCH, "只有接收机构临床医生可以受理");
    if (actor.orgId !== referral.receiverOrgId) throw new DomainError(ERR.RECEIVER_MISMATCH, "受理机构与转诊目标不一致");
    if (referral.disclosures.length === 0) throw new DomainError(ERR.BAD_INPUT, "受理前须先完成最小披露");
    if (referral.status === REFERRAL_STATUS.ACCEPTED) throw new DomainError(ERR.DUPLICATE_EVENT, "转诊已受理");
    return this.#appendReferral(referralId, referral.patientId, KIND.REFERRAL_ACCEPTED, actor, {
      referral_id: referralId, receiver_org_id: actor.orgId,
    }, { chain: referral.purpose, eventId, occurredAt }).event;
  }

  // 接收机构给出预约：预约信息直接取自机构目录当前版本并盖版本戳。
  offerAppointment({ eventId, referralId, slotId, actor, occurredAt }) {
    const referral = this.referralState(referralId);
    if (referral.consent?.status === CONSENT.WITHDRAWN) throw new DomainError(ERR.CONSENT_WITHDRAWN, "授权已撤回，不能安排预约");
    if (actor.role !== ROLE.RECEIVING_CLINICIAN || actor.orgId !== referral.receiverOrgId) {
      throw new DomainError(ERR.RECEIVER_MISMATCH, "只能由指定接收机构安排预约");
    }
    if (![REFERRAL_STATUS.ACCEPTED, REFERRAL_STATUS.APPOINTED].includes(referral.status)) {
      throw new DomainError(ERR.BAD_INPUT, "受理后才能给出预约；已交接/已关闭/已撤回的转诊不能改约");
    }
    if (!this.#directory) throw new DomainError(ERR.BAD_INPUT, "未配置接收机构目录");
    const current = this.#directory.assertAppointmentCurrent(referral.receiverOrgId, { slotId, directoryVersion: this.#directory.versionOf(referral.receiverOrgId) });
    return this.#appendReferral(referralId, referral.patientId, KIND.APPOINTMENT_OFFERED, actor, {
      referral_id: referralId, slot_id: slotId, scheduled_at: current.scheduledAt,
      contact: current.contact, directory_version: current.version,
    }, { chain: referral.purpose, eventId, occurredAt }).event;
  }

  // 患者确认前再次比对目录：号源/联系人任何变化都会让旧预约失效。
  confirmAppointment({ eventId, referralId, actor, occurredAt }) {
    const referral = this.referralState(referralId);
    if (referral.consent?.status === CONSENT.WITHDRAWN) throw new DomainError(ERR.CONSENT_WITHDRAWN, "授权已撤回");
    if (!referral.appointment) throw new DomainError(ERR.BAD_INPUT, "尚无预约可确认");
    if (actor?.id !== referral.patientId) throw new DomainError(ERR.BAD_INPUT, "预约须由患者确认");
    if (!this.#directory) throw new DomainError(ERR.BAD_INPUT, "未配置接收机构目录");
    const current = this.#directory.assertAppointmentCurrent(referral.receiverOrgId, {
      slotId: referral.appointment.slotId, directoryVersion: referral.appointment.directoryVersion,
    });
    const newVersion = this.#directory.markTaken(referral.receiverOrgId, referral.appointment.slotId);
    return this.#appendReferral(referralId, referral.patientId, KIND.APPOINTMENT_CONFIRMED, actor, {
      referral_id: referralId, contact: current.contact, directory_version: newVersion,
    }, { chain: referral.purpose, eventId, occurredAt }).event;
  }

  acknowledgeHandoff({ eventId, referralId, actor, occurredAt }) {
    const referral = this.referralState(referralId);
    if (actor.role !== ROLE.RECEIVING_CLINICIAN || actor.orgId !== referral.receiverOrgId) {
      throw new DomainError(ERR.RECEIVER_MISMATCH, "交接回执只能由指定接收机构签署");
    }
    if (referral.status !== REFERRAL_STATUS.APPOINTED) throw new DomainError(ERR.BAD_INPUT, "预约确认后才能回执交接");
    return this.#appendReferral(referralId, referral.patientId, KIND.HANDOFF_ACKNOWLEDGED, actor, {
      referral_id: referralId, receiver_org_id: actor.orgId,
    }, { chain: referral.purpose, eventId, occurredAt }).event;
  }

  recordDisposition({ eventId, referralId, outcome, recordLocator, actor, occurredAt }) {
    const referral = this.referralState(referralId);
    if (actor.role !== ROLE.RECEIVING_CLINICIAN || actor.orgId !== referral.receiverOrgId) {
      throw new DomainError(ERR.RECEIVER_MISMATCH, "最终处置只能由指定接收机构记录");
    }
    if (referral.status !== REFERRAL_STATUS.IN_CARE) throw new DomainError(ERR.BAD_INPUT, "完成交接后才能记录最终处置");
    if (referral.consent?.status === CONSENT.WITHDRAWN && !referral.withdrawalInCare && !referral.handoff) {
      throw new DomainError(ERR.CONSENT_WITHDRAWN, "授权已撤回且未进入诊疗");
    }
    return this.#appendReferral(referralId, referral.patientId, KIND.DISPOSITION_RECORDED, actor, {
      referral_id: referralId, outcome: requireText(outcome, "outcome"),
      record_locator: requireText(recordLocator, "recordLocator"),
    }, { chain: referral.purpose, eventId, occurredAt }).event;
  }

  // ---- 还原：一次转诊 -> 影像、判读、交接、处置的完整时间线 ----------

  referralTimeline(referralId) {
    const referral = this.referralState(referralId);
    const examEvents = referral.examIds.flatMap((id) => this.#store.readStream(this.examStream(id)));
    const referralEvents = this.#store.readStream(this.referralStream(referralId));
    const all = [...examEvents, ...referralEvents].sort((a, b) => {
      const dt = Date.parse(a.occurred_at) - Date.parse(b.occurred_at);
      return dt !== 0 ? dt : a.seq - b.seq;
    });
    return {
      referral_id: referralId,
      patient_id: referral.patientId,
      chain: referral.purpose,
      chain_label: CHAIN_LABEL[referral.purpose],
      status: referral.status,
      entries: all.map((e) => ({
        seq: e.seq,
        at: e.occurred_at,
        recorded_at: e.recorded_at,
        backfilled: e.backfilled,
        kind: e.kind,
        actor_id: e.actor_id,
        actor_role: e.actor_role,
        stream: e.stream_id,
        version: e.version,
        supersedes_version: e.supersedes_version,
        payload: e.payload,
      })),
    };
  }
}
