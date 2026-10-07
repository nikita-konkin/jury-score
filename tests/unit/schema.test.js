"use strict";
// Опубликованная JSON Schema и shared/model.js должны описывать один и тот же формат.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Ajv2020 = require("ajv/dist/2020").default;
const M = require("../../shared/model.js");

const root = path.join(__dirname, "../..");
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(read("public/schema/program.v1.json"));
const errs = () => (validate.errors || []).map(e => e.instancePath + " " + e.message).join("\n");

test("фикстуры соответствуют JSON Schema", () => {
  ["fixtures/rwp-2026.program.json", "fixtures/rwp-2026.broken.json", "fixtures/rrv-2023.program.json"].forEach(f => {
    // в broken время «14.30» — как в PDF; схема его не пропускает, нормализация чинит
    const doc = read(f);
    const ok = validate(doc);
    if (f.includes("broken")) assert.equal(ok, false, f);
    else assert.ok(ok, f + "\n" + errs());
  });
});

test("результат normalize соответствует JSON Schema", () => {
  ["fixtures/rwp-2026.program.json", "fixtures/rwp-2026.broken.json", "fixtures/rrv-2023.program.json"].forEach(f => {
    const { doc } = M.normalize(read(f));
    assert.ok(validate(doc), f + "\n" + errs());
  });
});

test("типы и форматы в схеме совпадают с model.js", () => {
  const s = read("public/schema/program.v1.json");
  assert.deepEqual(s.$defs.item.properties.type.enum, M.ITEM_TYPES);
  assert.deepEqual(s.$defs.item.properties.format.enum, M.FORMATS);
  assert.equal(s.properties.schema.const, M.SCHEMA_ID);
});
