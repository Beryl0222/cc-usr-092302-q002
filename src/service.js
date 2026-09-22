// 影像联动与转诊领域服务。
// 所有状态变更都以事件追加到 EventStore；规则违例抛出 DomainError，不产生任何事件。

import { EventStore } from "./store.js";
import {
  KIND, MODALITY, PATHWAY, PATHWAY_CHAIN, PURPOSE_SECTIONS, ROLE, URGENCY,
} from "./kinds.js";
import { foldCase, activeReportEvents } from "./projections.js";

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

let seqCounter = 0;
function defaultId(prefix) {
  seqCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${seqCounter}`;
}

export class ReferralService {
  constructor({ store = new EventStore(), clock = () => new Date().toISOString(), id = defaultId } = {}) {
    this.store = store;
    this.clock = clock;
    this.id = id;
  }

  _case(caseId) {
    if (!this.store.has(caseId)) throw new DomainError("CASE_NOT_FOUND", `病例 ${caseId} 不存在`);
    return foldCase(this.store, caseId);
  }

  _append(caseId, kind, payload, { eventId, at, localSeq, backfill, idempotencyKey } = {}) {
    const event = {
      event_id: eventId ?? this.id("evt"),
      kind,
      occurred_at: at ?? this.clock(),
      subject_id: caseId,
      local_seq: localSeq,
      actor: payload.actor_id ? { id: payload.actor_id, role: payload.actor_role } : undefined,
      payload: stripActor(payload),
    };
    if (event.actor === undefined) delete event.actor;
    const { status, event: recorded } = this.store.append(event, { idempotencyKey, backfill });
    return { status, event: recorded };
  }

  // ---- 1. 检查申请 ----

  requestExamination(caseId, cmd) {
    if (this.store.has(caseId)) throw new DomainError("CASE_EXISTS", `病例 ${caseId} 已存在`);
    const {
      patient_id, origin_org_id, modality, pathway, reason, clinician_id,
      clinical_history = "", requested_at,
    } = cmd;
    require(patient_id, "patient_id");
    require(origin_org_id, "origin_org_id");
    enumValue(MODALITY, modality, "modality");
    enumValue(PATHWAY, pathway, "pathway");
    require(clinician_id, "clinician_id");

    return this._append(caseId, KIND.EXAMINATION_REQUESTED, {
      patient_id, origin_org_id, modality, pathway, reason: reason ?? "",
      clinical_history, clinician_id,
      actor_id: clinician_id, actor_role: ROLE.PRIMARY_CLINICIAN,
    }, { at: requested_at, eventId: cmd.event_id }).event;
  }

  // ---- 2. 设备与协议版本登记（让影像可回溯到采集条件） ----

  prepareAcquisition(caseId, cmd) {
    const c = this._case(caseId);
    const { device, protocol, technologist_id, prepared_at } = cmd;
    require(device?.device_id, "device.device_id");
    require(protocol?.name, "protocol.name");
    require(protocol?.version, "protocol.version");
    require(technologist_id, "technologist_id");
    if (device.modality && device.modality !== c.request.modality) {
      throw new DomainError("MODALITY_MISMATCH", "设备模态与检查申请不一致");
    }
    return this._append(caseId, KIND.ACQUISITION_PREPARED, {
      device, protocol, technologist_id,
      actor_id: technologist_id, actor_role: ROLE.IMAGING_TECHNOLOGIST,
    }, { at: prepared_at, eventId: cmd.event_id }).event;
  }

  // ---- 3. 影像上传索引（断网补传 / 重复上传去重） ----

  uploadImages(caseId, cmd) {
    const c = this._case(caseId);
    if (!c.acquisition) throw new DomainError("ACQUISITION_NOT_PREPARED", "须先登记设备与协议版本");
    const { upload_id, images, connectivity = "ONLINE", uploaded_at } = cmd;
    require(upload_id, "upload_id");
    if (!Array.isArray(images) || images.length === 0) {
      throw new DomainError("EMPTY_UPLOAD", "上传批次为空");
    }

    const knownByChecksum = new Map();
    for (const img of c.images.values()) {
      knownByChecksum.set(img.checksum, img.imageId);
    }

    const accepted = [];
    const duplicates = [];
    const seenInBatch = new Set();
    for (const img of images) {
      require(img.image_id, "image.image_id");
      require(img.checksum, "image.checksum");
      if (seenInBatch.has(img.checksum)) {
        duplicates.push({ image_id: img.image_id, checksum: img.checksum, reason: "SAME_BATCH" });
        continue;
      }
      seenInBatch.add(img.checksum);
      const existing = knownByChecksum.get(img.checksum);
      if (existing || c.images.has(img.image_id)) {
        duplicates.push({
          image_id: img.image_id, checksum: img.checksum,
          matched_image_id: existing ?? img.image_id, reason: "CHECKSUM",
        });
        continue;
      }
      accepted.push({
        image_id: img.image_id,
        checksum: img.checksum,
        bytes: img.bytes ?? null,
        stage: img.stage ?? cmd.stage ?? null, // 检查阶段：该影像属于哪个环节
        series: img.series ?? null,
      });
    }

    const backfill = connectivity === "BACKFILL";
    let indexedEvent = null;
    if (accepted.length > 0) {
      indexedEvent = this._append(
        caseId, KIND.IMAGES_INDEXED,
        {
          upload_id, connectivity, accepted,
          acquisition_event_id: c.acquisition.eventId,
          protocol_version: c.acquisition.protocol.version,
          actor_id: cmd.technologist_id ?? c.acquisition.technologist_id,
          actor_role: ROLE.IMAGING_TECHNOLOGIST,
        },
        { at: uploaded_at, backfill, eventId: cmd.event_id, idempotencyKey: `upload:${upload_id}` }
      ).event;
    }
    let dedupEvent = null;
    if (duplicates.length > 0) {
      dedupEvent = this._append(
        caseId, KIND.IMAGE_UPLOAD_DEDUPLICATED,
        {
          upload_id, connectivity, checksums: duplicates,
          actor_id: cmd.technologist_id ?? c.acquisition.technologist_id,
          actor_role: ROLE.IMAGING_TECHNOLOGIST,
        },
        {
          at: uploaded_at, backfill,
          eventId: cmd.dedup_event_id,
          idempotencyKey: `dedup:${upload_id}`,
        }
      ).event;
    }
    return { indexed: indexedEvent, deduplicated: dedupEvent, accepted, duplicates };
  }

  // ---- 4. 结构化判读（责任链：仅该场景授权角色可初判） ----

  recordInterpretation(caseId, cmd) {
    const c = this._case(caseId);
    const chain = PATHWAY_CHAIN[c.request.pathway];
    const { report_id, reader_id, reader_role, image_ids = [] } = cmd;
    require(report_id, "report_id"); require(reader_id, "reader_id"); require(reader_role, "reader_role");
    if (c.reports.has(report_id)) throw new DomainError("REPORT_EXISTS", `报告 ${report_id} 已存在`);
    if (!chain.readers.includes(reader_role)) {
      throw new DomainError("ROLE_NOT_IN_CHAIN",
        `${chain.label}责任链的初判角色为 ${chain.readers.join("/")}，${reader_role} 无权初判`);
    }
    this._requireImages(c, image_ids);
    return this._append(caseId, KIND.INTERPRETATION_RECORDED, {
      report_id, pathway: c.request.pathway, reader_id, reader_role, image_ids,
      findings: cmd.findings ?? {}, impression: cmd.impression ?? "",
      recommendation: cmd.recommendation ?? null, measurements: cmd.measurements ?? null,
      modality: c.request.modality,
      actor_id: reader_id, actor_role: reader_role,
    }, { at: cmd.interpreted_at, eventId: cmd.event_id }).event;
  }

  // ---- 5. 补充意见（含 CT-FFR），沿各自责任链，不得另起临床结论 ----

  addSupplementalOpinion(caseId, cmd) {
    const c = this._case(caseId);
    const chain = PATHWAY_CHAIN[c.request.pathway];
    const { report_id, parent_report_id, reader_id, reader_role, image_ids = [] } = cmd;
    require(report_id, "report_id"); require(parent_report_id, "parent_report_id");
    require(reader_id, "reader_id"); require(reader_role, "reader_role");
    if (c.reports.has(report_id)) throw new DomainError("REPORT_EXISTS", `报告 ${report_id} 已存在`);
    const parent = c.reports.get(parent_report_id);
    if (!parent) throw new DomainError("PARENT_REPORT_NOT_FOUND", "补充意见必须依附既有判读");

    if (cmd.ctffr) {
      if (c.request.pathway !== PATHWAY.CT_FFR_SUPPLEMENT) {
        throw new DomainError("PATHWAY_MISMATCH", "CT-FFR 补充判断只属于 CT_FFR_SUPPLEMENT 责任链");
      }
      if (reader_role !== ROLE.CT_FFR_ANALYST && !chain.supplementalReaders.includes(reader_role)) {
        throw new DomainError("ROLE_NOT_IN_CHAIN", "CT-FFR 分析须由 CT_FFR_ANALYST 或该链授权专家出具");
      }
    } else if (!chain.supplementalReaders.includes(reader_role)) {
      throw new DomainError("ROLE_NOT_IN_CHAIN", `${chain.label}责任链不接受 ${reader_role} 的补充意见`);
    }
    this._requireImages(c, image_ids);

    return this._append(caseId, KIND.SUPPLEMENTAL_OPINION_ADDED, {
      report_id, parent_report_id, pathway: c.request.pathway,
      reader_id, reader_role, image_ids,
      findings: cmd.findings ?? {}, impression: cmd.impression ?? "",
      recommendation: cmd.recommendation ?? null,
      measurements: cmd.measurements ?? null, ctffr: cmd.ctffr ?? null,
      advice_only: true, // 意见性质：仅供临床参考，不构成签署
      actor_id: reader_id, actor_role: reader_role,
    }, { at: cmd.interpreted_at, eventId: cmd.event_id }).event;
  }

  // ---- 6. 专家更正：只追加新版本，保留原意见与版本顺序 ----

  correctInterpretation(caseId, cmd) {
    const c = this._case(caseId);
    const chain = PATHWAY_CHAIN[c.request.pathway];
    const report = c.reports.get(cmd.target_report_id);
    if (!report) throw new DomainError("REPORT_NOT_FOUND", `报告 ${cmd.target_report_id} 不存在`);
    require(cmd.reader_id, "reader_id"); require(cmd.reader_role, "reader_role");
    require(cmd.reason, "reason（更正须写明原因）");
    const allowedRoles = [...chain.readers, ...chain.supplementalReaders];
    if (!allowedRoles.includes(cmd.reader_role)) {
      throw new DomainError("ROLE_NOT_IN_CHAIN", `${cmd.reader_role} 无权在该责任链更正判读`);
    }
    return this._append(caseId, KIND.INTERPRETATION_CORRECTED, {
      target_report_id: cmd.target_report_id, pathway: c.request.pathway,
      reader_id: cmd.reader_id, reader_role: cmd.reader_role,
      findings: cmd.findings ?? {}, impression: cmd.impression ?? "",
      recommendation: cmd.recommendation ?? null,
      measurements: cmd.measurements ?? null, ctffr: cmd.ctffr ?? null,
      reason: cmd.reason,
      actor_id: cmd.reader_id, actor_role: cmd.reader_role,
    }, { at: cmd.corrected_at, eventId: cmd.event_id }).event;
  }

  // ---- 7. 风险分层 ----

  stratifyRisk(caseId, cmd) {
    const c = this._case(caseId);
    require(cmd.level, "level");
    // 无症状高危链强制留一次风险分层
    return this._append(caseId, KIND.RISK_STRATIFIED, {
      level: cmd.level, score: cmd.score ?? null,
      factors: cmd.factors ?? [], rationale: cmd.rationale ?? "",
      by: cmd.by,
      actor_id: cmd.by, actor_role: cmd.by_role ?? ROLE.CARDIOLOGY_SPECIALIST,
    }, { at: cmd.at, eventId: cmd.event_id }).event;
  }

  // ---- 8. 危急信号：只升级该患者，不影响机构队列中其他人 ----

  raiseCriticalSignal(caseId, cmd) {
    this._case(caseId);
    require(cmd.reason, "reason");
    return this._append(caseId, KIND.CRITICAL_SIGNAL_RAISED, {
      reason: cmd.reason, findings: cmd.findings ?? {},
      by: cmd.by, escalate_to: cmd.escalate_to ?? [],
      actor_id: cmd.by, actor_role: cmd.by_role ?? ROLE.CENTER_READER,
    }, { at: cmd.at, eventId: cmd.event_id, backfill: cmd.connectivity === "BACKFILL" }).event;
  }

  // ---- 9. 临床医生签署：影像建议永不替代签署 ----

  signClinicalDecision(caseId, cmd) {
    const c = this._case(caseId);
    const chain = PATHWAY_CHAIN[c.request.pathway];
    require(cmd.decision_id, "decision_id"); require(cmd.clinician_id, "clinician_id");
    require(cmd.role, "role"); require(cmd.decision, "decision");
    if (!chain.signers.includes(cmd.role)) {
      throw new DomainError("NOT_A_SIGNER", `影像角色 ${cmd.role} 不能在${chain.label}链上代行临床签署`);
    }
    const reportEvents = activeReportEvents(c);
    const basedOn = cmd.based_on_report_events ?? reportEvents;
    if (basedOn.length === 0 && !cmd.clinical_basis) {
      throw new DomainError("NO_REPORT_TO_SIGN",
        "签署须基于判读/补充意见；急症等判读未达的情形须填写 clinical_basis 说明纯临床依据");
    }
    const allVersionEvents = [...c.reports.values()].flatMap((r) => r.versions.map((v) => v.eventId));
    for (const ev of basedOn) {
      if (!allVersionEvents.includes(ev)) {
        throw new DomainError("BASE_EVENT_NOT_FOUND", `签署依据事件 ${ev} 不属于本病例判读`);
      }
    }
    if (chain.requiresRiskStratification && c.risk.length === 0) {
      throw new DomainError("RISK_STRATIFICATION_REQUIRED", "无症状高危链签署前必须完成风险分层");
    }
    return this._append(caseId, KIND.CLINICAL_DECISION_SIGNED, {
      decision_id: cmd.decision_id, clinician_id: cmd.clinician_id, role: cmd.role,
      pathway: c.request.pathway, based_on_report_events: basedOn,
      clinical_basis: cmd.clinical_basis ?? null,
      decision: cmd.decision,
      statement: cmd.statement ?? "本人已结合影像判读与临床情况作出决定，影像建议不替代本签署",
      actor_id: cmd.clinician_id, actor_role: cmd.role,
    }, { at: cmd.at, eventId: cmd.event_id }).event;
  }

  // ---- 10. 患者授权 ----

  grantConsent(caseId, cmd) {
    const c = this._case(caseId);
    require(cmd.consent_id, "consent_id"); require(cmd.purpose, "purpose");
    if (c.consents.has(cmd.consent_id)) throw new DomainError("CONSENT_EXISTS", "授权已存在");
    const sections = cmd.sections ?? PURPOSE_SECTIONS[cmd.purpose];
    const allowed = PURPOSE_SECTIONS[cmd.purpose];
    const excess = sections.filter((s) => !allowed.includes(s));
    if (excess.length > 0) {
      throw new DomainError("CONSENT_SCOPE_EXCESSIVE", `授权超出 ${cmd.purpose} 最小必要范围: ${excess.join(",")}`);
    }
    return this._append(caseId, KIND.CONSENT_GRANTED, {
      consent_id: cmd.consent_id, patient_id: c.request.patient_id,
      purpose: cmd.purpose, receiving_org_id: cmd.receiving_org_id ?? null,
      sections, statement: cmd.statement ?? "",
      actor_id: cmd.patient_id, actor_role: "PATIENT",
    }, { at: cmd.granted_at, eventId: cmd.event_id }).event;
  }

  // 撤回：尚未进入诊疗 → 停止共享；已进入病历 → 仅留可追溯痕迹。
  withdrawConsent(caseId, cmd) {
    const c = this._case(caseId);
    const consent = c.consents.get(cmd.consent_id);
    if (!consent) throw new DomainError("CONSENT_NOT_FOUND", "授权不存在");
    if (consent.withdrawn) throw new DomainError("CONSENT_ALREADY_WITHDRAWN", "授权已撤回");

    const enteredCare = c.shares.some(
      (s) => s.consentId === cmd.consent_id && s.enteredCare
    );
    const events = [];
    events.push(this._append(caseId, KIND.CONSENT_WITHDRAWN, {
      consent_id: cmd.consent_id, entered_record: enteredCare,
      reason: cmd.reason ?? "",
      actor_id: consent.patientId, actor_role: "PATIENT",
    }, { at: cmd.at, eventId: cmd.event_id }).event);

    if (!enteredCare) {
      for (const share of c.shares.filter((s) => s.consentId === cmd.consent_id && !s.enteredCare && !s.revokedAt)) {
        events.push(this._append(caseId, KIND.SHARING_REVOKED, {
          share_id: share.shareId, referral_id: share.referralId,
          actor_id: consent.patientId, actor_role: "PATIENT",
        }, { at: cmd.at, eventId: cmd.revoke_event_id }).event);
      }
    }
    return { enteredCare, events };
  }

  // ---- 11. 创建转诊（理由 + 接收机构 + 最小披露包；急症允许资料后补） ----

  createReferral(caseId, cmd) {
    const c = this._case(caseId);
    require(cmd.referral_id, "referral_id"); require(cmd.receiving_org_id, "receiving_org_id");
    require(cmd.purpose, "purpose"); require(cmd.urgency, "urgency");
    if (c.referrals.has(cmd.referral_id)) throw new DomainError("REFERRAL_EXISTS", "转诊已存在");
    const decision = c.decisions[c.decisions.length - 1];
    if (!decision) {
      throw new DomainError("NO_SIGNED_DECISION", "转诊须基于临床医生签署的决定，影像建议不得直接转诊");
    }
    const consent = [...c.consents.values()].find(
      (x) => x.purpose === cmd.purpose &&
        (!cmd.consent_id || x.consentId === cmd.consent_id) &&
        (!x.receivingOrgId || x.receivingOrgId === cmd.receiving_org_id)
    );
    if (!consent) throw new DomainError("NO_CONSENT", `缺少 ${cmd.purpose} 目的的患者授权`);
    if (consent.withdrawn) throw new DomainError("CONSENT_WITHDRAWN", "授权已撤回，不能创建转诊");

    const allowed = PURPOSE_SECTIONS[cmd.purpose];
    const { packet, pending } = buildPacket(c, allowed);
    return this._append(caseId, KIND.REFERRAL_CREATED, {
      referral_id: cmd.referral_id, receiving_org_id: cmd.receiving_org_id,
      purpose: cmd.purpose, urgency: cmd.urgency, pathway: c.request.pathway,
      rationale: cmd.rationale ?? "", clinical_reason: decision.decision,
      signed_decision_event_id: decision.eventId,
      consent_id: consent.consentId,
      packet, pending_sections: pending,
      actor_id: cmd.clinician_id ?? decision.clinicianId,
      actor_role: ROLE.PRIMARY_CLINICIAN,
    }, { at: cmd.at, eventId: cmd.event_id }).event;
  }

  // ---- 12. 实际披露：只发当前可得且被授权的最小资料；可随后补充 ----

  shareReferralPacket(caseId, cmd) {
    const c = this._case(caseId);
    const referral = c.referrals.get(cmd.referral_id);
    if (!referral) throw new DomainError("REFERRAL_NOT_FOUND", "转诊不存在");
    const consent = c.consents.get(referral.consentId);
    if (consent.withdrawn) {
      throw new DomainError("CONSENT_WITHDRAWN", "授权已撤回，停止共享");
    }
    const priorShares = referral.shares.filter((s) => !s.revokedAt);
    const sectionKey = (x) => `${x.section}:${x.eventId ?? ""}:${x.imageId ?? x.reportId ?? ""}`;
    const alreadyShared = new Set(priorShares.flatMap((s) => s.sections.map(sectionKey)));

    const allowed = PURPOSE_SECTIONS[referral.purpose];
    const { packet } = buildPacket(foldCase(this.store, caseId), allowed);
    const sections = packet
      .filter((s) => consent.sections.includes(s.section))
      .filter((s) => !alreadyShared.has(sectionKey(s)));

    if (sections.length === 0) {
      throw new DomainError("NOTHING_NEW_TO_SHARE", "没有新的可披露资料（等待补充资料）");
    }
    return this._append(caseId, KIND.REFERRAL_PACKET_SHARED, {
      share_id: cmd.share_id ?? this.id("share"), referral_id: cmd.referral_id,
      consent_id: consent.consentId, sections, supplement: priorShares.length > 0,
      actor_id: cmd.by ?? consent.patientId, actor_role: cmd.by_role ?? "SYSTEM",
    }, { at: cmd.at, eventId: cmd.event_id }).event;
  }

  // ---- 13. 接收机构回执与确认（预约/联系人以接收方实际状态为准） ----

  issueReceipt(caseId, cmd) {
    const c = this._case(caseId);
    const referral = c.referrals.get(cmd.referral_id);
    if (!referral) throw new DomainError("REFERRAL_NOT_FOUND", "转诊不存在");
    if (cmd.actor_org_id !== referral.receivingOrgId) {
      throw new DomainError("NOT_RECEIVING_ORG", "只有接收机构可出具回执");
    }
    const sectionKey = (x) => `${x.section}:${x.eventId ?? ""}:${x.imageId ?? x.reportId ?? ""}`;
    const sharedSections = new Set(referral.shares
      .filter((s) => !s.revokedAt)
      .flatMap((s) => s.sections.map(sectionKey)));
    const confirmed = (cmd.confirmed_sections ?? [...sharedSections])
      .filter((key) => sharedSections.has(key));
    return this._append(caseId, KIND.RECEIPT_ISSUED, {
      receipt_id: cmd.receipt_id ?? this.id("rcpt"), referral_id: cmd.referral_id,
      receiving_org_id: referral.receivingOrgId, confirmed_sections: confirmed,
      actor_id: cmd.by, actor_role: ROLE.RECEIVING_CLINICIAN,
    }, { at: cmd.at, eventId: cmd.event_id }).event;
  }

  acknowledgeReferral(caseId, cmd) {
    const c = this._case(caseId);
    const referral = c.referrals.get(cmd.referral_id);
    if (!referral) throw new DomainError("REFERRAL_NOT_FOUND", "转诊不存在");
    if (cmd.actor_org_id !== referral.receivingOrgId) {
      throw new DomainError("NOT_RECEIVING_ORG", "只有接收机构可更新接收状态");
    }
    if (cmd.decision === "REJECTED") {
      require(cmd.reason, "拒收须填写 reason");
      return this._append(caseId, KIND.RECEIVING_ACK_REJECTED, {
        referral_id: cmd.referral_id, receiving_org_id: referral.receivingOrgId,
        reason: cmd.reason,
        actor_id: cmd.by, actor_role: ROLE.RECEIVING_CLINICIAN,
      }, { at: cmd.at, eventId: cmd.event_id }).event;
    }
    require(cmd.appointment?.scheduled_at, "appointment.scheduled_at");
    require(cmd.contact?.name, "contact.name");
    require(cmd.contact?.channel, "contact.channel（电话/工位/平台账号）");
    return this._append(caseId, KIND.RECEIVING_ACK_ACCEPTED, {
      referral_id: cmd.referral_id, receiving_org_id: referral.receivingOrgId,
      appointment: {
        scheduled_at: cmd.appointment.scheduled_at,
        location: cmd.appointment.location ?? null,
        status: cmd.appointment.status ?? "BOOKED", // 必须是机构排程系统真实状态
      },
      contact: cmd.contact,
      update: Boolean(cmd.update),
      actor_id: cmd.by, actor_role: ROLE.RECEIVING_CLINICIAN,
    }, { at: cmd.at, eventId: cmd.event_id }).event;
  }

  // ---- 14. 交接：资料正式进入接收方诊疗（此后撤回只留痕） ----

  handover(caseId, cmd) {
    const c = this._case(caseId);
    const referral = c.referrals.get(cmd.referral_id);
    if (!referral) throw new DomainError("REFERRAL_NOT_FOUND", "转诊不存在");
    if (referral.status !== "ACCEPTED") {
      throw new DomainError("NOT_ACCEPTED", "接收机构确认接受后才能交接");
    }
    if (cmd.actor_org_id !== referral.receivingOrgId) {
      throw new DomainError("NOT_RECEIVING_ORG", "交接由接收机构临床医生执行");
    }
    if (referral.shares.filter((s) => !s.revokedAt).length === 0) {
      throw new DomainError("NOTHING_SHARED", "没有任何已授权披露资料可供交接");
    }
    return this._append(caseId, KIND.REFERRAL_HANDED_OVER, {
      referral_id: cmd.referral_id, receiving_clinician_id: cmd.receiving_clinician_id,
      notes: cmd.notes ?? "",
      actor_id: cmd.receiving_clinician_id, actor_role: ROLE.RECEIVING_CLINICIAN,
    }, { at: cmd.at, eventId: cmd.event_id }).event;
  }

  // ---- 15. 最终处置（闭环） ----

  recordDisposition(caseId, cmd) {
    const c = this._case(caseId);
    const referral = c.referrals.get(cmd.referral_id);
    if (!referral) throw new DomainError("REFERRAL_NOT_FOUND", "转诊不存在");
    require(cmd.disposition, "disposition"); require(cmd.by, "by");
    return this._append(caseId, KIND.FINAL_DISPOSITION_RECORDED, {
      referral_id: cmd.referral_id, disposition: cmd.disposition,
      by: cmd.by, notes: cmd.notes ?? "",
      actor_id: cmd.by, actor_role: ROLE.RECEIVING_CLINICIAN,
    }, { at: cmd.at, eventId: cmd.event_id }).event;
  }

  _requireImages(c, imageIds) {
    if (!Array.isArray(imageIds) || imageIds.length === 0) {
      throw new DomainError("IMAGES_REQUIRED", "判读必须关联至少一份影像");
    }
    for (const id of imageIds) {
      if (!c.images.has(id)) throw new DomainError("IMAGE_NOT_FOUND", `影像 ${id} 未入库`);
    }
  }
}

// ---- 披露包组装：目的允许清单 ∩ 当前已可得资料 ----

function buildPacket(c, allowedSections) {
  const packet = [];
  const pending = [];

  if (allowedSections.includes("request")) {
    packet.push({ section: "request", eventId: c.request.eventId });
  }
  if (allowedSections.includes("images")) {
    for (const img of c.images.values()) {
      packet.push({ section: "images", eventId: img.firstIndexEventId, imageId: img.imageId });
    }
    if (c.images.size === 0) pending.push("images");
  }
  if (allowedSections.includes("current_report")) {
    for (const report of c.reports.values()) {
      const v = report.versions[report.versions.length - 1];
      packet.push({ section: "current_report", eventId: v.eventId, reportId: report.reportId });
    }
    if (c.reports.size === 0) pending.push("current_report");
  }
  if (allowedSections.includes("measurements")) {
    const measured = [...c.reports.values()]
      .map((r) => ({ r, v: r.versions[r.versions.length - 1] }))
      .filter((x) => x.v.measurements);
    for (const { r, v } of measured) {
      packet.push({ section: "measurements", eventId: v.eventId, reportId: r.reportId });
    }
    if (measured.length === 0) pending.push("measurements");
  }
  if (allowedSections.includes("risk")) {
    const risk = c.risk[c.risk.length - 1];
    if (risk) packet.push({ section: "risk", eventId: risk.eventId });
    else pending.push("risk");
  }
  if (allowedSections.includes("signed_decision")) {
    const d = c.decisions[c.decisions.length - 1];
    if (d) packet.push({ section: "signed_decision", eventId: d.eventId });
    else pending.push("signed_decision");
  }
  return { packet, pending };
}

function require(value, field) {
  if (value === undefined || value === null || value === "") {
    throw new DomainError("VALIDATION", `缺少必填项: ${field}`);
  }
}

function enumValue(enumeration, value, field) {
  if (!Object.values(enumeration).includes(value)) {
    throw new DomainError("VALIDATION", `字段 ${field} 取值非法: ${value}`);
  }
}

function stripActor(payload) {
  const { actor_id, actor_role, ...rest } = payload;
  return rest;
}

export { URGENCY };
