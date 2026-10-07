// Программа conf.program/v1 → текст в духе официальной программы (материалы для замера ботов).
// Не повторяет нашу структуру JSON: бот должен сам разобрать заседания, время и докладчиков.
const FORMAT = { online: "онлайн", poster: "стендовый", oral: "" };
const DAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

function dateText(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const wd = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${d} ${MONTHS[m - 1]} ${y} г. (${wd})`;
}

export function renderText(doc) {
  const ev = doc.event;
  const lines = [];
  lines.push("ПРОГРАММА", ev.title + (ev.subtitle ? ". " + ev.subtitle : ""));
  lines.push([ev.venue, ev.city].filter(Boolean).join(", "));
  lines.push("");
  if (doc.sections.length) {
    lines.push("Секции:");
    doc.sections.forEach(s => lines.push(`  Секция ${s.no}. ${s.title}`));
    lines.push("");
  }
  doc.days.forEach(day => {
    lines.push(dateText(day.date).toUpperCase() + (day.title ? " — " + day.title : ""));
    day.sessions.forEach(s => {
      lines.push("");
      lines.push([s.title, s.room].filter(Boolean).join(", ") + (s.start ? `, начало в ${s.start}` : ""));
      if (s.chair) lines.push(`Председатель: ${s.chair}` + (s.cochair ? `; сопредседатель: ${s.cochair}` : ""));
      if (s.secretary) lines.push(`Секретарь: ${s.secretary}`);
      s.items.forEach(it => {
        const time = it.all_day ? "весь день" : `${it.start}–${it.end}`;
        if (it.type === "talk" || it.type === "plenary") {
          const authors = (it.authors && it.authors.length ? it.authors : [it.speaker]).filter(Boolean)
            .map(a => (a === it.speaker && it.authors && it.authors.length > 1 ? a + "*" : a)).join(", ");
          const fmt = FORMAT[it.format || "oral"];
          const place = [it.org, it.city].filter(Boolean).join(", ");
          const head = it.type === "plenary" ? "Пленарный доклад. " : it.section ? `[Секция ${it.section}] ` : "";
          lines.push(`${time}  ${head}${authors}. ${it.title}.` + (place ? ` (${place})` : "") + (fmt ? ` — ${fmt}` : ""));
        } else {
          lines.push(`${time}  ${it.title}` + (it.room && it.room !== s.room ? ` (${it.room})` : ""));
        }
        if (it.note) lines.push(`        Примечание: ${it.note}`);
      });
    });
    lines.push("");
  });
  lines.push("* — докладчик");
  return lines.join("\n");
}
