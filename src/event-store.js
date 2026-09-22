import { DomainError, ERR } from "./errors.js";
import { buildEnvelope } from "./envelope.js";

// 事件存储：只追加（append-only）。
//
// 版本语义：
// - version：每个流（stream）内从 1 单调递增，按"到达并被接受"的顺序分配，
//   断网补传晚到也拿新版本号，但带 backfilled 标记与原始 occurred_at；
// - seq：全库全局到达序号，机构队列按它排序——单个患者的危急升级只改变该患者的
//   优先级标记，不会阻止其他事件写入（队列永不被冻结）；
// - event_id 全局幂等：同一 event_id 重复提交（断网重试/重复上传）原样返回已存事件，
//   不产生第二个版本；
// - expectedVersion：乐观并发，调用方基于自己读到的流版本写入。
export class EventStore {
  #events = [];
  #byId = new Map();
  #streams = new Map(); // streamId -> { version, subjectId, lastOccurredAt, chains }
  #clock;

  constructor({ clock = () => new Date().toISOString() } = {}) {
    this.#clock = clock;
  }

  #head(streamId) {
    return this.#streams.get(streamId);
  }

  append(
    command,
    { expectedVersion, backfill = false } = {},
  ) {
    const { eventId, kind, occurredAt, subjectId, streamId, actor, chain = null, payload = {}, causationId = null, supersedesVersion = null } = command;

    // 幂等：同一事件再次提交（基层断网后重试、同一文件重复上传）直接回放，不占新版本。
    const existing = this.#byId.get(eventId);
    if (existing) {
      return { event: existing, duplicate: true };
    }

    const head = this.#head(streamId);
    const currentVersion = head ? head.version : 0;
    if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
      throw new DomainError(ERR.CONCURRENT_WRITE, "流版本已变化，请重读后再写", {
        streamId,
        expectedVersion,
        currentVersion,
      });
    }

    // 业务时间顺序：正常提交不允许 occurred_at 倒退；断网补传必须显式 backfill。
    // 时间字符串可能带不同时区写法（+08:00 / Z），一律按时间戳数值比较。
    if (head && Date.parse(occurredAt) < Date.parse(head.lastOccurredAt) && !backfill) {
      throw new DomainError(ERR.LATE_EVENT, "事件发生时间早于该流最新版本；断网补传请走 backfill", {
        streamId,
        occurredAt,
        lastOccurredAt: head.lastOccurredAt,
      });
    }

    const version = currentVersion + 1;
    const seq = this.#events.length + 1;
    const event = buildEnvelope({
      eventId,
      kind,
      occurredAt,
      subjectId,
      streamId,
      version,
      actor,
      chain,
      payload,
      causationId,
      supersedesVersion,
      backfilled: backfill,
      recordedAt: this.#clock(),
      seq,
    });

    this.#events.push(event);
    this.#byId.set(eventId, event);
    this.#streams.set(streamId, {
      version,
      subjectId,
      lastOccurredAt: head ? (occurredAt > head.lastOccurredAt ? occurredAt : head.lastOccurredAt) : occurredAt,
    });
    return { event, duplicate: false };
  }

  streamVersion(streamId) {
    return this.#head(streamId)?.version ?? 0;
  }

  readStream(streamId) {
    return this.#events.filter((e) => e.stream_id === streamId);
  }

  // 按全局到达顺序读取（机构工作队列用；升级标记在投影层处理，不在这里加锁/过滤）。
  readAll() {
    return [...this.#events].sort((a, b) => a.seq - b.seq);
  }

  getEvent(eventId) {
    return this.#byId.get(eventId) ?? null;
  }
}
