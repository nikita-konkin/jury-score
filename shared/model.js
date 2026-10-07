/* conf-kit · shared/model.js
 *
 * Документ программы conf.program/v1: нормализация, расчёт времени и проверки.
 * Один файл работает в браузере (через сборку esbuild), в Node (MCP, тесты)
 * и в goja (pb_hooks PocketBase). Поэтому синтаксис — ES2015: без ?., ??,
 * spread объектов, Object.fromEntries и Array.prototype.flat.
 *
 * Главная функция — normalize(input) → { doc, report }.
 * Терпима к ответам LLM: понимает русские синонимы типов и форматов, время
 * «14.30» и «09:00–09:15», авторов строкой, а незнакомые поля переносит в extra.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ConfModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SCHEMA_ID = "conf.program/v1";
  const ITEM_TYPES = ["talk", "plenary", "break", "lunch", "activity", "ceremony"];
  const FORMATS = ["oral", "online", "poster"];
  const DEFAULT_REGULATIONS = { talk_min: 15, plenary_min: 30, break_min: 15, lunch_min: 45, other_min: 30 };
  const DEFAULT_SCALE_MAX = 5;

  const TYPE_ALIASES = {
    "talk": "talk", "доклад": "talk", "секционный доклад": "talk", "report": "talk", "presentation": "talk",
    "plenary": "plenary", "пленарный": "plenary", "пленарный доклад": "plenary", "лекция": "plenary", "keynote": "plenary", "lecture": "plenary",
    "break": "break", "перерыв": "break", "кофе-брейк": "break", "кофе брейк": "break", "coffee": "break", "coffee break": "break",
    "lunch": "lunch", "обед": "lunch", "обеденный перерыв": "lunch",
    "activity": "activity", "мероприятие": "activity", "экскурсия": "activity", "деловая игра": "activity", "event": "activity", "other": "activity",
    "ceremony": "ceremony", "церемония": "ceremony", "открытие": "ceremony", "закрытие": "ceremony",
  };
  const FORMAT_ALIASES = {
    "oral": "oral", "устный": "oral", "устно": "oral", "очно": "oral", "очный": "oral", "offline": "oral", "in-person": "oral",
    "online": "online", "онлайн": "online", "дистанционно": "online", "дистанционный": "online", "remote": "online",
    "poster": "poster", "стендовый": "poster", "стенд": "poster", "постер": "poster",
  };

  // Известные поля на каждом уровне. Остальные переносятся в extra с предупреждением.
  const KEYS = {
    root: ["schema", "event", "rooms", "sections", "days"],
    event: ["title", "subtitle", "date_from", "date_to", "city", "venue", "organizer", "timezone", "regulations", "jury", "extra"],
    regulations: ["talk_min", "plenary_min", "break_min", "lunch_min", "other_min"],
    jury: ["enabled", "criteria", "scale_max"],
    section: ["no", "title", "short", "extra"],
    room: ["name", "building", "extra"],
    day: ["date", "title", "sessions", "extra"],
    session: ["title", "room", "start", "end", "chair", "cochair", "secretary", "items", "extra"],
    item: ["type", "code", "section", "start", "end", "duration", "anchor", "all_day", "title", "authors", "speaker",
      "format", "org", "city", "room", "competitive", "note", "extra"],
  };

  /* ---------------- мелкие утилиты ---------------- */

  const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const clean = s => (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
  const stripQuotes = s => clean(s).replace(/^[«"“„']+|[»"”']+$/g, "").trim();

  function assign(target) {
    for (let i = 1; i < arguments.length; i++) {
      const src = arguments[i];
      if (src) Object.keys(src).forEach(k => { target[k] = src[k]; });
    }
    return target;
  }

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  /** «9:00», «09.00», «9.00» → «09:00»; неверное → null. Допускается 24:00. */
  function normTime(s) {
    const m = /^(\d{1,2})[:.](\d{2})$/.exec(clean(s));
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h > 24 || mi > 59 || (h === 24 && mi > 0)) return null;
    return pad(h) + ":" + pad(mi);
  }
  const pad = n => (n < 10 ? "0" : "") + n;
  const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
  const fromMin = m => pad(Math.floor(m / 60)) + ":" + pad(m % 60);

  /** «2026-10-07» или «07.10.2026» → «2026-10-07»; неверное → null. */
  function normDate(s) {
    s = clean(s);
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s), y, mo, d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s))) { y = +m[3]; mo = +m[2]; d = +m[1]; }
    else return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return y + "-" + pad(mo) + "-" + pad(d);
  }

  /**
   * Человек: «А.О. Рябов», «Рябов А. О.» → { name: "А. О. Рябов", regalia: "" }.
   * Всё после первой запятой считается регалиями. Полное ФИО не сокращается.
   */
  function parsePerson(s) {
    s = clean(s);
    if (!s) return null;
    const i = s.indexOf(",");
    let name = (i >= 0 ? s.slice(0, i) : s).replace(/\s*\.\s*/g, ". ").trim();
    const regalia = i >= 0 ? clean(s.slice(i + 1)) : "";
    const toks = name.split(" ");
    const isInit = t => /^[A-ZА-ЯЁ]\.$/.test(t);
    let k = 0;
    while (k < toks.length && isInit(toks[k])) k++;
    if (k > 0 && k === toks.length - 1) return { name: toks.slice(0, k).join(" ") + " " + toks[k], regalia: regalia };
    let j = toks.length;
    while (j > 0 && isInit(toks[j - 1])) j--;
    if (j === 1 && toks.length > 1) return { name: toks.slice(1).join(" ") + " " + toks[0], regalia: regalia };
    return { name: name, regalia: regalia };
  }

  function normPersonString(s) {
    const p = parsePerson(s);
    return p ? p.name + (p.regalia ? ", " + p.regalia : "") : "";
  }

  /** Ключ для сравнения людей: регистр, ё, пробелы и точки не важны. */
  function personKey(s) {
    const p = parsePerson(s);
    return p ? p.name.toLowerCase().replace(/ё/g, "е").replace(/[\s.]/g, "") : "";
  }

  /** Ключ зала: «ауд. 431», «аудитория 431» и «431» — один зал. */
  function roomKey(s) {
    // «ПГТУ, 1й корпус, ауд.403» = «ПГТУ, 1й корпус ауд. 403»: пробелы и знаки препинания не различают залы
    return clean(s).toLowerCase().replace(/ё/g, "е").replace(/^(аудитория|ауд\.?)\s*/, "").replace(/[^a-zа-я0-9]+/g, "");
  }

  const titleKey = s => clean(s).toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim();
  const cleanCity = s => clean(s).replace(/^(г\.|город)\s*/i, "");
  const short = s => { s = clean(s); return s.length > 60 ? s.slice(0, 57) + "…" : s; };

  /* ---------------- отчёт проверки ---------------- */

  function Report() { this.entries = []; }
  Report.prototype.add = function (level, code, path, message, extra) {
    this.entries.push(assign({ level: level, code: code, path: path, message: message }, extra));
  };
  Report.prototype.error = function (c, p, m, x) { this.add("error", c, p, m, x); };
  Report.prototype.warn = function (c, p, m, x) { this.add("warning", c, p, m, x); };
  Report.prototype.info = function (c, p, m, x) { this.add("info", c, p, m, x); };
  Report.prototype.out = function (doc) {
    const by = lvl => this.entries.filter(e => e.level === lvl);
    const errors = by("error");
    return { ok: errors.length === 0, errors: errors, warnings: by("warning"), info: by("info"), stats: stats(doc) };
  };

  function stats(doc) {
    const s = { days: 0, sessions: 0, items: 0, talks: 0, competitive: 0, sections: 0, rooms: 0 };
    if (!doc) return s;
    s.sections = doc.sections.length;
    s.rooms = doc.rooms.length;
    doc.days.forEach(d => {
      s.days++;
      d.sessions.forEach(se => {
        s.sessions++;
        se.items.forEach(it => {
          s.items++;
          if (it.type === "talk") s.talks++;
          if (it.competitive) s.competitive++;
        });
      });
    });
    return s;
  }

  // Незнакомые поля → extra (ничего не теряется) + предупреждение.
  function moveUnknown(src, known, out, path, R) {
    const extra = isObj(src.extra) ? clone(src.extra) : {};
    let moved = [];
    Object.keys(src).forEach(k => {
      if (known.indexOf(k) < 0) { extra[k] = clone(src[k]); moved.push(k); }
    });
    if (moved.length) {
      R.warn("UNKNOWN_FIELD", path, `Поля ${moved.map(k => "«" + k + "»").join(", ")} не входят в схему — сохранены в extra`, { fields: moved });
    }
    if (Object.keys(extra).length) out.extra = extra;
  }

  /* ---------------- нормализация уровней ---------------- */

  function normEvent(src, R, days) {
    const p = "event";
    const ev = {};
    if (!isObj(src)) { R.error("MISSING_EVENT", p, "Нет объекта event с описанием мероприятия"); src = {}; }
    ev.title = stripQuotes(src.title);
    if (!ev.title) R.error("MISSING_EVENT_TITLE", p + ".title", "Не указано название мероприятия");
    ["subtitle", "venue", "organizer"].forEach(k => { if (clean(src[k])) ev[k] = clean(src[k]); });
    if (clean(src.city)) ev.city = cleanCity(src.city);

    ["date_from", "date_to"].forEach(k => {
      if (src[k] == null || src[k] === "") return;
      const d = normDate(src[k]);
      if (!d) R.error("BAD_DATE", p + "." + k, `Неверная дата «${clean(src[k])}», нужен формат ГГГГ-ММ-ДД`);
      else {
        if (d !== clean(src[k])) R.info("DATE_FORMAT_FIXED", p + "." + k, `Дата «${clean(src[k])}» приведена к виду ${d}`);
        ev[k] = d;
      }
    });
    const dayDates = days.map(d => normDate(isObj(d) ? d.date : null)).filter(Boolean).sort();
    if (!ev.date_from && dayDates.length) {
      ev.date_from = dayDates[0];
      R.warn("DATE_FROM_DERIVED", p + ".date_from", `Не указана дата начала — взята дата первого дня ${ev.date_from}`);
    }
    if (!ev.date_from && !dayDates.length) R.error("MISSING_DATE", p + ".date_from", "Не указана дата начала мероприятия");
    if (!ev.date_to && dayDates.length) ev.date_to = dayDates[dayDates.length - 1];
    if (ev.date_from && ev.date_to && ev.date_to < ev.date_from) {
      R.error("DATE_RANGE", p + ".date_to", `Дата окончания ${ev.date_to} раньше даты начала ${ev.date_from}`);
    }
    ev.timezone = clean(src.timezone) || "Europe/Moscow";

    const regs = assign({}, DEFAULT_REGULATIONS);
    if (isObj(src.regulations)) {
      KEYS.regulations.forEach(k => {
        const v = src.regulations[k];
        if (v == null) return;
        if (Number.isInteger(+v) && +v > 0 && +v <= 600) regs[k] = +v;
        else R.error("BAD_REGULATION", p + ".regulations." + k, `Регламент «${k}» должен быть целым числом минут от 1 до 600`);
      });
    }
    ev.regulations = regs;

    if (src.jury != null) {
      const j = isObj(src.jury) ? src.jury : {};
      const criteria = (Array.isArray(j.criteria) ? j.criteria : []).map(clean).filter(Boolean);
      if (!criteria.length) R.warn("JURY_NO_CRITERIA", p + ".jury.criteria", "У жюри нет критериев — оценка докладов будет недоступна");
      if (criteria.length > 20) R.error("JURY_TOO_MANY", p + ".jury.criteria", "Критериев больше 20");
      let scale = j.scale_max == null ? DEFAULT_SCALE_MAX : +j.scale_max;
      if (!(Number.isInteger(scale) && scale >= 2 && scale <= 100)) {
        R.error("BAD_SCALE", p + ".jury.scale_max", "Шкала scale_max должна быть целым числом от 2 до 100");
        scale = DEFAULT_SCALE_MAX;
      }
      ev.jury = { enabled: j.enabled == null ? criteria.length > 0 : !!j.enabled, criteria: criteria, scale_max: scale };
    }
    moveUnknown(src, KEYS.event, ev, p, R);
    return ev;
  }

  function normSections(src, R) {
    const out = [];
    if (src == null) return out;
    if (!Array.isArray(src)) { R.error("BAD_SECTIONS", "sections", "sections должен быть массивом"); return out; }
    src.forEach((s, i) => {
      const p = "sections[" + i + "]";
      if (!isObj(s)) { R.error("BAD_SECTION", p, "Секция должна быть объектом { no, title }"); return; }
      const no = +(s.no != null ? s.no : s.number);
      const sec = { no: no, title: clean(s.title != null ? s.title : s.name) };
      if (!(Number.isInteger(no) && no >= 1)) R.error("BAD_SECTION_NO", p + ".no", "Номер секции no должен быть целым числом от 1");
      if (!sec.title) R.error("MISSING_SECTION_TITLE", p + ".title", `У секции ${s.no} нет названия`);
      if (out.some(x => x.no === no)) R.error("DUPLICATE_SECTION", p + ".no", `Секция с номером ${no} уже есть`);
      if (clean(s.short)) sec.short = clean(s.short);
      const known = KEYS.section.concat(["number", "name"]);
      moveUnknown(s, known, sec, p, R);
      out.push(sec);
    });
    return out;
  }

  function normItem(src, path, R) {
    const it = {};
    if (!isObj(src)) { R.error("BAD_ITEM", path, "Элемент программы должен быть объектом"); return null; }
    const s = assign({}, src);

    // «time»: «09:00–09:15» или «09:00» — частый формат у LLM
    if (s.time != null && s.start == null) {
      const parts = clean(s.time).split(/\s*[–—-]\s*/);
      s.start = parts[0];
      if (parts[1]) s.end = parts[1];
      R.info("TIME_FIELD_SPLIT", path, `Поле time «${clean(s.time)}» разобрано на start/end`);
    }
    delete s.time;
    // докладчик объектом { name, org, city }
    if (isObj(s.speaker)) {
      if (s.org == null && s.speaker.org) s.org = s.speaker.org;
      if (s.city == null && s.speaker.city) s.city = s.speaker.city;
      s.speaker = s.speaker.name;
    }

    let type = clean(s.type).toLowerCase();
    if (type && TYPE_ALIASES[type]) type = TYPE_ALIASES[type];
    else if (type) {
      R.warn("UNKNOWN_TYPE", path + ".type", `Неизвестный тип «${clean(s.type)}» — считается activity`);
      type = "activity";
    } else {
      const t = clean(s.title).toLowerCase();
      type = clean(s.speaker) || (Array.isArray(s.authors) && s.authors.length) ? "talk"
        : /обед/.test(t) ? "lunch" : /кофе|перерыв/.test(t) ? "break" : "activity";
      R.info("TYPE_INFERRED", path + ".type", `Тип не указан — определён как ${type}`);
    }
    it.type = type;
    if (clean(s.code)) it.code = clean(s.code);

    if (s.section != null && s.section !== "") {
      const no = +s.section;
      if (Number.isInteger(no) && no >= 1) it.section = no;
      else R.error("BAD_SECTION_REF", path + ".section", `Ссылка на секцию «${s.section}» должна быть номером секции`);
    }

    it.title = stripQuotes(s.title);

    let authors = s.authors;
    if (typeof authors === "string") {
      authors = authors.split(/\s*[,;]\s*/);
      R.info("AUTHORS_SPLIT", path + ".authors", "Авторы переданы строкой — разделены по запятым");
    }
    if (authors != null && !Array.isArray(authors)) { R.error("BAD_AUTHORS", path + ".authors", "authors должен быть массивом строк"); authors = []; }
    if (authors && authors.length) it.authors = authors.map(normPersonString).filter(Boolean);
    if (clean(s.speaker)) it.speaker = normPersonString(s.speaker);

    if (s.format != null && clean(s.format)) {
      const f = FORMAT_ALIASES[clean(s.format).toLowerCase()];
      if (f) it.format = f;
      else R.warn("UNKNOWN_FORMAT", path + ".format", `Неизвестная форма «${clean(s.format)}» — допустимы oral, online, poster`);
    }
    if (clean(s.org)) it.org = clean(s.org);
    if (clean(s.city)) it.city = cleanCity(s.city);
    if (clean(s.room)) it.room = clean(s.room);
    if (clean(s.note)) it.note = clean(s.note);
    it.competitive = s.competitive == null ? type === "talk" : !!s.competitive;
    if (s.all_day) it.all_day = true;

    // Время: вычисленный start (anchor === false) при повторной нормализации не считается якорем
    const computed = s.anchor === false;
    it._start = null; it._end = null; it._duration = null;
    if (s.start != null && s.start !== "" && !computed) {
      const t = normTime(s.start);
      if (!t) R.error("BAD_TIME", path + ".start", `Неверное время «${clean(s.start)}», нужен формат ЧЧ:ММ`);
      else { if (t !== clean(s.start)) R.info("TIME_FORMAT_FIXED", path + ".start", `Время «${clean(s.start)}» приведено к ${t}`); it._start = toMin(t); }
    }
    if (s.end != null && s.end !== "" && !computed) {
      const t = normTime(s.end);
      if (!t) R.error("BAD_TIME", path + ".end", `Неверное время «${clean(s.end)}», нужен формат ЧЧ:ММ`);
      else { if (t !== clean(s.end)) R.info("TIME_FORMAT_FIXED", path + ".end", `Время «${clean(s.end)}» приведено к ${t}`); it._end = toMin(t); }
    }
    if (s.duration != null && s.duration !== "") {
      const d = +s.duration;
      if (Number.isInteger(d) && d >= 1 && d <= 1440) it._duration = d;
      else R.error("BAD_DURATION", path + ".duration", "duration — целое число минут от 1 до 1440");
    }

    const known = KEYS.item.concat(["time"]);
    moveUnknown(src, known, it, path, R);
    return it;
  }

  function normSession(src, path, R) {
    if (!isObj(src)) { R.error("BAD_SESSION", path, "Заседание должно быть объектом"); return null; }
    const se = { title: clean(src.title) };
    if (clean(src.room)) se.room = clean(src.room);
    ["start", "end"].forEach(k => {
      if (src[k] == null || src[k] === "") return;
      const t = normTime(src[k]);
      if (!t) R.error("BAD_TIME", path + "." + k, `Неверное время «${clean(src[k])}», нужен формат ЧЧ:ММ`);
      else { if (t !== clean(src[k])) R.info("TIME_FORMAT_FIXED", path + "." + k, `Время «${clean(src[k])}» приведено к ${t}`); se[k] = t; }
    });
    ["chair", "cochair", "secretary"].forEach(k => { if (clean(src[k])) se[k] = normPersonString(src[k]); });
    if (!Array.isArray(src.items)) {
      R.error("MISSING_ITEMS", path + ".items", "У заседания нет массива items");
      se.items = [];
    } else {
      se.items = src.items.map((x, k) => normItem(x, path + ".items[" + k + "]", R)).filter(Boolean);
      if (!se.items.length) R.warn("EMPTY_SESSION", path, `Заседание «${se.title || "без названия"}» пустое`);
    }
    moveUnknown(src, KEYS.session, se, path, R);
    return se;
  }

  function normDay(src, path, R) {
    if (!isObj(src)) { R.error("BAD_DAY", path, "День должен быть объектом { date, sessions }"); return null; }
    const day = { date: normDate(src.date) };
    if (!day.date) R.error("BAD_DATE", path + ".date", `Неверная или пустая дата дня «${clean(src.date)}»`);
    else if (day.date !== clean(src.date)) R.info("DATE_FORMAT_FIXED", path + ".date", `Дата «${clean(src.date)}» приведена к виду ${day.date}`);
    if (clean(src.title)) day.title = clean(src.title);
    let sessions = src.sessions;
    if (!Array.isArray(sessions) && Array.isArray(src.items)) {
      sessions = [{ items: src.items }];
      R.info("ITEMS_WRAPPED", path, "У дня нет sessions — элементы объединены в одно заседание");
    }
    if (!Array.isArray(sessions)) { R.error("MISSING_SESSIONS", path + ".sessions", "У дня нет массива sessions"); sessions = []; }
    day.sessions = sessions.map((s, k) => normSession(s, path + ".sessions[" + k + "]", R)).filter(Boolean);
    moveUnknown(src, KEYS.day.concat(["items"]), day, path, R);
    return day;
  }

  /* ---------------- коды, время, перекрёстные проверки ---------------- */

  function eachItem(doc, fn) {
    doc.days.forEach((d, di) => d.sessions.forEach((s, si) => s.items.forEach((it, ii) =>
      fn(it, "days[" + di + "].sessions[" + si + "].items[" + ii + "]", s, d))));
  }

  const label = it => (it.code ? it.code + " " : "") + "«" + short(it.title || it.type) + "»";

  // Коды: доклады — s<секция>-<n> (как ID в jury-score), пленарные — p<n>, прочее — x<n>
  function assignCodes(doc, R) {
    const used = {};
    eachItem(doc, (it, p) => {
      if (!it.code) return;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(it.code)) {
        R.error("BAD_CODE", p + ".code", `Код «${it.code}»: только латиница, цифры, «.», «_», «-», до 32 символов`);
      } else if (used[it.code]) {
        R.error("DUPLICATE_CODE", p + ".code", `Код «${it.code}» уже занят элементом ${used[it.code]}`);
      }
      used[it.code] = used[it.code] || p;
    });
    const counters = {};
    const next = prefix => {
      let n = counters[prefix] || 0, code;
      do { n++; code = prefix + n; } while (used[code]);
      counters[prefix] = n;
      used[code] = true;
      return code;
    };
    eachItem(doc, it => {
      if (it.code) return;
      it.code = it.type === "talk" && it.section ? next("s" + it.section + "-")
        : it.type === "plenary" ? next("p") : next("x");
    });
  }

  function defaultDuration(type, regs) {
    return type === "talk" ? regs.talk_min : type === "plenary" ? regs.plenary_min
      : type === "break" ? regs.break_min : type === "lunch" ? regs.lunch_min : regs.other_min;
  }

  function computeTimes(doc, R) {
    const regs = doc.event.regulations;
    doc.days.forEach((d, di) => {
      // конец последнего заседания дня по залам: заседание без start продолжает предыдущее в том же зале
      const endByRoom = {};
      let lastEnd = null;
      d.sessions.forEach((s, si) => {
        const sp = "days[" + di + "].sessions[" + si + "]";
        let cursor = s.start ? toMin(s.start) : null;
        let first = null;
        if (cursor == null && s.items.length && s.items[0]._start == null && !s.items[0].all_day) {
          const prev = s.room ? endByRoom[roomKey(s.room)] : lastEnd;
          if (prev != null) {
            cursor = prev;
            R.info("SESSION_CHAINED", sp + ".start", `Заседание «${s.title || "без названия"}» без времени начала — продолжает предыдущее${s.room ? " в зале " + s.room : ""} с ${fromMin(prev)}`);
          }
        }
        s.items.forEach((it, ii) => {
          const p = sp + ".items[" + ii + "]";
          const anchor = it._start, end = it._end, dur0 = it._duration;
          delete it._start; delete it._end; delete it._duration;
          delete it.start; delete it.end; delete it.duration; delete it.anchor;
          if (it.all_day) return;

          let start;
          if (anchor != null) {
            if (cursor != null && anchor < cursor) {
              R.error("TIME_OVERLAP", p + ".start", `${label(it)} начинается в ${fromMin(anchor)}, а предыдущий элемент заканчивается в ${fromMin(cursor)}`, { item: it.code });
            } else if (cursor != null && anchor > cursor && ii > 0) {
              R.info("GAP", p + ".start", `Пауза ${anchor - cursor} мин перед ${label(it)}`, { item: it.code });
            }
            start = anchor;
          } else if (cursor != null) {
            start = cursor;
          } else {
            R.error("NO_START", p, `${label(it)}: не задано время начала — укажите start у заседания или у первого элемента`, { item: it.code });
            return;
          }

          let dur;
          if (end != null) {
            dur = end - start;
            if (dur <= 0) {
              R.error("TIME_BACKWARDS", p + ".end", `${label(it)}: окончание ${fromMin(end)} не позже начала ${fromMin(start)}`, { item: it.code });
              dur = dur0 || defaultDuration(it.type, regs);
            } else if (dur0 && dur0 !== dur) {
              R.warn("DURATION_MISMATCH", p + ".duration", `${label(it)}: duration ${dur0} мин не совпадает с ${fromMin(start)}–${fromMin(end)} — взято время окончания`, { item: it.code });
            }
          } else if (dur0) {
            dur = dur0;
          } else {
            dur = defaultDuration(it.type, regs);
            if (it.type === "activity" || it.type === "ceremony") {
              R.warn("DEFAULT_DURATION", p + ".duration", `${label(it)}: длительность не указана — взято ${dur} мин`, { item: it.code });
            }
          }
          if (start + dur > 24 * 60) {
            R.error("PAST_MIDNIGHT", p, `${label(it)} заканчивается после полуночи`, { item: it.code });
            dur = Math.max(1, 24 * 60 - start);
          }
          it.start = fromMin(start);
          it.end = fromMin(start + dur);
          it.duration = dur;
          it.anchor = anchor != null;
          if (first == null) first = start;
          cursor = start + dur;
        });
        if (!s.start && first != null) s.start = fromMin(first);
        if (s.end && cursor != null && cursor > toMin(s.end)) {
          R.warn("SESSION_OVERRUN", sp + ".end", `Заседание «${s.title || "без названия"}» должно закончиться в ${s.end}, а последний элемент заканчивается в ${fromMin(cursor)}`);
        }
        if (cursor != null) {
          lastEnd = cursor;
          if (s.room) endByRoom[roomKey(s.room)] = cursor;
        }
      });
    });
  }

  function crossChecks(doc, R) {
    const sections = {};
    doc.sections.forEach(s => { sections[s.no] = s; });

    // разделы, на которые ссылаются доклады, но которых нет в списке
    eachItem(doc, (it, p) => {
      if (it.section && !sections[it.section]) {
        sections[it.section] = { no: it.section, title: "Секция " + it.section };
        doc.sections.push(sections[it.section]);
        R.warn("SECTION_AUTO", p + ".section", `Секции ${it.section} нет в списке sections — создана «Секция ${it.section}» без названия`);
      }
      if ((it.type === "talk" || it.type === "plenary") && !it.title) {
        R.error("MISSING_TITLE", p + ".title", `У доклада ${it.code} нет названия`, { item: it.code });
      }
      if (it.type === "talk" && !it.speaker) {
        R.warn("MISSING_SPEAKER", p + ".speaker", `У доклада ${label(it)} не указан докладчик`, { item: it.code });
      }
      if (it.speaker && it.authors && it.authors.length &&
        !it.authors.some(a => personKey(a) === personKey(it.speaker))) {
        R.warn("SPEAKER_NOT_IN_AUTHORS", p + ".speaker", `Докладчик ${parsePerson(it.speaker).name} не входит в список авторов ${label(it)}`, { item: it.code });
      }
      if (it.type === "talk" && doc.sections.length && !it.section) {
        R.warn("NO_SECTION", p + ".section", `Доклад ${label(it)} не отнесён ни к одной секции`, { item: it.code });
      }
    });
    doc.sections.sort((a, b) => a.no - b.no);

    // повторяющиеся доклады
    const titles = {};
    eachItem(doc, (it, p) => {
      if (it.type !== "talk" || !it.title) return;
      const k = titleKey(it.title);
      if (titles[k]) R.warn("DUPLICATE_TALK", p + ".title", `Доклад ${label(it)} повторяет ${titles[k]}`, { item: it.code });
      else titles[k] = it.code;
    });

    // дни: дубли, порядок, выход за даты мероприятия
    const seen = {};
    doc.days.forEach((d, di) => {
      if (!d.date) return;
      if (seen[d.date]) R.error("DUPLICATE_DAY", "days[" + di + "].date", `День ${d.date} указан дважды`);
      seen[d.date] = true;
      const ev = doc.event;
      if ((ev.date_from && d.date < ev.date_from) || (ev.date_to && d.date > ev.date_to)) {
        R.warn("DAY_OUT_OF_RANGE", "days[" + di + "].date", `День ${d.date} вне дат мероприятия ${ev.date_from}…${ev.date_to}`);
      }
      d.sessions.forEach((s, si) => {
        // обеду и перерыву зал не обязателен
        if (!s.room && s.items.some(it => !it.room && !it.all_day && it.type !== "lunch" && it.type !== "break")) {
          R.warn("NO_ROOM", "days[" + di + "].sessions[" + si + "].room", `У заседания «${s.title || "без названия"}» не указан зал`);
        }
      });
    });

    // залы и докладчики: пересечения по времени в один день между разными заседаниями
    doc.days.forEach((d, di) => {
      const slots = [];
      d.sessions.forEach((s, si) => s.items.forEach((it, ii) => {
        if (!it.start) return;
        slots.push({ it: it, si: si, path: "days[" + di + "].sessions[" + si + "].items[" + ii + "]",
          room: it.room || s.room || "", a: toMin(it.start), b: toMin(it.end) });
      }));
      for (let x = 0; x < slots.length; x++) {
        for (let y = x + 1; y < slots.length; y++) {
          const A = slots[x], B = slots[y];
          if (!(A.a < B.b && B.a < A.b)) continue;
          const when = it => it.start + "–" + it.end;
          if (A.si !== B.si && A.room && roomKey(A.room) === roomKey(B.room)) {
            R.error("ROOM_OVERLAP", B.path, `Зал «${B.room}» занят: ${label(B.it)} (${when(B.it)}) пересекается с ${label(A.it)} (${when(A.it)})`, { item: B.it.code, with: A.it.code });
          }
          const people = it => [it.speaker].filter(Boolean).map(personKey);
          const pa = people(A.it), pb = people(B.it);
          const clash = pa.filter(k => pb.indexOf(k) >= 0);
          if (clash.length) {
            R.error("SPEAKER_CLASH", B.path, `${parsePerson(B.it.speaker).name} выступает одновременно: ${label(A.it)} (${when(A.it)}) и ${label(B.it)} (${when(B.it)})`, { item: B.it.code, with: A.it.code });
          }
        }
      }
    });
  }

  function collectRooms(src, doc, R) {
    const rooms = [], keys = {};
    const add = (name, building, extra) => {
      const k = roomKey(name);
      if (!k || keys[k]) return;
      keys[k] = true;
      const r = { name: clean(name) };
      if (clean(building)) r.building = clean(building);
      if (extra) r.extra = extra;
      rooms.push(r);
    };
    if (Array.isArray(src)) {
      src.forEach((r, i) => {
        if (typeof r === "string") add(r);
        else if (isObj(r) && clean(r.name)) {
          const out = {};
          moveUnknown(r, KEYS.room, out, "rooms[" + i + "]", R);
          add(r.name, r.building, out.extra);
        } else R.error("BAD_ROOM", "rooms[" + i + "]", "Зал должен быть строкой или объектом { name }");
      });
    }
    doc.days.forEach(d => d.sessions.forEach(s => {
      if (s.room) add(s.room);
      s.items.forEach(it => { if (it.room) add(it.room); });
    }));
    return rooms;
  }

  // Предупреждение «данные вне схемы»: по нему видно, каких полей не хватает на практике
  function reportExtra(doc, R) {
    const note = (obj, path) => {
      if (obj && obj.extra && Object.keys(obj.extra).length) {
        R.warn("EXTRA_USED", path + ".extra", `Данные вне схемы: ${Object.keys(obj.extra).join(", ")}`, { fields: Object.keys(obj.extra) });
      }
    };
    note(doc.event, "event");
    doc.sections.forEach((s, i) => note(s, "sections[" + i + "]"));
    doc.rooms.forEach((r, i) => note(r, "rooms[" + i + "]"));
    doc.days.forEach((d, di) => {
      note(d, "days[" + di + "]");
      d.sessions.forEach((s, si) => {
        note(s, "days[" + di + "].sessions[" + si + "]");
        s.items.forEach((it, ii) => note(it, "days[" + di + "].sessions[" + si + "].items[" + ii + "]"));
      });
    });
  }

  /* ---------------- главная функция ---------------- */

  /**
   * Нормализует документ программы и проверяет его.
   * input — объект или JSON-строка. Возвращает { doc, report }:
   * doc — программа с рассчитанными start/end/duration у каждого элемента
   * (anchor: true — время задано явно), report — { ok, errors, warnings, info, stats }.
   * Повторная нормализация корректного doc даёт тот же doc.
   * Если report.ok === false, doc — лишь попытка починки (например, время «наоборот»
   * заменено длительностью по регламенту): показывать можно, сохранять нельзя.
   */
  function normalize(input) {
    const R = new Report();
    if (typeof input === "string") {
      try { input = JSON.parse(input); } catch (e) {
        R.error("BAD_JSON", "", "Не удалось разобрать JSON: " + e.message);
        return { doc: null, report: R.out(null) };
      }
    }
    if (!isObj(input)) {
      R.error("SCHEMA_ROOT", "", "Ожидается JSON-объект программы { schema, event, sections, days }");
      return { doc: null, report: R.out(null) };
    }
    if (input.schema != null && input.schema !== SCHEMA_ID) {
      R.warn("SCHEMA_VERSION", "schema", `Неизвестная версия схемы «${clean(input.schema)}» — обработано как ${SCHEMA_ID}`);
    }
    const daysSrc = Array.isArray(input.days) ? input.days : [];
    if (!Array.isArray(input.days)) R.error("MISSING_DAYS", "days", "Нет массива days с днями программы");

    const doc = { schema: SCHEMA_ID };
    doc.event = normEvent(input.event, R, daysSrc);
    // незнакомые поля верхнего уровня — в event.extra
    const rootExtra = {};
    Object.keys(input).forEach(k => { if (KEYS.root.indexOf(k) < 0) rootExtra[k] = clone(input[k]); });
    if (Object.keys(rootExtra).length) {
      doc.event.extra = assign(doc.event.extra || {}, rootExtra);
      R.warn("UNKNOWN_FIELD", "", `Поля ${Object.keys(rootExtra).map(k => "«" + k + "»").join(", ")} не входят в схему — сохранены в event.extra`, { fields: Object.keys(rootExtra) });
    }
    doc.sections = normSections(input.sections, R);
    doc.days = daysSrc.map((d, i) => normDay(d, "days[" + i + "]", R)).filter(Boolean);
    if (!doc.days.length && Array.isArray(input.days)) R.error("NO_DAYS", "days", "В программе нет ни одного дня");

    assignCodes(doc, R);
    computeTimes(doc, R);
    crossChecks(doc, R);
    doc.rooms = collectRooms(input.rooms, doc, R);
    reportExtra(doc, R);

    // порядок ключей как в схеме — удобнее читать и сравнивать
    const out = { schema: doc.schema, event: doc.event, rooms: doc.rooms, sections: doc.sections, days: doc.days };
    return { doc: out, report: R.out(out) };
  }

  const TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh", "з": "z", "и": "i", "й": "y",
    "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f",
    "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
  };

  /** Адрес мероприятия из названия: «Школа РРВ 2026» → «shkola-rrv-2026». Пустая строка, если букв нет. */
  function slugify(s, maxLen) {
    const out = clean(s).toLowerCase().split("").map(ch => (has(TRANSLIT, ch) ? TRANSLIT[ch] : ch)).join("")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const max = maxLen || 48;
    if (out.length <= max) return out;
    // обрезка по границе слова, если она есть
    const cut = out.slice(0, max + 1), dash = cut.lastIndexOf("-");
    return (dash > 0 ? cut.slice(0, dash) : out.slice(0, max)).replace(/-+$/, "");
  }

  /* ---------------- документ ↔ строки БД ---------------- */

  // Поля строк по коллекциям PocketBase (порядок и состав — как в pb/pb_migrations)
  const ROW_FIELDS = {
    room: ["name", "building", "extra"],
    section: ["no", "title", "short", "extra"],
    day: ["date", "title", "extra"],
    session: ["title", "room", "start", "end", "chair", "cochair", "secretary", "extra"],
    item: ["type", "code", "section", "title", "authors", "speaker", "format", "org", "city", "room", "note",
      "competitive", "all_day", "start", "end", "duration", "anchor", "extra"],
  };

  function pick(src, fields, base) {
    const out = base || {};
    fields.forEach(k => { if (src[k] !== undefined) out[k] = clone(src[k]); });
    return out;
  }

  /**
   * Разбирает нормализованный документ на строки коллекций rooms, sections, days,
   * sessions, items. Связи — локальные ключи: sessions[].day → days[].key,
   * items[].session → sessions[].key. Порядок — поле sort.
   * Вызывать только для документа с report.ok === true.
   */
  function fromDocument(doc) {
    const rows = { event: clone(doc.event), rooms: [], sections: [], days: [], sessions: [], items: [] };
    (doc.rooms || []).forEach((r, i) => rows.rooms.push(pick(r, ROW_FIELDS.room, { sort: i })));
    (doc.sections || []).forEach((s, i) => rows.sections.push(pick(s, ROW_FIELDS.section, { sort: i })));
    doc.days.forEach((d, di) => {
      const dk = "d" + di;
      rows.days.push(pick(d, ROW_FIELDS.day, { key: dk, sort: di }));
      d.sessions.forEach((s, si) => {
        const sk = dk + ".s" + si;
        rows.sessions.push(pick(s, ROW_FIELDS.session, { key: sk, day: dk, sort: si }));
        s.items.forEach((it, ii) => rows.items.push(pick(it, ROW_FIELDS.item, { session: sk, sort: ii })));
      });
    });
    return rows;
  }

  // Значения по умолчанию из БД («», 0, false, null, {}) считаются отсутствующими
  const empty = v => v == null || v === "" || (Array.isArray(v) && !v.length) || (isObj(v) && !Object.keys(v).length);
  const bySort = list => list.map((r, i) => ({ r: r, i: i }))
    .sort((a, b) => ((+a.r.sort || 0) - (+b.r.sort || 0)) || (a.i - b.i)).map(x => x.r);
  const rowId = r => r.id || r.key;

  function copyFilled(src, fields, out, always) {
    fields.forEach(k => {
      const v = src[k];
      if ((always || []).indexOf(k) >= 0) out[k] = v == null ? "" : clone(v);
      else if (!empty(v) && v !== false && v !== 0) out[k] = clone(v);
    });
    return out;
  }

  /**
   * Собирает документ conf.program/v1 из строк (обратное к fromDocument).
   * Принимает и строки из PocketBase: связи по id или key, пустые значения
   * полей («», 0, false, null) считаются отсутствующими, лишние поля строк
   * (id, event, created…) игнорируются.
   */
  function toDocument(rows) {
    const doc = { schema: SCHEMA_ID, event: clone(rows.event) || {}, rooms: [], sections: [], days: [] };
    bySort(rows.rooms || []).forEach(r => doc.rooms.push(copyFilled(r, ROW_FIELDS.room, {}, ["name"])));
    bySort(rows.sections || []).forEach(s => {
      doc.sections.push(copyFilled(s, ["short", "extra"], { no: +s.no, title: s.title || "" }));
    });
    const sessionsByDay = {}, itemsBySession = {};
    bySort(rows.sessions || []).forEach(s => { (sessionsByDay[s.day] = sessionsByDay[s.day] || []).push(s); });
    bySort(rows.items || []).forEach(it => { (itemsBySession[it.session] = itemsBySession[it.session] || []).push(it); });
    bySort(rows.days || []).forEach(d => {
      const day = copyFilled(d, ["date", "title"], {}, ["date"]);
      day.sessions = (sessionsByDay[rowId(d)] || []).map(s => {
        const se = copyFilled(s, ["title", "room", "start", "end", "chair", "cochair", "secretary"], {}, ["title"]);
        se.items = (itemsBySession[rowId(s)] || []).map(it => {
          const out = copyFilled(it, ROW_FIELDS.item.filter(k => ["competitive", "anchor", "extra"].indexOf(k) < 0), {}, ["type", "title"]);
          out.competitive = !!it.competitive;
          if (!it.all_day && out.start) out.anchor = !!it.anchor;
          else if (it.all_day) { delete out.start; delete out.end; delete out.duration; }
          if (!empty(it.extra)) out.extra = clone(it.extra);
          return out;
        });
        if (!empty(s.extra)) se.extra = clone(s.extra);
        return se;
      });
      if (!empty(d.extra)) day.extra = clone(d.extra);
      doc.days.push(day);
    });
    return doc;
  }

  return {
    SCHEMA_ID: SCHEMA_ID,
    ITEM_TYPES: ITEM_TYPES,
    FORMATS: FORMATS,
    DEFAULT_REGULATIONS: DEFAULT_REGULATIONS,
    ROW_FIELDS: ROW_FIELDS,
    normalize: normalize,
    fromDocument: fromDocument,
    toDocument: toDocument,
    slugify: slugify,
    normTime: normTime,
    normDate: normDate,
    parsePerson: parsePerson,
    personKey: personKey,
    roomKey: roomKey,
    toMin: toMin,
    fromMin: fromMin,
  };
});
