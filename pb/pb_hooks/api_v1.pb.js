/// <reference path="../pb_data/types.d.ts" />
// API программы мероприятия (этап 1). Документ — conf.program/v1, схема: /schema/program.v1.json.
// Тело запросов с программой: документ целиком или обёртка { program, note, slug, status, owners }.
// Логика хранения — lib/program_store.js; модуль загружается внутри каждого обработчика,
// потому что обработчики PocketBase выполняются в изолированных контекстах.

routerAdd("GET", "/api/v1", (e) => {
  const S = require(`${__hooks}/lib/program_store.js`);
  return e.json(200, { service: "conf-kit", api: "v1", schema: S.M.SCHEMA_ID });
});

// Проверка без сохранения: нормализованная программа с рассчитанным временем и отчёт
routerAdd("POST", "/api/v1/programs/validate", (e) => {
  const S = require(`${__hooks}/lib/program_store.js`);
  const res = S.M.normalize(S.readBody(e).program);
  return e.json(200, { ok: res.report.ok, doc: res.doc, report: res.report });
});

// Программа мероприятия по id или slug. Черновик видят только владельцы и администратор.
routerAdd("GET", "/api/v1/events/{id}/program", (e) => {
  const S = require(`${__hooks}/lib/program_store.js`);
  const ev = S.findEvent(e.app, e.request.pathValue("id"));
  if (!ev || !S.canRead(e, ev)) throw new NotFoundError("Мероприятие не найдено");
  return e.json(200, { event: S.eventInfo(ev), program: S.loadProgram(e.app, ev) });
});

// Заменить программу целиком; каждая замена — новая версия. Программа с ошибками не сохраняется.
routerAdd("PUT", "/api/v1/events/{id}/program", (e) => {
  const S = require(`${__hooks}/lib/program_store.js`);
  const ev = S.findEvent(e.app, e.request.pathValue("id"));
  if (!ev || !S.canRead(e, ev)) throw new NotFoundError("Мероприятие не найдено");
  if (!S.canWrite(e, ev)) throw new ForbiddenError("Нет прав на изменение программы");
  const body = S.readBody(e);
  const res = S.saveProgram(e.app, {
    event: ev, program: body.program, source: "api",
    author: S.isUser(e.auth) ? e.auth.id : "", note: body.meta.note,
  });
  if (!res.ok) return e.json(res.status || 422, { ok: false, message: res.message || "Программа содержит ошибки и не сохранена", report: res.report });
  return e.json(200, { ok: true, event: S.eventInfo(res.event), report: res.report });
});

// Импорт мероприятия из документа (только суперпользователь; для ботов — этап 2, по API-ключу)
routerAdd("POST", "/api/v1/admin/events", (e) => {
  const S = require(`${__hooks}/lib/program_store.js`);
  const body = S.readBody(e);
  const res = S.saveProgram(e.app, {
    program: body.program, source: "import", note: body.meta.note,
    slug: body.meta.slug, status: body.meta.status, owners: body.meta.owners,
  });
  if (!res.ok) return e.json(res.status || 422, { ok: false, message: res.message || "Программа содержит ошибки и не сохранена", report: res.report });
  return e.json(201, { ok: true, event: S.eventInfo(res.event), report: res.report });
}, $apis.requireSuperuserAuth());
