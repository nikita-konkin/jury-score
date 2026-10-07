/// <reference path="../../pb_data/types.d.ts" />
// Кто обращается к API и что ему можно: суперпользователь, администратор, владелец,
// черновой токен бота (до принятия приглашения), API-ключ с правами.
// Секреты сравниваются по sha256: в базе хранится только хэш.

const KEY_RE = /^ck_([a-z0-9]{8})_[A-Za-z0-9]{32}$/;
const DEFAULTS = { max_events_per_day: 20, max_doc_kb: 512 };

const sha = (s) => $security.sha256(s);
const header = (e, name) => String(e.request.header.get(name) || "").trim();

function newToken(prefix, len) {
  return prefix + "_" + $security.randomString(len || 32);
}

/** Новый API-ключ. Сам ключ возвращается один раз, в базе — только хэш. */
function createKey(app, opts) {
  const prefix = $security.randomStringWithAlphabet(8, "abcdefghijklmnopqrstuvwxyz0123456789");
  const key = "ck_" + prefix + "_" + $security.randomString(32);
  const rec = new Record(app.findCollectionByNameOrId("api_keys"));
  rec.set("name", opts.name);
  rec.set("prefix", prefix);
  rec.set("hash", sha(key));
  rec.set("scopes", opts.scopes || ["create_events", "update_own", "read_own", "send_feedback"]);
  rec.set("max_events_per_day", opts.max_events_per_day || 0);
  rec.set("max_doc_kb", opts.max_doc_kb || 0);
  if (opts.expires_days) rec.set("expires", new DateTime().addDate(0, 0, opts.expires_days));
  if (opts.issued_by) rec.set("issued_by", opts.issued_by);
  rec.set("note", opts.note || "");
  app.save(rec);
  return { record: rec, key: key };
}

function readKey(e) {
  const direct = header(e, "X-API-Key");
  if (direct) return direct;
  const m = /^Bearer\s+(ck_\S+)$/.exec(header(e, "Authorization"));
  return m ? m[1] : "";
}

function findKey(app, raw) {
  const m = KEY_RE.exec(raw);
  if (!m) return { error: "Неверный формат API-ключа (ожидается ck_…)" };
  let rec = null;
  try { rec = app.findFirstRecordByFilter("api_keys", "prefix = {:p}", { p: m[1] }); } catch (err) { /* нет */ }
  if (!rec || !$security.equal(rec.getString("hash"), sha(raw))) return { error: "API-ключ не найден" };
  if (rec.getBool("revoked")) return { error: "API-ключ отозван" };
  const exp = rec.getDateTime("expires");
  if (!exp.isZero() && exp.before(new DateTime())) return { error: "Срок действия API-ключа истёк" };
  return { key: rec };
}

const isUser = (auth) => !!auth && auth.collection().name === "users";

/**
 * Кто обращается. Неверный ключ — ошибка 401, а не тихий переход к анонимному доступу.
 * { su, user, admin, key, draft }
 */
function actor(e) {
  const a = { su: e.hasSuperuserAuth(), user: null, admin: false, key: null, draft: header(e, "X-Draft-Token") };
  if (isUser(e.auth)) { a.user = e.auth; a.admin = e.auth.getBool("is_admin"); }
  const raw = readKey(e);
  if (raw) {
    const r = findKey(e.app, raw);
    if (!r.key) throw new UnauthorizedError(r.error);
    a.key = r.key;
    // отметка использования не чаще раза в минуту
    const last = r.key.getDateTime("last_used");
    if (last.isZero() || last.before(new DateTime().add(-60 * 1000 * 1000 * 1000))) {
      r.key.set("last_used", new DateTime());
      try { e.app.unsafeWithoutHooks().save(r.key); } catch (err) { /* не критично */ }
    }
  }
  return a;
}

const hasScope = (key, scope) => key.getStringSlice("scopes").indexOf(scope) >= 0;

/** Ключ с правом scope или 401/403. */
function requireKey(a, scope) {
  if (!a.key) throw new UnauthorizedError("Нужен API-ключ: заголовок X-API-Key или Authorization: Bearer ck_…");
  if (!hasScope(a.key, scope)) throw new ForbiddenError(`У ключа нет права ${scope}`);
  return a.key;
}

const unclaimed = (ev) => ev.getString("status") === "draft" && ev.getStringSlice("owners").length === 0;
const isOwner = (a, ev) => !!a.user && ev.getStringSlice("owners").indexOf(a.user.id) >= 0;

function draftOk(a, ev) {
  const h = ev.getString("draft_token_hash");
  return !!a.draft && !!h && unclaimed(ev) && $security.equal(h, sha(a.draft));
}

// «Своё» для ключа: создано этим ключом или принадлежит тому, кто ключ выдал
function keyOwns(a, ev) {
  if (!a.key) return false;
  if (ev.getString("created_by_key") === a.key.id) return true;
  const issuer = a.key.getString("issued_by");
  return !!issuer && ev.getStringSlice("owners").indexOf(issuer) >= 0;
}

/** { read, write, manage, via }; manage — публикация и приглашение соавторов (только люди). */
function access(a, ev) {
  if (a.su) return { read: true, write: true, manage: true, via: "superuser" };
  if (a.admin) return { read: true, write: true, manage: true, via: "admin" };
  if (isOwner(a, ev)) return { read: true, write: true, manage: true, via: "owner" };
  if (draftOk(a, ev)) return { read: true, write: true, manage: false, via: "draft" };
  if (keyOwns(a, ev) && (hasScope(a.key, "update_own") || hasScope(a.key, "read_own"))) {
    return { read: true, write: hasScope(a.key, "update_own"), manage: false, via: "key" };
  }
  if (ev.getString("status") === "published") return { read: true, write: false, manage: false, via: "public" };
  return { read: false, write: false, manage: false, via: "" };
}

/** Базовый адрес сайта для ссылок: настройка Application URL, иначе адрес запроса. */
function baseUrl(e) {
  const url = String(e.app.settings().meta.appURL || "").replace(/\/+$/, "");
  if (url) return url;
  const proto = header(e, "X-Forwarded-Proto") || "http";
  return proto + "://" + e.request.host;
}

function requireAdmin(e) {
  const a = actor(e);
  if (!a.su && !a.user && !a.key) throw new UnauthorizedError("Нужен вход администратора");
  if (!a.su && !a.admin) throw new ForbiddenError("Только для администратора");
  return a;
}

/** JSON-тело запроса (пустое тело — {}). */
function readJson(e, maxBytes) {
  const max = maxBytes || 64 * 1024;
  const raw = toString(e.request.body, max + 1);
  if (raw.length > max) throw new ApiError(413, `Тело запроса больше ${Math.round(max / 1024)} КБ`);
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch (err) { throw new BadRequestError("Тело запроса — не JSON: " + err.message); }
}

/** Источник версии и обратной связи по заголовку X-Conf-Client («mcp/…», «ui», …). */
function clientSource(e) {
  const c = header(e, "X-Conf-Client").toLowerCase();
  return c.indexOf("mcp") === 0 ? "mcp" : c === "ui" ? "ui" : "api";
}

function limit(key, name) {
  return key.getInt(name) || DEFAULTS[name];
}

module.exports = {
  sha, header, newToken, createKey, readKey, findKey, isUser, actor, hasScope, requireKey,
  unclaimed, isOwner, draftOk, keyOwns, access, baseUrl, limit, readJson, clientSource, requireAdmin, DEFAULTS,
};
