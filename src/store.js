// 仅追加事件存储。
// 每个病例（subject_id = case_id）是一条独立事件流。
//
// 两套顺序，职责分开：
//   version    物理落库顺序，一旦分配永不改变（审计与回执引用 event_id，不引用会移动的位置）；
//   临床顺序   重放/还原时按 (occurred_at, local_seq, version) 排列——断网恢复后补传的事件
//              虽晚到（version 更大），仍回到其现场发生时应在的位置，并带 backfill 标记。
// 重复上传：相同幂等键只生效一次；专家更正：只追加更正事件，绝不修改旧事件。

import { validateEnvelope } from "./envelope.js";

export class EventStore {
  constructor({ clock = () => new Date().toISOString() } = {}) {
    this._clock = clock;
    /** @type {Map<string, Array<object>>} subject_id -> 已定版事件 */
    this._streams = new Map();
    /** @type {Map<string, string>} 幂等键 -> `${subject_id}:${event_id}` */
    this._idempotency = new Map();
  }

  /**
   * 追加事件。event 须含 event_id/kind/occurred_at/subject_id，version 由存储定版。
   * 返回 { status: "appended" | "duplicate", event }。
   */
  append(event, { idempotencyKey, backfill = false } = {}) {
    const missing = validateEnvelope(event);
    if (missing.length > 0) {
      throw new Error(`事件缺少必填字段: ${missing.join(", ")}`);
    }

    // 幂等键按病例（事件流）隔离：不同病例可复用同一上传批次号而互不干扰。
    const key = `${event.subject_id}:${idempotencyKey ?? event.event_id}`;
    const seenEventId = this._idempotency.get(key);
    if (seenEventId) {
      const existing = this._streams
        .get(event.subject_id)
        .find((e) => e.event_id === seenEventId);
      return { status: "duplicate", event: existing };
    }

    const stream = this._streams.get(event.subject_id) ?? [];
    if (stream.some((e) => e.event_id === event.event_id)) {
      throw new Error(`事件 ${event.event_id} 在流 ${event.subject_id} 中已存在`);
    }

    const recorded = {
      ...event,
      version: stream.length + 1, // 物理版本，不可变
      recorded_at: this._clock(),
    };
    if (backfill) recorded.backfill = true;
    stream.push(recorded);

    this._streams.set(event.subject_id, stream);
    this._idempotency.set(key, event.event_id);
    return { status: "appended", event: recorded };
  }

  /** 临床顺序重放（断网补传的事件回到其发生时的位置）。 */
  stream(subjectId) {
    return [...(this._streams.get(subjectId) ?? [])].sort(compareClinical);
  }

  /** 物理落库顺序（审计：系统实际获知事件的先后）。 */
  physicalStream(subjectId) {
    return [...(this._streams.get(subjectId) ?? [])];
  }

  has(subjectId) {
    return this._streams.has(subjectId);
  }

  subjectIds() {
    return [...this._streams.keys()];
  }

  /** 跨病例扫描（机构队列、危急升级等投影使用），按临床顺序产出。 */
  *scan() {
    for (const [subjectId, stream] of this._streams) {
      for (const event of [...stream].sort(compareClinical)) {
        yield { subjectId, event };
      }
    }
  }
}

export function compareClinical(a, b) {
  const ta = Date.parse(a.occurred_at);
  const tb = Date.parse(b.occurred_at);
  if (ta !== tb) return ta - tb;
  const sa = a.local_seq ?? 0;
  const sb = b.local_seq ?? 0;
  if (sa !== sb) return sa - sb;
  return a.version - b.version;
}
