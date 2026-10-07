"use strict";
// llms.txt и openapi.json должны описывать реальные маршруты pb_hooks, а пример — проходить проверку.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const M = require("../../shared/model.js");
const F = require("../../shared/feedback.js");

const root = path.join(__dirname, "../..");
const read = p => fs.readFileSync(path.join(root, p), "utf8");
const hooks = fs.readdirSync(path.join(root, "pb/pb_hooks")).filter(f => f.endsWith(".pb.js")).map(f => read("pb/pb_hooks/" + f)).join("\n");
const routes = {};
hooks.replace(/routerAdd\("(GET|POST|PUT|PATCH|DELETE)", "([^"]+)"/g, (m, method, p) => { routes[method + " " + p] = true; });

test("openapi.json: каждая операция есть в pb_hooks, перечисления совпадают с кодом", () => {
  const spec = JSON.parse(read("public/openapi.json"));
  const ops = [];
  Object.keys(spec.paths).forEach(p => Object.keys(spec.paths[p]).filter(m => m !== "parameters").forEach(m => {
    ops.push(m.toUpperCase() + " " + p);
    assert.ok(spec.paths[p][m].operationId, p + " без operationId");
  }));
  ops.forEach(op => assert.ok(routes[op], "нет маршрута " + op));
  ["POST /api/v1/programs/validate", "POST /api/v1/events", "GET /api/v1/events/{id}/program", "PUT /api/v1/events/{id}/program",
    "POST /api/v1/events/{id}/invite", "POST /api/v1/feedback", "GET /api/v1/changelog"].forEach(op => assert.ok(ops.indexOf(op) >= 0, op));
  const fb = spec.components.schemas.Feedback.properties;
  assert.deepEqual(fb.kind.enum, F.KINDS);
  assert.deepEqual(fb.area.enum, F.AREAS);
  assert.deepEqual(fb.impact.enum, F.IMPACTS);
  // ссылки $ref указывают на существующие схемы
  JSON.stringify(spec).replace(/"#\/components\/(schemas|responses)\/(\w+)"/g, (m, kind, name) => {
    assert.ok(spec.components[kind][name], m);
  });
});

test("llms.txt: пример — корректная программа, упомянуты маршруты и виды обратной связи", () => {
  const txt = read("public/llms.txt");
  const json = /```json\n([\s\S]+?)\n```/.exec(txt)[1];
  const { report } = M.normalize(JSON.parse(json));
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.deepEqual(report.warnings, []);
  ["/api/v1/programs/validate", "/api/v1/events", "/api/v1/feedback", "/api/v1/changelog", "X-API-Key", "X-Draft-Token", "Idempotency-Key", "extra"]
    .forEach(s => assert.ok(txt.indexOf(s) >= 0, s));
  F.KINDS.concat(F.AREAS).concat(M.ITEM_TYPES).concat(M.FORMATS).forEach(s => assert.ok(txt.indexOf(s) >= 0, s));
  assert.ok(Buffer.byteLength(txt) < 12 * 1024, "llms.txt должен оставаться коротким");
});
