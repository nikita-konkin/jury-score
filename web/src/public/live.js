// Публичная программа: «сейчас / далее», поиск и фильтры, обновления в реальном времени, копия на случай без связи.
import Ics from "../../../shared/ics.js";

const pad = n => (n < 10 ? "0" : "") + n;
const toMin = t => (t ? +t.slice(0, 2) * 60 + +t.slice(3, 5) : null);

/** Текущие дата и минуты в поясе мероприятия; незнакомый пояс — время устройства. */
export function nowIn(tz, at) {
  const ms = at == null ? Date.now() : +at;
  const off = Ics.TZ_OFFSETS[tz];
  if (off == null) {
    const d = new Date(ms);
    return { date: d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()), min: d.getHours() * 60 + d.getMinutes() };
  }
  const d = new Date(ms + off * 60000);
  return { date: d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** Индекс сегодняшнего дня программы или -1. */
export const todayIndex = (program, now) => program.days.findIndex(d => d.date === now.date);

/** Что идёт сейчас и что дальше (сегодня). До начала — сколько дней осталось. */
export function nowNext(program, now) {
  const days = program.days;
  if (!days.length) return null;
  if (now.date < days[0].date) {
    const a = Date.UTC.apply(null, now.date.split("-").map((x, i) => +x - (i === 1 ? 1 : 0)));
    const b = Date.UTC.apply(null, days[0].date.split("-").map((x, i) => +x - (i === 1 ? 1 : 0)));
    return { before: Math.round((b - a) / 864e5) };
  }
  const di = todayIndex(program, now);
  if (di < 0) return null;
  const cur = [], later = [];
  days[di].sessions.forEach((s, si) => s.items.forEach((it, ii) => {
    if (it.all_day || !it.start) return;
    const a = toMin(it.start), b = toMin(it.end);
    const x = { di, si, ii, item: it, session: s, room: it.room || s.room || "" };
    if (a <= now.min && now.min < b) cur.push(x);
    else if (a > now.min) later.push(x);
  }));
  later.sort((x, y) => toMin(x.item.start) - toMin(y.item.start));
  // «далее» — ближайший элемент и то, что начинается в других залах в пределах получаса от него
  const seen = {}, next = [];
  const first = later.length ? toMin(later[0].item.start) : 0;
  later.forEach(x => {
    if (seen[x.room] || next.length >= 4 || toMin(x.item.start) - first > 30) return;
    seen[x.room] = 1;
    next.push(x);
  });
  return { di, now: cur, next, over: !cur.length && !later.length };
}

/** Состояние элемента относительно текущего времени: "past" | "now" | "". */
export function itemState(day, it, now) {
  if (!now || day.date !== now.date || it.all_day || !it.start) return "";
  const a = toMin(it.start), b = toMin(it.end);
  return now.min >= b ? "past" : now.min >= a ? "now" : "";
}

const norm = s => String(s || "").toLowerCase().replace(/ё/g, "е");

/** Поиск по всем дням: каждое слово запроса должно найтись в названии, людях, организации или коде. */
export function searchItems(program, q, f) {
  f = f || {};
  const words = norm(q).split(/[\s,]+/).filter(Boolean);
  const out = [];
  program.days.forEach((d, di) => d.sessions.forEach((s, si) => s.items.forEach((it, ii) => {
    if (f.section && it.section !== +f.section) return;
    if (f.format && it.format !== f.format) return;
    if (f.room && (it.room || s.room) !== f.room) return;
    if (words.length) {
      const hay = norm([it.title, it.speaker, (it.authors || []).join(" "), it.org, it.city, it.code, s.chair, s.title].join(" "));
      if (!words.every(w => hay.indexOf(w) >= 0)) return;
    }
    out.push({ di, si, ii, day: d, session: s, item: it });
  })));
  return out;
}

/** Залы и формы участия, которые есть в программе, — для фильтров. */
export function facets(program) {
  const rooms = {}, formats = {};
  program.days.forEach(d => d.sessions.forEach(s => s.items.forEach(it => {
    const r = it.room || s.room;
    if (r) rooms[r] = 1;
    if (it.format) formats[it.format] = 1;
  })));
  return { rooms: Object.keys(rooms), formats: Object.keys(formats) };
}

/* ---------------- копия программы без связи ---------------- */

const CACHE = "conf_prog_";
const CACHE_MAX = 5;

export function readCache(key) {
  try { return JSON.parse(localStorage.getItem(CACHE + key) || "null"); } catch (e) { return null; }
}

export function writeCache(key, data) {
  try {
    localStorage.setItem(CACHE + key, JSON.stringify({ at: Date.now(), data }));
    // старые копии — вон, чтобы не занять всё место
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(CACHE) === 0) keys.push(k);
    }
    if (keys.length > CACHE_MAX) {
      keys.map(k => [k, (readCache(k.slice(CACHE.length)) || {}).at || 0]).sort((a, b) => a[1] - b[1])
        .slice(0, keys.length - CACHE_MAX).forEach(([k]) => localStorage.removeItem(k));
    }
  } catch (e) { /* нет места или приватный режим */ }
}

/* ---------------- обновления ---------------- */

/**
 * Следит за мероприятием: realtime PocketBase (SSE), а без него или при сбоях — опрос раз в минуту
 * и при возвращении на вкладку. onChange(record) вызывается, когда сменилась версия или статус.
 */
export function watchEvent(id, record, onChange, opts) {
  opts = opts || {};
  let last = { version: record.version, status: record.status };
  let es = null, timer = null, fails = 0, stopped = false;
  const changed = r => {
    if (stopped || !r || (r.version === last.version && r.status === last.status)) return;
    last = { version: r.version, status: r.status };
    onChange(r);
  };
  const poll = () => {
    fetch(`/api/collections/events/records/${id}?fields=version,status`).then(r => (r.status === 200 ? r.json() : r.status === 404 ? { status: "gone" } : null))
      .then(changed, () => {});
  };
  const startPolling = () => { if (!timer) timer = setInterval(poll, opts.pollMs || 60000); };
  if (typeof EventSource === "function" && !opts.noRealtime) {
    es = new EventSource("/api/realtime");
    es.addEventListener("PB_CONNECT", e => {
      fails = 0;
      let clientId = "";
      try { clientId = JSON.parse(e.data).clientId; } catch (x) { return; }
      fetch("/api/realtime", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, subscriptions: ["events/" + id] }) }).catch(() => {});
    });
    es.addEventListener("events/" + id, e => {
      try {
        const m = JSON.parse(e.data);
        changed(m.action === "delete" ? { status: "gone" } : m.record);
      } catch (x) { /* битое сообщение */ }
    });
    es.onerror = () => {
      fails++;
      if (fails > 3 && es) { es.close(); es = null; startPolling(); }
    };
  } else startPolling();
  const onVisible = () => { if (!document.hidden) poll(); };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    stopped = true;
    if (es) es.close();
    if (timer) clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

