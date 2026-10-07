"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const M = require("../../shared/model.js");

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, "../../fixtures", name), "utf8"));
const codes = list => list.map(e => e.code);
const allItems = doc => {
  const out = [];
  doc.days.forEach(d => d.sessions.forEach(s => s.items.forEach(it => out.push(it))));
  return out;
};
const byCode = doc => {
  const m = {};
  allItems(doc).forEach(it => { m[it.code] = it; });
  return m;
};
// минимальная программа для точечных проверок
const mini = (sessions, extra) => Object.assign({
  schema: "conf.program/v1",
  event: { title: "Тест", date_from: "2026-10-07" },
  sections: [{ no: 1, title: "Секция один" }],
  days: [{ date: "2026-10-07", sessions: sessions }],
}, extra);
const talk = (title, speaker, more) => Object.assign({ type: "talk", section: 1, title: title, speaker: speaker }, more);

test("RWP-2026: программа без ошибок, 23 доклада, коды как в jury-score", () => {
  const { doc, report } = M.normalize(fixture("rwp-2026.program.json"));
  assert.deepEqual(report.errors, []);
  assert.equal(report.ok, true);
  assert.equal(report.stats.talks, 23);
  assert.equal(report.stats.competitive, 23);
  assert.equal(report.stats.days, 3);
  const talks = allItems(doc).filter(it => it.type === "talk").map(it => it.code);
  const expected = [];
  [[1, 6], [2, 7], [3, 3], [4, 7]].forEach(([s, n]) => { for (let i = 1; i <= n; i++) expected.push(`s${s}-${i}`); });
  assert.deepEqual(talks, expected);
});

test("RWP-2026: авто-время совпадает с официальной программой", () => {
  const items = byCode(M.normalize(fixture("rwp-2026.program.json")).doc);
  const t = c => items[c].start + "–" + items[c].end;
  assert.equal(t("s1-1"), "09:00–09:15");
  assert.equal(t("s1-6"), "10:15–10:30");
  assert.equal(t("x1"), "10:30–11:00");      // кофе-брейк
  assert.equal(t("p1"), "11:00–11:30");      // пленарная лекция, якорь 11:00
  assert.equal(items.p1.anchor, true);
  assert.equal(items["s2-1"].anchor, false);
  assert.equal(t("s2-7"), "13:00–13:15");
  assert.equal(t("x2"), "13:15–14:00");      // обед 45 мин по регламенту
  assert.equal(t("s3-1"), "14:00–14:15");
  assert.equal(t("s3-3"), "14:30–14:45");
  assert.equal(t("s4-7"), "15:45–15:55");
});

test("RWP-2026 с временем из PDF: сбитая секция 4 даёт ошибки с точными путями", () => {
  const { report } = M.normalize(fixture("rwp-2026.broken.json"));
  assert.equal(report.ok, false);
  assert.deepEqual(codes(report.errors), ["TIME_BACKWARDS", "TIME_OVERLAP"]);
  assert.equal(report.errors[0].path, "days[0].sessions[1].items[3].end");
  assert.equal(report.errors[0].item, "s4-1");
  assert.match(report.errors[0].message, /окончание 14:00 не позже начала 14:45/);
  assert.equal(report.errors[1].path, "days[0].sessions[1].items[4].start");
  assert.ok(report.info.some(e => e.code === "TIME_FORMAT_FIXED" && /14\.30/.test(e.message)));
});

test("нормализация корректного документа идемпотентна", () => {
  const llm = mini([{ room: "1", items: [{ type: "доклад", section: 1, time: "9.00", title: "А", speaker: "Иванов И.И.", poster_no: 1 }] }]);
  [fixture("rwp-2026.program.json"), llm].forEach((src, i) => {
    const a = M.normalize(src);
    assert.equal(a.report.ok, true, "doc " + i);
    const b = M.normalize(a.doc);
    assert.deepEqual(b.doc, a.doc, "doc " + i);
    assert.deepEqual(b.report.errors, [], "doc " + i);
    assert.deepEqual(b.report.warnings.filter(w => w.code === "UNKNOWN_FIELD"), [], "doc " + i);
  });
});

test("документ с ошибками: doc — лишь попытка починки, сохранять его нельзя", () => {
  // TIME_BACKWARDS заменён длительностью по регламенту — повторная проверка ошибку уже не видит,
  // поэтому API принимает только документы с report.ok === true
  const a = M.normalize(fixture("rwp-2026.broken.json"));
  assert.equal(a.report.ok, false);
  const s41 = byCode(a.doc)["s4-1"];
  assert.equal(s41.start + "–" + s41.end, "14:45–15:00");
});

test("parsePerson и personKey: разные записи одного человека", () => {
  assert.deepEqual(M.parsePerson("А.О. Рябов"), { name: "А. О. Рябов", regalia: "" });
  assert.deepEqual(M.parsePerson("Рябов А.О."), { name: "А. О. Рябов", regalia: "" });
  assert.deepEqual(M.parsePerson("  Рябов   А. О. "), { name: "А. О. Рябов", regalia: "" });
  assert.deepEqual(M.parsePerson("Н. В. Рябова, д.ф.-м.н., профессор"), { name: "Н. В. Рябова", regalia: "д.ф.-м.н., профессор" });
  assert.deepEqual(M.parsePerson("Иванов Иван Иванович"), { name: "Иванов Иван Иванович", regalia: "" });
  assert.equal(M.personKey("А.О. Рябов"), M.personKey("Рябов А. О., к.ф.-м.н."));
  assert.equal(M.personKey("В. В. Ковалёва"), M.personKey("Ковалева В.В."));
  assert.equal(M.parsePerson(""), null);
});

test("normTime и normDate", () => {
  assert.equal(M.normTime("9:00"), "09:00");
  assert.equal(M.normTime("14.30"), "14:30");
  assert.equal(M.normTime("24:00"), "24:00");
  assert.equal(M.normTime("24:30"), null);
  assert.equal(M.normTime("25:00"), null);
  assert.equal(M.normTime("9"), null);
  assert.equal(M.normDate("07.10.2026"), "2026-10-07");
  assert.equal(M.normDate("2026-02-30"), null);
});

test("ответ в стиле LLM: синонимы, time-диапазон, авторы строкой, лишние поля → extra", () => {
  const { doc, report } = M.normalize(mini([{
    title: "Утро", room: "Аудитория 431",
    items: [
      { type: "доклад", section: 1, time: "9.00–9.20", title: "«Первый»", authors: "Иванов И.И., Петров П. П.",
        speaker: { name: "Петров П.П.", org: "ПГТУ", city: "г. Йошкар-Ола" }, format: "онлайн", poster_no: 7 },
      { type: "кофе-брейк", title: "Кофе" },
    ],
  }]));
  assert.deepEqual(report.errors, []);
  const [a, b] = allItems(doc);
  assert.equal(a.type, "talk");
  assert.equal(a.title, "Первый");
  assert.equal(a.start + "–" + a.end, "09:00–09:20");
  assert.deepEqual(a.authors, ["И. И. Иванов", "П. П. Петров"]);
  assert.equal(a.speaker, "П. П. Петров");
  assert.equal(a.city, "Йошкар-Ола");
  assert.equal(a.format, "online");
  assert.deepEqual(a.extra, { poster_no: 7 });
  assert.equal(b.type, "break");
  assert.equal(b.start + "–" + b.end, "09:20–09:35");
  const w = codes(report.warnings);
  assert.ok(w.includes("UNKNOWN_FIELD") && w.includes("EXTRA_USED"), w.join());
  assert.ok(codes(report.info).includes("AUTHORS_SPLIT"));
});

test("зал занят: пересечение двух заседаний в одном зале", () => {
  const { report } = M.normalize(mini([
    { room: "ауд. 431", start: "10:00", items: [talk("А", "А. А. Первый"), talk("Б", "Б. Б. Второй")] },
    { room: "431", start: "10:20", items: [talk("В", "В. В. Третий")] },
  ]));
  assert.deepEqual(codes(report.errors), ["ROOM_OVERLAP"]);
  assert.match(report.errors[0].message, /Зал «431» занят/);
});

test("докладчик в двух местах одновременно", () => {
  const { report } = M.normalize(mini([
    { room: "ауд. 1", start: "10:00", items: [talk("А", "Рябов А.О.")] },
    { room: "ауд. 2", start: "10:05", items: [talk("Б", "А. О. Рябов")] },
  ]));
  assert.deepEqual(codes(report.errors), ["SPEAKER_CLASH"]);
});

test("без времени начала — ошибка NO_START", () => {
  const { report } = M.normalize(mini([{ room: "1", items: [talk("А", "А. А. Первый")] }]));
  assert.deepEqual(codes(report.errors), ["NO_START"]);
});

test("якорь позже курсора — пауза, выход за плановое окончание — предупреждение", () => {
  const { doc, report } = M.normalize(mini([{
    room: "1", start: "10:00", end: "10:40",
    items: [talk("А", "А. А. Первый"), talk("Б", "Б. Б. Второй", { start: "10:30" })],
  }]));
  assert.deepEqual(report.errors, []);
  assert.ok(codes(report.info).includes("GAP"));
  assert.ok(codes(report.warnings).includes("SESSION_OVERRUN"));
  assert.equal(allItems(doc)[1].end, "10:45");
});

test("коды: дубль — ошибка, недостающие присваиваются без конфликтов", () => {
  const dup = M.normalize(mini([{ room: "1", start: "10:00", items: [
    talk("А", "А. А. Первый", { code: "s1-1" }), talk("Б", "Б. Б. Второй", { code: "s1-1" }) ] }]));
  assert.deepEqual(codes(dup.report.errors), ["DUPLICATE_CODE"]);

  const gen = M.normalize(mini([{ room: "1", start: "10:00", items: [
    talk("А", "А. А. Первый"), talk("Б", "Б. Б. Второй", { code: "s1-1" }) ] }]));
  assert.deepEqual(allItems(gen.doc).map(it => it.code), ["s1-2", "s1-1"]);
});

test("ссылка на несуществующую секцию создаёт её с предупреждением", () => {
  const { doc, report } = M.normalize(mini([{ room: "1", start: "10:00", items: [talk("А", "А. А. Первый", { section: 3 })] }]));
  assert.deepEqual(report.errors, []);
  assert.ok(codes(report.warnings).includes("SECTION_AUTO"));
  assert.deepEqual(doc.sections.map(s => s.no), [1, 3]);
});

test("грубые ошибки входа не роняют нормализацию", () => {
  assert.deepEqual(codes(M.normalize("{не json").report.errors), ["BAD_JSON"]);
  assert.deepEqual(codes(M.normalize([1, 2]).report.errors), ["SCHEMA_ROOT"]);
  const r = M.normalize({ event: {}, days: [{ date: "31.02.2026", sessions: [{ items: [null, { type: "talk" }] }] }] }).report;
  assert.ok(codes(r.errors).includes("MISSING_EVENT_TITLE"));
  assert.ok(codes(r.errors).includes("BAD_DATE"));
  assert.ok(codes(r.errors).includes("BAD_ITEM"));
  assert.ok(codes(r.errors).includes("MISSING_TITLE"));
});
