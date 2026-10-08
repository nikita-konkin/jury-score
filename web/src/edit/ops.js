// Правка документа программы conf.program/v1 в конструкторе. Чистые функции: принимают документ,
// возвращают изменённую копию; время и проверки потом считает ConfModel.normalize.

export const clone = v => JSON.parse(JSON.stringify(v));

const pad = n => (n < 10 ? "0" : "") + n;
const MAX_DAYS = 31;

/** Сдвиг даты «2026-10-07» на n дней. */
export function shiftDate(iso, n) {
  const p = String(iso || "").split("-").map(Number);
  if (p.length !== 3 || !p[0]) return iso;
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
}

/** Дней от a до b (обе — «ГГГГ-ММ-ДД»); null, если дата неверна. */
export function daysBetween(a, b) {
  const t = s => {
    const p = String(s || "").split("-").map(Number);
    return p.length === 3 && p[0] ? Date.UTC(p[0], p[1] - 1, p[2]) : NaN;
  };
  const d = (t(b) - t(a)) / 864e5;
  return isNaN(d) ? null : Math.round(d);
}

function move(arr, from, to) {
  const x = arr.splice(from, 1)[0];
  arr.splice(Math.max(0, Math.min(to, arr.length)), 0, x);
  return arr;
}

/** Элемент на соседнее место в заседании: dir = -1 вверх, +1 вниз. */
export function shiftItem(doc, di, si, ii, dir) {
  const out = clone(doc);
  const items = out.days[di].sessions[si].items;
  if (ii + dir < 0 || ii + dir >= items.length) return doc;
  move(items, ii, ii + dir);
  return out;
}

/** Элемент в конец другого заседания (или на место ti). */
export function moveItem(doc, from, to) {
  const out = clone(doc);
  const src = out.days[from.di].sessions[from.si].items;
  const it = src.splice(from.ii, 1)[0];
  const dst = out.days[to.di].sessions[to.si].items;
  dst.splice(to.ii == null ? dst.length : to.ii, 0, it);
  return out;
}

export function shiftSession(doc, di, si, dir) {
  const out = clone(doc);
  const list = out.days[di].sessions;
  if (si + dir < 0 || si + dir >= list.length) return doc;
  move(list, si, si + dir);
  return out;
}

/** Заседание в другой день (в конец). Время начала сохраняется. */
export function moveSession(doc, di, si, toDi) {
  const out = clone(doc);
  const s = out.days[di].sessions.splice(si, 1)[0];
  out.days[toDi].sessions.push(s);
  return out;
}

/** Копия элемента сразу после него: без кода (выдаст normalize) и без явного времени. */
export function duplicateItem(doc, di, si, ii) {
  const out = clone(doc);
  const items = out.days[di].sessions[si].items;
  const copy = clone(items[ii]);
  delete copy.code; delete copy.start; delete copy.end; copy.anchor = false;
  items.splice(ii + 1, 0, copy);
  return out;
}

export function removeAt(doc, path) {
  const out = clone(doc);
  if (path.ii != null) out.days[path.di].sessions[path.si].items.splice(path.ii, 1);
  else if (path.si != null) out.days[path.di].sessions.splice(path.si, 1);
  else out.days.splice(path.di, 1);
  return out;
}

/** День в порядке дат; возвращает { doc, di }. */
export function addDay(doc, day) {
  const out = clone(doc);
  const d = Object.assign({ sessions: [] }, day);
  let di = 0;
  while (di < out.days.length && String(out.days[di].date) < String(d.date)) di++;
  out.days.splice(di, 0, d);
  return { doc: out, di };
}

/** После смены даты дни снова идут по порядку; возвращает { doc, di } с новым местом дня. */
export function setDay(doc, di, fields) {
  const out = clone(doc);
  const d = Object.assign(out.days[di], fields);
  out.days.sort((a, b) => (String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0));
  return { doc: out, di: out.days.indexOf(d) };
}

/** Поля из формы элемента → элемент документа. Пустая строка — поле убрать. */
export function applyItemForm(item, form) {
  const it = clone(item || {});
  ["type", "title", "speaker", "org", "city", "room", "note", "format"].forEach(k => {
    const v = form[k] == null ? "" : String(form[k]).trim();
    if (v) it[k] = v; else delete it[k];
  });
  const authors = splitPeople(form.authors);
  if (authors.length) it.authors = authors; else delete it.authors;
  const sec = parseInt(form.section, 10);
  if (sec >= 1) it.section = sec; else delete it.section;
  // время: пусто — считается по порядку; конец всегда пересчитывается из длительности
  delete it.end;
  if (form.all_day) {
    it.all_day = true;
    delete it.start; delete it.duration; delete it.anchor;
  } else {
    delete it.all_day;
    if (form.start) { it.start = form.start; it.anchor = true; } else { delete it.start; it.anchor = false; }
    const dur = parseInt(form.duration, 10);
    if (dur >= 1) it.duration = dur; else delete it.duration;
  }
  if (form.competitive != null) it.competitive = !!form.competitive;
  return it;
}

export function itemForm(it) {
  it = it || {};
  return {
    type: it.type || "talk", title: it.title || "", speaker: it.speaker || "", authors: (it.authors || []).join(", "),
    org: it.org || "", city: it.city || "", room: it.room || "", note: it.note || "", format: it.format || "",
    section: it.section ? String(it.section) : "", start: it.anchor ? it.start || "" : "",
    duration: it.duration ? String(it.duration) : "", all_day: !!it.all_day,
    competitive: it.competitive == null ? (it.type || "talk") === "talk" : !!it.competitive,
  };
}

/** «Иванов И. И., Петров П. П.; Сидоров» → список; переносы строк тоже разделяют. */
export function splitPeople(s) {
  return String(s || "").split(/[;\n]+|,(?!\s*(?:к\.|д\.|доц|проф|канд|докт|ст\.|асп|магистр|студ))/i)
    .map(x => x.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** Ошибки и предупреждения по местам: "d0", "d0s1", "d0s1i3" → { err, warn, list }. */
export function issueIndex(report) {
  const idx = {};
  const add = (key, lvl, e) => {
    const x = idx[key] || (idx[key] = { err: 0, warn: 0, list: [] });
    x[lvl]++;
    x.list.push(e);
  };
  [["err", report ? report.errors : []], ["warn", report ? report.warnings : []]].forEach(([lvl, list]) => {
    (list || []).forEach(e => {
      if (e.code === "EXTRA_USED") return; // данные вне схемы — не ошибка организатора
      const p = parsePath(e.path);
      add("all", lvl, e);
      if (p.di == null) return add("event", lvl, e);
      add("d" + p.di, lvl, e);
      if (p.si == null) return;
      add("d" + p.di + "s" + p.si, lvl, e);
      if (p.ii != null) add("d" + p.di + "s" + p.si + "i" + p.ii, lvl, e);
    });
  });
  return idx;
}

export function parsePath(path) {
  const m = /^days\[(\d+)\](?:\.sessions\[(\d+)\](?:\.items\[(\d+)\])?)?/.exec(path || "");
  return m ? { di: +m[1], si: m[2] == null ? null : +m[2], ii: m[3] == null ? null : +m[3] } : {};
}

/** Пустая программа на даты from…to (не больше 31 дня). */
export function blankProgram(f) {
  const n = f.date_to ? daysBetween(f.date_from, f.date_to) : 0;
  if (n == null || n < 0) throw new Error("Дата окончания раньше даты начала");
  if (n >= MAX_DAYS) throw new Error(`Не больше ${MAX_DAYS} дней`);
  const event = { title: f.title, date_from: f.date_from };
  if (n > 0) event.date_to = f.date_to;
  ["city", "venue", "organizer"].forEach(k => { if (f[k]) event[k] = f[k]; });
  const days = [];
  for (let i = 0; i <= n; i++) days.push({ date: shiftDate(f.date_from, i), sessions: [] });
  return { schema: "conf.program/v1", event, sections: [], days };
}

/**
 * Новая программа по образцу: даты сдвигаются к date_from, коды выдаются заново.
 * Без докладов остаётся каркас — заседания, залы, перерывы и церемонии с закреплённым временем.
 */
export function fromTemplate(doc, f) {
  const out = clone(doc);
  const from = out.event.date_from || (out.days[0] && out.days[0].date);
  const shift = daysBetween(from, f.date_from);
  if (shift == null) throw new Error("Неверная дата начала");
  out.event.title = f.title;
  out.event.date_from = f.date_from;
  if (out.event.date_to) out.event.date_to = shiftDate(out.event.date_to, shift);
  delete out.event.extra;
  out.days.forEach(d => {
    d.date = shiftDate(d.date, shift);
    d.sessions.forEach(s => {
      if (!f.keepTalks) {
        delete s.chair; delete s.cochair; delete s.secretary;
        s.items = s.items.filter(it => it.type !== "talk" && it.type !== "plenary");
        s.items.forEach(it => { if (!it.all_day && it.start) it.anchor = true; });
      }
      s.items.forEach(it => { delete it.code; delete it.extra; });
      delete s.extra;
    });
    delete d.extra;
  });
  return out;
}

/** Секция для нового доклада в конце заседания: секция последнего доклада с секцией; иначе null. */
export function sessionSection(session) {
  for (let i = session.items.length - 1; i >= 0; i--) {
    const it = session.items[i];
    if (it.type === "talk" && it.section) return it.section;
  }
  return null;
}

/** Список людей программы для подсказок: докладчики, авторы, председатели. */
export function peopleOf(doc) {
  const seen = {};
  const out = [];
  const add = s => {
    const k = String(s || "").split(",")[0].trim();
    if (k && !seen[k]) { seen[k] = 1; out.push(k); }
  };
  doc.days.forEach(d => d.sessions.forEach(s => {
    [s.chair, s.cochair, s.secretary].forEach(add);
    s.items.forEach(it => { add(it.speaker); (it.authors || []).forEach(add); });
  }));
  return out.sort();
}

export function roomsOf(doc) {
  const seen = {};
  const out = [];
  const add = s => { if (s && !seen[s]) { seen[s] = 1; out.push(s); } };
  (doc.rooms || []).forEach(r => add(r.name));
  doc.days.forEach(d => d.sessions.forEach(s => { add(s.room); s.items.forEach(it => add(it.room)); }));
  return out;
}
