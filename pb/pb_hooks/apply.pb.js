/// <reference path="../pb_data/types.d.ts" />
// Заявки на доклады. Участник: GET/POST /api/apply/{id или slug}, своя заявка по ссылке — /api/apply/{id}/{токен}.
// Владелец: GET /api/v1/events/{id}/applications (с контактами), POST …/applications/{заявка} — принять, отклонить, вернуть.
// Ответы участнику — { ok, message, field }, чтобы форма показала ошибку у нужного поля.

routerAdd("GET", "/api/apply/{id}", (e) => {
  const S = require(`${__hooks}/lib/program_store.js`);
  const P = require(`${__hooks}/lib/apply_store.js`);
  const ev = S.findEvent(e.app, e.request.pathValue("id"));
  if (!ev) return e.json(404, { ok: false, message: "Мероприятие не найдено" });
  return e.json(200, P.publicInfo(e.app, ev));
});

routerAdd("POST", "/api/apply/{id}", (e) => {
  const S = require(`${__hooks}/lib/program_store.js`);
  const A = require(`${__hooks}/lib/access.js`);
  const P = require(`${__hooks}/lib/apply_store.js`);
  const ev = S.findEvent(e.app, e.request.pathValue("id"));
  if (!ev) return e.json(404, { ok: false, message: "Мероприятие не найдено" });
  const r = P.submit(e, ev, A.readJson(e, 32 * 1024));
  return e.json(r.status, r.body);
});

routerAdd("GET", "/api/apply/{id}/{token}", (e) => {
  const S = require(`${__hooks}/lib/program_store.js`);
  const P = require(`${__hooks}/lib/apply_store.js`);
  const ev = S.findEvent(e.app, e.request.pathValue("id"));
  const a = ev ? P.findByToken(e.app, ev, e.request.pathValue("token")) : null;
  if (!a) return e.json(404, { ok: false, message: "Заявка не найдена. Проверьте ссылку" });
  return e.json(200, { ok: true, event: { title: S.loadProgram(e.app, ev).event.title, slug: ev.getString("slug") }, application: P.view(a, false) });
});

routerAdd("POST", "/api/apply/{id}/{token}", (e) => {
  const S = require(`${__hooks}/lib/program_store.js`);
  const A = require(`${__hooks}/lib/access.js`);
  const P = require(`${__hooks}/lib/apply_store.js`);
  const ev = S.findEvent(e.app, e.request.pathValue("id"));
  const a = ev ? P.findByToken(e.app, ev, e.request.pathValue("token")) : null;
  if (!a) return e.json(404, { ok: false, message: "Заявка не найдена. Проверьте ссылку" });
  const body = A.readJson(e);
  if (body.action !== "withdraw") return e.json(400, { ok: false, message: "action: withdraw" });
  P.withdraw(e.app, a);
  return e.json(200, { ok: true, application: P.view(a, false) });
});

routerAdd("GET", "/api/v1/events/{id}/applications", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const S = require(`${__hooks}/lib/program_store.js`);
  const P = require(`${__hooks}/lib/apply_store.js`);
  const ev = S.findEvent(e.app, e.request.pathValue("id"));
  const acc = ev ? A.access(A.actor(e), ev) : null;
  if (!ev || !acc.read) throw new NotFoundError("Мероприятие не найдено");
  if (!acc.manage) throw new ForbiddenError("Заявки с контактами участников видит только владелец");
  const info = P.publicInfo(e.app, ev);
  return e.json(200, {
    open: info.open, reason: info.reason || "", deadline: info.deadline || "",
    url: A.baseUrl(e) + "/#/apply/" + ev.getString("slug"), version: ev.getInt("version"),
    applications: P.list(e.app, ev),
  });
});

routerAdd("POST", "/api/v1/events/{id}/applications/{app}", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const S = require(`${__hooks}/lib/program_store.js`);
  const P = require(`${__hooks}/lib/apply_store.js`);
  const ev = S.findEvent(e.app, e.request.pathValue("id"));
  const a = A.actor(e);
  const acc = ev ? A.access(a, ev) : null;
  if (!ev || !acc.read) throw new NotFoundError("Мероприятие не найдено");
  if (!acc.manage) throw new ForbiddenError("Решения по заявкам принимает только владелец");
  let rec = null;
  try { rec = e.app.findRecordById("applications", e.request.pathValue("app")); } catch (err) { /* нет */ }
  if (!rec || rec.getString("event") !== ev.id) throw new NotFoundError("Заявка не найдена");
  const r = P.decide(e, ev, rec, A.readJson(e), a.user ? a.user.id : "");
  return e.json(r.status, r.body);
});
