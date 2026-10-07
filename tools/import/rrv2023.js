// Разовый конвертер: программа РРВ-2023 (docx → docx_grid.py JSON) → conf.program/v1.
// python tools/import/docx_grid.py <программа.docx> program.json
// python tools/import/docx_grid.py <список заявок.docx> apps.json
// node tools/import/rrv2023.js program.json apps.json fixtures/rrv-2023.program.json
"use strict";
const fs = require("fs");
const M = require("../../shared/model.js");
const [progPath, appsPath, outPath] = process.argv.slice(2);
const prog = JSON.parse(fs.readFileSync(progPath, "utf8"));
const apps = JSON.parse(fs.readFileSync(appsPath, "utf8"));
const log = [];

const clean = s => String(s || "").replace(/\s+/g, " ").trim();
const key = s => clean(s).toUpperCase().replace(/Ё/g, "Е").replace(/[^A-ZА-Я0-9]/g, "").slice(0, 60);

// --- секции и «название → секция» из списка заявок (контакты не используются)
const appSection = {};
const sectionTitles = {};
apps.filter(x => x.table).forEach(x => {
  const rows = x.table.rows;
  const h = rows[1] && rows[1].length === 1 ? clean(rows[1][0].paras.join(" ")) : "";
  const m = /^Секция\s+(\d+)\.\s*(.+)$/.exec(h);
  if (!m) return;
  sectionTitles[+m[1]] = m[2];
  rows.slice(2).forEach(r => { if (r.length >= 3) { const t = clean(r[2].paras.join(" ")); if (t) appSection[key(t)] = +m[1]; } });
});

function findSection(title) {
  const k = key(title);
  if (appSection[k]) return appSection[k];
  const probe = k.slice(0, 40);
  const hit = Object.keys(appSection).find(a => a.indexOf(probe) >= 0 || k.indexOf(a.slice(0, 40)) >= 0);
  return hit ? appSection[hit] : null;
}

// --- краткое содержание: конец и место общих событий по дате и началу
const MONTHS = { "мая": "05" };
const summary = {};
let sDate = null;
prog.filter(x => x.p).forEach(x => {
  const p = clean(x.p);
  let m = /^(\d{1,2}) (мая) (\d{4}) г\./.exec(p);
  if (m) { sDate = `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, "0")}`; summary[sDate] = summary[sDate] || {}; return; }
  m = /^(\d{1,2}[:.]\d{2})\s*[-–—]\s*(\d{1,2}[:.]\d{2})\s+(.+)$/.exec(p);
  if (m && sDate) {
    const place = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*\.?$/.exec(m[3]);
    summary[sDate][M.normTime(m[1])] = { end: M.normTime(m[2]), text: m[3], place: place ? clean(place[1]) : "" };
  }
});
const coffee = Object.keys(summary).map(d => Object.keys(summary[d]).map(t => summary[d][t]))
  .reduce((a, b) => a.concat(b), []).find(s => /кофе-брейк/i.test(s.text));
const COFFEE_ROOM = coffee ? coffee.place : "";

// --- разбор ячеек
const TIME = /^(\d{1,2}[:.]\d{2})\s*(?:[—–-]\s*(\d{1,2}[:.]\d{2}))?$/;
const cellText = c => clean(c.paras.join(" "));
const isTime = s => TIME.test(clean(s));
const times = s => { const m = TIME.exec(clean(s)); return { start: M.normTime(m[1]), end: m[2] ? M.normTime(m[2]) : null }; };

function parseTalk(paras) {
  const text = clean(paras.join(" "));
  const m = /^(.*?)\s*Докладчик(?:и)?\s*\(([^)]+)\)\s*:\s*(.+)$/.exec(text);
  const head = m ? m[1] : text;
  const words = head.split(" ");
  const caps = w => { const l = w.replace(/[^A-Za-zА-Яа-яЁё]/g, ""); return l.length >= 3 && l === l.toUpperCase(); };
  let k = -1;
  for (let i = 0; i < words.length && k < 0; i++) {
    if (!caps(words[i])) continue;
    const next = words.slice(i + 1).filter(w => w.replace(/[^A-Za-zА-Яа-яЁё]/g, "").length >= 3).slice(0, 3);
    if (next.every(caps)) k = i;
  }
  if (k < 0) { log.push("не найдено название: " + text.slice(0, 80)); k = 0; }
  const authors = words.slice(0, k).join(" ").replace(/[.\s]+$/, "").split(/\s*,\s*|\s+(?=[А-ЯЁA-Z]\.\s*[А-ЯЁA-Z]\.)/).filter(Boolean);
  const title = words.slice(k).join(" ").replace(/\.\s*$/, "");
  const it = { type: "talk", title: title, authors: authors };
  if (m) {
    it.format = { "устный": "oral", "онлайн": "online", "стендовый": "poster" }[clean(m[2]).toLowerCase()] || clean(m[2]);
    let rest = clean(m[3]).replace(/\.\s*$/, "");
    const city = /,\s*г\.\s*([^,]+)$/.exec(rest);
    if (city) { it.city = clean(city[1]); rest = rest.slice(0, city.index); }
    const nm = /^((?:[А-ЯЁA-Z]\.\s*){1,2}[А-ЯЁA-Z][а-яёa-z-]+)[.,]?\s*(.*)$/.exec(rest);
    const comma = rest.indexOf(",");
    it.speaker = nm ? nm[1] : comma < 0 ? rest : rest.slice(0, comma);
    const org = nm ? nm[2] : comma < 0 ? "" : rest.slice(comma + 1);
    if (clean(org)) it.org = clean(org);
  } else log.push("нет докладчика: " + text.slice(0, 80));
  return it;
}

// строки после «Председатель:» до следующей метки: «Ратовский Константин Геннадьевич,» + «к. ф.-м.н.»
function person(lines, i) {
  const out = [];
  for (let j = i + 1; j < lines.length && !/:$/.test(lines[j]) && !/^Секция\s/.test(lines[j]); j++) out.push(lines[j]);
  return clean(out.join(" ")).replace(/,\s*$/, "");
}

// залы ПГТУ: «ПГТУ, 1й корпус, ауд.403», «ПГТУ (площадь …), 1й корпус, ауд. 403» → «ауд. 403»
const ROOMS = {};
const roomName = s => room(s);
function room(s) {
  s = clean(s);
  const m = /ауд\.\s*(\d+[а-я]?)\s*(\([^)]*\))?/i.exec(s);
  let name = s;
  if (m && /ПГТУ|корпус/i.test(s) && !/фойе|рекреац/i.test(s)) name = "ауд. " + m[1] + (m[2] ? " " + m[2] : "");
  else if (/актовый зал/i.test(s)) name = "актовый зал";
  if (name !== s) ROOMS[M.roomKey(name)] = ROOMS[M.roomKey(name)] || name;
  return name;
}

function people(lines, i) {
  const out = [];
  for (let j = i + 1; j < lines.length && !/:$/.test(lines[j]) && !/^Секция\s/.test(lines[j]); j++) {
    if (!out.length || /^[А-ЯЁ][а-яё-]+ [А-ЯЁ][а-яё]+/.test(lines[j])) out.push(lines[j]);
    else out[out.length - 1] += " " + lines[j];
  }
  return out.map(x => clean(x).replace(/,\s*$/, ""));
}

function globalType(t) {
  if (/обед/i.test(t)) return "lunch";
  if (/перерыв|кофе/i.test(t)) return "break";
  if (/открыти|закрыти|заключительное/i.test(t)) return "ceremony";
  return "activity";
}

// --- обход дней
const sectionsSeen = {};
const days = [];
prog.filter(x => x.table).forEach(x => {
  const rows = x.table.rows;
  const dm = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(cellText(rows[0][0]));
  const date = `${dm[3]}-${dm[2]}-${dm[1]}`;
  const day = { date: date, sessions: [] };
  days.push(day);
  let place = "";          // «Место» во всю ширину
  let flow = null;         // текущее общее заседание
  let block = null;        // параллельные колонки { cols: [...] }
  let lastGlobal = null;

  const globalSession = (title, room, extra) => {
    const s = Object.assign({ title: title, items: [] }, room ? { room: roomName(room) } : {}, extra || {});
    day.sessions.push(s);
    lastGlobal = s;
    return s;
  };
  const sum = start => (summary[date] || {})[start] || {};

  for (let ri = 1; ri < rows.length; ri++) {
    const r = rows[ri].filter(c => c.vmerge !== "continue");
    if (!r.length) continue;
    const head = cellText(r[0]);

    if (/^(Секция|Событие)$/.test(head)) {
      // новый блок параллельных колонок; строки-продолжения добавляют секции в колонку
      block = { cols: r.slice(1).map(c => ({ col: c.col, span: c.span, header: c.paras, sections: [], room: "", session: null })) };
      for (let rj = ri + 1; rj < rows.length && rows[rj][0].vmerge === "continue"; rj++) {
        rows[rj].filter(c => c.vmerge !== "continue").forEach(c => {
          const col = block.cols.find(b => b.col === c.col);
          if (col) col.header = col.header.concat(c.paras);
        });
        ri = rj;
      }
      block.cols.forEach(col => {
        const lines = col.header.map(clean);
        lines.forEach((l, i) => {
          const m = /^Секция\s+(\d+)\.\s*(.+)$/.exec(l);
          if (m) { col.sections.push(+m[1]); sectionsSeen[+m[1]] = sectionsSeen[+m[1]] || m[2]; }
          if (/^Председатель:?$/.test(l)) { const ps = people(lines, i); col.chair = ps[0]; if (ps[1]) col.cochair = ps[1]; }
          if (/^Учёный секретарь:?$/.test(l)) col.secretary = person(lines, i);
        });
        col.event = col.sections.length ? "" : lines[0];
      });
      flow = null;
      place = "";
      continue;
    }
    if (head === "Место") {
      if (r.length === 2 && !block) {
        place = cellText(r[1]);
        if (lastGlobal && !lastGlobal.room) lastGlobal.room = roomName(place);
      } else if (block) {
        r.slice(1).forEach(c => { const col = block.cols.find(b => b.col === c.col); if (col) col.room = roomName(cellText(c)); });
      } else if (lastGlobal && !lastGlobal.room) lastGlobal.room = roomName(cellText(r[1]));
      continue;
    }
    if (r.length === 1) {
      // «Пленарные доклады: / Председатель: …» во всю ширину
      const lines = r[0].paras.map(clean);
      if (/^Пленарные доклады/.test(lines[0])) {
        block = null;
        const s = globalSession("Пленарное заседание", place);
        lines.forEach((l, i) => {
          if (/^Председатель:?$/.test(l)) { const ps = people(lines, i); s.chair = ps[0]; if (ps[1]) s.cochair = ps[1]; }
          if (/^Учёный секретарь:?$/.test(l)) s.secretary = person(lines, i);
        });
        flow = s;
      } else log.push(`${date}: строка без времени «${lines[0]}»`);
      continue;
    }
    if (r[0].col !== 0 && block) { blockRow(r, null); continue; }
    if (!isTime(head)) { log.push(`${date}: непонятная строка «${head}»`); continue; }
    const tm = times(head);

    if (r.length === 2 && (r[1].span > 1 || !block)) {
      // строка во всю ширину: пленарный доклад или общее событие
      const text = cellText(r[1]);
      if (/Докладчик/.test(text)) {
        const it = Object.assign(parseTalk(r[1].paras), { type: "plenary", start: tm.start, end: tm.end });
        (flow || (flow = globalSession("Пленарное заседание", place))).items.push(it);
        continue;
      }
      const type = globalType(text);
      const sm = sum(tm.start);
      const end = tm.end || sm.end;
      let title = text, room = "";
      const par = /^(.*?)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/.exec(text);
      if (par && type !== "break" && type !== "lunch") { title = clean(par[1]); room = clean(par[2]); }
      if (type === "break") { title = "Кофе-брейк"; room = COFFEE_ROOM; }
      if (type === "lunch") title = "Обеденный перерыв";
      title = title.replace(/[,\s]*ПГТУ[,\s]*$/, "").replace(/[:.]\s*$/, "");
      if (title === title.toUpperCase() && sm.text) title = clean(sm.text.replace(/\s*\([^)]*\)\s*$/, ""));
      if (!room && type !== "lunch") room = (!block && place) || sm.place || "";
      // регистрация и открытие идут подряд в одном месте — одно заседание
      const join = false;
      const s = join ? flow : globalSession(type === "break" ? "Кофе-брейк" : type === "lunch" ? "Обеденный перерыв" : title, room);
      s.items.push(Object.assign({ type: type, title: title, start: tm.start }, end ? { end: end } : {}));
      flow = type === "break" || type === "lunch" ? null : s;
      if (type === "lunch") place = "";
      // перерыв делит колонки на заседания до и после; другое общее событие закрывает блок
      if (block) block.cols.forEach(col => { col.session = null; });
      if (type !== "break") block = null;
      continue;
    }

    if (!block) { log.push(`${date} ${head}: строка с колонками вне блока`); continue; }
    blockRow(r, tm);
  }

  // строка блока: в каждой колонке доклад, пусто, событие или пара «время | доклад»
  function blockRow(r, tm) {
    block.cols.forEach(col => {
      const inCol = r.filter(c => c.col >= col.col && c.col < col.col + col.span);
      if (!inCol.length) return;
      let t = tm, cell = inCol[0];
      if (inCol.length === 2 && isTime(cellText(inCol[0]))) { t = times(cellText(inCol[0])); cell = inCol[1]; }
      const text = cellText(cell);
      if (!text || !t) return;
      if (!col.session) {
        const title = col.sections.length === 1 ? "Секция " + col.sections[0]
          : col.sections.length ? "Секции " + col.sections.join(", ") : clean(col.event);
        col.session = Object.assign({ title: title, items: [] }, col.room ? { room: col.room } : {},
          col.chair ? { chair: col.chair } : {}, col.cochair ? { cochair: col.cochair } : {}, col.secretary ? { secretary: col.secretary } : {});
        day.sessions.push(col.session);
      }
      if (/Докладчик/.test(text)) {
        const it = parseTalk(cell.paras);
        if (col.sections.length === 1) it.section = col.sections[0];
        else {
          const sec = findSection(it.title);
          if (sec && (!col.sections.length || col.sections.indexOf(sec) >= 0)) it.section = sec;
          else if (sec) { it.section = sec; log.push(`${date}: доклад «${it.title.slice(0, 50)}» по заявке в секции ${sec}, а колонка — ${col.sections.join(",") || col.event}`); }
          else log.push(`${date}: секция не найдена для «${it.title.slice(0, 60)}»`);
        }
        col.session.items.push(Object.assign(it, { start: t.start, end: t.end }));
      } else {
        const sm = sum(t.start);
        col.session.items.push(Object.assign({ type: globalType(text), title: text, start: t.start }, (t.end || sm.end) ? { end: t.end || sm.end } : {}));
      }
    });
  }
  // общее заседание во всю ширину внутри блока делит колонки на заседания до и после
});

const sections = Object.keys(Object.assign({}, sectionTitles, sectionsSeen)).map(Number).sort((a, b) => a - b)
  .map(no => {
    if (sectionsSeen[no] && sectionTitles[no] && key(sectionsSeen[no]) !== key(sectionTitles[no])) log.push(`секция ${no}: в программе «${sectionsSeen[no]}», в заявках «${sectionTitles[no]}»`);
    return { no: no, title: clean(sectionTitles[no] || sectionsSeen[no]) };
  });

const doc = {
  schema: "conf.program/v1",
  event: {
    title: "XXVIII Всероссийская открытая научная конференция «Распространение радиоволн» (РРВ-28)",
    date_from: days[0].date,
    date_to: days[days.length - 1].date,
    city: "Йошкар-Ола",
    venue: "Поволжский государственный технологический университет",
    regulations: { talk_min: 15, plenary_min: 30, break_min: 30, lunch_min: 90, other_min: 60 },
  },
  rooms: Object.keys(ROOMS).map(k => ({ name: ROOMS[k], building: "ПГТУ, 1-й корпус" })),
  sections: sections,
  days: days,
};
fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n");
const res = M.normalize(doc);
console.log(JSON.stringify(res.report.stats));
console.log("errors", res.report.errors.length, "warnings", res.report.warnings.length);
const count = list => list.reduce((m, e) => { m[e.code] = (m[e.code] || 0) + 1; return m; }, {});
console.log("errors", JSON.stringify(count(res.report.errors)), "\nwarnings", JSON.stringify(count(res.report.warnings)));
res.report.errors.slice(0, 15).forEach(e => console.log("E", e.code, e.path, e.message));
console.log("--- лог конвертера");
log.forEach(l => console.log(l));
