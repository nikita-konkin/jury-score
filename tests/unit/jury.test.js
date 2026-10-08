"use strict";
// Жюри на клиенте (web/src/jury): итоги и рейтинг как в jury-score, офлайн-очередь.
const test = require("node:test");
const assert = require("node:assert/strict");

const R = () => import("../../web/src/jury/results.js");
const Q = () => import("../../web/src/jury/queue.js");

const TALKS = [
  { code: "s1-1", title: "А", speaker: "А. А. Ан", section: 1, idx: 0 },
  { code: "s1-2", title: "Б", speaker: "Б. Б. Бе", section: 1, idx: 1 },
  { code: "s2-1", title: "В", speaker: "В. В. Ве", section: 2, idx: 2 },
  { code: "s2-2", title: "Г", speaker: "Г. Г. Ге", section: 2, idx: 3 },
];
const row = (juror, id, scores, status) => ({ juror, id, scores, status: status || "", comment: "", ts: 1 });

test("итоги: засчитываются только полные оценки без статуса; одинаковые средние — одно место", async () => {
  const r = await R();
  const all = r.groupRows([
    row("Иванов И.И.", "s1-1", [5, 5]), row("иванов и. и.", "s1-2", [4, 5]),
    row("Петров", "s1-1", [4, 4]), row("Петров", "s1-2", [5, 4]),
    row("Петров", "s2-1", [5, null]), row("Петров", "s2-2", [5, 5], "abstain"),
    row("Петров", "x9", [5, 5]),
  ], TALKS, 2, 5);
  assert.deepEqual(Object.keys(all).sort(), ["иванов и. и.", "петров"]);
  const rows = r.computeResults(all, TALKS, 2, 5);
  assert.deepEqual(rows.map(x => x.t.code), ["s1-1", "s1-2"], "частичная и «воздерживаюсь» не в рейтинге");
  const s11 = rows[0];
  assert.equal(s11.avg, 9);
  assert.equal(s11.n, 2);
  assert.deepEqual([s11.min, s11.max], [8, 10]);
  assert.deepEqual(s11.crit, [4.5, 4.5]);
  const ranked = r.rankRows(rows);
  assert.deepEqual(ranked.map(x => [x.t.code, x.rank]), [["s1-1", 1], ["s1-2", 1]], "9 = 9 — общее первое место");
  const st = r.stats(all, rows, TALKS, ["К1", "К2"], 5, [{ no: 1, title: "x" }, { no: 2, title: "y" }]);
  assert.equal(st.counted, 4);
  assert.equal(st.overall, 9);
  assert.equal(st.dist[4], 4);
  assert.equal(st.bySection[0].leaders.length, 2);
  assert.equal(st.bySection[1].rated, 0);
  assert.equal(st.jurors.find(j => j.name === "Петров").done, 3);
  const csv = r.csvRank(rows, ["К1", "К2"]);
  assert.match(csv, /^﻿Место;Место в секции/);
  assert.match(csv, /\r\n1;1;1;s1-1;А\. А\. Ан;А;9;2;8;10;1;4,5;4,5\r\n/);
  assert.match(r.csvRaw(all, TALKS, ["К1", "К2"], 5), /Петров;2;s2-2;Г\. Г\. Ге;Г;5;5;;воздерживается;/);
});

function memStore() {
  const m = {};
  return { get: (k, d) => (k in m ? JSON.parse(m[k]) : d), set: (k, v) => { m[k] = JSON.stringify(v); return true; }, m };
}
const tick = ms => new Promise(r => setTimeout(r, ms));

test("очередь: правка сохраняется сразу, отправляется, при сбое — повтор, устаревшая отправка остаётся в очереди", async () => {
  const q = await Q();
  const store = memStore();
  const sent = [];
  let fail = true;
  const queue = q.createQueue({
    slug: "ev", juror: "Иванов И.И.", code: "c", nc: 2, smax: 5, storage: store, delays: { flush: 1, retry: 5 },
    post: async body => { sent.push(body); if (fail) throw new Error("нет сети"); return { ok: true }; },
  });
  queue.change("s1-1", r => { r.s[0] = 5; });
  assert.deepEqual(store.get("conf_jury_pending_ev_иванов и. и.", []), ["s1-1"], "в localStorage до отправки");
  await tick(3);
  assert.equal(queue.errs["s1-1"], 1);
  fail = false;
  await tick(20);
  assert.equal(queue.pendingCount(), 0, "повтор после сбоя");
  assert.deepEqual(sent[sent.length - 1].scores, [5, null]);

  // пока запрос в пути, оценку поправили — запись остаётся в очереди и уходит ещё раз
  let release;
  const slow = q.createQueue({
    slug: "ev2", juror: "П", code: "c", nc: 2, smax: 5, storage: memStore(), delays: { flush: 1, retry: 5 },
    post: body => new Promise(res => { release = () => res({ ok: true }); }),
  });
  slow.change("s1-1", r => { r.s[0] = 3; });
  await tick(3);
  slow.change("s1-1", r => { r.s[1] = 4; });
  release();
  await tick(3);
  assert.equal(slow.pending["s1-1"], 1);
  release();
  await tick(5);
  release && release();
  await tick(5);
  assert.equal(slow.pendingCount(), 0);
  slow.close();

  // неверный код — без повторов
  const bad = q.createQueue({ slug: "ev3", juror: "Х", code: "c", nc: 1, smax: 5, storage: memStore(), delays: { flush: 1, retry: 1 },
    post: async () => ({ ok: false, error: "bad_code" }) });
  bad.change("s1-1", r => { r.s[0] = 1; });
  await tick(10);
  assert.equal(bad.fatal, "bad_code");
  bad.close();

  // слияние с сервером: неотправленное и более свежее локальное не затирается
  queue.change("s1-2", r => { r.s[0] = 2; });
  queue.merge([{ id: "s1-2", scores: [5, 5], ts: 1 }, { id: "s2-1", scores: [1, 1], status: "", comment: "c", ts: 7 }]);
  assert.deepEqual(queue.rec("s1-2").s, [2, null]);
  assert.deepEqual(queue.rec("s2-1").s, [1, 1]);
  queue.close();
});
