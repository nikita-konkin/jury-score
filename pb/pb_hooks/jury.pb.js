/// <reference path="../pb_data/types.d.ts" />
// Жюри (перенос Code.gs из jury-score): GET ?action=ping|mine|all&code=…&juror=…, POST JSON { action: save|delete, … }.
// Ответ всегда JSON { ok, role, rows, error }, как у Apps Script, чтобы офлайн-очередь клиента осталась прежней.
// POST принимается с любым Content-Type: sendBeacon при уходе со страницы шлёт text/plain.

routerAdd("GET", "/api/jury/{id}", (e) => {
  const S = require(`${__hooks}/lib/program_store.js`);
  const J = require(`${__hooks}/lib/jury_store.js`);
  const ev = S.findEvent(e.app, e.request.pathValue("id"));
  if (!ev) return e.json(404, { ok: false, error: "not_found" });
  const q = e.request.url.query();
  const p = { action: q.get("action"), code: q.get("code"), juror: q.get("juror") };
  if (!p.action) return e.json(200, { ok: true, service: "conf-kit jury" });
  return e.json(200, J.handle(e, ev, p, false));
});

routerAdd("POST", "/api/jury/{id}", (e) => {
  const S = require(`${__hooks}/lib/program_store.js`);
  const J = require(`${__hooks}/lib/jury_store.js`);
  const ev = S.findEvent(e.app, e.request.pathValue("id"));
  if (!ev) return e.json(404, { ok: false, error: "not_found" });
  let p;
  try { p = JSON.parse(toString(e.request.body, 64 * 1024)); } catch (err) { return e.json(200, { ok: false, error: "bad_json" }); }
  if (!p || typeof p !== "object") return e.json(200, { ok: false, error: "bad_json" });
  return e.json(200, J.handle(e, ev, p, true));
});

// Коды комиссии для владельца: показать (созданием при первом обращении) и выпустить новый код
routerAdd("GET", "/api/v1/events/{id}/jury", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const S = require(`${__hooks}/lib/program_store.js`);
  const J = require(`${__hooks}/lib/jury_store.js`);
  let ev = S.findEvent(e.app, e.request.pathValue("id"));
  const acc = ev ? A.access(A.actor(e), ev) : null;
  if (!ev || !acc.read) throw new NotFoundError("Мероприятие не найдено");
  if (!acc.manage) throw new ForbiddenError("Коды комиссии видит только владелец");
  const info = J.juryInfo(e.app, ev);
  if (info.enabled) ev = J.ensureCodes(e.app, ev);
  const jurors = {};
  let n = 0;
  e.app.findRecordsByFilter("scores", "event = {:e}", "", 0, 0, { e: ev.id }).forEach((r) => { jurors[r.getString("juror_key")] = 1; n++; });
  return e.json(200, {
    enabled: info.enabled, criteria: info.criteria, scale_max: info.scaleMax, talks: info.talks.length,
    juror_code: info.enabled ? ev.getString("jury_code") : "", admin_code: info.enabled ? ev.getString("jury_admin_code") : "",
    url: A.baseUrl(e) + "/#/jury/" + ev.getString("slug"), scores: n, jurors: Object.keys(jurors).length,
  });
});

routerAdd("POST", "/api/v1/events/{id}/jury", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const S = require(`${__hooks}/lib/program_store.js`);
  const J = require(`${__hooks}/lib/jury_store.js`);
  const ev = S.findEvent(e.app, e.request.pathValue("id"));
  const acc = ev ? A.access(A.actor(e), ev) : null;
  if (!ev || !acc.read) throw new NotFoundError("Мероприятие не найдено");
  if (!acc.manage) throw new ForbiddenError("Коды комиссии меняет только владелец");
  const body = A.readJson(e);
  const which = String(body.reset || "");
  if (["juror", "admin"].indexOf(which) < 0) throw new BadRequestError("reset: juror или admin");
  const rec = e.app.findRecordById("events", ev.id);
  rec.set(which === "juror" ? "jury_code" : "jury_admin_code", J.newCode());
  e.app.unsafeWithoutHooks().save(rec);
  return e.json(200, { ok: true, juror_code: rec.getString("jury_code"), admin_code: rec.getString("jury_admin_code") });
});
