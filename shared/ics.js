/* conf-kit · shared/ics.js
 *
 * Программа conf.program/v1 → календарь iCalendar (RFC 5545).
 * Работает в goja (pb_hooks: подписка /api/v1/events/{id}/program.ics), в Node и в браузере
 * (один доклад «в календарь»). Синтаксис ES2015, как в model.js.
 *
 * Время переводится в UTC по часовому поясу мероприятия. В России нет перехода на летнее время,
 * поэтому достаточно таблицы смещений; для незнакомого пояса время пишется «плавающим» (без Z).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ConfIcs = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // смещение от UTC в минутах; без летнего времени
  const TZ_OFFSETS = {
    "UTC": 0, "Europe/Kaliningrad": 120, "Europe/Moscow": 180, "Europe/Simferopol": 180, "Europe/Volgograd": 180,
    "Europe/Kirov": 180, "Europe/Minsk": 180, "Europe/Samara": 240, "Europe/Ulyanovsk": 240, "Europe/Astrakhan": 240,
    "Europe/Saratov": 240, "Asia/Yekaterinburg": 300, "Asia/Tashkent": 300, "Asia/Almaty": 300, "Asia/Omsk": 360,
    "Asia/Novosibirsk": 420, "Asia/Barnaul": 420, "Asia/Tomsk": 420, "Asia/Novokuznetsk": 420, "Asia/Krasnoyarsk": 420,
    "Asia/Irkutsk": 480, "Asia/Chita": 540, "Asia/Yakutsk": 540, "Asia/Khandyga": 540, "Asia/Vladivostok": 600,
    "Asia/Ust-Nera": 600, "Asia/Sakhalin": 660, "Asia/Magadan": 660, "Asia/Srednekolymsk": 660,
    "Asia/Kamchatka": 720, "Asia/Anadyr": 720,
  };

  const pad = n => (n < 10 ? "0" : "") + n;
  const TYPE_LABEL = { plenary: "Пленарный доклад", break: "Перерыв", lunch: "Обед", ceremony: "Церемония", activity: "" };

  /** «2026-10-07» + «09:00» в поясе tz → «20261007T060000Z» (или «20261007T090000» для незнакомого пояса). */
  function stamp(date, time, tz) {
    const p = String(date).split("-").map(Number);
    const t = String(time || "00:00").split(":").map(Number);
    const off = TZ_OFFSETS[tz];
    if (off == null) return p[0] + pad(p[1]) + pad(p[2]) + "T" + pad(t[0]) + pad(t[1]) + "00";
    const d = new Date(Date.UTC(p[0], p[1] - 1, p[2], t[0], t[1]) - off * 60000);
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + "00Z";
  }

  function utcNow(now) {
    const d = now ? new Date(now) : new Date();
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + "Z";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  }

  const utf8len = ch => { const c = ch.charCodeAt(0); return c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xdc00 ? 4 : c >= 0xdc00 && c < 0xe000 ? 0 : 3; };

  /** Строки длиннее 75 байт переносятся (RFC 5545, 3.1), не разрывая символы UTF-8. */
  function fold(line) {
    let out = "", n = 0;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const b = utf8len(ch);
      if (n + b > 74) { out += "\r\n "; n = 1; }
      out += ch;
      n += b;
    }
    return out;
  }

  function people(it) {
    const list = it.authors && it.authors.length ? it.authors : it.speaker ? [it.speaker] : [];
    return list.join(", ");
  }

  function itemLine(it) {
    const who = people(it);
    return (it.all_day ? "" : it.start + " ") + it.title + (who ? " — " + who : "");
  }

  function event(lines, f) {
    lines.push("BEGIN:VEVENT");
    lines.push("UID:" + f.uid);
    lines.push("DTSTAMP:" + f.dtstamp);
    if (f.allDay) {
      lines.push("DTSTART;VALUE=DATE:" + f.date.replace(/-/g, ""));
    } else {
      lines.push("DTSTART:" + stamp(f.date, f.start, f.tz));
      lines.push("DTEND:" + stamp(f.date, f.end, f.tz));
    }
    lines.push("SUMMARY:" + esc(f.summary));
    if (f.location) lines.push("LOCATION:" + esc(f.location));
    if (f.description) lines.push("DESCRIPTION:" + esc(f.description));
    if (f.url) lines.push("URL:" + f.url);
    lines.push("END:VEVENT");
  }

  /**
   * opts: { mode: "sessions" (по умолчанию: заседание — одно событие со списком докладов в описании)
   *         | "items" (каждый элемент — событие), only: код элемента (одно событие), url, uid, now }
   */
  function toIcs(program, opts) {
    opts = opts || {};
    const ev = program.event || {};
    const tz = ev.timezone || "Europe/Moscow";
    const uid = (opts.uid || ev.title || "event").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40) || "event";
    const dtstamp = utcNow(opts.now);
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//conf-kit//conf.program/v1//RU", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "X-WR-CALNAME:" + esc(ev.title || "Программа"), "X-WR-TIMEZONE:" + tz];
    (program.days || []).forEach((d, di) => {
      (d.sessions || []).forEach((s, si) => {
        const items = s.items || [];
        const timed = items.filter(it => !it.all_day && it.start && it.end);
        if (opts.mode === "items" || opts.only) {
          items.forEach((it, ii) => {
            if (opts.only && it.code !== opts.only) return;
            if (!it.all_day && !(it.start && it.end)) return;
            const label = TYPE_LABEL[it.type];
            event(lines, {
              uid: uid + "-" + (it.code || di + "-" + si + "-" + ii) + "@conf-kit", dtstamp, tz, date: d.date, allDay: !!it.all_day,
              start: it.start, end: it.end,
              summary: (label && it.title.indexOf(label) < 0 && it.type !== "break" && it.type !== "lunch" ? label + ": " : "") + it.title,
              location: it.room || s.room || ev.venue || "",
              description: [people(it), [it.org, it.city].filter(Boolean).join(", "), s.title, it.note].filter(Boolean).join("\n"),
              url: opts.url,
            });
          });
          return;
        }
        if (!timed.length) return;
        event(lines, {
          uid: uid + "-d" + di + "s" + si + "@conf-kit", dtstamp, tz, date: d.date,
          start: timed[0].start, end: timed[timed.length - 1].end,
          summary: (s.title || "Заседание") + (ev.title ? " · " + ev.title : ""),
          location: s.room || ev.venue || "",
          description: [s.chair ? "Председатель: " + s.chair : ""].concat(items.map(itemLine)).filter(Boolean).join("\n"),
          url: opts.url,
        });
      });
    });
    lines.push("END:VCALENDAR");
    return lines.map(fold).join("\r\n") + "\r\n";
  }

  return { TZ_OFFSETS: TZ_OFFSETS, toIcs: toIcs, stamp: stamp, fold: fold, esc: esc };
});
