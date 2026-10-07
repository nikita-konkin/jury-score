/**
 * Оценка докладов конкурса RWP-2026 — бэкенд на Google Apps Script.
 *
 * Установка: Google-таблица → Расширения → Apps Script → вставить этот файл →
 * сменить ACCESS_CODE и ADMIN_CODE → выполнить setup() → Развернуть →
 * Веб-приложение (выполнять от имени «Я», доступ «Все») → скопировать URL …/exec
 * в CONFIG.SCRIPT_URL в index.html.
 *
 * Любая правка этого файла вступает в силу только после
 * «Управление развертываниями → изменить → Новая версия». URL /exec не меняется.
 */

const ACCESS_CODE = "СМЕНИТЕ-КОД";      // код комиссии для экспертов (регистр не важен)
const ADMIN_CODE = "СМЕНИТЕ-АДМИН";     // код администратора: видит итоги всех экспертов. Должен отличаться от ACCESS_CODE
const SCALE_MAX = 5;
// Должно совпадать с CONFIG.CRITERIA в index.html: количество и порядок.
const CRITERIA = [
  "Актуальность темы",
  "Научная новизна",
  "Обоснованность и достоверность результатов",
  "Практическая значимость",
  "Качество доклада и презентации",
  "Ответы на вопросы",
];

const SHEET_SCORES = "Оценки";
const SHEET_SUMMARY = "Сводка";
const SHEET_DELETED = "Удалённые";
const STATUS_LABEL = { absent: "не состоялся", abstain: "воздерживается" };

// Колонки листа «Оценки» (с нуля). Если в листе уже есть оценки, порядок не менять.
const NCRIT = CRITERIA.length;
const COL = { juror: 0, id: 1, title: 2, crit: 3, total: 3 + NCRIT, status: 4 + NCRIT, comment: 5 + NCRIT, ts: 6 + NCRIT, updated: 7 + NCRIT };
const WIDTH = 8 + NCRIT;
const HEADER = ["Эксперт", "ID доклада", "Доклад"].concat(CRITERIA, ["Сумма", "Статус", "Комментарий", "ts", "Обновлено"]);
// Текстовый формат не даёт Sheets превращать имена и комментарии в даты и формулы
const FORMATS = ["@", "@", "@"].concat(CRITERIA.map(() => "0"), ["0", "@", "@", "0", "dd.MM.yyyy HH:mm:ss"]);

/** Запустить вручную один раз (и снова после изменения критериев). */
function setup() {
  const ss = SpreadsheetApp.getActive();
  const sh = scoresSheet_();
  sh.getRange(1, 1, 1, WIDTH).setValues([HEADER]).setFontWeight("bold");
  sh.setFrozenRows(1);
  const sum = ss.getSheetByName(SHEET_SUMMARY) || ss.insertSheet(SHEET_SUMMARY);
  sum.clear();
  sum.getRange(1, 1).setFormula(summaryFormula_());
  sum.setFrozenRows(1);
}

function doGet(e) {
  return json_(handle_((e && e.parameter) || {}, false));
}

function doPost(e) {
  let p;
  try {
    p = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: "bad_json" });
  }
  return json_(handle_(p, true));
}

function handle_(p, isPost) {
  try {
    if (!p.action) return { ok: true, service: "jury-score" };
    const role = roleOf_(p.code);
    if (!role) return { ok: false, error: "bad_code" };
    switch (p.action) {
      case "ping":
        return { ok: true, role: role, criteria: NCRIT, scaleMax: SCALE_MAX };
      case "mine":
        return { ok: true, role: role, rows: readRows_(norm_(p.juror)) };
      case "all":
        if (role !== "admin") return { ok: false, error: "forbidden" };
        return { ok: true, role: role, rows: readRows_(null) };
      case "save":
        return isPost ? save_(p) : { ok: false, error: "post_only" };
      case "delete":
        if (role !== "admin") return { ok: false, error: "forbidden" };
        return isPost ? delete_(p) : { ok: false, error: "post_only" };
      default:
        return { ok: false, error: "bad_action" };
    }
  } catch (err) {
    return { ok: false, error: "server", message: String((err && err.message) || err) };
  }
}

function roleOf_(code) {
  const c = String(code || "").trim().toLowerCase();
  if (!c) return "";
  if (c === String(ADMIN_CODE).trim().toLowerCase()) return "admin";
  if (c === String(ACCESS_CODE).trim().toLowerCase()) return "juror";
  return "";
}

function save_(p) {
  const id = String(p.id || "");
  if (!/^s\d+-\d+$/.test(id)) return { ok: false, error: "bad_id" };
  const juror = clean_(p.juror);
  if (!juror) return { ok: false, error: "bad_juror" };
  const raw = Array.isArray(p.scores) ? p.scores : [];
  if (raw.length !== NCRIT) return { ok: false, error: "bad_scores" };
  const scores = raw.map(v => (v === null || v === undefined || v === "" ? null : Number(v)));
  if (scores.some(v => v !== null && !(Number.isInteger(v) && v >= 1 && v <= SCALE_MAX))) return { ok: false, error: "bad_scores" };
  const status = p.status === "absent" || p.status === "abstain" ? p.status : "";
  const comment = String(p.comment || "").slice(0, 2000);
  const ts = Number(p.ts) || Date.now();
  // Сумма пишется только для засчитываемой оценки: все критерии и без статуса
  const complete = !status && scores.every(v => v !== null);
  const total = complete ? scores.reduce((a, b) => a + b, 0) : "";

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = scoresSheet_();
    const key = norm_(juror);
    const last = sh.getLastRow();
    let row = 0;
    if (last >= 2) {
      const keys = sh.getRange(2, 1, last - 1, 2).getValues();
      for (let i = 0; i < keys.length; i++) {
        if (String(keys[i][COL.id]) === id && norm_(unesc_(keys[i][COL.juror])) === key) { row = i + 2; break; }
      }
    }
    if (row) {
      const old = Number(sh.getRange(row, COL.ts + 1).getValue()) || 0;
      if (old > ts) return { ok: true, stale: true };  // на сервере более свежая правка
    } else {
      row = Math.max(last, 1) + 1;
    }
    const vals = [esc_(juror), id, esc_(String(p.title || "").slice(0, 400))]
      .concat(scores.map(v => (v === null ? "" : v)), [total, STATUS_LABEL[status] || "", esc_(comment), ts, new Date()]);
    sh.getRange(row, 1, 1, WIDTH).setNumberFormats([FORMATS]).setValues([vals]);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// Удаление всех оценок эксперта (только администратор). Строки не стираются,
// а переносятся на лист «Удалённые», откуда их можно вернуть вручную.
function delete_(p) {
  const key = norm_(p.target);
  if (!key) return { ok: false, error: "bad_target" };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = scoresSheet_();
    const last = sh.getLastRow();
    if (last < 2) return { ok: true, deleted: 0 };
    const vals = sh.getRange(2, 1, last - 1, WIDTH).getValues();
    const rows = [];
    vals.forEach((r, i) => { if (r[COL.id] && norm_(unesc_(r[COL.juror])) === key) rows.push(i + 2); });
    if (!rows.length) return { ok: true, deleted: 0 };

    const arch = archiveSheet_();
    const moved = rows.map(n => vals[n - 2].map(v => (typeof v === "string" ? esc_(unesc_(v)) : v))
      .concat([new Date(), esc_(clean_(p.juror))]));
    arch.getRange(arch.getLastRow() + 1, 1, moved.length, WIDTH + 2)
      .setNumberFormats(moved.map(() => FORMATS.concat(["dd.MM.yyyy HH:mm:ss", "@"])))
      .setValues(moved);

    // Sheets не даёт удалить все незакреплённые строки — оставим запас пустых
    if (sh.getMaxRows() - rows.length < 2) sh.insertRowsAfter(sh.getMaxRows(), 10);
    // удаляем снизу вверх, подряд идущие строки — одним вызовом
    for (let i = rows.length - 1; i >= 0;) {
      let j = i;
      while (j > 0 && rows[j - 1] === rows[j] - 1) j--;
      sh.deleteRows(rows[j], i - j + 1);
      i = j - 1;
    }
    return { ok: true, deleted: rows.length };
  } finally {
    lock.releaseLock();
  }
}

function archiveSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_DELETED);
  if (!sh) {
    sh = ss.insertSheet(SHEET_DELETED);
    sh.getRange(1, 1, 1, WIDTH + 2).setValues([HEADER.concat(["Удалено", "Кем"])]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}

function readRows_(jurorKey) {
  const sh = scoresSheet_();
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const out = [];
  for (const r of sh.getRange(2, 1, n, WIDTH).getValues()) {
    if (!r[COL.id]) continue;
    const name = unesc_(r[COL.juror]);
    if (jurorKey && norm_(name) !== jurorKey) continue;
    const scores = [];
    for (let i = 0; i < NCRIT; i++) {
      const v = r[COL.crit + i];
      scores.push(v === "" || v === null ? null : Number(v));
    }
    out.push({
      juror: name,
      id: String(r[COL.id]),
      scores: scores,
      status: statusCode_(r[COL.status]),
      comment: unesc_(r[COL.comment]),
      ts: Number(r[COL.ts]) || 0,
    });
  }
  return out;
}

function scoresSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_SCORES);
  if (!sh) {
    sh = ss.insertSheet(SHEET_SCORES);
    sh.getRange(1, 1, 1, WIDTH).setValues([HEADER]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}

// Средний суммарный балл по докладу: считаются только строки с заполненной «Суммой»
function summaryFormula_() {
  const L = i => colLetter_(i);
  const id = L(COL.id), title = L(COL.title), tot = L(COL.total);
  const crit = CRITERIA.map((_, i) => L(COL.crit + i));
  const select = [id, title, "avg(" + tot + ")", "count(" + tot + ")"].concat(crit.map(c => "avg(" + c + ")"));
  const labels = [id + " 'ID'", title + " 'Доклад'", "avg(" + tot + ") 'Средний балл'", "count(" + tot + ") 'Экспертов'"]
    .concat(crit.map((c, i) => "avg(" + c + ") '" + CRITERIA[i].replace(/['"]/g, "") + "'"));
  const q = "select " + select.join(", ") + " where " + tot + " is not null group by " + id + ", " + title +
    " order by avg(" + tot + ") desc label " + labels.join(", ");
  return "=QUERY('" + SHEET_SCORES + "'!A2:" + L(WIDTH - 1) + ", \"" + q + "\", 0)";
}

function colLetter_(i) {  // индекс с нуля → буква колонки
  let n = i + 1, s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function statusCode_(label) {
  const s = String(label || "").trim();
  for (const k in STATUS_LABEL) if (STATUS_LABEL[k] === s || k === s) return k;
  return "";
}

// Та же нормализация, что и в index.html: регистр, ё, пробелы вокруг точек
function norm_(s) {
  return String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s*\.\s*/g, ". ").replace(/\s+/g, " ").trim();
}

function clean_(s) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, 100);
}

// Строки, начинающиеся с = + - @, Sheets пытается считать формулами
function esc_(s) {
  s = String(s || "");
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function unesc_(s) {
  s = String(s === null || s === undefined ? "" : s);
  return /^'[=+\-@]/.test(s) ? s.slice(1) : s;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
