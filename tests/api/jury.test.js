"use strict";
// Жюри (/api/jury/{id}): коды комиссии, роли, оценки с upsert по ts, архив удалённых — как Code.gs jury-score.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, "../../fixtures", name), "utf8"));
const srv = require("./pb_server.js").setup(test);
const { api, login, t } = srv;
let ev, owner, codes;

test.before(async () => {
  await srv.ready;
  if (!srv.base) return;
  const u = { email: "jury-owner@example.com", password: "owner-pass-12345", passwordConfirm: "owner-pass-12345" };
  const created = await api("POST", "/api/collections/users/records", u, srv.suToken);
  owner = await login("users", u.email, u.password);
  const imp = await api("POST", "/api/v1/admin/events", { slug: "rwp-jury", owners: [created.json.id], program: fixture("rwp-2026.program.json") }, srv.suToken);
  ev = imp.json.event;
});

const get = (q, auth) => api("GET", "/api/jury/rwp-jury?" + new URLSearchParams(q), undefined, auth);
const post = (body, auth) => api("POST", "/api/jury/rwp-jury", body, auth);
const S = [5, 4, 5, 4, 5, 4];

t("коды комиссии: видит только владелец, создаются сами, выпускаются заново", async () => {
  assert.equal((await api("GET", `/api/v1/events/${ev.id}/jury`)).status, 404);
  const r = await api("GET", `/api/v1/events/${ev.id}/jury`, undefined, owner);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.enabled, true);
  assert.equal(r.json.criteria.length, 6);
  assert.match(r.json.juror_code, /^[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.notEqual(r.json.juror_code, r.json.admin_code);
  assert.match(r.json.url, /#\/jury\/rwp-jury$/);
  const again = await api("GET", `/api/v1/events/${ev.id}/jury`, undefined, owner);
  assert.equal(again.json.juror_code, r.json.juror_code, "коды не меняются сами");
  // в публичных ответах кодов нет
  const pub = await api("GET", `/api/collections/events/records/${ev.id}`, undefined, owner);
  assert.equal(pub.json.jury_code, undefined);
  codes = { juror: r.json.juror_code, admin: r.json.admin_code };
});

t("роли: неверный код, эксперт, администратор (регистр и дефис не важны), владелец без кода", async () => {
  assert.equal((await get({ action: "ping", code: "zzzz-zzzz" })).json.error, "bad_code");
  const j = await get({ action: "ping", code: codes.juror.toUpperCase().replace("-", " ") });
  assert.equal(j.json.ok, true);
  assert.equal(j.json.role, "juror");
  assert.equal(j.json.criteria.length, 6);
  assert.equal(j.json.scaleMax, 5);
  assert.ok(j.json.talks.length >= 20 && j.json.talks.every(x => /^s\d+-\d+$/.test(x.code)), "оцениваются конкурсные доклады");
  assert.equal((await get({ action: "ping", code: codes.admin.replace("-", "") })).json.role, "admin");
  assert.equal((await get({ action: "ping" }, owner)).json.role, "admin");
  assert.equal((await get({ action: "all", code: codes.juror })).json.error, "forbidden");
  assert.equal((await api("GET", "/api/jury/nope?action=ping")).status, 404);
});

t("оценки: проверка, сумма считается сервером, upsert, устаревшая правка, частичная и статус", async () => {
  const base = { action: "save", code: codes.juror, juror: "Иванов И.И.", id: "s1-1", scores: S, status: "", comment: "хорошо", ts: 1000 };
  assert.equal((await post(Object.assign({}, base, { id: "x1" }))).json.error, "bad_id");
  assert.equal((await post(Object.assign({}, base, { scores: [5, 5] }))).json.error, "bad_scores");
  assert.equal((await post(Object.assign({}, base, { scores: [6, 4, 5, 4, 5, 4] }))).json.error, "bad_scores");
  assert.equal((await post(Object.assign({}, base, { juror: "  " }))).json.error, "bad_juror");
  assert.equal((await get({ action: "save", code: codes.juror })).json.error, "post_only");
  assert.equal((await post(Object.assign({}, base, { total: 999 }))).json.ok, true);
  // тот же эксперт под другим написанием — та же строка; более старая правка не затирает новую
  assert.equal((await post(Object.assign({}, base, { juror: "иванов  и. и.", scores: [1, 1, 1, 1, 1, 1], ts: 2000 }))).json.ok, true);
  assert.deepEqual((await post(Object.assign({}, base, { ts: 1500 }))).json, { ok: true, stale: true });
  const mine = await get({ action: "mine", code: codes.juror, juror: "ИВАНОВ И. И." });
  assert.equal(mine.json.rows.length, 1);
  assert.deepEqual(mine.json.rows[0].scores, [1, 1, 1, 1, 1, 1]);
  // частичная оценка и «не состоялся» — без суммы
  assert.equal((await post(Object.assign({}, base, { id: "s1-2", scores: [5, null, null, null, null, null], ts: 3000 }))).json.ok, true);
  assert.equal((await post(Object.assign({}, base, { id: "s1-3", status: "absent", scores: [null, null, null, null, null, null], ts: 3000 }))).json.ok, true);
  const recs = await api("GET", `/api/collections/scores/records?perPage=50&filter=${encodeURIComponent(`event="${ev.id}"`)}&sort=code`, undefined, srv.suToken);
  const by = {};
  recs.json.items.forEach(r => { by[r.code] = r; });
  assert.equal(by["s1-1"].total, 6);
  assert.equal(by["s1-1"].complete, true);
  assert.equal(by["s1-2"].complete, false);
  assert.equal(by["s1-2"].total, 0);
  assert.equal(by["s1-3"].status, "absent");
  // напрямую оценки не читаются и не пишутся
  assert.equal((await api("GET", "/api/collections/scores/records", undefined, owner)).status, 403);
  // sendBeacon шлёт text/plain — тоже принимается
  const beacon = await api("POST", "/api/jury/rwp-jury", JSON.stringify(Object.assign({}, base, { id: "s1-4", ts: 4000 })), { "Content-Type": "text/plain;charset=UTF-8" });
  assert.equal(beacon.json.ok, true);
});

t("администратор: все оценки, удаление эксперта в архив", async () => {
  await post({ action: "save", code: codes.juror, juror: "Петров П. П.", id: "s1-1", scores: S, ts: 5000 });
  const all = await get({ action: "all", code: codes.admin });
  assert.equal(new Set(all.json.rows.map(r => r.juror.toLowerCase().replace(/\s/g, ""))).size, 2);
  assert.equal((await post({ action: "delete", code: codes.juror, juror: "x", target: "Петров П. П." })).json.error, "forbidden");
  const del = await post({ action: "delete", code: codes.admin, juror: "Админ", target: "петров п.п." });
  assert.deepEqual(del.json, { ok: true, deleted: 1 });
  const arch = await api("GET", "/api/collections/scores_deleted/records", undefined, srv.suToken);
  assert.equal(arch.json.items[0].deleted_by, "Админ");
  assert.equal((await get({ action: "all", code: codes.admin })).json.rows.every(r => !/Петров/.test(r.juror)), true);
});

t("новый код эксперта: старый перестаёт работать; программа без критериев — жюри выключено", async () => {
  const r = await api("POST", `/api/v1/events/${ev.id}/jury`, { reset: "juror" }, owner);
  assert.equal(r.status, 200, r.text);
  assert.notEqual(r.json.juror_code, codes.juror);
  assert.equal((await get({ action: "ping", code: codes.juror })).json.error, "bad_code");
  assert.equal((await get({ action: "ping", code: r.json.juror_code })).json.role, "juror");
  // оценки переживают правку программы: коды докладов стабильны
  const prog = (await api("GET", `/api/v1/events/${ev.id}/program`, undefined, owner)).json.program;
  prog.days[0].sessions[0].items[0].title = "Новое название";
  assert.equal((await api("PUT", `/api/v1/events/${ev.id}/program`, { program: prog }, owner)).status, 200);
  assert.ok((await get({ action: "all", code: codes.admin })).json.rows.some(r => r.id === "s1-1"));
  delete prog.event.jury;
  assert.equal((await api("PUT", `/api/v1/events/${ev.id}/program`, { program: prog }, owner)).status, 200);
  assert.equal((await get({ action: "ping", code: r.json.juror_code })).json.error, "jury_disabled");
  assert.equal((await api("GET", `/api/v1/events/${ev.id}/jury`, undefined, owner)).json.juror_code, "");
});
