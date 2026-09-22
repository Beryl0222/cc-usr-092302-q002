import assert from "node:assert/strict";
import test from "node:test";
import { EventStore } from "../src/store.js";
import { validate } from "../src/contract.js";

function evt(kind, occurredAt, extra = {}) {
  return {
    event_id: extra.event_id ?? `e-${Math.random().toString(36).slice(2)}`,
    kind,
    occurred_at: occurredAt,
    subject_id: "case-1",
    ...extra,
  };
}

test("物理版本按落库顺序单调分配且不可变", () => {
  const store = new EventStore();
  store.append(evt("A", "2026-09-22T09:00:00+08:00"));
  store.append(evt("B", "2026-09-22T10:00:00+08:00"));
  const physical = store.physicalStream("case-1");
  assert.deepEqual(physical.map((e) => e.version), [1, 2]);
  assert.deepEqual(physical.map((e) => validate(e)), [[], []]);
});

test("断网补传：临床顺序回到发生时刻位置，物理版本仍保留迟到事实", () => {
  const clock = () => "2026-09-22T11:00:00+08:00"; // 补传统一在 11:00 落库
  const store = new EventStore({ clock });

  // 08:50 设备准备（在线）
  store.append(evt("ACQUISITION_PREPARED", "2026-09-22T08:50:00+08:00", { event_id: "prep" }));
  // 10:30 中心在线完成风险分层
  store.append(evt("RISK_STRATIFIED", "2026-09-22T10:30:00+08:00", { event_id: "risk" }));
  // 11:00 补传 09:05 现场已发生的危急信号
  const r = store.append(
    evt("CRITICAL_SIGNAL_RAISED", "2026-09-22T09:05:00+08:00", { event_id: "crit" }),
    { backfill: true }
  );

  assert.equal(r.status, "appended");
  assert.equal(r.event.backfill, true);
  assert.equal(r.event.version, 3, "物理版本是第 3 条落库事件");

  const clinicalKinds = store.stream("case-1").map((e) => e.kind);
  assert.deepEqual(clinicalKinds, [
    "ACQUISITION_PREPARED",
    "CRITICAL_SIGNAL_RAISED", // 09:05 回到风险分层之前
    "RISK_STRATIFIED",
  ]);

  const physicalKinds = store.physicalStream("case-1").map((e) => e.kind);
  assert.deepEqual(physicalKinds, [
    "ACQUISITION_PREPARED",
    "RISK_STRATIFIED",
    "CRITICAL_SIGNAL_RAISED", // 物理上仍是最后到达
  ]);

  // 旧事件的物理 version 不因为补传而改变
  assert.equal(store.physicalStream("case-1")[1].version, 2);
});

test("重复上传：相同幂等键只生效一次", () => {
  const store = new EventStore();
  const payload = evt("IMAGES_INDEXED", "2026-09-22T09:00:00+08:00", { event_id: "up-1" });
  const first = store.append(payload, { idempotencyKey: "upload:u1" });
  const second = store.append({ ...payload }, { idempotencyKey: "upload:u1" });
  assert.equal(first.status, "appended");
  assert.equal(second.status, "duplicate");
  assert.equal(second.event.event_id, "up-1");
  assert.equal(store.physicalStream("case-1").length, 1);
});

test("同流内 event_id 不可伪造重复", () => {
  const store = new EventStore();
  store.append(evt("A", "2026-09-22T09:00:00+08:00", { event_id: "x" }));
  assert.throws(
    () => store.append(evt("B", "2026-09-22T09:10:00+08:00", { event_id: "x" }), { idempotencyKey: "other" }),
    /已存在/
  );
});

test("信封缺字段或时间非法被拒绝", () => {
  const store = new EventStore();
  assert.throws(() => store.append({ kind: "X", occurred_at: "t", subject_id: "c" }), /event_id/);
  assert.throws(
    () => store.append({ event_id: "e", kind: "X", occurred_at: "not-a-time", subject_id: "c" }),
    /occurred_at/
  );
});
