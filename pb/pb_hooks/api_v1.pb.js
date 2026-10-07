/// <reference path="../pb_data/types.d.ts" />
// API v1. Документ — conf.program/v1 (/schema/program.v1.json), описание для ботов — /llms.txt и /openapi.json.
// Тело запросов с программой: документ целиком или обёртка { program, note, slug, … }.
// Модули загружаются внутри каждого обработчика: обработчики PocketBase выполняются
// в изолированных контекстах. Права — lib/access.js, хранение — lib/program_store.js.

routerAdd("GET", "/api/v1", (e) => {
  const S = require(`${__hooks}/lib/program_store.js`);
  return e.json(200, {
    service: "conf-kit", api: "v1", schema: S.M.SCHEMA_ID,
    docs: { llms: "/llms.txt", openapi: "/openapi.json", schema: "/schema/program.v1.json" },
  });
});

// Проверка без сохранения: нормализованная программа с рассчитанным временем и отчёт
routerAdd("POST", "/api/v1/programs/validate", (e) => {
  const S = require(`${__hooks}/lib/program_store.js`);
  const res = S.M.normalize(S.readBody(e).program);
  return e.json(200, { ok: res.report.ok, doc: res.doc, report: res.report });
});

// Черновик мероприятия от бота (ключ с правом create_events). Повтор с тем же Idempotency-Key
// не создаёт дубль: возвращается то же мероприятие с новыми токенами, прежние перестают действовать.
// Вошедший пользователь без ключа («Создать из ответа чат-бота») сразу становится владельцем черновика.
routerAdd("POST", "/api/v1/events", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const S = require(`${__hooks}/lib/program_store.js`);
  const FB = require(`${__hooks}/lib/feedback_store.js`);
  const a = A.actor(e);
  if (!a.key && a.user) {
    const body = S.readBody(e);
    const since = new DateTime().addDate(0, 0, -1).string();
    const mine = e.app.findRecordsByFilter("events", "owners.id ?= {:u} && created >= {:t}", "", 21, 0, { u: a.user.id, t: since });
    if (mine.length >= 20 && !a.admin) throw new TooManyRequestsError("Не больше 20 новых мероприятий в сутки");
    const res = S.saveProgram(e.app, {
      program: body.program, slug: body.meta.slug, status: "draft", owners: [a.user.id],
      source: "ui", author: a.user.id, note: body.meta.note || "из ответа чат-бота",
    });
    if (!res.ok) return e.json(res.status || 422, { ok: false, message: res.message || "Программа содержит ошибки и не сохранена", report: res.report });
    FB.addExtraFeedback(e.app, res.report, { source: "auto", user: a.user.id, event: res.event.id });
    return e.json(201, { ok: true, event: S.eventInfo(res.event), report: res.report });
  }
  const key = A.requireKey(a, "create_events");
  const body = S.readBody(e);
  const maxKb = A.limit(key, "max_doc_kb");
  if (body.raw.length > maxKb * 1024) throw new ApiError(413, `Документ больше ${maxKb} КБ — лимит ключа`);

  const tokens = () => {
    const t = { draft: A.newToken("dt"), invite: A.newToken("inv"), preview: A.newToken("pv", 24) };
    t.fields = {
      draft_token_hash: A.sha(t.draft), invite_hash: A.sha(t.invite), preview_hash: A.sha(t.preview),
      invite_expires: new DateTime().addDate(0, 0, 14),
    };
    return t;
  };
  const reply = (status, ev, t, report, extra) => {
    const base = A.baseUrl(e);
    return e.json(status, Object.assign({
      ok: true,
      event: S.eventInfo(ev),
      draft_token: t.draft,
      invite_url: `${base}/#/claim/${t.invite}`,
      invite_expires: ev.getDateTime("invite_expires").string(),
      preview_url: `${base}/#/preview/${t.preview}`,
      report: report,
      next: "Отдайте пользователю invite_url: по ней он станет владельцем черновика. Пока приглашение не принято, программу можно читать и менять с заголовком X-Draft-Token. Опубликовать мероприятие может только человек.",
    }, extra || {}));
  };

  const idem = A.header(e, "Idempotency-Key").slice(0, 200);
  if (idem) {
    let prev = null;
    try {
      prev = e.app.findFirstRecordByFilter("events", "created_by_key = {:k} && idempotency_key = {:i}", { k: key.id, i: idem });
    } catch (err) { /* нет */ }
    if (prev) {
      if (!A.unclaimed(prev)) throw new ApiError(409, "Мероприятие с этим Idempotency-Key уже принято владельцем");
      const t = tokens();
      Object.keys(t.fields).forEach((k) => prev.set(k, t.fields[k]));
      e.app.save(prev);
      return reply(200, prev, t, null, { replay: true });
    }
  }

  const perDay = A.limit(key, "max_events_per_day");
  const since = new DateTime().addDate(0, 0, -1).string();
  const today = e.app.findRecordsByFilter("events", "created_by_key = {:k} && created >= {:t}", "", perDay + 1, 0, { k: key.id, t: since });
  if (today.length >= perDay) throw new TooManyRequestsError(`Лимит ключа: ${perDay} мероприятий в сутки`);

  const t = tokens();
  const fields = Object.assign({ created_by_key: key.id, idempotency_key: idem }, t.fields);
  const res = S.saveProgram(e.app, {
    program: body.program, slug: body.meta.slug, status: "draft", owners: [], fields: fields,
    source: A.clientSource(e), apiKey: key.id, note: body.meta.note,
  });
  if (!res.ok) {
    return e.json(res.status || 422, { ok: false, message: res.message || "Программа содержит ошибки и не сохранена — исправьте их по отчёту и отправьте снова", report: res.report });
  }
  const auto = FB.addExtraFeedback(e.app, res.report, {
    source: "auto", apiKey: key.id, event: res.event.id,
    client: A.header(e, "X-Conf-Client"), model: A.header(e, "X-Conf-Model"),
  });
  return reply(201, res.event, t, res.report, auto.length ? { auto_feedback: auto.length } : {});
});

// Программа мероприятия по id или slug
routerAdd("GET", "/api/v1/events/{id}/program", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const S = require(`${__hooks}/lib/program_store.js`);
  const ev = S.findEvent(e.app, e.request.pathValue("id"));
  const acc = ev ? A.access(A.actor(e), ev) : null;
  if (!ev || !acc.read) throw new NotFoundError("Мероприятие не найдено");
  return e.json(200, { event: S.eventInfo(ev), program: S.loadProgram(e.app, ev) });
});

// Заменить программу целиком; каждая замена — новая версия. Программа с ошибками не сохраняется.
routerAdd("PUT", "/api/v1/events/{id}/program", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const S = require(`${__hooks}/lib/program_store.js`);
  const FB = require(`${__hooks}/lib/feedback_store.js`);
  const a = A.actor(e);
  const ev = S.findEvent(e.app, e.request.pathValue("id"));
  const acc = ev ? A.access(a, ev) : null;
  if (!ev || !acc.read) throw new NotFoundError("Мероприятие не найдено");
  if (!acc.write) throw new ForbiddenError("Нет прав на изменение программы");
  const body = S.readBody(e);
  if (a.key && body.raw.length > A.limit(a.key, "max_doc_kb") * 1024) throw new ApiError(413, "Документ больше лимита ключа");
  const res = S.saveProgram(e.app, {
    event: ev, program: body.program, source: A.clientSource(e), note: body.meta.note,
    author: a.user ? a.user.id : "", apiKey: a.key ? a.key.id : acc.via === "draft" ? ev.getString("created_by_key") : "",
  });
  if (!res.ok) return e.json(res.status || 422, { ok: false, message: res.message || "Программа содержит ошибки и не сохранена", report: res.report });
  if (acc.via === "key" || acc.via === "draft") {
    FB.addExtraFeedback(e.app, res.report, {
      source: "auto", apiKey: a.key ? a.key.id : ev.getString("created_by_key"), event: ev.id,
      client: A.header(e, "X-Conf-Client"), model: A.header(e, "X-Conf-Model"),
    });
  }
  return e.json(200, { ok: true, event: S.eventInfo(res.event), report: res.report });
});

// Новая ссылка-приглашение (прежняя перестаёт действовать). До принятия — черновой токен или ключ,
// создавший черновик; после — владельцы приглашают соавторов.
routerAdd("POST", "/api/v1/events/{id}/invite", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const S = require(`${__hooks}/lib/program_store.js`);
  const a = A.actor(e);
  const ev = S.findEvent(e.app, e.request.pathValue("id"));
  const acc = ev ? A.access(a, ev) : null;
  if (!ev || !acc.read) throw new NotFoundError("Мероприятие не найдено");
  const allowed = acc.manage || (A.unclaimed(ev) && (acc.via === "draft" || acc.via === "key"));
  if (!allowed) throw new ForbiddenError("Приглашать после принятия черновика могут только владельцы");
  const invite = A.newToken("inv");
  ev.set("invite_hash", A.sha(invite));
  ev.set("invite_expires", new DateTime().addDate(0, 0, 14));
  e.app.save(ev);
  return e.json(200, {
    ok: true, invite_url: `${A.baseUrl(e)}/#/claim/${invite}`, invite_expires: ev.getDateTime("invite_expires").string(),
    co_owner: !A.unclaimed(ev),
  });
});

// Предпросмотр по приглашению: что получит человек
routerAdd("GET", "/api/v1/claim/{token}", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const S = require(`${__hooks}/lib/program_store.js`);
  const ev = findByToken(e, "invite_hash", e.request.pathValue("token"));
  const expires = ev.getDateTime("invite_expires");
  if (!expires.isZero() && expires.before(new DateTime())) throw new ApiError(410, "Срок приглашения истёк — попросите новое");
  let preparedBy = "";
  if (ev.getString("created_by_key")) {
    try { preparedBy = e.app.findRecordById("api_keys", ev.getString("created_by_key")).getString("name"); } catch (err) { /* удалён */ }
  }
  return e.json(200, {
    event: S.eventInfo(ev), program: S.loadProgram(e.app, ev), invite_expires: expires.string(),
    prepared_by: preparedBy, co_owner: !A.unclaimed(ev),
  });

  function findByToken(e, field, token) {
    let ev = null;
    if (token) {
      try { ev = e.app.findFirstRecordByFilter("events", `${field} = {:h}`, { h: A.sha(token) }); } catch (err) { /* нет */ }
    }
    if (!ev) throw new NotFoundError("Приглашение не найдено или уже использовано");
    return ev;
  }
});

// Принять приглашение: новый аккаунт { email, password, name } или вход под своим (Authorization: токен пользователя).
// Ответ — как у auth-with-password (token, record) плюс meta.event.
routerAdd("POST", "/api/v1/claim/{token}", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const S = require(`${__hooks}/lib/program_store.js`);
  const a = A.actor(e);
  const token = e.request.pathValue("token");
  let ev = null;
  try { ev = e.app.findFirstRecordByFilter("events", "invite_hash = {:h}", { h: A.sha(token) }); } catch (err) { /* нет */ }
  if (!token || !ev) throw new NotFoundError("Приглашение не найдено или уже использовано");
  const expires = ev.getDateTime("invite_expires");
  if (!expires.isZero() && expires.before(new DateTime())) throw new ApiError(410, "Срок приглашения истёк — попросите новое");

  let user = a.user;
  if (!user) {
    const body = A.readJson(e);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!email || !password) throw new BadRequestError("Нужны email и password нового аккаунта — или войдите в свой и повторите запрос");
    let exists = null;
    try { exists = e.app.findAuthRecordByEmail("users", email); } catch (err) { /* свободен */ }
    if (exists) throw new ApiError(409, "Аккаунт с таким e-mail уже есть — войдите в него и откройте ссылку снова");
    if (password.length < 8) throw new BadRequestError("Пароль — не короче 8 символов");
    user = new Record(e.app.findCollectionByNameOrId("users"));
    user.setEmail(email);
    user.setPassword(password);
    user.set("name", String(body.name || "").trim().slice(0, 255));
    try { e.app.save(user); } catch (err) { throw new BadRequestError("Не удалось создать аккаунт: " + err); }
  }

  e.app.runInTransaction((tx) => {
    const cur = tx.findRecordById("events", ev.id);
    if (cur.getString("invite_hash") !== A.sha(token)) throw new Error("приглашение уже использовано");
    const owners = [];
    const cs = cur.getStringSlice("owners");
    for (let i = 0; i < cs.length; i++) owners.push(cs[i]);
    if (owners.indexOf(user.id) < 0) owners.push(user.id);
    if (cur.getDateTime("claimed_at").isZero()) {
      cur.set("claimed_at", new DateTime());
      cur.set("draft_token_hash", ""); // после принятия бот правит только по ключу с update_own
    }
    cur.set("owners", owners);
    cur.set("invite_hash", "");
    cur.set("invite_expires", "");
    tx.save(cur);
    ev = cur;
  });
  // ответ как у auth-with-password; $apis.recordAuthResponse здесь не подходит — он заново читает тело запроса
  return e.json(200, {
    token: user.newAuthToken(),
    record: {
      id: user.id, collectionId: user.collection().id, collectionName: "users", email: user.email(),
      name: user.getString("name"), verified: user.verified(), is_admin: user.getBool("is_admin"),
    },
    meta: { event: S.eventInfo(ev) },
  });
});

// Предпросмотр только для чтения (preview_url из ответа на создание черновика)
routerAdd("GET", "/api/v1/preview/{token}", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const S = require(`${__hooks}/lib/program_store.js`);
  const token = e.request.pathValue("token");
  let ev = null;
  if (token) {
    try { ev = e.app.findFirstRecordByFilter("events", "preview_hash = {:h}", { h: A.sha(token) }); } catch (err) { /* нет */ }
  }
  if (!ev) throw new NotFoundError("Ссылка предпросмотра не найдена");
  return e.json(200, { event: S.eventInfo(ev), program: S.loadProgram(e.app, ev) });
});

// Публикация — только люди: владельцы и администратор (боты публиковать не могут)
routerAdd("POST", "/api/v1/events/{id}/publish", (e) => require(`${__hooks}/lib/program_store.js`).setStatus(e, "published"));
routerAdd("POST", "/api/v1/events/{id}/unpublish", (e) => require(`${__hooks}/lib/program_store.js`).setStatus(e, "draft"));

// Обратная связь: ключ с правом send_feedback или вошедший пользователь
routerAdd("POST", "/api/v1/feedback", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const FB = require(`${__hooks}/lib/feedback_store.js`);
  const a = A.actor(e);
  if (a.key) A.requireKey(a, "send_feedback");
  else if (!a.user) throw new UnauthorizedError("Нужен API-ключ с правом send_feedback или вход пользователя");
  const owner = a.key ? ["api_key", a.key.id, FB.PER_HOUR.key] : ["user", a.user.id, FB.PER_HOUR.user];
  if (FB.recentCount(e.app, owner[0], owner[1]) >= owner[2]) throw new TooManyRequestsError(`Не больше ${owner[2]} сообщений в час`);

  const body = A.readJson(e, 32 * 1024);
  const n = FB.F.normalizeFeedback(Object.assign({
    client: A.header(e, "X-Conf-Client"), model: A.header(e, "X-Conf-Model"),
  }, body));
  if (!n.item) return e.json(400, { ok: false, message: "Сообщение не принято", errors: n.errors, kinds: FB.F.KINDS, areas: FB.F.AREAS });
  let eventId = "";
  if (body.event_id) {
    const S = require(`${__hooks}/lib/program_store.js`);
    const ev = S.findEvent(e.app, String(body.event_id));
    if (ev && A.access(a, ev).read) eventId = ev.id;
  }
  const src = a.key ? A.clientSource(e) : (FB.F.SOURCES.indexOf(body.source) >= 0 ? body.source : "ui");
  const res = FB.addFeedback(e.app, n.item, {
    source: src === "ui" && a.key ? "api" : src, apiKey: a.key ? a.key.id : "", user: a.user ? a.user.id : "", event: eventId,
  });
  return e.json(201, FB.answer(res));
});

routerAdd("GET", "/api/v1/changelog", (e) => {
  const FB = require(`${__hooks}/lib/feedback_store.js`);
  return e.json(200, { items: FB.changelog(e.app) });
});

/* ---------------- администрирование (суперпользователь или users.is_admin) ---------------- */

// Импорт мероприятия из документа
routerAdd("POST", "/api/v1/admin/events", (e) => {
  const S = require(`${__hooks}/lib/program_store.js`);
  const a = require(`${__hooks}/lib/access.js`).requireAdmin(e);
  const body = S.readBody(e);
  const res = S.saveProgram(e.app, {
    program: body.program, source: "import", note: body.meta.note, author: a.user ? a.user.id : "",
    slug: body.meta.slug, status: body.meta.status, owners: body.meta.owners,
  });
  if (!res.ok) return e.json(res.status || 422, { ok: false, message: res.message || "Программа содержит ошибки и не сохранена", report: res.report });
  return e.json(201, { ok: true, event: S.eventInfo(res.event), report: res.report });
});

// Новый API-ключ; сам ключ показывается один раз
routerAdd("POST", "/api/v1/admin/keys", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const a = require(`${__hooks}/lib/access.js`).requireAdmin(e);
  const body = A.readJson(e);
  if (!String(body.name || "").trim()) throw new BadRequestError("Нужно название ключа (name), например «Claude — кафедра»");
  const res = A.createKey(e.app, {
    name: String(body.name).trim(), scopes: body.scopes, note: body.note,
    max_events_per_day: +body.max_events_per_day || 0, max_doc_kb: +body.max_doc_kb || 0,
    expires_days: +body.expires_days || 0, issued_by: a.user ? a.user.id : "",
  });
  return e.json(201, {
    ok: true, key: res.key, id: res.record.id, prefix: res.record.getString("prefix"),
    scopes: res.record.getStringSlice("scopes"), message: "Сохраните ключ: повторно он не показывается",
  });
});

// Удалить непринятые черновики старше days дней (по умолчанию 30; то же делает cron)
routerAdd("POST", "/api/v1/admin/cleanup", (e) => {
  const a = require(`${__hooks}/lib/access.js`).requireAdmin(e);
  if (!a.su) throw new ForbiddenError("Только суперпользователь");
  const days = e.request.url.query().get("days");
  const n = require(`${__hooks}/lib/maintenance.js`).cleanupDrafts(e.app, days === "" ? 30 : Math.max(0, +days || 0));
  return e.json(200, { ok: true, deleted: n });
});
