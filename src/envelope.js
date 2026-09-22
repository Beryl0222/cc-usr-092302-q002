// 事件信封校验，沿用基线契约（src/contract.js 的 required 约定），并扩展时间语义检查。
const REQUIRED = ["event_id", "kind", "occurred_at", "subject_id", "version"];

// 工厂阶段 version 允许缺省（由存储定版）；其余字段必须齐备。
const REQUIRED_BEFORE_STORE = ["event_id", "kind", "occurred_at", "subject_id"];

export function validateEnvelope(record, { versionAssignedByStore = true } = {}) {
  const required = versionAssignedByStore ? REQUIRED_BEFORE_STORE : REQUIRED;
  const missing = required.filter((name) => !(name in record));
  if (missing.length > 0) return missing;
  if (Number.isNaN(Date.parse(record.occurred_at))) {
    return ["occurred_at(invalid)"];
  }
  return [];
}

// 兼容基线导出：原始合同只要求字段存在。
export function validate(record) {
  return REQUIRED.filter((name) => !(name in record));
}
