"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../../shared/feedback.js");
const M = require("../../shared/model.js");

test("scrub: e-mail и телефоны вырезаются, даты и время остаются", () => {
  const s = F.scrub("Пишите ivan.petrov@mail.ru или +7 (912) 345-67-89, 8 912 345 67 89; заседание 2026-10-07 в 09:00–10:00, ауд. 431");
  assert.equal(s, "Пишите [e-mail] или [телефон], [телефон]; заседание 2026-10-07 в 09:00–10:00, ауд. 431");
});

test("signature и similarity: похожие формулировки близки, разные — нет", () => {
  const a = F.signature("Не хватает стендовой сессии с номерами стендов");
  const b = F.signature("нет поддержки стендовой сессии и номеров стендов");
  const c = F.signature("Нужна выгрузка программы в Word");
  assert.ok(F.similarity(a, b) >= 0.5, F.similarity(a, b));
  assert.ok(F.similarity(a, c) < 0.2);
  const groups = [{ id: "g1", signature: c }, { id: "g2", signature: a }];
  assert.equal(F.bestGroup(b, groups).id, "g2");
  assert.equal(F.bestGroup(F.signature("Онлайн-трансляция заседаний"), groups), null);
});

test("normalizeFeedback: синонимы, неизвестная область → other, обрезка, ошибки", () => {
  const { item, errors } = F.normalizeFeedback({
    kind: "feature", area: "posters", summary: "  Нет стендовой  сессии ", details: { tried: "extra" },
    impact: "blocker", client: "Claude Desktop", model: "Claude Opus 5.5", context: { email: "a@b.ru" },
  });
  assert.deepEqual(errors, []);
  assert.equal(item.kind, "missing_feature");
  assert.equal(item.area, "other");
  assert.equal(item.context.area_original, "posters");
  assert.equal(item.context.email, "[e-mail]");
  assert.equal(item.summary, "Нет стендовой сессии");
  assert.match(item.details, /"tried": "extra"/);
  assert.equal(F.normalizeFeedback({ kind: "x" }).errors.length, 2);
  assert.equal(F.normalizeFeedback({ kind: "bug", summary: "я".repeat(400) }).item.summary.length, 300);
});

test("fromExtraWarnings: по одному сообщению на поле и уровень", () => {
  const { report } = M.normalize({
    event: { title: "Т", date_from: "2026-11-01", stream: "https://x" },
    days: [{ date: "2026-11-01", sessions: [{ start: "10:00", items: [
      { type: "talk", title: "А", speaker: "А. А. Иванов", stand: 1 },
      { type: "talk", title: "Б", speaker: "Б. Б. Петров", stand: 2 },
    ] }] }],
  });
  const fb = F.fromExtraWarnings(report);
  assert.deepEqual(fb.map(f => f.context.level + ":" + f.context.field), ["event:stream", "items:stand"]);
  assert.ok(fb.every(f => f.kind === "schema_limitation" && f.workaround === "extra"));
});
