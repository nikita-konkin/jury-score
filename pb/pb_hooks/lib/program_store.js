/// <reference path="../../pb_data/types.d.ts" />
// Хранение программы: документ conf.program/v1 ↔ строки коллекций PocketBase.
// Подключается внутри обработчиков *.pb.js: require(`${__hooks}/lib/program_store.js`).
// Обработчики PocketBase выполняются в изолированных контекстах, поэтому модуль
// загружается в каждом обработчике заново, а не один раз на уровне файла.

const M = require(`${__hooks}/../../shared/model.js`);

const CHILDREN = ["rooms", "sections", "days", "sessions", "items"];
const JSON_FIELDS = { extra: true, authors: true };
const MAX_BODY = 2 * 1024 * 1024;

function parseJson(v) {
  const s = toString(v);
  return s && s !== "null" ? JSON.parse(s) : null;
}

// Запись PocketBase → обычный объект с нужными полями (JSON-поля разобраны)
function plain(rec, fields) {
  const o = { id: rec.id };
  fields.forEach((k) => { o[k] = JSON_FIELDS[k] ? parseJson(rec.get(k)) : rec.get(k); });
  return o;
}

/** Тело запроса: документ программы целиком или обёртка { program, note, slug, … }. */
function readBody(e) {
  const raw = toString(e.request.body, MAX_BODY + 1);
  if (raw.length > MAX_BODY) throw new ApiError(413, "Документ больше 2 МБ");
  let body;
  try { body = JSON.parse(raw); } catch (err) { return { raw: raw, program: raw, meta: {} }; }
  if (body && typeof body === "object" && !Array.isArray(body) && body.program && typeof body.program === "object") {
    const meta = {};
    Object.keys(body).forEach((k) => { if (k !== "program") meta[k] = body[k]; });
    return { raw: raw, program: body.program, meta: meta };
  }
  return { raw: raw, program: body, meta: {} };
}

/** Мероприятие по id или slug; null, если нет. */
function findEvent(app, idOrSlug) {
  try { return app.findRecordById("events", idOrSlug); } catch (err) { /* не id */ }
  try { return app.findFirstRecordByFilter("events", "slug = {:s}", { s: idOrSlug }); } catch (err) { return null; }
}

/** Документ программы из строк мероприятия. */
function loadProgram(app, ev) {
  const rows = { event: parseJson(ev.get("info")) || {} };
  const fields = { rooms: M.ROW_FIELDS.room, sections: M.ROW_FIELDS.section, days: M.ROW_FIELDS.day,
    sessions: M.ROW_FIELDS.session.concat(["day"]), items: M.ROW_FIELDS.item.concat(["session"]) };
  CHILDREN.forEach((name) => {
    rows[name] = app.findRecordsByFilter(name, "event = {:e}", "sort", 0, 0, { e: ev.id })
      .map((rec) => plain(rec, fields[name].concat(["sort"])));
  });
  return M.toDocument(rows);
}

function uniqueSlug(app, base) {
  let slug = base, n = 1;
  while (findEvent(app, slug)) slug = base + "-" + (++n);
  return slug;
}

/**
 * Сохраняет программу целиком и создаёт новую версию. Документ проверяется
 * заново: с ошибками (report.ok === false) не сохраняется.
 * opts: { event?: Record, program, slug?, status?, owners?: [id], source, author?: id, apiKey?: id, note?,
 *         fields?: { поле: значение } — дополнительные поля нового мероприятия }
 * Возвращает { ok, report, event?, version? }.
 */
function saveProgram(app, opts) {
  const res = M.normalize(opts.program);
  if (!res.report.ok) return { ok: false, report: res.report };
  const doc = res.doc;
  const rows = M.fromDocument(doc);
  let slug = "";
  if (!opts.event) {
    if (opts.slug) {
      slug = M.slugify(opts.slug, 63);
      if (slug.length < 2) return { ok: false, status: 400, message: `Неверный адрес «${opts.slug}»: нужны латинские буквы или цифры` };
      if (findEvent(app, slug)) return { ok: false, status: 409, message: `Адрес «${slug}» уже занят` };
    } else {
      const year = (doc.event.date_from || "").slice(0, 4);
      const title = M.slugify(doc.event.title, 40);
      const base = title.indexOf(year) >= 0 ? title : [title, year].filter(Boolean).join("-");
      slug = uniqueSlug(app, base.length >= 2 ? base : "event");
    }
  }
  let event = null, version = 0;

  app.runInTransaction((tx) => {
    let ev = opts.event ? tx.findRecordById("events", opts.event.id) : null;
    if (!ev) {
      ev = new Record(tx.findCollectionByNameOrId("events"));
      ev.set("slug", slug);
      ev.set("status", opts.status === "published" ? "published" : "draft");
      ev.set("owners", opts.owners || []);
      ev.set("version", 0);
      Object.keys(opts.fields || {}).forEach((k) => ev.set(k, opts.fields[k]));
    } else {
      // старые строки удаляются целиком; коды элементов (s1-1…) стабильны, на них ссылаются оценки жюри
      ["items", "sessions", "days", "rooms", "sections"].forEach((name) => {
        tx.findRecordsByFilter(name, "event = {:e}", "", 0, 0, { e: ev.id }).forEach((rec) => tx.delete(rec));
      });
    }
    version = ev.getInt("version") + 1;
    ev.set("title", doc.event.title);
    ev.set("date_from", doc.event.date_from || "");
    ev.set("date_to", doc.event.date_to || "");
    ev.set("info", doc.event);
    ev.set("version", version);
    tx.save(ev);

    const ids = {};
    const insert = (name, row, links) => {
      const rec = new Record(tx.findCollectionByNameOrId(name));
      rec.set("event", ev.id);
      Object.keys(row).forEach((k) => { if (k !== "key") rec.set(k, row[k]); });
      Object.keys(links || {}).forEach((k) => rec.set(k, ids[links[k]]));
      tx.save(rec);
      if (row.key) ids[row.key] = rec.id;
    };
    rows.rooms.forEach((r) => insert("rooms", r));
    rows.sections.forEach((r) => insert("sections", r));
    rows.days.forEach((r) => insert("days", r));
    rows.sessions.forEach((r) => insert("sessions", r, { day: r.day }));
    rows.items.forEach((r) => insert("items", r, { session: r.session }));

    const v = new Record(tx.findCollectionByNameOrId("program_versions"));
    v.set("event", ev.id);
    v.set("no", version);
    v.set("doc", doc);
    v.set("stats", res.report.stats);
    v.set("source", opts.source);
    if (opts.author) v.set("author", opts.author);
    if (opts.apiKey) v.set("api_key", opts.apiKey);
    v.set("note", opts.note || "");
    tx.save(v);
    event = ev;
  });
  return { ok: true, report: res.report, event: event, version: version };
}

/** Публикация и снятие с публикации — только владельцы и администратор. */
function setStatus(e, status) {
  const A = require(`${__hooks}/lib/access.js`);
  const ev = findEvent(e.app, e.request.pathValue("id"));
  const acc = ev ? A.access(A.actor(e), ev) : null;
  if (!ev || !acc.read) throw new NotFoundError("Мероприятие не найдено");
  if (!acc.manage) throw new ForbiddenError("Публиковать мероприятие может только владелец");
  ev.set("status", status);
  e.app.save(ev);
  return e.json(200, { ok: true, event: eventInfo(ev) });
}

function eventInfo(ev) {
  return { id: ev.id, slug: ev.getString("slug"), status: ev.getString("status"), title: ev.getString("title"),
    version: ev.getInt("version"), claimed: ev.getStringSlice("owners").length > 0 };
}

module.exports = { M, MAX_BODY, readBody, findEvent, loadProgram, saveProgram, setStatus, eventInfo };
