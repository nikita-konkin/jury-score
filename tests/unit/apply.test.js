"use strict";
// Заявки: настройки event.applications в модели, выбор заседания для принятой заявки, CSV для оргкомитета.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const M = require("../../shared/model.js");

const rwp = () => JSON.parse(fs.readFileSync(path.join(__dirname, "../../fixtures/rwp-2026.program.json"), "utf8"));
const codes = r => r.errors.concat(r.warnings).map(x => x.code);

test("модель: приём заявок — срок, оператор, текст; без оператора — предупреждение", () => {
  const p = rwp();
  p.event.applications = { deadline: "01.09.2026", operator: "  ООО  «Пример» ", note: "Строка 1\n\n\n\nСтрока 2", unknown: 1 };
  let r = M.normalize(p);
  assert.equal(r.report.ok, true);
  assert.deepEqual(r.doc.event.applications, { enabled: true, deadline: "2026-09-01", operator: "ООО «Пример»", note: "Строка 1\n\nСтрока 2" });
  p.event.applications = { deadline: "завтра" };
  r = M.normalize(p);
  assert.ok(codes(r.report).indexOf("BAD_DATE") >= 0);
  p.event.applications = {};
  delete p.event.organizer;
  r = M.normalize(p);
  assert.ok(codes(r.report).indexOf("APPLICATIONS_NO_OPERATOR") >= 0);
  p.event.applications = { enabled: false };
  assert.ok(codes(M.normalize(p).report).indexOf("APPLICATIONS_NO_OPERATOR") < 0, "выключенный приём не требует оператора");
});

test("принятая заявка: заседание по секции, CSV с контактами", async () => {
  const D = await import("../../web/src/apply/data.js");
  const doc = M.normalize(rwp()).doc;
  const sc = D.sessionChoices(doc, 3);
  const pick = sc.list[sc.def];
  const s = doc.days[pick.day].sessions[pick.session];
  assert.ok(s.items.some(it => it.section === 3), "по умолчанию — заседание с докладами секции 3");
  assert.match(pick.label, /^\d\d\.\d\d · /);
  assert.equal(D.sessionChoices(doc, 0).def, 0);
  const csv = D.applicationsCsv([{ no: 1, status: "accepted", speaker: "Иванова А. Б.", authors: ["Иванова А. Б.", "Петров В. Г."], title: "Доклад; с точкой с запятой",
    section: 1, format: "online", org: "Университет", city: "Казань", email: "a@example.com", phone: "+7 900", note: "", created: "2026-10-08 09:00:00.000Z", item_code: "s1-9", reason: "" }]);
  assert.match(csv, /^﻿№;Статус;Докладчик/);
  assert.match(csv, /\r\n1;принята;Иванова А\. Б\.;Иванова А\. Б\., Петров В\. Г\.;"Доклад; с точкой с запятой";1;онлайн;Университет;Казань;a@example\.com;\+7 900;;2026-10-08 09:00;s1-9;\r\n$/);
});
