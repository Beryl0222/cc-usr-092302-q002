import { KIND, REFERRAL_STATUS, CHAIN_LABEL } from "./vocabulary.js";
import { foldExam, foldReferral } from "./projections.js";

// 读模型：只负责"怎么看"，所有状态都从事件流现场折叠，不落第二份事实。

// 机构工作队列。
// 关键语义：危急升级只会把"该患者"的任务提到队列最前并打红，
// 队列本身没有任何锁定/冻结——其他患者的待办照旧在列、可被领取处理。
export function orgWorklist(store, orgId) {
  const exams = [];
  const streams = new Set();
  for (const e of store.readAll()) {
    if (!e.stream_id.startsWith("exam:")) continue;
    streams.add(e.stream_id);
  }
  for (const streamId of streams) {
    const events = store.readStream(streamId);
    if (events[0]?.payload?.org_id !== orgId) continue;
    const exam = foldExam(events);
    const awaiting = exam.signOff
      ? "SIGNED_OFF"
      : exam.critical?.active
        ? "CRITICAL_AWAITING_ACK"
        : exam.latestInterpretationVersion > 0
          ? "AWAITING_SIGN_OFF"
          : exam.images.size > 0
            ? "AWAITING_INTERPRETATION"
            : "AWAITING_IMAGING";
    exams.push({
      exam_id: exam.examId,
      patient_id: exam.patientId,
      modality: exam.modality,
      chain: exam.purpose,
      chain_label: CHAIN_LABEL[exam.purpose],
      risk: exam.risk?.level ?? null,
      critical_active: exam.critical?.active ?? false,
      critical_acknowledged: exam.critical?.acknowledged ?? false,
      awaiting,
      latest_interpretation_version: exam.latestInterpretationVersion,
      signed_off: exam.signOff !== null,
      last_seq: events[events.length - 1].seq,
      // 断网补传的任务依然可被领取，只做提示。
      has_backfill: events.some((x) => x.backfilled),
    });
  }

  const rank = (item) => {
    if (item.critical_active) return 0; // 仅相关患者升级
    if (item.risk === "HIGH") return 1;
    return 2;
  };
  exams.sort((a, b) => rank(a) - rank(b) || a.last_seq - b.last_seq);
  return {
    org_id: orgId,
    total: exams.length,
    frozen: false, // 队列结构上不存在冻结状态
    items: exams,
  };
}

// 患者侧预约视图：显示的时间与联系人必须与接收机构当前实际状态一致。
// 任何与目录不符的情况都显示 STALE 并提示重新联系，绝不展示过期信息冒充有效。
export function patientAppointmentView(service, directory, referralId) {
  const referral = service.referralState(referralId);
  if (!referral.appointment) {
    return {
      referral_id: referralId,
      status: referral.status,
      appointment: null,
      consistency: referral.status === REFERRAL_STATUS.REVOKED ? "REVOKED" : "NO_APPOINTMENT",
    };
  }

  let current = null;
  let mismatch = null;
  try {
    if (referral.appointment.confirmedAt) {
      // 已确认：直接核对该号源的实际时间/联系人，不受机构内其他号源变动影响。
      current = directory.assertSlotMatches(referral.receiverOrgId, {
        slotId: referral.appointment.slotId,
        scheduledAt: referral.appointment.scheduledAt,
        contact: referral.appointment.contact,
      });
    } else {
      // 待确认：目录任何推进都使旧要约失效，须重新给出。
      current = directory.assertAppointmentCurrent(referral.receiverOrgId, {
        slotId: referral.appointment.slotId,
        directoryVersion: referral.appointment.directoryVersion,
      });
    }
  } catch (err) {
    mismatch = err.details ?? { reason: err.code };
  }

  const base = {
    referral_id: referralId,
    receiver_org_id: referral.receiverOrgId,
    slot_id: referral.appointment.slotId,
    status: referral.status,
    confirmed_at_event: referral.appointment.confirmedAt,
  };

  if (referral.status === REFERRAL_STATUS.REVOKED) {
    return { ...base, appointment: null, consistency: "REVOKED" };
  }
  if (mismatch) {
    return {
      ...base,
      appointment: null, // 不把过期时间/联系人给患者看
      consistency: "STALE",
      stale_reason: mismatch,
      notice: "接收机构安排已变化，原预约信息失效，请按机构最新通知重新确认",
    };
  }
  return {
    ...base,
    consistency: "CURRENT",
    appointment: {
      scheduled_at: current.scheduledAt,
      contact: current.contact,
      directory_version: current.version,
      confirmed: referral.appointment.confirmedAt !== null,
    },
  };
}

// 转诊索引：供"从一次转诊还原全过程"的入口使用。
export function referralSummary(service, referralId) {
  const r = service.referralState(referralId);
  return {
    referral_id: referralId,
    patient_id: r.patientId,
    chain: r.purpose,
    chain_label: CHAIN_LABEL[r.purpose],
    receiver_org_id: r.receiverOrgId,
    status: r.status,
    reason: r.reason,
    risk_level: r.riskLevel,
    exams: r.examIds,
    consent_status: r.consent?.status ?? null,
    disclosures: r.disclosures.length,
    appointment_confirmed: r.appointment?.confirmedAt !== null,
    handoff_at: r.handoff?.at ?? null,
    disposition: r.disposition
      ? { outcome: r.disposition.outcome, record_locator: r.disposition.recordLocator }
      : null,
    withdrawal_after_record: r.withdrawalAfterRecord,
    withdrawal_in_care: r.withdrawalInCare,
    sharing_stopped: r.sharingStopped,
  };
}

export { foldExam, foldReferral };
