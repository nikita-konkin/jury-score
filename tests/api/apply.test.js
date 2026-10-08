"use strict";
// Заявки (/api/apply/{id}, /api/v1/events/{id}/applications): согласие, антиспам, модерация, заявка → доклад.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, "../../fixtures", name), "utf8"));
const srv = require("./pb_server.js").setup(test);
const { api, login, t } = srv;
let ev, owner, prog;

const OPERATOR = "ООО «Пример», г. Йошкар-Ола";
const form = extra => Object.assign({
  speaker: "Иванова А. Б.", authors: "Иванова А. Б.\nПетров В. Г.", title: "Распространение радиоволн в тропосфере",
  section: 1, format: "online", org: "Университет", city: "Казань", email: "Ivanova@Example.com", phone: "+7 900 000-00-00",
  note: "Нужен проектор", consent: true, elapsed: 60000, website: "",
}, extra || {});
const submit = body => api("POST", "/api/apply/rwp-apply", body);

test.before(async () => {
  await srv.ready;
  if (!srv.base) return;
  const u = { email: "apply-owner@example.com", password: "owner-pass-12345", passwordConfirm: "owner-pass-12345" };
  const created = await api("POST", "/api/collections/users/records", u, srv.suToken);
  owner = await login("users", u.email, u.password);
  prog = fixture("rwp-2026.program.json");
  prog.event.applications = { deadline: "2099-12-31", operator: OPERATOR, contact: "conf@example.com", note: "Тезисы — до 1 страницы" };
  const imp = await api("POST", "/api/v1/admin/events", { slug: "rwp-apply", owners: [created.json.id], program: prog }, srv.suToken);
  assert.equal(imp.status, 201, imp.text);
  ev = imp.json.event;
});

t("форма: настройки приёма, текст согласия с оператором и контактом", async () => {
  const r = await api("GET", "/api/apply/rwp-apply");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.open, true);
  assert.equal(r.json.note, "Тезисы — до 1 страницы");
  assert.ok(r.json.consent.indexOf(OPERATOR) > 0 && r.json.consent.indexOf("conf@example.com") > 0);
  assert.ok(r.json.sections.length >= 4);
  assert.deepEqual(r.json.formats.map(f => f.value), ["oral", "online", "poster"]);
  assert.equal((await api("GET", "/api/apply/nope")).status, 404);
});

let token;
t("заявка: проверки полей, согласие, ловушка для ботов, слишком быстрая отправка", async () => {
  const bad = async (extra, field) => {
    const r = await submit(form(extra));
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.field, field, r.text);
  };
  await bad({ consent: false }, "consent");
  await bad({ speaker: " " }, "speaker");
  await bad({ title: "" }, "title");
  await bad({ email: "нет" }, "email");
  await bad({ section: 99 }, "section");
  await bad({ section: "" }, "section");
  await bad({ phone: "звоните" }, "phone");
  assert.match((await submit(form({ elapsed: 500 }))).json.message, /слишком быстро/);
  const trap = await submit(form({ website: "http://spam.example" }));
  assert.deepEqual([trap.status, trap.json.no], [201, 0], "бот думает, что заявка принята");
  const ok = await submit(form());
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.json.no, 1);
  assert.match(ok.json.url, /#\/apply\/rwp-apply\/ap_[A-Za-z0-9]{24}$/);
  token = ok.json.token;
  const dup = await submit(form({ title: "  распространение радиоволн в тропосфере. " }));
  assert.equal(dup.status, 409, dup.text);
  // своя заявка по ссылке
  const mine = await api("GET", "/api/apply/rwp-apply/" + token);
  assert.equal(mine.json.application.status, "new");
  assert.deepEqual(mine.json.application.authors, ["Иванова А. Б.", "Петров В. Г."]);
  assert.equal(mine.json.application.email, "ivanova@example.com");
  assert.equal((await api("GET", "/api/apply/rwp-apply/ap_" + "x".repeat(24))).status, 404);
});

t("модерация: только владелец; принятая заявка — доклад в программе без контактов", async () => {
  assert.equal((await api("GET", `/api/v1/events/${ev.id}/applications`)).status, 404);
  const list = await api("GET", `/api/v1/events/${ev.id}/applications`, undefined, owner);
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.applications.length, 1, "ловушка ничего не сохранила");
  const a = list.json.applications[0];
  assert.equal(a.phone, "+7 900 000-00-00");
  assert.match(list.json.url, /#\/apply\/rwp-apply$/);
  const before = list.json.version;

  const acc = await api("POST", `/api/v1/events/${ev.id}/applications/${a.id}`, { action: "accept" }, owner);
  assert.equal(acc.status, 200, acc.text);
  assert.match(acc.json.item.code, /^s1-\d+$/);
  assert.equal(acc.json.version, before + 1);
  assert.equal(acc.json.application.status, "accepted");
  assert.equal((await api("POST", `/api/v1/events/${ev.id}/applications/${a.id}`, { action: "accept" }, owner)).status, 409);
  const p = (await api("GET", `/api/v1/events/${ev.id}/program`, undefined, owner)).json.program;
  const s = p.days[acc.json.item.day].sessions[acc.json.item.session];
  const it = s.items.find(x => x.code === acc.json.item.code);
  assert.equal(it.title, "Распространение радиоволн в тропосфере");
  assert.equal(it.format, "online");
  assert.ok(JSON.stringify(p).indexOf("ivanova@") < 0 && JSON.stringify(p).indexOf("900 000") < 0, "контакты не попали в программу");
  const versions = await api("GET", `/api/v1/events/${ev.id}/versions`, undefined, owner);
  assert.match(versions.json.versions[0].note, /Заявка №1/);

  // вторая заявка: отклонить с причиной, вернуть, принять в выбранное заседание
  const two = await submit(form({ title: "Ионосфера", email: "b@example.com", section: 2 }));
  const id2 = (await api("GET", `/api/v1/events/${ev.id}/applications`, undefined, owner)).json.applications[0].id;
  const rej = await api("POST", `/api/v1/events/${ev.id}/applications/${id2}`, { action: "reject", reason: "Не по теме конференции" }, owner);
  assert.equal(rej.json.application.status, "rejected");
  const seen = await api("GET", "/api/apply/rwp-apply/" + two.json.token);
  assert.deepEqual([seen.json.application.status, seen.json.application.reason], ["rejected", "Не по теме конференции"]);
  await api("POST", `/api/v1/events/${ev.id}/applications/${id2}`, { action: "reset" }, owner);
  assert.equal((await api("POST", `/api/v1/events/${ev.id}/applications/${id2}`, { action: "accept", day: 0, session: 99 }, owner)).status, 400);
  const acc2 = await api("POST", `/api/v1/events/${ev.id}/applications/${id2}`, { action: "accept", day: 0, session: 0 }, owner);
  assert.equal(acc2.status, 200, acc2.text);
  assert.deepEqual([acc2.json.item.day, acc2.json.item.session], [0, 0]);
});

t("отзыв заявки участником стирает контакты; частота с одного адреса ограничена", async () => {
  const w = await api("POST", "/api/apply/rwp-apply/" + token, { action: "withdraw" });
  assert.equal(w.json.application.status, "withdrawn");
  const list = (await api("GET", `/api/v1/events/${ev.id}/applications`, undefined, owner)).json.applications;
  const a = list.find(x => x.no === 1);
  assert.deepEqual([a.email, a.phone, a.note], ["", "", ""]);
  assert.equal((await api("POST", `/api/v1/events/${ev.id}/applications/${a.id}`, { action: "accept" }, owner)).status, 409);
  // с этого адреса за час осталась 1 заявка (у отозванной адрес стёрт), лимит — 10
  const codes = [];
  for (let i = 0; i < 10; i++) codes.push((await submit(form({ title: "Доклад " + i, email: `x${i}@example.com` }))).status);
  assert.deepEqual(codes, [201, 201, 201, 201, 201, 201, 201, 201, 201, 429]);
});

t("приём закрыт: срок прошёл, выключен, нет оператора персональных данных", async () => {
  const set = async ap => {
    const p = (await api("GET", `/api/v1/events/${ev.id}/program`, undefined, owner)).json.program;
    p.event.applications = ap;
    if (!ap) delete p.event.applications;
    delete p.event.organizer;
    const r = await api("PUT", `/api/v1/events/${ev.id}/program`, { program: p }, owner);
    assert.equal(r.status, 200, r.text);
    return (await api("GET", "/api/apply/rwp-apply")).json;
  };
  assert.match((await set({ deadline: "2020-01-01", operator: OPERATOR })).reason, /завершён 01\.01\.2020/);
  assert.equal((await set({ enabled: false, operator: OPERATOR })).open, false);
  const noOp = await set({});
  assert.deepEqual([noOp.open, noOp.reason], [false, "Приём заявок ещё не настроен организатором"]);
  assert.equal((await set(null)).reason, "Приём заявок закрыт");
  const r = await submit(form({ title: "Поздно", email: "late@example.com" }));
  assert.equal(r.status, 403, r.text);
});
