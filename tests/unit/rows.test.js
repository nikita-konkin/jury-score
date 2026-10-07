"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const M = require("../../shared/model.js");

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, "../../fixtures", name), "utf8"));

const NUM = ["sort", "no", "section", "duration"];
const BOOL = ["competitive", "all_day", "anchor"];
const JSONF = ["extra", "authors"];

// Строки «как из PocketBase»: id вместо ключей, значения по умолчанию у пустых полей,
// служебные поля и перемешанный порядок
function dbify(rows) {
  let n = 0;
  const ids = {};
  const id = key => (ids[key] = ids[key] || "r" + String(++n).padStart(14, "0"));
  const fill = (r, fields) => {
    const out = { id: r.key ? id(r.key) : "r" + String(++n).padStart(14, "0"), collectionName: "x", event: "e1", created: "2026-10-08 10:00:00.000Z" };
    fields.concat(["sort"]).forEach(k => {
      const v = r[k];
      out[k] = v !== undefined ? v : NUM.indexOf(k) >= 0 ? 0 : BOOL.indexOf(k) >= 0 ? false : JSONF.indexOf(k) >= 0 ? null : "";
    });
    return out;
  };
  const shuffle = list => list.slice().reverse();
  return {
    event: rows.event,
    rooms: shuffle(rows.rooms.map(r => fill(r, M.ROW_FIELDS.room))),
    sections: shuffle(rows.sections.map(r => fill(r, M.ROW_FIELDS.section))),
    days: shuffle(rows.days.map(r => fill(r, M.ROW_FIELDS.day))),
    sessions: shuffle(rows.sessions.map(r => Object.assign(fill(r, M.ROW_FIELDS.session), { day: id(r.day) }))),
    items: shuffle(rows.items.map(r => Object.assign(fill(r, M.ROW_FIELDS.item), { session: id(r.session) }))),
  };
}

test("RWP-2026: toDocument(fromDocument(doc)) возвращает тот же документ", () => {
  const { doc, report } = M.normalize(fixture("rwp-2026.program.json"));
  assert.equal(report.ok, true);
  const rows = M.fromDocument(doc);
  assert.equal(rows.days.length, 3);
  assert.equal(rows.items.length, report.stats.items);
  assert.deepEqual(M.toDocument(rows), doc);
});

test("строки из БД: id вместо ключей, пустые значения, другой порядок — документ тот же", () => {
  const { doc } = M.normalize(fixture("rwp-2026.program.json"));
  const back = M.toDocument(dbify(M.fromDocument(doc)));
  assert.deepEqual(back, doc);
  // собранный документ снова проходит проверку без изменений
  const again = M.normalize(back);
  assert.equal(again.report.ok, true);
  assert.deepEqual(again.doc, doc);
});

test("extra, all_day, пустой день и заседание без зала переживают разбор и сборку", () => {
  const { doc, report } = M.normalize({
    event: { title: "Школа", date_from: "2026-11-01", extra: { stream: "https://example.org/live" } },
    rooms: [{ name: "ауд. 1", building: "корпус 2", extra: { seats: 40 } }],
    sections: [{ no: 1, title: "Секция", short: "С1" }],
    days: [
      { date: "2026-11-01", title: "Первый день", extra: { theme: "вводный" }, sessions: [
        { title: "", start: "10:00", items: [
          { type: "talk", section: 1, title: "Доклад", speaker: "А. Б. Иванов", authors: ["А. Б. Иванов"], format: "poster", extra: { stand: 7 } },
          { type: "break", title: "Перерыв", competitive: false },
        ] },
        { title: "Весь день", room: "ауд. 1", items: [{ type: "activity", title: "Выставка", all_day: true }] },
      ] },
      { date: "2026-11-02", sessions: [] },
    ],
  });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.deepEqual(M.toDocument(dbify(M.fromDocument(doc))), doc);
});

test("slugify: транслитерация, обрезка, пустой результат", () => {
  assert.equal(M.slugify("Школа РРВ — 2026!"), "shkola-rrv-2026");
  assert.equal(M.slugify("  Ёлка  и   щука "), "elka-i-schuka");
  assert.equal(M.slugify("«»—"), "");
  assert.equal(M.slugify("а".repeat(10) + " бб", 11), "aaaaaaaaaa");
});
