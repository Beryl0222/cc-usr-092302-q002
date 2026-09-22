import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validate } from "../src/contract.js";
test("样例符合约定", async () => { const data = JSON.parse(await readFile(new URL("../fixtures/event.json", import.meta.url))); assert.deepEqual(validate(data), []); });
