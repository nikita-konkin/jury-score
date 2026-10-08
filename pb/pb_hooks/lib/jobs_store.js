// Задачи для локального обработчика (worker/ на ПК владельца с LM Studio). Владелец ставит задачу с текстом,
// обработчик забирает её по ключу process_jobs (только задачи мероприятий того, кто выдал ключ), возвращает
// результат; сервер проверяет его model.js, владелец смотрит и применяет — получается новая версия программы.
const S = require(`${__hooks}/lib/program_store.js`);
const M = S.M;

const KINDS = { program_from_text: "Программа из текста", talks_from_text: "Доклады из текста" };
const MAX_TEXT = 400 * 1024;
const MAX_OPEN = 20; // в очереди и в работе на одно мероприятие
const STALE_MIN = 30; // задача в работе дольше — обработчик пропал, возвращаем в очередь
const MAX_ATTEMPTS = 3;
const CONTACT_KEY = /mail|phone|тел|почт/i;

const clean = (s, max) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max || 200);
const fail = (status, message) => ({ status: status, body: { ok: false, message: message } });

/** Задача для ответа: без входного текста; full — с результатом и отчётом проверки. */
function view(j, full) {
  const result = S.parseJson(j.get("result"));
  const report = S.parseJson(j.get("report"));
  const out = {
    id: j.id, kind: j.getString("kind"), title: j.getString("title"), status: j.getString("status"), error: j.getString("error"),
    model: j.getString("model"), attempts: j.getInt("attempts"), applied_version: j.getInt("applied_version"),
    created: j.getString("created"), claimed_at: j.getString("claimed_at"), finished_at: j.getString("finished_at"),
    stats: report && report.stats ? report.stats : null,
  };
  if (result && result.items) out.stats = { items: result.items.length };
  if (full) { out.result = result; out.report = report; }
  return out;
}

function create(app, ev, userId, body) {
  const kind = String(body.kind || "");
  if (!KINDS[kind]) return fail(400, "kind: program_from_text или talks_from_text");
  const text = String(body.text || "").trim();
  if (!text) return fail(400, "Нужен текст материалов");
  if (text.length > MAX_TEXT) return fail(413, `Текст длиннее ${Math.round(MAX_TEXT / 1024)} КБ — разделите его на части`);
  const open = app.findRecordsByFilter("jobs", "event = {:e} && (status = 'queued' || status = 'running')", "", MAX_OPEN, 0, { e: ev.id });
  if (open.length >= MAX_OPEN) return fail(429, "Слишком много задач в очереди: дождитесь обработки");
  const j = new Record(app.findCollectionByNameOrId("jobs"));
  j.set("event", ev.id);
  j.set("kind", kind);
  j.set("status", "queued");
  j.set("title", clean(body.title, 200) || KINDS[kind]);
  j.set("input", { text: text, note: clean(body.note, 1000) });
  j.set("created_by", userId || "");
  j.set("attempts", 0);
  app.save(j);
  return { status: 201, body: { ok: true, job: view(j, false) } };
}

function list(app, ev) {
  return app.findRecordsByFilter("jobs", "event = {:e}", "-created", 50, 0, { e: ev.id }).map((j) => view(j, false));
}

/** Когда обработчик владельца последний раз обращался к серверу (ключи process_jobs, выданные им). */
function workerSeen(app, userId) {
  if (!userId) return "";
  let last = "";
  app.findRecordsByFilter("api_keys", "issued_by = {:u} && revoked = false", "-last_used", 20, 0, { u: userId }).forEach((k) => {
    if (k.getStringSlice("scopes").indexOf("process_jobs") < 0) return;
    const t = k.getString("last_used");
    if (t > last) last = t;
  });
  return last;
}

/** Задачи, у которых обработчик пропал: снова в очередь или ошибка после MAX_ATTEMPTS. */
function requeueStale(app) {
  const before = new DateTime().add(-STALE_MIN * 60 * 1000 * 1000 * 1000).string();
  app.findRecordsByFilter("jobs", "status = 'running' && claimed_at < {:t}", "", 100, 0, { t: before }).forEach((j) => {
    if (j.getInt("attempts") >= MAX_ATTEMPTS) {
      j.set("status", "failed");
      j.set("error", `Обработчик не вернул результат за ${STALE_MIN} минут (${MAX_ATTEMPTS} попытки)`);
      j.set("finished_at", new DateTime());
    } else j.set("status", "queued");
    app.save(j);
  });
}

/** Самая старая задача в очереди среди мероприятий того, кто выдал ключ (ключ без владельца — любые). */
function claim(e, key) {
  requeueStale(e.app);
  const issuer = key.getString("issued_by");
  let found = null;
  e.app.runInTransaction((tx) => {
    const queued = tx.findRecordsByFilter("jobs", "status = 'queued'", "created", 100, 0);
    for (let i = 0; i < queued.length && !found; i++) {
      const j = queued[i];
      const ev = tx.findRecordById("events", j.getString("event"));
      if (issuer && ev.getStringSlice("owners").indexOf(issuer) < 0) continue;
      j.set("status", "running");
      j.set("worker", key.id);
      j.set("claimed_at", new DateTime());
      j.set("attempts", j.getInt("attempts") + 1);
      tx.save(j);
      found = { j: j, ev: ev };
    }
  });
  if (!found) return { ok: true, job: null };
  const doc = S.loadProgram(e.app, found.ev);
  const ev = doc.event;
  return {
    ok: true,
    job: {
      id: found.j.id, kind: found.j.getString("kind"), title: found.j.getString("title"), input: S.parseJson(found.j.get("input")) || {},
      event: { id: found.ev.id, title: ev.title, date_from: ev.date_from || "", date_to: ev.date_to || "", city: ev.city || "",
        venue: ev.venue || "", timezone: ev.timezone || "", sections: doc.sections },
    },
  };
}

/** Доклады из ответа модели: только поля доклада, без контактов, через normalize во временной программе. */
function checkTalks(items, sections) {
  const list = (Array.isArray(items) ? items : []).filter((x) => x && typeof x === "object").map((x) => {
    const it = {};
    Object.keys(x).forEach((k) => { if (!CONTACT_KEY.test(k) && ["code", "start", "end", "anchor", "duration"].indexOf(k) < 0) it[k] = x[k]; });
    it.type = it.type === "plenary" ? "plenary" : "talk";
    return it;
  });
  if (!list.length) return { ok: false, message: "Модель не нашла ни одного доклада" };
  const tmp = { schema: M.SCHEMA_ID, event: { title: "x", date_from: "2000-01-01" }, sections: sections,
    days: [{ date: "2000-01-01", sessions: [{ title: "x", start: "09:00", items: list }] }] };
  const r = M.normalize(tmp);
  const bad = r.report.errors.filter((x) => x.path.indexOf("days[0].sessions[0].items") === 0);
  if (bad.length) return { ok: false, report: r.report, message: "Ошибки в докладах: " + bad.slice(0, 3).map((x) => x.message).join("; ") };
  const out = r.doc.days[0].sessions[0].items.map((it) => {
    const o = {};
    Object.keys(it).forEach((k) => { if (["code", "start", "end", "anchor", "duration"].indexOf(k) < 0) o[k] = it[k]; }); // длительность — по регламенту мероприятия
    return o;
  });
  return { ok: true, items: out, report: r.report };
}

/** Результат обработчика: проверка model.js; с ошибками — failed, но результат сохраняется для разбора. */
function submitResult(e, key, j, body) {
  if (j.getString("status") !== "running" || j.getString("worker") !== key.id) return fail(409, "Задача уже не в работе у этого обработчика");
  j.set("model", clean(body.model, 200));
  j.set("finished_at", new DateTime());
  if (body.error) {
    j.set("status", "failed");
    j.set("error", clean(body.error, 2000));
    e.app.save(j);
    return { status: 200, body: { ok: true, job: view(j, false) } };
  }
  const res = body.result || {};
  if (j.getString("kind") === "program_from_text") {
    const r = M.normalize(res.program || {});
    j.set("result", { program: r.doc });
    j.set("report", r.report);
    j.set("status", r.report.ok ? "done" : "failed");
    j.set("error", r.report.ok ? "" : "Программа с ошибками: " + r.report.errors.slice(0, 3).map((x) => x.message).join("; "));
  } else {
    const ev = e.app.findRecordById("events", j.getString("event"));
    const t = checkTalks(res.items, S.loadProgram(e.app, ev).sections);
    j.set("result", t.items ? { items: t.items } : null);
    j.set("report", t.report || null);
    j.set("status", t.ok ? "done" : "failed");
    j.set("error", t.ok ? "" : t.message);
  }
  e.app.save(j);
  return { status: 200, body: { ok: true, job: view(j, false) } };
}

/** Применить результат: новая версия программы (целиком или доклады в конец заседания { day, session }). */
function apply(e, ev, j, body, userId) {
  if (j.getString("status") !== "done") return fail(409, "Применить можно только готовый результат");
  const result = S.parseJson(j.get("result")) || {};
  let program;
  if (j.getString("kind") === "program_from_text") program = result.program;
  else {
    program = S.loadProgram(e.app, ev);
    const day = program.days[+body.day];
    const session = day && day.sessions[+body.session];
    if (!session) return fail(400, "Выберите заседание для докладов");
    (result.items || []).forEach((it) => session.items.push(JSON.parse(JSON.stringify(it))));
  }
  const res = S.saveProgram(e.app, {
    event: ev, program: program, source: "import", author: userId || "", baseVersion: ev.getInt("version"),
    note: "Обработчик: " + j.getString("title"),
  });
  if (!res.ok) return { status: res.status || 422, body: { ok: false, message: res.message || "Программа не сохранена: есть ошибки", report: res.report } };
  j.set("status", "applied");
  j.set("applied_version", res.version);
  j.set("input", null); // текст материалов больше не нужен
  e.app.save(j);
  return { status: 200, body: { ok: true, version: res.version, job: view(j, false) } };
}

function cancel(app, j) {
  if (["queued", "running", "done", "failed"].indexOf(j.getString("status")) < 0) return fail(409, "Задачу уже нельзя отменить");
  j.set("status", "cancelled");
  j.set("input", null);
  app.save(j);
  return { status: 200, body: { ok: true, job: view(j, false) } };
}

/** Старые задачи удаляются целиком (с текстом и результатом). */
function purge(app, days) {
  const before = new DateTime().addDate(0, 0, -days).string();
  const list = app.findRecordsByFilter("jobs", "created < {:t}", "", 1000, 0, { t: before });
  list.forEach((j) => app.delete(j));
  return list.length;
}

module.exports = { KINDS, view, create, list, workerSeen, claim, checkTalks, submitResult, apply, cancel, purge };
