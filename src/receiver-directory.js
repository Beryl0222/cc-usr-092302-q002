import { DomainError, ERR } from "./errors.js";

// 接收机构目录：保存各接收机构的实际受理能力、预约号源与联系人。
// 目录带版本号；预约/确认必须与患者看到时的目录版本一致——
// 号源或联系人一旦变化，旧预约信息立即失效，必须重新给出，
// 保证患者看到的预约时间与联系人始终等于接收机构当前真实状态。
export class ReceiverDirectory {
  #orgs = new Map(); // orgId -> { name, accepting, slots: Map(slotId->{at, taken, contact}), version }

  register(orgId, { name = "", contact = null } = {}) {
    this.#orgs.set(orgId, { name, accepting: true, contact, slots: new Map(), version: 1 });
    return this.snapshot(orgId);
  }

  #get(orgId) {
    const org = this.#orgs.get(orgId);
    if (!org) throw new DomainError(ERR.UNKNOWN_STREAM, `未登记的接收机构: ${orgId}`, { orgId });
    return org;
  }

  snapshot(orgId) {
    const org = this.#get(orgId);
    return {
      org_id: orgId,
      name: org.name,
      accepting: org.accepting,
      contact: org.contact,
      version: org.version,
      slots: [...org.slots.values()].map((s) => ({ slot_id: s.slotId, scheduled_at: s.at, taken: s.taken })),
    };
  }

  versionOf(orgId) {
    return this.#get(orgId).version;
  }

  setAccepting(orgId, accepting, contact) {
    const org = this.#get(orgId);
    org.accepting = accepting;
    if (contact !== undefined) org.contact = contact;
    org.version += 1;
    return org.version;
  }

  addSlot(orgId, slotId, at, contact = undefined) {
    const org = this.#get(orgId);
    org.slots.set(slotId, { slotId, at, taken: false, contact: contact ?? org.contact });
    org.version += 1;
    return org.version;
  }

  // 号源被占用/取消或联系人调整都会推进版本。
  updateSlot(orgId, slotId, patch = {}) {
    const org = this.#get(orgId);
    const slot = org.slots.get(slotId);
    if (!slot) throw new DomainError(ERR.BAD_INPUT, `号源不存在: ${slotId}`);
    if (patch.at !== undefined) slot.at = patch.at;
    if (patch.taken !== undefined) slot.taken = patch.taken;
    if (patch.contact !== undefined) slot.contact = patch.contact;
    org.version += 1;
    return org.version;
  }

  // 校验某次预约引用的目录版本仍然有效；机构暂停受理、号源已占、时间/联系人变更都会失配。
  // 已确认的预约号源本就属于该患者，allowTaken 用于确认后的视图校验。
  assertAppointmentCurrent(orgId, { slotId, directoryVersion, allowTaken = false }) {
    const org = this.#get(orgId);
    if (!org.accepting) {
      throw new DomainError(ERR.BAD_INPUT, "接收机构当前暂停受理，预约需重新安排", { orgId });
    }
    const slot = org.slots.get(slotId);
    if (!slot) throw new DomainError(ERR.BAD_INPUT, "号源已撤销，预约需重新安排", { orgId, slotId });
    if (slot.taken && !allowTaken) throw new DomainError(ERR.BAD_INPUT, "号源已被占用，预约需重新安排", { orgId, slotId });
    if (directoryVersion !== org.version) {
      throw new DomainError(ERR.BAD_INPUT, "接收机构号源/联系人状态已更新，须向患者提供最新预约", {
        orgId, slotId, seenVersion: directoryVersion, currentVersion: org.version,
      });
    }
    return { scheduledAt: slot.at, contact: slot.contact, version: org.version };
  }

  markTaken(orgId, slotId) {
    return this.updateSlot(orgId, slotId, { taken: true });
  }

  // 已确认预约的核对：机构级版本可能因无关号源变动而前进，因此直接比对
  // 该号源当前的时间与联系人，并允许"已被本患者占用"。
  assertSlotMatches(orgId, { slotId, scheduledAt, contact }) {
    const org = this.#get(orgId);
    if (!org.accepting) throw new DomainError(ERR.BAD_INPUT, "接收机构当前暂停受理", { orgId });
    const slot = org.slots.get(slotId);
    if (!slot) throw new DomainError(ERR.BAD_INPUT, "号源已撤销", { orgId, slotId });
    if (slot.at !== scheduledAt) {
      throw new DomainError(ERR.BAD_INPUT, "预约时间已被机构调整", { slotId, expected: scheduledAt, actual: slot.at });
    }
    if (slot.contact !== contact) {
      throw new DomainError(ERR.BAD_INPUT, "联系人已变更", { slotId });
    }
    return { scheduledAt: slot.at, contact: slot.contact, version: org.version };
  }
}
