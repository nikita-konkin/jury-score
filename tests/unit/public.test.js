"use strict";
// Публичная программа: календарь .ics (shared/ics.js), «сейчас / далее», поиск (web/src/public/live.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const M = require("../../shared/model.js");
const Ics = require("../../shared/ics.js");

const rwp = () => M.normalize(JSON.parse(fs.readFileSync(path.join(__dirname, "../../fixtures/rwp-2026.program.json"), "utf8"))).doc;
const live = () => import("../../web/src/public/live.js");
const unfold = s => s.replace(/\r\n /g, "");

test("ics: заседания — события в UTC по поясу мероприятия, строки по 75 байт, экранирование", () => {
  const doc = rwp();
  const ics = Ics.toIcs(doc, { now: Date.UTC(2026, 9, 1), url: "https://conf.example/#/e/rwp-2026", uid: "rwp-2026" });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  ics.split("\r\n").forEach(l => assert.ok(Buffer.byteLength(l, "utf8") <= 75, l));
  const flat = unfold(ics);
  const sessions = doc.days.reduce((n, d) => n + d.sessions.filter(s => s.items.some(it => it.start)).length, 0);
  assert.equal((flat.match(/BEGIN:VEVENT/g) || []).length, sessions);
  // 7 октября 09:00 по Москве = 06:00 UTC
  assert.match(flat, /DTSTART:20261007T060000Z/);
  assert.match(flat, /UID:rwp-2026-d0s0@conf-kit/);
  assert.match(flat, /DTSTAMP:20261001T000000Z/);
  assert.equal(Ics.esc("а, б; в\\г\nд"), "а\\, б\\; в\\\\г\\nд");
});

test("ics: один элемент по коду; незнакомый пояс — плавающее время", () => {
  const doc = rwp();
  const one = unfold(Ics.toIcs(doc, { only: "s1-2", now: 0 }));
  assert.equal((one.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(one, /UID:.*-s1-2@conf-kit/);
  doc.event.timezone = "America/Nowhere";
  assert.match(unfold(Ics.toIcs(doc, { only: "s1-1", now: 0 })), /DTSTART:20261007T090000\r\n/);
  assert.equal(Ics.stamp("2026-01-01", "02:00", "Asia/Vladivostok"), "20251231T160000Z");
});

test("сейчас и далее: по поясу мероприятия, ближайшее в каждом зале; до начала — дни", async () => {
  const L = await live();
  const doc = rwp();
  // 7 октября 09:20 МСК = 06:20 UTC
  const now = L.nowIn("Europe/Moscow", Date.UTC(2026, 9, 7, 6, 20));
  assert.deepEqual(now, { date: "2026-10-07", min: 9 * 60 + 20 });
  const nn = L.nowNext(doc, now);
  assert.equal(nn.di, 0);
  assert.equal(nn.now.length, 1);
  assert.equal(nn.now[0].item.start, "09:15");
  assert.deepEqual(nn.next.map(x => x.item.start), ["09:30"], "кофе-брейк через час — не «далее»");
  assert.equal(L.itemState(doc.days[0], doc.days[0].sessions[0].items[0], now), "past");
  assert.equal(L.itemState(doc.days[0], doc.days[0].sessions[0].items[1], now), "now");
  assert.deepEqual(L.nowNext(doc, { date: "2026-10-04", min: 600 }), { before: 3 });
  assert.equal(L.nowNext(doc, { date: "2026-11-01", min: 600 }), null);
});

test("поиск: все слова, без учёта регистра и ё; фильтры секции и формы", async () => {
  const L = await live();
  const doc = rwp();
  const first = doc.days[0].sessions[0].items[0];
  const word = first.title.split(" ")[0].toUpperCase();
  assert.ok(L.searchItems(doc, word).some(x => x.item.code === first.code));
  assert.equal(L.searchItems(doc, word + " несуществующее").length, 0);
  const online = L.searchItems(doc, "", { format: "online" });
  assert.ok(online.length > 0 && online.every(x => x.item.format === "online"));
  assert.ok(L.searchItems(doc, "", { section: "2" }).every(x => x.item.section === 2));
  const f = L.facets(doc);
  assert.ok(f.rooms.length >= 2 && f.formats.indexOf("online") >= 0);
});

test("параллельные залы (РРВ-2023): «сейчас» — по элементу в каждом идущем зале", async () => {
  const L = await live();
  const doc = M.normalize(JSON.parse(fs.readFileSync(path.join(__dirname, "../../fixtures/rrv-2023.program.json"), "utf8"))).doc;
  const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
  // первый момент, когда в один день идут элементы в двух разных залах
  let hit = null;
  doc.days.forEach(d => {
    if (hit) return;
    for (let m = 8 * 60; m < 20 * 60 && !hit; m += 5) {
      const nn = L.nowNext(doc, { date: d.date, min: m });
      if (nn && nn.now && new Set(nn.now.map(x => x.room)).size >= 2) hit = { d, m, nn };
    }
  });
  assert.ok(hit, "в РРВ-2023 должны быть параллельные заседания");
  hit.nn.now.forEach(x => assert.ok(toMin(x.item.start) <= hit.m && hit.m < toMin(x.item.end)));
  assert.equal(new Set(hit.nn.next.map(x => x.room)).size, hit.nn.next.length, "в «далее» по одному элементу на зал");
});
