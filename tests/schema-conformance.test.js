import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { makeContext, ACTORS, FULL_CATEGORIES } from "./helpers.js";
import { PURPOSE, MODALITY, RISK } from "../src/vocabulary.js";

// 不引入第三方依赖的最小 JSON Schema 子集校验：覆盖 required / type / enum。
function checkValue(value, schema, path, errors) {
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const jsType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const ok = types.some((t) => {
      if (t === "integer") return jsType === "number" && Number.isInteger(value);
      return t === jsType;
    });
    if (!ok) errors.push(`${path}: 期望 ${types.join("|")}，实际 ${jsType}`);
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} 不在枚举内`);
}

function validateAgainstSchema(event, schema, path = "$", errors = []) {
  for (const key of schema.required ?? []) {
    if (!(key in event)) errors.push(`${path}.${key} 必填`);
  }
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (key in event) checkValue(event[key], prop, `${path}.${key}`, errors);
  }
  return errors;
}

test("端到端过程中产生的每个事件都符合信封 schema", () => {
  const { service, directory } = makeContext();
  const d = ACTORS.grassDoctor, ex = ACTORS.expert, rc = { ...ACTORS.receiver, orgId: "org-c" }, patient = ACTORS.patient("pat-schema");

  const examId = "exam-schema", referralId = "ref-schema";
  service.requestExamination({ examId, patientId: "pat-schema", orgId: "org-fuping-county", modality: MODALITY.CARDIAC_CT, purpose: PURPOSE.ASYMPTOMATIC_HIGH_RISK, clinician: d });
  service.recordDeployment({ examId, deviceId: "dev", protocolId: "p", protocolVersion: "1", actor: d });
  service.indexImage({ examId, imageId: "img", storageUri: "u", checksum: "c", acquiredAt: "t", actor: d });
  service.recordInterpretation({ examId, interpretationId: "r", imageIds: ["img"], findings: { a: 1 }, actor: ex });
  service.stratifyRisk({ examId, riskLevel: RISK.HIGH, rationale: "高危", actor: d });
  service.signOff({ examId, clinician: d, scope: "s" });
  service.grantConsent({ referralId, patientId: "pat-schema", purpose: PURPOSE.ASYMPTOMATIC_HIGH_RISK, receiverOrgId: "org-c", categories: FULL_CATEGORIES, examIds: [examId], actor: patient });
  service.openReferral({ referralId, examIds: [examId], receiverOrgId: "org-c", reason: "r", actor: d });
  service.makeDisclosure({ referralId, actor: d });
  service.acceptReferral({ referralId, actor: rc });
  directory.register("org-c", { contact: "x" });
  directory.addSlot("org-c", "s", "2026-09-24T09:00:00+08:00", "x");
  service.offerAppointment({ referralId, slotId: "s", actor: rc });
  service.confirmAppointment({ referralId, actor: patient });
  service.acknowledgeHandoff({ referralId, actor: rc });
  service.recordDisposition({ referralId, outcome: "o", recordLocator: "loc", actor: rc });

  return readFile(new URL("../contracts/event.schema.json", import.meta.url), "utf8").then((text) => {
    const schema = JSON.parse(text);
    const all = service.store.readAll();
    assert.ok(all.length >= 14);
    const errors = all.flatMap((e) => validateAgainstSchema(e, schema));
    assert.deepEqual(errors, []);
  });
});
