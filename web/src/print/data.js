// Данные печатных документов из программы conf.program/v1 — общие для HTML-печати и Word.
// Вид официальной программы повторяет программу RWP-2026: день «07.10.2026 [Среда]», «ЗАСЕДАНИЕ №1»,
// председатели, «Место», заголовки секций прописными, доклад — авторы, «время — название», «Докладчик (форма): …».

const WEEKDAYS = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const FORMAT = { oral: "устный", online: "онлайн", poster: "стендовый" };
const BREAK_TITLE = { break: "КОФЕ-БРЕЙК", lunch: "ОБЕДЕННЫЙ ПЕРЕРЫВ" };

const parts = iso => String(iso || "").split("-").map(Number);
const weekday = iso => { const p = parts(iso); return WEEKDAYS[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()]; };

/** «07.10.2026 [Среда]» */
export function dayHeading(iso) {
  const p = parts(iso);
  return `${p[2] < 10 ? "0" : ""}${p[2]}.${p[1] < 10 ? "0" : ""}${p[1]}.${p[0]} [${weekday(iso)}]`;
}

/** «7 октября 2026 г., среда» */
export function dayLong(iso) {
  const p = parts(iso);
  return `${p[2]} ${MONTHS[p[1] - 1]} ${p[0]} г., ${weekday(iso).toLowerCase()}`;
}

/** «7–9 октября 2026 г.» */
export function datesLine(from, to) {
  const a = parts(from), b = parts(to || from);
  if (!a[0]) return "";
  if (!to || to === from) return `${a[2]} ${MONTHS[a[1] - 1]} ${a[0]} г.`;
  if (a[0] === b[0] && a[1] === b[1]) return `${a[2]}–${b[2]} ${MONTHS[a[1] - 1]} ${a[0]} г.`;
  return `${a[2]} ${MONTHS[a[1] - 1]} – ${b[2]} ${MONTHS[b[1] - 1]} ${b[0]} г.`;
}

export const timeRange = it => (it.all_day ? "весь день" : it.start && it.end ? `${it.start} – ${it.end}` : it.start || "");
export const nameOnly = s => String(s || "").split(",")[0].trim();
const withCity = c => (c ? (/^г\./.test(c) ? c : "г. " + c) : "");

/** «Докладчик (онлайн): Е. С. Беленя, Организация, г. Город» */
export function speakerLine(it) {
  if (!it.speaker) return "";
  const fmt = FORMAT[it.format];
  return `Докладчик${fmt ? ` (${fmt})` : ""}: ` + [it.speaker, it.org, withCity(it.city)].filter(Boolean).join(", ");
}

/**
 * Программа для печати: дни → заседания → строки. Строка — { kind: "section" | "plenary-head" | "talk" | "break" | "event", … }.
 * Заголовок секции ставится, когда секция меняется внутри заседания.
 */
export function programRows(doc) {
  const sections = {};
  doc.sections.forEach(s => { sections[s.no] = s; });
  return doc.days.map(d => ({
    date: d.date, heading: dayHeading(d.date), title: d.title || "",
    sessions: d.sessions.map(s => {
      const rows = [];
      let sec = null, inPlenary = false;
      s.items.forEach(it => {
        if (it.type === "talk") {
          if (it.section && it.section !== sec && sections[it.section]) {
            rows.push({ kind: "section", text: `Секция ${it.section}. ${sections[it.section].title}` });
          }
          sec = it.section || sec;
          inPlenary = false;
          rows.push({ kind: "talk", item: it, time: timeRange(it), authors: (it.authors || []).join(", "), speaker: speakerLine(it) });
        } else if (it.type === "plenary") {
          if (!inPlenary) rows.push({ kind: "plenary-head", text: "Пленарные доклады" });
          inPlenary = true;
          sec = null;
          rows.push({ kind: "talk", item: it, time: timeRange(it), authors: (it.authors || []).join(", "), speaker: speakerLine(it) });
        } else {
          inPlenary = false;
          const title = BREAK_TITLE[it.type] && /брейк|перерыв|обед/i.test(it.title) ? BREAK_TITLE[it.type] : it.title;
          rows.push({ kind: BREAK_TITLE[it.type] ? "break" : "event", item: it, time: timeRange(it), text: title,
            place: it.room && it.room !== s.room ? it.room : "" });
        }
      });
      const timed = s.items.filter(it => !it.all_day && it.start);
      return {
        session: s, rows,
        place: [doc.event.venue, s.room].filter(Boolean).join(", "),
        time: timed.length ? `${timed[0].start} – ${timed[timed.length - 1].end}` : s.start || "",
      };
    }),
  }));
}

/** Протоколы: заседание × секция; строки — доклады этой секции в этом заседании. */
export function protocols(doc, dayFilter) {
  const sections = {};
  doc.sections.forEach(s => { sections[s.no] = s; });
  const out = [];
  doc.days.forEach((d, di) => {
    if (dayFilter != null && dayFilter !== "" && +dayFilter !== di) return;
    d.sessions.forEach(s => {
      const groups = [];
      s.items.forEach(it => {
        if (it.type !== "talk" && it.type !== "plenary") return;
        const key = it.type === "plenary" ? "p" : it.section || 0;
        let g = groups.find(x => x.key === key);
        if (!g) groups.push(g = { key, items: [] });
        g.items.push(it);
      });
      groups.forEach(g => out.push({
        day: d, session: s,
        title: g.key === "p" ? `пленарного заседания «${s.title || "Пленарное заседание"}»`
          : g.key && sections[g.key] ? `секции ${g.key} «${sections[g.key].title}»` : `«${s.title || "Заседание"}»`,
        place: [doc.event.venue, s.room].filter(Boolean).join(", "),
        chair: nameOnly(s.chair), secretary: nameOnly(s.secretary),
        rows: g.items.map((it, i) => ({
          no: i + 1, speaker: it.speaker || (it.authors || [])[0] || "", title: it.title,
          org: [it.org, withCity(it.city)].filter(Boolean).join(", "), format: FORMAT[it.format] || "", code: it.code || "",
        })),
      }));
    });
  });
  return out;
}

/** Таблички «на дверь»: по заседанию на страницу. */
export function doors(doc, dayFilter) {
  const out = [];
  doc.days.forEach((d, di) => {
    if (dayFilter != null && dayFilter !== "" && +dayFilter !== di) return;
    d.sessions.forEach(s => {
      const timed = s.items.filter(it => !it.all_day && it.start);
      out.push({
        day: d, session: s, room: s.room || doc.event.venue || "", dayText: dayLong(d.date),
        time: timed.length ? `${timed[0].start} – ${timed[timed.length - 1].end}` : s.start || "",
        rows: s.items.map(it => ({ time: it.all_day ? "" : it.start || "", who: it.speaker ? nameOnly(it.speaker) : "", title: it.title, type: it.type })),
      });
    });
  });
  return out;
}

/** Сертификаты участника: по докладу (и докладчику) на страницу. */
export function certificates(doc, dayFilter) {
  const out = [];
  doc.days.forEach((d, di) => {
    if (dayFilter != null && dayFilter !== "" && +dayFilter !== di) return;
    d.sessions.forEach(s => s.items.forEach(it => {
      if ((it.type === "talk" || it.type === "plenary") && it.speaker) out.push({ name: nameOnly(it.speaker), title: it.title, code: it.code || "" });
    }));
  });
  return out;
}
