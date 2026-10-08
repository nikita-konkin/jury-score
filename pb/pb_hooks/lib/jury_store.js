// Жюри: роли по кодам комиссии, оценки (upsert по эксперту и докладу с защитой от устаревших правок),
// удаление оценок эксперта в архив. Логика и формат ответов — как в Code.gs jury-score: { ok, role, rows, error }.
const S = require(`${__hooks}/lib/program_store.js`);
const A = require(`${__hooks}/lib/access.js`);

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // без 0/o, 1/l/i
const STATUSES = ["absent", "abstain"];

/** Код вида «k7m2-p9x4»: 31^8 вариантов, удобно диктовать и набирать на телефоне. */
function newCode() {
  const r = $security.randomStringWithAlphabet(8, ALPHABET);
  return r.slice(0, 4) + "-" + r.slice(4);
}
const normCode = (s) => String(s || "").toLowerCase().replace(/[\s-]+/g, "");

// Как norm_ в Code.gs: регистр, ё, пробелы вокруг точек
function norm(s) {
  return String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s*\.\s*/g, ". ").replace(/\s+/g, " ").trim();
}
const clean = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max || 100);

/** Настройки конкурса и доклады, которые оценивает жюри. */
function juryInfo(app, ev) {
  const doc = S.loadProgram(app, ev);
  const jury = doc.event.jury || {};
  const talks = [];
  doc.days.forEach((d) => d.sessions.forEach((s) => s.items.forEach((it) => {
    if (!it.competitive || !it.code) return;
    talks.push({
      code: it.code, title: it.title, speaker: it.speaker || "", authors: it.authors || [], org: it.org || "", city: it.city || "",
      format: it.format || "", section: it.section || 0, date: d.date, start: it.start || "", end: it.end || "",
      room: it.room || s.room || "", session: s.title || "",
    });
  })));
  return {
    enabled: !!jury.enabled && (jury.criteria || []).length > 0,
    criteria: jury.criteria || [], scaleMax: jury.scale_max || 5,
    title: doc.event.title, sections: doc.sections, talks: talks,
  };
}

/** Коды комиссии мероприятия; при первом обращении создаются. */
function ensureCodes(app, ev) {
  if (ev.getString("jury_code") && ev.getString("jury_admin_code")) return ev;
  const rec = app.findRecordById("events", ev.id);
  if (!rec.getString("jury_code")) rec.set("jury_code", newCode());
  if (!rec.getString("jury_admin_code")) rec.set("jury_admin_code", newCode());
  app.unsafeWithoutHooks().save(rec);
  return rec;
}

/** Роль: владелец мероприятия и администратор сервиса — admin без кода; иначе по коду. */
function roleOf(e, ev, code) {
  const acc = A.access(A.actor(e), ev);
  if (acc.manage) return "admin";
  const c = normCode(code);
  if (!c) return "";
  const admin = normCode(ev.getString("jury_admin_code"));
  const juror = normCode(ev.getString("jury_code"));
  if (admin && $security.equal(c, admin)) return "admin";
  if (juror && $security.equal(c, juror)) return "juror";
  return "";
}

function toRow(r) {
  let scores = [];
  try { scores = JSON.parse(toString(r.get("scores")) || "[]"); } catch (err) { scores = []; }
  return { juror: r.getString("juror"), id: r.getString("code"), scores: scores, status: r.getString("status"),
    comment: r.getString("comment"), ts: r.getInt("ts") };
}

function readRows(app, ev, jurorKey) {
  const filter = jurorKey ? "event = {:e} && juror_key = {:k}" : "event = {:e}";
  return app.findRecordsByFilter("scores", filter, "juror_key,code", 0, 0, { e: ev.id, k: jurorKey || "" }).map(toRow);
}

function save(app, ev, info, p) {
  const id = String(p.id || "");
  const talk = info.talks.find((t) => t.code === id);
  if (!talk) return { ok: false, error: "bad_id" };
  const juror = clean(p.juror);
  if (!juror) return { ok: false, error: "bad_juror" };
  const raw = Array.isArray(p.scores) ? p.scores : [];
  if (raw.length !== info.criteria.length) return { ok: false, error: "bad_scores" };
  const scores = raw.map((v) => (v === null || v === undefined || v === "" ? null : Number(v)));
  if (scores.some((v) => v !== null && !(Number.isInteger(v) && v >= 1 && v <= info.scaleMax))) return { ok: false, error: "bad_scores" };
  const status = STATUSES.indexOf(p.status) >= 0 ? p.status : "";
  const comment = String(p.comment || "").slice(0, 2000);
  const ts = Math.floor(Number(p.ts)) || Date.now();
  // сумма — только у засчитываемой оценки: все критерии и без статуса; клиентской сумме не доверяем
  const complete = !status && scores.every((v) => v !== null);
  const total = complete ? scores.reduce((a, b) => a + b, 0) : 0;
  const key = norm(juror);
  let stale = false;
  app.runInTransaction((tx) => {
    let rec = null;
    try { rec = tx.findFirstRecordByFilter("scores", "event = {:e} && code = {:c} && juror_key = {:k}", { e: ev.id, c: id, k: key }); } catch (err) { rec = null; }
    if (rec && rec.getInt("ts") > ts) { stale = true; return; } // на сервере более свежая правка
    if (!rec) {
      rec = new Record(tx.findCollectionByNameOrId("scores"));
      rec.set("event", ev.id);
      rec.set("code", id);
      rec.set("juror_key", key);
    }
    rec.set("juror", juror);
    rec.set("title", (talk.speaker ? talk.speaker + " — " : "") + talk.title);
    rec.set("scores", scores);
    rec.set("total", total);
    rec.set("complete", complete);
    rec.set("status", status);
    rec.set("comment", comment);
    rec.set("ts", ts);
    tx.save(rec);
  });
  return stale ? { ok: true, stale: true } : { ok: true };
}

/** Все оценки эксперта target — в архив scores_deleted. */
function removeJuror(app, ev, target, by) {
  const key = norm(target);
  if (!key) return { ok: false, error: "bad_target" };
  let n = 0;
  app.runInTransaction((tx) => {
    const archive = tx.findCollectionByNameOrId("scores_deleted");
    tx.findRecordsByFilter("scores", "event = {:e} && juror_key = {:k}", "", 0, 0, { e: ev.id, k: key }).forEach((r) => {
      const copy = new Record(archive);
      ["event", "code", "title", "juror", "juror_key", "scores", "total", "complete", "status", "comment", "ts"].forEach((f) => copy.set(f, r.get(f)));
      copy.set("deleted_by", clean(by));
      copy.set("deleted_at", new DateTime());
      tx.save(copy);
      tx.delete(r);
      n++;
    });
  });
  return { ok: true, deleted: n };
}

/** Один запрос жюри: action ping | mine | all | save | delete. */
function handle(e, ev, p, isPost) {
  const info = juryInfo(e.app, ev);
  if (!info.enabled) return { ok: false, error: "jury_disabled" };
  const role = roleOf(e, ev, p.code);
  if (!role) return { ok: false, error: "bad_code" };
  switch (p.action) {
    case "ping":
      return { ok: true, role: role, title: info.title, criteria: info.criteria, scaleMax: info.scaleMax, sections: info.sections, talks: info.talks };
    case "mine":
      return { ok: true, role: role, rows: readRows(e.app, ev, norm(p.juror)) };
    case "all":
      if (role !== "admin") return { ok: false, error: "forbidden" };
      return { ok: true, role: role, rows: readRows(e.app, ev, "") };
    case "save":
      return isPost ? save(e.app, ev, info, p) : { ok: false, error: "post_only" };
    case "delete":
      if (role !== "admin") return { ok: false, error: "forbidden" };
      return isPost ? removeJuror(e.app, ev, p.target, p.juror) : { ok: false, error: "post_only" };
    default:
      return { ok: false, error: "bad_action" };
  }
}

module.exports = { newCode, normCode, norm, juryInfo, ensureCodes, roleOf, readRows, save, removeJuror, handle };
