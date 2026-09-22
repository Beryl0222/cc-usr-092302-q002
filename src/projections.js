import { KIND, REFERRAL_STATUS, CONSENT } from "./vocabulary.js";

// 纯函数状态折叠：把一个流上的事件序列还原为当前状态。
// 不做权限判断（那是服务层的职责），只如实反映"发生过什么"。

export function foldExam(events) {
  const state = {
    examId: null,
    patientId: null,
    orgId: null,
    modality: null,
    purpose: null,
    requestingClinicianId: null,
    requestedAt: null,
    deployment: null,
    images: new Map(), // imageId -> 影像索引（含 suppressed 标记）
    checksums: new Map(), // checksum -> imageId（重复上传识别）
    interpretations: [], // 按版本顺序；被更正的版本保留并打 supersededBy
    latestInterpretationVersion: 0,
    risk: null,
    critical: null, // { active, acknowledged, signals, reason, escalatedAt, acknowledgedAt }
    signOff: null, // 临床医生签署；为 null 时影像意见不能驱动转诊
  };

  for (const e of events) {
    const p = e.payload;
    switch (e.kind) {
      case KIND.EXAMINATION_REQUESTED:
        Object.assign(state, {
          examId: p.exam_id,
          patientId: p.patient_id,
          orgId: p.org_id,
          modality: p.modality,
          purpose: p.purpose,
          requestingClinicianId: p.clinician_id,
          requestedAt: e.occurred_at,
        });
        break;

      case KIND.DEPLOYMENT_RECORDED:
        state.deployment = {
          deviceId: p.device_id,
          deviceName: p.device_name,
          protocolId: p.protocol_id,
          protocolVersion: p.protocol_version,
          recordedAt: e.occurred_at,
        };
        break;

      case KIND.IMAGE_INDEXED: {
        const img = state.images.get(p.image_id) ?? {
          imageId: p.image_id,
          storageUri: p.storage_uri,
          checksum: p.checksum,
          seriesUid: p.series_uid,
          acquiredAt: p.acquired_at,
          suppressed: false,
          indexedVersions: [],
        };
        img.indexedVersions.push(e.version); // 重复/补传在同一影像上留下版本痕迹
        state.images.set(p.image_id, img);
        state.checksums.set(p.checksum, p.image_id);
        break;
      }

      case KIND.IMAGE_SUPPRESSED: {
        const img = state.images.get(p.image_id);
        if (img) img.suppressed = true;
        break;
      }

      case KIND.INTERPRETATION_RECORDED: {
        const version = state.interpretations.length + 1;
        // 同一谱系的再次判读自动取代前一有效版本：解剖学判读与附属分析各成谱系，
        // 附属分析的出现不取代解剖学判读。被取代的版本仍完整保留。
        const lineage = (i) => Boolean(i.adjunct) === Boolean(p.adjunct ?? false);
        const previous = [...state.interpretations].reverse()
          .find((i) => lineage(i) && i.supersededBy === null);
        if (previous) previous.supersededBy = version;
        state.interpretations.push({
          version,
          interpretationId: p.interpretation_id,
          imageIds: [...p.image_ids],
          findings: p.findings, // 结构化判读
          recommendation: p.recommendation,
          interpreterId: e.actor_id,
          interpreterRole: e.actor_role,
          recordedAt: e.occurred_at,
          adjunct: p.adjunct ?? false,
          supplements: [],
          supersededBy: null,
        });
        state.latestInterpretationVersion = version;
        break;
      }

      case KIND.SUPPLEMENT_RECORDED: {
        const target = state.interpretations.find((i) => i.version === p.interpretation_version);
        if (target) {
          target.supplements.push({
            supplementId: p.supplement_id,
            body: p.body,
            expertId: e.actor_id,
            at: e.occurred_at,
          });
        }
        break;
      }

      case KIND.INTERPRETATION_CORRECTED: {
        const target = state.interpretations.find((i) => i.version === p.interpretation_version);
        const version = state.interpretations.length + 1;
        state.interpretations.push({
          version,
          interpretationId: p.interpretation_id,
          imageIds: target ? [...target.imageIds] : [...p.image_ids],
          findings: p.findings,
          recommendation: p.recommendation,
          interpreterId: e.actor_id,
          interpreterRole: e.actor_role,
          recordedAt: e.occurred_at,
          adjunct: target?.adjunct ?? false,
          supplements: [],
          supersededBy: null,
          correctedFrom: p.interpretation_version,
        });
        if (target) target.supersededBy = version;
        state.latestInterpretationVersion = version;
        break;
      }

      case KIND.RISK_STRATIFIED:
        state.risk = { level: p.risk_level, rationale: p.rationale, at: e.occurred_at, by: e.actor_id };
        break;

      case KIND.CRITICAL_SIGNAL_ESCALATED:
        state.critical = {
          active: true,
          acknowledged: false,
          signals: [...p.signals],
          reason: p.reason,
          escalatedAt: e.occurred_at,
          escalatedBy: e.actor_id,
          acknowledgedAt: null,
        };
        break;

      case KIND.ESCALATION_ACKNOWLEDGED:
        if (state.critical) {
          state.critical.active = false;
          state.critical.acknowledged = true;
          state.critical.acknowledgedAt = e.occurred_at;
          state.critical.acknowledgedBy = e.actor_id;
        }
        break;

      case KIND.CLINICAL_SIGN_OFF:
        state.signOff = {
          clinicianId: p.clinician_id,
          role: e.actor_role,
          scope: p.scope,
          interpretationVersion: p.interpretation_version ?? state.latestInterpretationVersion,
          at: e.occurred_at,
        };
        break;
    }
  }
  return state;
}

export function foldReferral(events) {
  const state = {
    referralId: null,
    patientId: null,
    purpose: null,
    fromOrgId: null,
    receiverOrgId: null,
    examIds: [],
    reason: null,
    riskLevel: null,
    consent: null, // { status, categories, grantedAt, withdrawnAt, withdrawReason }
    status: null,
    openedAt: null,
    disclosures: [],
    acceptedAt: null,
    acceptedBy: null,
    appointment: null, // { scheduledAt, slotId, contact, directoryVersion, confirmedAt }
    handoff: null,
    disposition: null,
    // 撤回发生在进入病历之后：事件本身即为可追溯留痕，状态不回退。
    withdrawalAfterRecord: false,
    withdrawalInCare: false, // 已交接但尚未形成病历决定：留痕且禁止再披露
    // 撤回时尚未用于诊疗：接收方须停止使用并处置已收资料。
    purgeRequired: false,
    sharingStopped: false,
  };

  for (const e of events) {
    const p = e.payload;
    switch (e.kind) {
      case KIND.CONSENT_GRANTED:
        state.referralId = p.referral_id;
        state.patientId = p.patient_id;
        state.purpose = p.purpose;
        state.receiverOrgId = p.receiver_org_id;
        state.consent = {
          status: CONSENT.GRANTED,
          receiverOrgId: p.receiver_org_id,
          categories: [...p.categories],
          examIds: [...p.exam_ids],
          grantedAt: e.occurred_at,
          withdrawnAt: null,
          withdrawReason: null,
        };
        break;

      case KIND.CONSENT_WITHDRAWN:
        if (state.consent) {
          state.consent.status = CONSENT.WITHDRAWN;
          state.consent.withdrawnAt = e.occurred_at;
          state.consent.withdrawReason = p.reason;
        }
        if (state.disposition) {
          // 已进入病历的决定不能抹除：撤回仅作为留痕，转诊保持 CLOSED。
          state.withdrawalAfterRecord = true;
        } else if (state.handoff) {
          // 已在诊疗中：不能收回，但禁止任何后续披露，并等待最终处置留痕。
          state.withdrawalInCare = true;
        } else {
          // 尚未用于诊疗：停止共享，已披露资料须由接收方处置。
          state.status = REFERRAL_STATUS.REVOKED;
          state.purgeRequired = state.disclosures.length > 0;
          state.appointment = null;
        }
        break;

      case KIND.SHARING_DISCONTINUED:
        // 接收机构确认：已停止访问、未入病历的资料完成处置。
        state.sharingStopped = true;
        state.purgeRequired = false;
        state.sharingStoppedAt = e.occurred_at;
        state.sharingStoppedBy = e.actor_id;
        break;

      case KIND.REFERRAL_OPENED:
        Object.assign(state, {
          referralId: p.referral_id,
          patientId: p.patient_id,
          purpose: p.purpose,
          fromOrgId: p.from_org_id,
          receiverOrgId: p.receiver_org_id,
          examIds: [...p.exam_ids],
          reason: p.reason,
          riskLevel: p.risk_level ?? null,
          openedAt: e.occurred_at,
          status: REFERRAL_STATUS.OPENED,
        });
        break;

      case KIND.REFERRAL_DISCLOSURE_MADE:
        state.disclosures.push({
          at: e.occurred_at,
          eventId: e.event_id,
          categories: [...p.categories],
          pack: p.pack,
        });
        state.status = REFERRAL_STATUS.DISCLOSED;
        break;

      case KIND.REFERRAL_ACCEPTED:
        state.acceptedAt = e.occurred_at;
        state.acceptedBy = e.actor_id;
        state.status = REFERRAL_STATUS.ACCEPTED;
        break;

      case KIND.APPOINTMENT_OFFERED:
        state.appointment = {
          slotId: p.slot_id,
          scheduledAt: p.scheduled_at,
          contact: p.contact,
          directoryVersion: p.directory_version,
          offeredAt: e.occurred_at,
          confirmedAt: null,
        };
        break;

      case KIND.APPOINTMENT_CONFIRMED:
        if (state.appointment) {
          state.appointment.confirmedAt = e.occurred_at;
          state.appointment.contact = p.contact ?? state.appointment.contact;
          state.appointment.directoryVersion = p.directory_version ?? state.appointment.directoryVersion;
        }
        state.status = REFERRAL_STATUS.APPOINTED;
        break;

      case KIND.HANDOFF_ACKNOWLEDGED:
        state.handoff = { at: e.occurred_at, by: e.actor_id, receiverOrgId: p.receiver_org_id };
        state.status = REFERRAL_STATUS.IN_CARE;
        state.purgeRequired = false; // 资料已用于诊疗
        break;

      case KIND.DISPOSITION_RECORDED:
        state.disposition = {
          outcome: p.outcome,
          recordLocator: p.record_locator,
          at: e.occurred_at,
          by: e.actor_id,
        };
        state.status = REFERRAL_STATUS.CLOSED;
        break;
    }
  }
  return state;
}
