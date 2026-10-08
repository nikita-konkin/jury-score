"use strict";
// Локальный обработчик: задачи владельца, ключ process_jobs, worker/worker.mjs против поддельного LM Studio,
// проверка результата model.js, применение новой версией, чужой ключ не видит задачи.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, "../../fixtures", name), "utf8"));
const srv = require("./pb_server.js").setup(test);
const { api, login, t } = srv;
let ev, owner, other, lm, lmUrl;
const calls = [];

// Поддельный LM Studio: программа — сначала без даты (ошибка), после отчёта — правильная; доклады — с e-mail
function fakeLm() {
  const program = fixture("rwp-2026.program.json");
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      const send = obj => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
      if (req.url === "/v1/models") return send({ data: [{ id: "fake-model" }] });
      if (req.url !== "/v1/chat/completions") { res.statusCode = 404; return res.end(); }
      const msg = JSON.parse(body).messages;
      calls.push(msg);
      let content;
      if (/извлекаешь доклады/.test(msg[0].content)) {
        content = "<think>думаю</think>```json\n" + JSON.stringify({ items: [
          { title: "Доклад из письма", speaker: "Иванова А.Б.", org: "Университет", section: 2, email: "a@example.com" },
          { title: "Второй доклад", speaker: "П. П. Петров", format: "онлайн" },
        ] }) + "\n```";
      } else if (msg.length === 2) {
        const bad = JSON.parse(JSON.stringify(program));
        delete bad.event.date_from;
        bad.days = [];
        content = "Вот программа: " + JSON.stringify(bad);
      } else content = JSON.stringify(program);
      send({ choices: [{ message: { content } }] });
    });
  });
}

test.before(async () => {
  await srv.ready;
  if (!srv.base) return;
  const mk = async email => {
    const u = { email, password: "owner-pass-12345", passwordConfirm: "owner-pass-12345" };
    const created = await api("POST", "/api/collections/users/records", u, srv.suToken);
    return { id: created.json.id, token: await login("users", email, u.password) };
  };
  owner = await mk("jobs-owner@example.com");
  other = await mk("jobs-other@example.com");
  const imp = await api("POST", "/api/v1/admin/events", { slug: "jobs-ev", owners: [owner.id], program: fixture("rwp-2026.program.json") }, srv.suToken);
  ev = imp.json.event;
  lm = fakeLm();
  await new Promise(r => lm.listen(0, "127.0.0.1", r));
  lmUrl = "http://127.0.0.1:" + lm.address().port;
});
test.after(() => { if (lm) lm.close(); });

const worker = () => import("../../worker/worker.mjs");
let ownKey, otherKey;

t("ключ обработчика: только process_jobs, только свои; задача — только владельцу", async () => {
  assert.equal((await api("POST", "/api/v1/worker-keys", {})).status, 401);
  const k = await api("POST", "/api/v1/worker-keys", { name: "кафедра" }, owner.token);
  assert.equal(k.status, 201, k.text);
  ownKey = k.json.key;
  otherKey = (await api("POST", "/api/v1/worker-keys", {}, other.token)).json.key;
  const list = await api("GET", "/api/v1/worker-keys", undefined, owner.token);
  assert.deepEqual(list.json.keys.map(x => x.name), ["Обработчик — кафедра"]);
  // ключ обработчика не создаёт мероприятия
  assert.equal((await api("POST", "/api/v1/events", { program: fixture("rwp-2026.program.json") }, { "X-API-Key": ownKey })).status, 403);
  // обычный ключ бота не забирает задачи
  const bot = await api("POST", "/api/v1/admin/keys", { name: "бот" }, srv.suToken);
  assert.equal((await api("POST", "/api/v1/jobs/claim", {}, { "X-API-Key": bot.json.key })).status, 403);
  assert.equal((await api("POST", `/api/v1/events/${ev.id}/jobs`, { kind: "talks_from_text", text: "x" }, other.token)).status, 404);
  assert.equal((await api("POST", `/api/v1/events/${ev.id}/jobs`, { kind: "magic", text: "x" }, owner.token)).status, 400);
  assert.equal((await api("POST", `/api/v1/events/${ev.id}/jobs`, { kind: "talks_from_text", text: "  " }, owner.token)).status, 400);
});

t("доклады из текста: обработчик, контакты вырезаны, применение в заседание", async () => {
  const W = await worker();
  const j = await api("POST", `/api/v1/events/${ev.id}/jobs`, { kind: "talks_from_text", title: "Заявки из письма", text: "Иванова А.Б., a@example.com — Доклад из письма" }, owner.token);
  assert.equal(j.status, 201, j.text);
  assert.equal(j.json.job.status, "queued");
  // чужой обработчик задачу не видит
  assert.equal((await W.runOnce({ server: srv.base, key: otherKey, lm: lmUrl, docs: { llms: "", schema: "{}" } })), null);
  const done = await W.runOnce({ server: srv.base, key: ownKey, lm: lmUrl, docs: { llms: "", schema: "{}" } });
  assert.equal(done.status, "done", JSON.stringify(done));
  assert.deepEqual(done.stats, { items: 2 });
  const full = await api("GET", `/api/v1/events/${ev.id}/jobs/${j.json.job.id}`, undefined, owner.token);
  assert.equal(full.json.model, "fake-model");
  assert.equal(full.json.result.items[0].speaker, "А. Б. Иванова");
  assert.equal(full.json.result.items[1].format, "online");
  assert.equal(full.json.result.items[0].duration, undefined, "длительность — по регламенту, не из ответа модели");
  assert.ok(JSON.stringify(full.json.result).indexOf("example.com") < 0, "контакты вырезаны");
  const before = (await api("GET", `/api/v1/events/${ev.id}/program`, undefined, owner.token)).json.event.version;
  assert.equal((await api("POST", `/api/v1/events/${ev.id}/jobs/${j.json.job.id}`, { action: "apply", day: 0, session: 99 }, owner.token)).status, 400);
  const ap = await api("POST", `/api/v1/events/${ev.id}/jobs/${j.json.job.id}`, { action: "apply", day: 0, session: 0 }, owner.token);
  assert.equal(ap.status, 200, ap.text);
  assert.equal(ap.json.version, before + 1);
  const prog = (await api("GET", `/api/v1/events/${ev.id}/program`, undefined, owner.token)).json.program;
  const items = prog.days[0].sessions[0].items;
  assert.equal(items[items.length - 1].title, "Второй доклад");
  assert.match(items[items.length - 2].code, /^s2-\d+$/, "код по секции");
  const list = await api("GET", `/api/v1/events/${ev.id}/jobs`, undefined, owner.token);
  assert.equal(list.json.jobs[0].status, "applied");
  assert.ok(list.json.worker_seen, "видно, когда обработчик был на связи");
  assert.equal((await api("POST", `/api/v1/events/${ev.id}/jobs/${j.json.job.id}`, { action: "apply", day: 0, session: 0 }, owner.token)).status, 409);
});

t("программа из текста: исправление по отчёту проверки, применение целиком; отмена", async () => {
  const W = await worker();
  calls.length = 0;
  const j = await api("POST", `/api/v1/events/${ev.id}/jobs`, { kind: "program_from_text", text: "Информационное письмо…", note: "без перерывов" }, owner.token);
  const done = await W.runOnce({ server: srv.base, key: ownKey, lm: lmUrl, docs: { llms: "LLMS", schema: "{}" } });
  assert.equal(done.status, "done", JSON.stringify(done));
  assert.equal(calls.length, 2, "вторая попытка — по отчёту проверки");
  assert.match(calls[1][3].content, /Проверка нашла ошибки/);
  assert.match(calls[0][1].content, /без перерывов/);
  assert.ok(done.stats.items > 20);
  const ap = await api("POST", `/api/v1/events/${ev.id}/jobs/${j.json.job.id}`, { action: "apply" }, owner.token);
  assert.equal(ap.status, 200, ap.text);
  const versions = await api("GET", `/api/v1/events/${ev.id}/versions`, undefined, owner.token);
  assert.match(versions.json.versions[0].note, /^Обработчик: /);
  // отмена задачи в очереди; пустая очередь — null
  const q = await api("POST", `/api/v1/events/${ev.id}/jobs`, { kind: "talks_from_text", text: "ещё" }, owner.token);
  const c = await api("POST", `/api/v1/events/${ev.id}/jobs/${q.json.job.id}`, { action: "cancel" }, owner.token);
  assert.equal(c.json.job.status, "cancelled");
  assert.equal(await W.runOnce({ server: srv.base, key: ownKey, lm: lmUrl, docs: { llms: "", schema: "{}" } }), null);
  // результат по чужой задаче не принимается
  const q2 = await api("POST", `/api/v1/events/${ev.id}/jobs`, { kind: "talks_from_text", text: "ещё" }, owner.token);
  assert.equal((await api("POST", `/api/v1/jobs/${q2.json.job.id}/result`, { result: { items: [] } }, { "X-API-Key": ownKey })).status, 409);
});
