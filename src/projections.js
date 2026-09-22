// 病例状态归约与读模型。
// 所有判断都基于临床顺序（store.stream）重放；物理落库顺序仅用于审计与到达延迟展示。

import { KIND, PURPOSE_SECTIONS } from "./kinds.js";

/** 把单病例事件流折叠为当前状态。 */
export function foldCase(store, caseId) {
  const state = {
    caseId,
    request: null,
    acquisition: null,
    images: new Map(), // imageId -> 影像索引记录
    uploads: new Map(), // uploadId -> { eventId, imageIds, connectivity }
    duplicateUploads: [], // 被识别的重复上传
    reports: new Map(), // reportId -> 逻辑报告（含 versions）
    risk: [], // 历次风险分层，末条为当前
    critical: null, // 当前危急信号
    decisions: [], // 历次临床签署，末条为当前
    consents: new Map(), // consentId -> 授权（含撤回/留痕状态）
    referrals: new Map(), // referralId -> 转诊聚合
    shares: [], // 实际披露记录
    receipts: [], // 接收回执
    acks: [], // 接收机构确认（接受/拒收/预约更新）
    handover: null,
    disposition: null,
  };

  for (const event of store.stream(caseId)) {
    apply(state, event);
  }
  return state;
}

function apply(state, e) {
  const p = e.payload ?? {};
  switch (e.kind) {
    case KIND.EXAMINATION_REQUESTED:
      state.request = { ...p, eventId: e.event_id, occurredAt: e.occurred_at };
      break;

    case KIND.ACQUISITION_PREPARED:
      state.acquisition = { ...p, eventId: e.event_id, occurredAt: e.occurred_at };
      break;

    case KIND.IMAGES_INDEXED: {
      state.uploads.set(p.upload_id, {
        eventId: e.event_id,
        occurredAt: e.occurred_at,
        connectivity: p.connectivity,
        imageIds: (p.accepted ?? []).map((x) => x.image_id),
      });
      for (const img of p.accepted ?? []) {
        if (!state.images.has(img.image_id)) {
          state.images.set(img.image_id, {
            imageId: img.image_id,
            checksum: img.checksum,
            bytes: img.bytes,
            stage: img.stage ?? null,
            firstIndexEventId: e.event_id,
            firstIndexedAt: e.occurred_at,
            backfill: Boolean(e.backfill),
            uploads: [],
          });
        }
        state.images.get(img.image_id).uploads.push({
          uploadId: p.upload_id,
          at: e.occurred_at,
          connectivity: p.connectivity,
        });
      }
      break;
    }

    case KIND.IMAGE_UPLOAD_DEDUPLICATED:
      state.duplicateUploads.push({
        eventId: e.event_id,
        uploadId: p.upload_id,
        checksums: p.checksums ?? [],
        at: e.occurred_at,
        backfill: Boolean(e.backfill),
      });
      break;

    case KIND.INTERPRETATION_RECORDED:
    case KIND.SUPPLEMENTAL_OPINION_ADDED: {
      const version = {
        eventId: e.event_id,
        kind: e.kind,
        occurredAt: e.occurred_at,
        readerId: p.reader_id,
        readerRole: p.reader_role,
        imageIds: p.image_ids ?? [],
        findings: p.findings ?? {},
        impression: p.impression ?? "",
        recommendation: p.recommendation ?? null,
        measurements: p.measurements ?? null,
        ctffr: p.ctffr ?? null,
        backfill: Boolean(e.backfill),
      };
      const existing = state.reports.get(p.report_id);
      if (existing) {
        existing.versions.push(version);
      } else {
        state.reports.set(p.report_id, {
          reportId: p.report_id,
          pathway: p.pathway,
          parentReportId: p.parent_report_id ?? null,
          versions: [version],
        });
      }
      break;
    }

    case KIND.INTERPRETATION_CORRECTED: {
      const target = state.reports.get(p.target_report_id);
      const version = {
        eventId: e.event_id,
        kind: KIND.INTERPRETATION_CORRECTED,
        occurredAt: e.occurred_at,
        readerId: p.reader_id,
        readerRole: p.reader_role,
        findings: p.findings ?? {},
        impression: p.impression ?? "",
        recommendation: p.recommendation ?? null,
        measurements: p.measurements ?? null,
        ctffr: p.ctffr ?? null,
        reason: p.reason ?? "",
        supersedesEventId: target ? target.versions[target.versions.length - 1].eventId : null,
      };
      if (!target) {
        state.reports.set(p.target_report_id, {
          reportId: p.target_report_id,
          pathway: p.pathway,
          parentReportId: null,
          versions: [version],
        });
      } else {
        target.versions.push(version);
      }
      break;
    }

    case KIND.RISK_STRATIFIED:
      state.risk.push({
        eventId: e.event_id,
        level: p.level,
        score: p.score ?? null,
        factors: p.factors ?? [],
        rationale: p.rationale ?? "",
        by: p.by,
        occurredAt: e.occurred_at,
      });
      break;

    case KIND.CRITICAL_SIGNAL_RAISED:
      state.critical = {
        eventId: e.event_id,
        reason: p.reason,
        findings: p.findings ?? {},
        by: p.by,
        escalateTo: p.escalate_to ?? [],
        occurredAt: e.occurred_at,
        backfill: Boolean(e.backfill),
      };
      break;

    case KIND.CLINICAL_DECISION_SIGNED:
      state.decisions.push({
        eventId: e.event_id,
        decisionId: p.decision_id,
        clinicianId: p.clinician_id,
        role: p.role,
        pathway: p.pathway,
        basedOn: p.based_on_report_events ?? [],
        decision: p.decision,
        statement: p.statement ?? "",
        occurredAt: e.occurred_at,
      });
      break;

    case KIND.CONSENT_GRANTED:
      state.consents.set(p.consent_id, {
        consentId: p.consent_id,
        patientId: p.patient_id,
        purpose: p.purpose,
        receivingOrgId: p.receiving_org_id ?? null,
        sections: p.sections ?? [],
        statement: p.statement ?? "",
        grantedEventId: e.event_id,
        grantedAt: e.occurred_at,
        withdrawn: false,
        withdrawnEventId: null,
        withdrawnAt: null,
        enteredRecordAtWithdraw: false,
        traceOnly: false,
      });
      break;

    case KIND.CONSENT_WITHDRAWN: {
      const c = state.consents.get(p.consent_id);
      if (c) {
        c.withdrawn = true;
        c.withdrawnEventId = e.event_id;
        c.withdrawnAt = e.occurred_at;
        c.enteredRecordAtWithdraw = Boolean(p.entered_record);
        c.traceOnly = Boolean(p.entered_record);
      }
      break;
    }

    case KIND.SHARING_REVOKED: {
      for (const share of state.shares) {
        if (share.shareId === p.share_id) {
          share.revokedEventId = e.event_id;
          share.revokedAt = e.occurred_at;
        }
      }
      break;
    }

    case KIND.REFERRAL_CREATED:
      state.referrals.set(p.referral_id, {
        referralId: p.referral_id,
        purpose: p.purpose,
        receivingOrgId: p.receiving_org_id,
        urgency: p.urgency,
        pathway: p.pathway,
        rationale: p.rationale ?? "",
        clinicalReason: p.clinical_reason ?? "",
        packet: p.packet ?? [], // [{section, eventId/imageId?}]
        pendingSections: p.pending_sections ?? [],
        createdEventId: e.event_id,
        createdAt: e.occurred_at,
        consentId: p.consent_id,
        shares: [],
        status: "CREATED",
      });
      break;

    case KIND.REFERRAL_PACKET_SHARED: {
      const referral = state.referrals.get(p.referral_id);
      const share = {
        shareId: p.share_id,
        referralId: p.referral_id,
        consentId: p.consent_id,
        sections: p.sections ?? [],
        supplement: Boolean(p.supplement),
        eventId: e.event_id,
        sharedAt: e.occurred_at,
        enteredCare: false,
      };
      state.shares.push(share);
      if (referral) referral.shares.push(share);
      break;
    }

    case KIND.RECEIPT_ISSUED:
      state.receipts.push({
        receiptId: p.receipt_id,
        referralId: p.referral_id,
        orgId: p.receiving_org_id,
        sections: p.confirmed_sections ?? [],
        occurredAt: e.occurred_at,
        eventId: e.event_id,
      });
      break;

    case KIND.RECEIVING_ACK_ACCEPTED: {
      const ack = {
        kind: "ACCEPTED",
        referralId: p.referral_id,
        orgId: p.receiving_org_id,
        appointment: p.appointment ?? null,
        contact: p.contact ?? null,
        update: Boolean(p.update),
        occurredAt: e.occurred_at,
        eventId: e.event_id,
      };
      state.acks.push(ack);
      const referral = state.referrals.get(p.referral_id);
      if (referral) {
        referral.status = "ACCEPTED";
        referral.appointment = ack.appointment;
        referral.contact = ack.contact;
      }
      break;
    }

    case KIND.RECEIVING_ACK_REJECTED: {
      state.acks.push({
        kind: "REJECTED",
        referralId: p.referral_id,
        orgId: p.receiving_org_id,
        reason: p.reason,
        occurredAt: e.occurred_at,
        eventId: e.event_id,
      });
      const referral = state.referrals.get(p.referral_id);
      if (referral) {
        referral.status = "REJECTED";
        referral.appointment = null;
        referral.contact = null;
      }
      break;
    }

    case KIND.REFERRAL_HANDED_OVER: {
      state.handover = {
        referralId: p.referral_id,
        receivingClinicianId: p.receiving_clinician_id,
        notes: p.notes ?? "",
        eventId: e.event_id,
        occurredAt: e.occurred_at,
      };
      const referral = state.referrals.get(p.referral_id);
      if (referral) referral.status = "IN_CARE";
      for (const share of state.shares) {
        if (share.referralId === p.referral_id) share.enteredCare = true;
      }
      break;
    }

    case KIND.FINAL_DISPOSITION_RECORDED: {
      state.disposition = {
        referralId: p.referral_id,
        disposition: p.disposition,
        by: p.by,
        notes: p.notes ?? "",
        eventId: e.event_id,
        occurredAt: e.occurred_at,
      };
      const referral = state.referrals.get(p.referral_id);
      if (referral) referral.status = "CLOSED";
      state.critical = null; // 处置落定，危急升级闭环
      break;
    }

    default:
      break;
  }
}

// ---- 报告派生 ----

export function activeReportVersion(report) {
  return report.versions[report.versions.length - 1];
}

export function activeReportEvents(state) {
  const events = [];
  for (const report of state.reports.values()) {
    events.push(activeReportVersion(report).eventId);
  }
  return events;
}

// ---- 机构工作队列：危急患者置顶，但不冻结其他患者 ----

export function institutionQueue(store, originOrgId) {
  const items = [];
  for (const subjectId of store.subjectIds()) {
    const c = foldCase(store, subjectId);
    if (!c.request || c.request.origin_org_id !== originOrgId) continue;
    const stage = currentStage(c);
    items.push({
      caseId: subjectId,
      patientId: c.request.patient_id,
      modality: c.request.modality,
      pathway: c.request.pathway,
      stage,
      critical: c.critical
        ? { reason: c.critical.reason, raisedAt: c.critical.occurredAt }
        : null,
      pendingSections: [...c.referrals.values()]
        .filter((r) => r.status === "CREATED" || r.status === "ACCEPTED")
        .flatMap((r) => r.pendingSections),
      referrals: [...c.referrals.values()].map((r) => ({
        referralId: r.referralId,
        status: r.status,
        receivingOrgId: r.receivingOrgId,
      })),
      closed: c.disposition != null,
    });
  }
  items.sort((a, b) => {
    if (Boolean(a.critical) !== Boolean(b.critical)) return a.critical ? -1 : 1;
    return a.caseId < b.caseId ? -1 : 1;
  });
  return {
    orgId: originOrgId,
    total: items.length,
    criticalCount: items.filter((i) => i.critical).length,
    openCount: items.filter((i) => !i.closed).length,
    items,
  };
}

function currentStage(c) {
  if (c.disposition) return "CLOSED";
  if (c.handover) return "IN_CARE";
  if (c.referrals.size > 0) return "REFERRED";
  if (c.decisions.length > 0) return "SIGNED";
  if (c.reports.size > 0) return "REPORTED";
  if (c.images.size > 0) return "ACQUIRED";
  if (c.acquisition) return "PREPARED";
  return "REQUESTED";
}

// ---- 患者视图：预约与联系人只能来自接收机构最新确认 ----

export function patientView(store, caseId) {
  const c = foldCase(store, caseId);
  const referrals = [...c.referrals.values()].map((r) => {
    const ack = [...c.acks].reverse().find((a) => a.referralId === r.referralId);
    return {
      referralId: r.referralId,
      receivingOrgId: r.receivingOrgId,
      purpose: r.purpose,
      status: r.status,
      appointment: ack?.kind === "ACCEPTED" ? ack.appointment : null,
      contact: ack?.kind === "ACCEPTED" ? ack.contact : null,
      rejectedReason: ack?.kind === "REJECTED" ? ack.reason : null,
      lastConfirmedAt: ack ? ack.occurredAt : null,
    };
  });
  return {
    caseId,
    patientId: c.request?.patient_id ?? null,
    referrals,
    consents: [...c.consents.values()].map((x) => ({
      consentId: x.consentId,
      purpose: x.purpose,
      sections: x.sections,
      grantedAt: x.grantedAt,
      withdrawn: x.withdrawn,
      withdrawnAt: x.withdrawnAt,
      inMedicalRecord: x.enteredRecordAtWithdraw,
    })),
  };
}

// ---- 转诊还原：影像 → 判读 → 交接 → 处置 的完整时间线 ----

const CASE_LEVEL_KINDS = new Set([
  KIND.EXAMINATION_REQUESTED,
  KIND.ACQUISITION_PREPARED,
  KIND.IMAGES_INDEXED,
  KIND.IMAGE_UPLOAD_DEDUPLICATED,
  KIND.INTERPRETATION_RECORDED,
  KIND.SUPPLEMENTAL_OPINION_ADDED,
  KIND.INTERPRETATION_CORRECTED,
  KIND.RISK_STRATIFIED,
  KIND.CRITICAL_SIGNAL_RAISED,
  KIND.CLINICAL_DECISION_SIGNED,
  KIND.CONSENT_GRANTED,
  KIND.CONSENT_WITHDRAWN,
]);

export function referralTimeline(store, caseId, referralId = null) {
  const physical = new Map(
    store.physicalStream(caseId).map((e) => [e.event_id, e])
  );
  const entries = [];
  for (const e of store.stream(caseId)) {
    const belongsToReferral = e.payload?.referral_id === referralId;
    if (referralId && !CASE_LEVEL_KINDS.has(e.kind) && !belongsToReferral) continue;
    const phys = physical.get(e.event_id);
    const arrivedLater =
      phys?.recorded_at &&
      Date.parse(phys.recorded_at) > Date.parse(e.occurred_at);
    entries.push({
      eventId: e.event_id,
      kind: e.kind,
      version: e.version,
      occurredAt: e.occurred_at,
      recordedAt: phys?.recorded_at ?? null,
      backfill: Boolean(e.backfill),
      arrivedLater: Boolean(arrivedLater),
      referralId: e.payload?.referral_id ?? null,
      summary: summarize(e),
    });
  }
  return entries;
}

function summarize(e) {
  const p = e.payload ?? {};
  switch (e.kind) {
    case KIND.IMAGES_INDEXED:
      return `影像索引 ${(p.accepted ?? []).map((x) => x.image_id).join(",")}（${p.connectivity}）`;
    case KIND.INTERPRETATION_RECORDED:
      return `结构化判读 ${p.report_id}：${p.impression}`;
    case KIND.SUPPLEMENTAL_OPINION_ADDED:
      return p.ctffr ? `CT-FFR 补充判断 ${p.report_id}` : `补充意见 ${p.report_id}`;
    case KIND.INTERPRETATION_CORRECTED:
      return `专家更正 ${p.target_report_id}：${p.reason}`;
    case KIND.REFERRAL_CREATED:
      return `转诊 ${p.referral_id} → ${p.receiving_org_id}（${p.urgency}）`;
    case KIND.RECEIVING_ACK_ACCEPTED:
      return p.update ? "预约信息更新" : "接收机构确认接受并预约";
    case KIND.REFERRAL_HANDED_OVER:
      return "交接完成，资料进入诊疗";
    case KIND.FINAL_DISPOSITION_RECORDED:
      return `最终处置：${p.disposition}`;
    default:
      return e.kind;
  }
}

// ---- 披露台账：每一次跨院披露及其授权状态 ----

export function disclosureLedger(store, caseId) {
  const c = foldCase(store, caseId);
  return c.shares.map((s) => {
    const consent = c.consents.get(s.consentId);
    return {
      shareId: s.shareId,
      referralId: s.referralId,
      receivingOrgId: c.referrals.get(s.referralId)?.receivingOrgId ?? null,
      sections: s.sections,
      purpose: consent?.purpose ?? null,
      sharedAt: s.sharedAt,
      enteredCare: s.enteredCare,
      revokedAt: s.revokedAt ?? null,
      consentWithdrawn: consent?.withdrawn ?? false,
      trace: s.enteredCare ? "已进入病历，撤回仅留痕" : s.revokedAt ? "授权撤回，共享已停止" : "共享中",
    };
  });
}

export { PURPOSE_SECTIONS };
