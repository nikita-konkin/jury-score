"use strict";
// Операции конструктора над документом программы (web/src/edit/ops.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const M = require("../../shared/model.js");

const rwp = () => M.normalize(JSON.parse(fs.readFileSync(path.join(__dirname, "../../fixtures/rwp-2026.program.json"), "utf8"))).doc;
const ops = () => import("../../web/src/edit/ops.js");

test("перемещение элемента пересчитывает время, коды сохраняются", async () => {
  const O = await ops();
  const doc = rwp();
  const [a, b] = doc.days[0].sessions[0].items;
  const moved = M.normalize(O.shiftItem(doc, 0, 0, 0, 1));
  const items = moved.doc.days[0].sessions[0].items;
  assert.equal(items[0].code, b.code);
  assert.equal(items[1].code, a.code);
  assert.equal(items[0].start, a.start);
  assert.equal(O.shiftItem(doc, 0, 0, 0, -1), doc, "выше первого — без изменений");
});

test("форма элемента: явное время — якорь, пустое — расчёт; конец не переносится", async () => {
  const O = await ops();
  const it = { type: "talk", title: "Доклад", start: "09:00", end: "09:15", duration: 15, anchor: true };
  const f = O.itemForm(it);
  assert.equal(f.start, "09:00");
  const auto = O.applyItemForm(it, Object.assign({}, f, { start: "", duration: "20", authors: "А. А. Иванов; Б. Б. Петров" }));
  assert.equal(auto.anchor, false);
  assert.equal(auto.end, undefined);
  assert.equal(auto.duration, 20);
  assert.deepEqual(auto.authors, ["А. А. Иванов", "Б. Б. Петров"]);
});

test("ошибки по местам, пустая программа, образец без докладов", async () => {
  const O = await ops();
  const idx = O.issueIndex({ errors: [{ code: "TIME_OVERLAP", path: "days[0].sessions[1].items[3].start" }], warnings: [] });
  assert.equal(idx.d0.err, 1);
  assert.equal(idx.d0s1i3.err, 1);
  assert.equal(idx.all.err, 1);

  const blank = M.normalize(O.blankProgram({ title: "Школа", date_from: "2026-12-01", date_to: "2026-12-03" }));
  assert.equal(blank.report.ok, true, JSON.stringify(blank.report.errors));
  assert.equal(blank.doc.days.length, 3);
  assert.throws(() => O.blankProgram({ title: "x", date_from: "2026-12-03", date_to: "2026-12-01" }));

  const tpl = M.normalize(O.fromTemplate(rwp(), { title: "RWP-2027", date_from: "2027-10-06" }));
  assert.equal(tpl.report.ok, true, JSON.stringify(tpl.report.errors));
  assert.equal(tpl.doc.days[0].date, "2027-10-06");
  assert.equal(tpl.report.stats.talks, 0);
});

test("секция нового доклада — как у последнего доклада заседания", async () => {
  const O = await ops();
  assert.equal(O.sessionSection({ items: [{ type: "talk", section: 1 }, { type: "talk", section: 2 }, { type: "lunch" }] }), 2);
  assert.equal(O.sessionSection({ items: [{ type: "activity" }] }), null);
  assert.equal(O.sessionSection({ items: [] }), null);
});

test("люди: одно написание по фамилии и инициалам, роли, приведение к одному", async () => {
  const O = await ops();
  assert.equal(O.nameKey("Рябов Алексей Олегович"), O.nameKey("А. О. Рябов, д.т.н."));
  assert.equal(O.nameKey("рябов а.о."), "рябовао");
  assert.notEqual(O.nameKey("А. О. Рябов"), O.nameKey("А. П. Рябов"));
  const doc = { days: [{ date: "2026-10-07", sessions: [{ chair: "А. О. Рябов, д.т.н.", items: [
    { type: "talk", title: "a", speaker: "Рябов Алексей Олегович", authors: ["Рябов Алексей Олегович", "Б. Б. Петров"] },
    { type: "talk", title: "b", speaker: "А. О. Рябов" },
    { type: "talk", title: "c", speaker: "Б. Б. Петров" },
  ] }] }] };
  const t = O.peopleTable(doc);
  assert.deepEqual(t.map(p => [p.name, p.variants.length, p.talks, p.authored, p.chairs]),
    [["А. О. Рябов", 2, 2, 0, 1], ["Б. Б. Петров", 1, 1, 1, 0]], "разное написание — первым");
  const fixed = O.renamePerson(doc, ["Рябов Алексей Олегович"], "А. О. Рябов");
  assert.equal(fixed.days[0].sessions[0].items[0].speaker, "А. О. Рябов");
  assert.deepEqual(fixed.days[0].sessions[0].items[0].authors, ["А. О. Рябов", "Б. Б. Петров"]);
  assert.equal(fixed.days[0].sessions[0].chair, "А. О. Рябов, д.т.н.", "регалии сохраняются");
  assert.equal(O.peopleTable(fixed)[0].variants.length, 1);
});
