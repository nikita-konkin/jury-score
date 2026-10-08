// Заявки на доклады: выбор заседания для принятой заявки и выгрузка в CSV (Excel в русской Windows: «;», BOM).

export const STATUS = { new: "на рассмотрении", accepted: "принята", rejected: "отклонена", withdrawn: "отозвана" };
export const FORMAT = { oral: "очно", online: "онлайн", poster: "стендовый" };
const ddmm = iso => (iso ? iso.slice(8, 10) + "." + iso.slice(5, 7) : "");

/** Заседания программы для выбора; по умолчанию — последнее, где есть доклады той же секции. */
export function sessionChoices(doc, section) {
  const list = [];
  let def = -1;
  doc.days.forEach((d, di) => d.sessions.forEach((s, si) => {
    const secs = {};
    s.items.forEach(it => { if (it.type === "talk" && it.section) secs[it.section] = 1; });
    if (section && secs[section]) def = list.length;
    list.push({ day: di, session: si, label: [ddmm(d.date), s.start, s.title || "Заседание", s.room].filter(Boolean).join(" · ") +
      (Object.keys(secs).length ? " — секц. " + Object.keys(secs).join(", ") : "") });
  }));
  return { list, def: def < 0 ? 0 : def };
}

const q = v => { const s = String(v == null ? "" : v); return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export function applicationsCsv(apps) {
  const rows = [["№", "Статус", "Докладчик", "Авторы", "Доклад", "Секция", "Форма", "Организация", "Город", "E-mail", "Телефон", "Комментарий", "Подана", "Код в программе", "Причина отклонения"]];
  apps.forEach(a => rows.push([a.no, STATUS[a.status] || a.status, a.speaker, a.authors.join(", "), a.title, a.section || "", FORMAT[a.format] || a.format,
    a.org, a.city, a.email, a.phone, a.note, a.created.slice(0, 16), a.item_code, a.reason]));
  return "﻿" + rows.map(r => r.map(q).join(";")).join("\r\n") + "\r\n";
}
