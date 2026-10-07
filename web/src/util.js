// Мелкие утилиты интерфейса.

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

/** «2026-10-07» → «7 октября, ср» */
export function dayLabel(iso, withWeekday) {
  const p = String(iso || "").split("-").map(Number);
  if (p.length !== 3 || !p[0]) return iso || "";
  const wd = WEEKDAYS[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()];
  return `${p[2]} ${MONTHS[p[1] - 1]}` + (withWeekday === false ? "" : `, ${wd}`);
}

export function weekday(iso) {
  const p = String(iso || "").split("-").map(Number);
  return p.length === 3 && p[0] ? WEEKDAYS[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()] : "";
}

/** Даты мероприятия: «7–9 октября 2026» */
export function dateRange(from, to) {
  if (!from) return "";
  const a = from.split("-").map(Number), b = (to || from).split("-").map(Number);
  if (from === (to || from)) return `${a[2]} ${MONTHS[a[1] - 1]} ${a[0]}`;
  if (a[0] === b[0] && a[1] === b[1]) return `${a[2]}–${b[2]} ${MONTHS[a[1] - 1]} ${a[0]}`;
  return `${a[2]} ${MONTHS[a[1] - 1]} – ${b[2]} ${MONTHS[b[1] - 1]} ${b[0]}`;
}

/** Дата-время PocketBase «2026-10-21 10:00:00.000Z» → «21 октября» */
export function shortDate(pb) {
  return pb ? dayLabel(String(pb).slice(0, 10), false) : "";
}

export function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  // запасной путь для старых браузеров и http
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } finally { document.body.removeChild(ta); }
  return Promise.resolve();
}

export function download(name, text, type) {
  const blob = new Blob([text], { type: type || "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 0);
}

/** JSON из ответа чат-бота: без <think> и ```-ограждений, от первой { до последней }. */
export function extractJson(text) {
  const t = String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  const body = fenced ? fenced[1] : t;
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  if (a < 0 || b < a) return { error: "В тексте не найден JSON — скопируйте ответ чат-бота целиком" };
  try { return { value: JSON.parse(body.slice(a, b + 1)) }; } catch (e) { return { error: "JSON с ошибкой: " + e.message }; }
}
