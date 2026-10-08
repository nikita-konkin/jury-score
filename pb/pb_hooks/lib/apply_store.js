// Заявки на доклады: настройки приёма (event.applications), согласие на обработку персональных данных,
// защита от спама (ловушка, время заполнения, частота с одного адреса, дубли), модерация владельцем.
// Принятая заявка становится докладом в выбранном заседании — новой версией программы.
const S = require(`${__hooks}/lib/program_store.js`);
const A = require(`${__hooks}/lib/access.js`);
const I = require(`${__hooks}/../../shared/ics.js`);
const M = S.M;

const FORMATS = { oral: "очно", online: "онлайн", poster: "стендовый" };
const MIN_FILL_MS = 3000; // быстрее человек форму не заполнит
const PER_IP_HOUR = 10;
const PER_EVENT = 2000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN = /^ap_[A-Za-z0-9]{24}$/;

const clean = (s, max) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max || 200);
const ru = (iso) => (iso ? String(iso).split("-").reverse().join(".") : "");
const titleKey = (s) => clean(s, 600).toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, "");

/** Сегодняшняя дата в часовом поясе мероприятия (без летнего времени, как в календаре). */
function today(tz) {
  const off = I.TZ_OFFSETS[tz];
  return new Date(Date.now() + (off == null ? 180 : off) * 60000).toISOString().slice(0, 10);
}

/** Текст согласия по 152-ФЗ: оператор, цель, состав данных, действия, срок, отзыв. Сохраняется с заявкой. */
function consentText(ev, operator, contact) {
  const dates = ev.date_from === ev.date_to || !ev.date_to ? ru(ev.date_from) : ru(ev.date_from) + "–" + ru(ev.date_to);
  return `Отправляя заявку, я даю согласие оператору — ${operator} — на обработку моих персональных данных: ` +
    "фамилии, имени, отчества, места работы, города, адреса электронной почты, номера телефона и сведений о докладе. " +
    `Цель — рассмотрение заявки и участие в мероприятии «${ev.title}»${dates ? " (" + dates + ")" : ""}. ` +
    "Действия: сбор, запись, систематизация, хранение, уточнение, использование, удаление и уничтожение, " +
    "а также публикация фамилии, инициалов, места работы, города и темы доклада в программе мероприятия. " +
    "Электронная почта и телефон не публикуются и не передаются третьим лицам. " +
    "Согласие действует до окончания мероприятия и одного года после него. Его можно отозвать на странице заявки" +
    (contact ? ` или письмом по адресу ${contact}` : " или письмом организатору") + ".";
}

/** { open, reason } и параметры формы по документу программы. */
function settings(doc) {
  const ev = doc.event, ap = ev.applications;
  if (!ap || !ap.enabled) return { open: false, reason: "Приём заявок закрыт" };
  const operator = ap.operator || ev.organizer || "";
  if (!operator) return { open: false, reason: "Приём заявок ещё не настроен организатором" };
  if (ap.deadline && today(ev.timezone) > ap.deadline) return { open: false, reason: `Приём заявок завершён ${ru(ap.deadline)}` };
  return { open: true, deadline: ap.deadline || "", note: ap.note || "", operator: operator, contact: ap.contact || "",
    consent: consentText(ev, operator, ap.contact) };
}

/** Публичные сведения для формы заявки. */
function publicInfo(app, rec) {
  const doc = S.loadProgram(app, rec);
  const ev = doc.event;
  return Object.assign({
    ok: true, slug: rec.getString("slug"), title: ev.title, date_from: ev.date_from || "", date_to: ev.date_to || "",
    city: ev.city || "", venue: ev.venue || "",
    sections: doc.sections.map((s) => ({ no: s.no, title: s.title })),
    formats: Object.keys(FORMATS).map((v) => ({ value: v, label: FORMATS[v] })),
  }, settings(doc));
}

/** Поля формы → { form } или { field, message }. Контакты в программу не попадают. */
function readForm(p, doc) {
  const authors = (Array.isArray(p.authors) ? p.authors : String(p.authors || "").split(/[\n;]+/))
    .map((a) => clean(a, 200)).filter(Boolean);
  const f = {
    speaker: clean(p.speaker, 200), title: clean(p.title, 600), org: clean(p.org, 300), city: clean(p.city, 100),
    email: clean(p.email, 200).toLowerCase(), phone: clean(p.phone, 40), note: String(p.note || "").trim().slice(0, 2000),
    format: clean(p.format, 20), section: p.section == null || p.section === "" ? 0 : +p.section, authors: authors.slice(0, 30),
  };
  if (!f.speaker) return { field: "speaker", message: "Укажите докладчика: фамилию и инициалы" };
  if (!f.title) return { field: "title", message: "Укажите название доклада" };
  if (doc.sections.length && !f.section) return { field: "section", message: "Выберите секцию" };
  if (f.section && !doc.sections.some((s) => s.no === f.section)) return { field: "section", message: "Такой секции нет" };
  if (f.format && !FORMATS[f.format]) return { field: "format", message: "Неизвестная форма участия" };
  if (!EMAIL.test(f.email)) return { field: "email", message: "Укажите e-mail для связи" };
  if (f.phone && !/^[+\d()\s-]{5,40}$/.test(f.phone)) return { field: "phone", message: "Телефон: цифры, пробелы, «+», «-» и скобки" };
  if (authors.length > 30) return { field: "authors", message: "Авторов больше 30" };
  return { form: f };
}

const fail = (status, message, field) => ({ status: status, body: { ok: false, message: message, field: field || "" } });

/** Новая заявка. Возвращает { status, body }. */
function submit(e, rec, p) {
  // ловушка: скрытое поле заполняют только боты — делаем вид, что заявка принята
  if (clean(p.website)) return { status: 201, body: { ok: true, no: 0, token: "", url: "" } };
  const doc = S.loadProgram(e.app, rec);
  const st = settings(doc);
  if (!st.open) return fail(403, st.reason);
  if (!(+p.elapsed >= MIN_FILL_MS)) return fail(400, "Форма заполнена слишком быстро. Проверьте данные и отправьте ещё раз");
  if (p.consent !== true) return fail(400, "Без согласия на обработку персональных данных заявку принять нельзя", "consent");
  const r = readForm(p, doc);
  if (!r.form) return fail(400, r.message, r.field);
  const f = r.form;

  const ipHash = A.sha("ip:" + e.realIP());
  const hourAgo = new DateTime().add(-3600 * 1000 * 1000 * 1000).string();
  const recent = e.app.findRecordsByFilter("applications", "event = {:e} && ip_hash = {:h} && created >= {:t}", "", PER_IP_HOUR, 0,
    { e: rec.id, h: ipHash, t: hourAgo });
  if (recent.length >= PER_IP_HOUR) return fail(429, "Слишком много заявок с этого адреса. Попробуйте через час");
  const same = e.app.findRecordsByFilter("applications", "event = {:e} && email = {:m} && status != 'withdrawn'", "", 200, 0, { e: rec.id, m: f.email });
  const dup = same.find((a) => titleKey(a.getString("title")) === titleKey(f.title));
  if (dup) return fail(409, `Заявка с таким докладом уже подана: №${dup.getInt("no")}`);

  const token = A.newToken("ap", 24);
  let no = 0;
  e.app.runInTransaction((tx) => {
    const last = tx.findRecordsByFilter("applications", "event = {:e}", "-no", 1, 0, { e: rec.id });
    no = last.length ? last[0].getInt("no") + 1 : 1;
    if (no > PER_EVENT) return;
    const a = new Record(tx.findCollectionByNameOrId("applications"));
    a.set("event", rec.id);
    a.set("no", no);
    a.set("status", "new");
    Object.keys(f).forEach((k) => a.set(k, f[k]));
    a.set("consent_text", st.consent);
    a.set("consent_at", new DateTime());
    a.set("token_hash", A.sha(token));
    a.set("ip_hash", ipHash);
    tx.save(a);
  });
  if (no > PER_EVENT) return fail(429, "Приём заявок временно приостановлен: их слишком много");
  return { status: 201, body: { ok: true, no: no, token: token, url: A.baseUrl(e) + "/#/apply/" + rec.getString("slug") + "/" + token } };
}

function findByToken(app, rec, token) {
  if (!TOKEN.test(String(token || ""))) return null;
  try {
    return app.findFirstRecordByFilter("applications", "event = {:e} && token_hash = {:h}", { e: rec.id, h: A.sha(token) });
  } catch (err) { return null; }
}

const STR = ["status", "speaker", "title", "format", "org", "city", "email", "phone", "note", "reason", "item_code"];

/** Заявка для участника (по ссылке) и для владельца (с контактами и служебными полями). */
function view(a, owner) {
  const out = { no: a.getInt("no"), section: a.getInt("section"), authors: [], created: a.getString("created") };
  STR.forEach((k) => { out[k] = a.getString(k); });
  try { out.authors = S.parseJson(a.get("authors")) || []; } catch (err) { /* пусто */ }
  if (!Array.isArray(out.authors)) out.authors = [];
  if (owner) {
    out.id = a.id;
    out.consent_at = a.getString("consent_at");
    out.decided_at = a.getString("decided_at");
  }
  return out;
}

/** Отзыв заявки участником: отзыв согласия — контакты стираются сразу. */
function withdraw(app, a) {
  if (a.getString("status") === "withdrawn") return;
  a.set("status", "withdrawn");
  ["email", "phone", "note", "ip_hash"].forEach((k) => a.set(k, ""));
  app.save(a);
}

function list(app, rec) {
  return app.findRecordsByFilter("applications", "event = {:e}", "-no", 0, 0, { e: rec.id }).map((a) => view(a, true));
}

/** Заседание по умолчанию: последнее, где есть доклады той же секции. */
function autoTarget(doc, section) {
  let found = null;
  doc.days.forEach((d, di) => d.sessions.forEach((s, si) => {
    if (section && s.items.some((it) => it.type === "talk" && it.section === section)) found = { day: di, session: si };
  }));
  return found;
}

/** Решение владельца: accept (в заседание { day, session }), reject (с причиной), reset (снова на рассмотрении). */
function decide(e, rec, a, p, userId) {
  const action = String(p.action || "");
  const status = a.getString("status");
  if (["accept", "reject", "reset"].indexOf(action) < 0) return fail(400, "action: accept, reject или reset");
  if (status === "withdrawn") return fail(409, "Участник отозвал заявку");
  const done = (extra) => {
    a.set("decided_by", userId || "");
    a.set("decided_at", new DateTime());
    e.app.save(a);
    return { status: 200, body: Object.assign({ ok: true, application: view(a, true) }, extra || {}) };
  };
  if (action === "reject") {
    a.set("status", "rejected");
    a.set("reason", clean(p.reason, 1000));
    return done();
  }
  if (action === "reset") {
    a.set("status", "new");
    a.set("reason", "");
    a.set("item_code", "");
    return done();
  }
  if (status === "accepted") return fail(409, "Заявка уже принята");

  const doc = S.loadProgram(e.app, rec);
  let t = p.day != null && p.session != null ? { day: +p.day, session: +p.session } : autoTarget(doc, a.getInt("section"));
  if (!t) return fail(409, doc.days.some((d) => d.sessions.length) ? "Выберите заседание для доклада" : "В программе нет заседаний: добавьте день и заседание в конструкторе");
  const day = doc.days[t.day], session = day && day.sessions[t.session];
  if (!session) return fail(400, "Нет такого заседания");
  const v = view(a, false);
  const item = { type: "talk", title: v.title, speaker: v.speaker };
  if (v.authors.length) item.authors = v.authors;
  ["format", "org", "city"].forEach((k) => { if (v[k]) item[k] = v[k]; });
  if (v.section) item.section = v.section;
  session.items.push(item);
  const n = M.normalize(doc);
  if (!n.report.ok) return { status: 422, body: { ok: false, message: "Программа с этим докладом не проходит проверку", report: n.report } };
  const code = n.doc.days[t.day].sessions[t.session].items[session.items.length - 1].code;
  const res = S.saveProgram(e.app, {
    event: rec, program: n.doc, source: "ui", author: userId || "", baseVersion: rec.getInt("version"),
    note: `Заявка №${v.no}: ${v.speaker}`,
  });
  if (!res.ok) return fail(res.status || 422, res.message || "Программа не сохранена");
  a.set("status", "accepted");
  a.set("reason", "");
  a.set("item_code", code);
  return done({ version: res.version, item: { code: code, day: t.day, session: t.session } });
}

/** Через год после мероприятия контакты из заявок стираются (срок согласия). Возвращает число заявок. */
function purgeContacts(app, days) {
  const before = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  let n = 0;
  app.findRecordsByFilter("events", "date_to != '' && date_to < {:d}", "", 0, 0, { d: before }).forEach((ev) => {
    app.findRecordsByFilter("applications", "event = {:e} && (email != '' || phone != '' || ip_hash != '')", "", 0, 0, { e: ev.id }).forEach((a) => {
      ["email", "phone", "ip_hash"].forEach((k) => a.set(k, ""));
      app.unsafeWithoutHooks().save(a);
      n++;
    });
  });
  return n;
}

module.exports = { FORMATS, today, consentText, settings, publicInfo, readForm, submit, findByToken, view, withdraw, list, decide, autoTarget, purgeContacts };
