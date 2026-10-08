/// <reference path="../pb_data/types.d.ts" />
// Локальный обработчик (этап 9).
// Владелец: GET/POST /api/v1/events/{id}/jobs, GET/POST …/jobs/{задача} (apply, cancel),
//           POST/GET /api/v1/worker-keys — ключ process_jobs для своего компьютера, POST …/{prefix}/revoke.
// Обработчик: POST /api/v1/jobs/claim, POST /api/v1/jobs/{задача}/result — по ключу с правом process_jobs.

routerAdd("GET", "/api/v1/events/{id}/jobs", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const S = require(`${__hooks}/lib/program_store.js`);
  const J = require(`${__hooks}/lib/jobs_store.js`);
  const ev = S.findEvent(e.app, e.request.pathValue("id"));
  const a = A.actor(e);
  const acc = ev ? A.access(a, ev) : null;
  if (!ev || !acc.read) throw new NotFoundError("Мероприятие не найдено");
  if (!acc.manage) throw new ForbiddenError("Задачи обработчика видит только владелец");
  return e.json(200, { jobs: J.list(e.app, ev), worker_seen: J.workerSeen(e.app, a.user ? a.user.id : ""), version: ev.getInt("version") });
});

routerAdd("POST", "/api/v1/events/{id}/jobs", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const S = require(`${__hooks}/lib/program_store.js`);
  const J = require(`${__hooks}/lib/jobs_store.js`);
  const ev = S.findEvent(e.app, e.request.pathValue("id"));
  const a = A.actor(e);
  const acc = ev ? A.access(a, ev) : null;
  if (!ev || !acc.read) throw new NotFoundError("Мероприятие не найдено");
  if (!acc.manage) throw new ForbiddenError("Задачи обработчика ставит только владелец");
  const r = J.create(e.app, ev, a.user ? a.user.id : "", A.readJson(e, 512 * 1024));
  return e.json(r.status, r.body);
});

routerAdd("GET", "/api/v1/events/{id}/jobs/{job}", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const S = require(`${__hooks}/lib/program_store.js`);
  const J = require(`${__hooks}/lib/jobs_store.js`);
  const ev = S.findEvent(e.app, e.request.pathValue("id"));
  const acc = ev ? A.access(A.actor(e), ev) : null;
  if (!ev || !acc.read) throw new NotFoundError("Мероприятие не найдено");
  if (!acc.manage) throw new ForbiddenError("Задачи обработчика видит только владелец");
  let j = null;
  try { j = e.app.findRecordById("jobs", e.request.pathValue("job")); } catch (err) { /* нет */ }
  if (!j || j.getString("event") !== ev.id) throw new NotFoundError("Задача не найдена");
  return e.json(200, J.view(j, true));
});

routerAdd("POST", "/api/v1/events/{id}/jobs/{job}", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const S = require(`${__hooks}/lib/program_store.js`);
  const J = require(`${__hooks}/lib/jobs_store.js`);
  const ev = S.findEvent(e.app, e.request.pathValue("id"));
  const a = A.actor(e);
  const acc = ev ? A.access(a, ev) : null;
  if (!ev || !acc.read) throw new NotFoundError("Мероприятие не найдено");
  if (!acc.manage) throw new ForbiddenError("Задачи обработчика меняет только владелец");
  let j = null;
  try { j = e.app.findRecordById("jobs", e.request.pathValue("job")); } catch (err) { /* нет */ }
  if (!j || j.getString("event") !== ev.id) throw new NotFoundError("Задача не найдена");
  const body = A.readJson(e);
  let r;
  if (body.action === "apply") r = J.apply(e, ev, j, body, a.user ? a.user.id : "");
  else if (body.action === "cancel") r = J.cancel(e.app, j);
  else throw new BadRequestError("action: apply или cancel");
  return e.json(r.status, r.body);
});

// Ключ для своего компьютера: только право process_jobs, задачи — только своих мероприятий
routerAdd("POST", "/api/v1/worker-keys", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const a = A.actor(e);
  if (!a.user) throw new UnauthorizedError("Нужен вход");
  const mine = e.app.findRecordsByFilter("api_keys", "issued_by = {:u} && revoked = false", "", 50, 0, { u: a.user.id })
    .filter((k) => k.getStringSlice("scopes").join(",") === "process_jobs");
  if (mine.length >= 5) throw new BadRequestError("Уже есть 5 ключей обработчика — отзовите ненужные");
  const body = A.readJson(e);
  const res = A.createKey(e.app, {
    name: "Обработчик — " + (String(body.name || "").trim().slice(0, 60) || "мой компьютер"),
    scopes: ["process_jobs"], issued_by: a.user.id,
  });
  return e.json(201, { ok: true, key: res.key, prefix: res.record.getString("prefix"), message: "Сохраните ключ: повторно он не показывается" });
});

routerAdd("GET", "/api/v1/worker-keys", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const a = A.actor(e);
  if (!a.user) throw new UnauthorizedError("Нужен вход");
  const keys = e.app.findRecordsByFilter("api_keys", "issued_by = {:u}", "-created", 50, 0, { u: a.user.id })
    .filter((k) => k.getStringSlice("scopes").indexOf("process_jobs") >= 0)
    .map((k) => ({ prefix: k.getString("prefix"), name: k.getString("name"), revoked: k.getBool("revoked"),
      last_used: k.getString("last_used"), created: k.getString("created") }));
  return e.json(200, { keys: keys });
});

routerAdd("POST", "/api/v1/worker-keys/{prefix}/revoke", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const a = A.actor(e);
  if (!a.user) throw new UnauthorizedError("Нужен вход");
  let k = null;
  try { k = e.app.findFirstRecordByFilter("api_keys", "prefix = {:p} && issued_by = {:u}", { p: e.request.pathValue("prefix"), u: a.user.id }); } catch (err) { /* нет */ }
  if (!k || k.getStringSlice("scopes").indexOf("process_jobs") < 0) throw new NotFoundError("Ключ не найден");
  k.set("revoked", true);
  e.app.save(k);
  return e.json(200, { ok: true });
});

routerAdd("POST", "/api/v1/jobs/claim", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const J = require(`${__hooks}/lib/jobs_store.js`);
  const key = A.requireKey(A.actor(e), "process_jobs");
  return e.json(200, J.claim(e, key));
});

routerAdd("POST", "/api/v1/jobs/{job}/result", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const J = require(`${__hooks}/lib/jobs_store.js`);
  const key = A.requireKey(A.actor(e), "process_jobs");
  let j = null;
  try { j = e.app.findRecordById("jobs", e.request.pathValue("job")); } catch (err) { /* нет */ }
  if (!j) throw new NotFoundError("Задача не найдена");
  const r = J.submitResult(e, key, j, A.readJson(e, 4 * 1024 * 1024));
  return e.json(r.status, r.body);
});
