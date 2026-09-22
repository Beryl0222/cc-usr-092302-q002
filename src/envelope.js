// 事件信封：沿用基线合同（event_id/kind/occurred_at/subject_id/version），
// 补充链路归属、操作者、因果关联与入库时间。基线字段含义保持不变。

const REQUIRED = ["event_id", "kind", "occurred_at", "subject_id", "version"];

// 返回缺失字段名数组；为空数组表示通过。保持与基线 src/contract.js 相同的契约形状。
export function validate(record) {
  return REQUIRED.filter((name) => record?.[name] === undefined || record?.[name] === null);
}

// 由事件存储在追加时调用，业务层不要自行分配 version/recorded_at/seq。
export function buildEnvelope({
  eventId,
  kind,
  occurredAt,
  subjectId,
  streamId,
  version,
  actor,
  chain = null,
  payload = {},
  causationId = null,
  supersedesVersion = null,
  backfilled = false,
  recordedAt,
  seq,
}) {
  const event = {
    event_id: eventId,
    kind,
    occurred_at: occurredAt,
    subject_id: subjectId,
    version,
    stream_id: streamId,
    seq,
    recorded_at: recordedAt,
    actor_id: actor.id,
    actor_role: actor.role,
    chain,
    payload,
    causation_id: causationId,
    supersedes_version: supersedesVersion,
    backfilled,
  };
  const missing = validate(event);
  if (missing.length > 0) {
    throw new Error(`事件信封缺少必填字段: ${missing.join(", ")}`);
  }
  return event;
}
