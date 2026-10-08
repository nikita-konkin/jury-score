"use strict";
// Печатные документы и Word (web/src/print): данные программы, протоколы, .docx.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { unzipSync, strFromU8 } = require("fflate");
const M = require("../../shared/model.js");

const rwp = () => M.normalize(JSON.parse(fs.readFileSync(path.join(__dirname, "../../fixtures/rwp-2026.program.json"), "utf8"))).doc;
const data = () => import("../../web/src/print/data.js");
const docx = () => import("../../web/src/print/docx.js");
const table = () => import("../../web/src/edit/table.js");

test("программа для печати: день, заседание, секции, строка докладчика как в программе RWP-2026", async () => {
  const D = await data();
  const doc = rwp();
  const days = D.programRows(doc);
  assert.equal(days[0].heading, "07.10.2026 [Среда]");
  const s0 = days[0].sessions[0];
  assert.equal(s0.place, "ПГТУ, 3-й корпус, ауд. 431");
  assert.equal(s0.rows[0].kind, "section");
  assert.match(s0.rows[0].text, /^Секция 1\. /);
  const talk = s0.rows[1];
  assert.equal(talk.time, "09:00 – 09:15");
  assert.match(talk.speaker, /^Докладчик \(онлайн\): Е\. С\. Беленя, .+, г\. Санкт-Петербург$/);
  assert.ok(s0.rows.some(r => r.kind === "break" && r.text === "КОФЕ-БРЕЙК"));
  // секция меняется внутри заседания — новый заголовок
  assert.equal(s0.rows.filter(r => r.kind === "section").length, 2);
  assert.equal(D.datesLine("2026-10-07", "2026-10-09"), "7–9 октября 2026 г.");
  assert.equal(D.datesLine("2026-09-30", "2026-10-02"), "30 сентября – 2 октября 2026 г.");
});

test("протоколы и таблички: по заседанию и секции, фильтр дня", async () => {
  const D = await data();
  const doc = rwp();
  const all = D.protocols(doc);
  const talks = doc.days.reduce((n, d) => n + d.sessions.reduce((m, s) => m + s.items.filter(it => it.type === "talk" || it.type === "plenary").length, 0), 0);
  assert.equal(all.reduce((n, p) => n + p.rows.length, 0), talks);
  assert.match(all[0].title, /^секции 1 «/);
  assert.equal(all[0].chair, "Н. В. Рябова");
  assert.ok(D.protocols(doc, "1").every(p => p.day.date === doc.days[1].date));
  assert.equal(D.doors(doc).length, doc.days.reduce((n, d) => n + d.sessions.length, 0));
  assert.ok(D.certificates(doc).every(c => c.name && c.title));
});

test("Word: пакет открывается, протокол читается обратно импортом таблиц", async () => {
  const X = await docx();
  const T = await table();
  const doc = rwp();
  const prog = unzipSync(X.docx(X.programBlocks(doc)));
  ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/_rels/document.xml.rels"].forEach(f => assert.ok(prog[f], f));
  const xml = strFromU8(prog["word/document.xml"]);
  assert.equal((xml.match(/<w:p>/g) || []).length, (xml.match(/<\/w:p>/g) || []).length);
  assert.ok(xml.indexOf("Докладчик (онлайн): Е. С. Беленя") > 0);
  assert.ok(xml.indexOf('w:type="page"') > 0, "дни с новой страницы");

  const bytes = X.docx(X.protocolBlocks(doc, "0"));
  const rows = T.readTable("протокол.docx", bytes);
  assert.deepEqual(rows[0], ["№", "ФИО докладчика", "Тема доклада", "Место работы", "Форма участия", "Примечание"]);
  // импорт берёт самую большую таблицу — это самый длинный протокол дня
  const D = await data();
  const biggest = D.protocols(doc, "0").reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
  assert.equal(rows.length, biggest.rows.length + 1);
  assert.equal(rows[1][1], biggest.rows[0].speaker);
  assert.equal(rows[1][2], biggest.rows[0].title);
  // спецсимволы экранируются
  const amp = strFromU8(unzipSync(X.docx([{ p: "A & B <c>" }]))["word/document.xml"]);
  assert.ok(amp.indexOf("A &amp; B &lt;c&gt;") > 0);
});

test("итоги конкурса и дипломы: места внутри секции, общее место при равенстве, без секции — отдельной группой", async () => {
  const D = await data();
  const R = await import("../../web/src/jury/results.js");
  const talks = [
    { code: "s1-1", title: "А", speaker: "А. А. Ан, к.т.н.", section: 1, idx: 0 },
    { code: "s1-2", title: "Б", speaker: "Б. Б. Бе", section: 1, idx: 1 },
    { code: "s1-3", title: "В", speaker: "В. В. Ве", section: 1, idx: 2 },
    { code: "s1-4", title: "Г", speaker: "Г. Г. Ге", section: 1, idx: 3 },
    { code: "s2-1", title: "Д", speaker: "Д. Д. Де", section: 2, idx: 4 },
    { code: "x1", title: "Е", speaker: "Е. Е. Ее", idx: 5 },
  ];
  const all = { j: { name: "J", data: {} } };
  [["s1-1", 3], ["s1-2", 5], ["s1-3", 5], ["s1-4", 2], ["s2-1", 1], ["x1", 4]].forEach(([id, v]) => { all.j.data[id] = { s: [v, v], ts: 1 }; });
  const rows = R.computeResults(all, talks, 2, 5);
  const groups = D.contest(rows, [{ no: 1, title: "Радио" }, { no: 2, title: "" }, { no: 3, title: "Пустая" }], R.rankRows);
  assert.deepEqual(groups.map(g => g.title), ["Секция 1. Радио", "Секция 2", "Без секции"]);
  assert.deepEqual(groups[0].rows.map(r => [r.t.code, r.rank]), [["s1-2", 1], ["s1-3", 1], ["s1-1", 3], ["s1-4", 4]]);
  const dip = D.diplomas(groups);
  assert.deepEqual(dip.map(d => [d.name, d.degree]), [["Б. Б. Бе", "I"], ["В. В. Ве", "I"], ["А. А. Ан", "III"], ["Д. Д. Де", "I"], ["Е. Е. Ее", "I"]]);
  assert.equal(D.contest(rows, [], R.rankRows)[0].title, "", "без секций — один список без заголовка");
});
