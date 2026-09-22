import assert from "node:assert/strict";
import test from "node:test";
import { validate } from "../src/contract.js";

// 基线合同：既有样例与最小校验必须继续通过。
test("基线：样例符合信封约定", async () => {
  const { readFile } = await import("node:fs/promises");
  const data = JSON.parse(await readFile(new URL("../fixtures/event.json", import.meta.url)));
  assert.deepEqual(validate(data), []);
});

test("基线：缺字段被识别", () => {
  assert.deepEqual(validate({ event_id: "x", kind: "K" }), ["occurred_at", "subject_id", "version"]);
});
