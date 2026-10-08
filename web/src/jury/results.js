// Оценки жюри и итоги (перенос из jury-score): запись оценки, засчитываемость, рейтинг с общими местами,
// статистика для администратора, CSV. talks — доклады из ping (с полем idx — порядок в программе).

/** Как norm в jury-score и norm_ на сервере: регистр, ё, пробелы вокруг точек. */
export function norm(s) {
  return String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s*\.\s*/g, ". ").replace(/\s+/g, " ").trim();
}

/** Запись оценки: s — баллы по критериям (null — не поставлен), st — статус, cm — комментарий, ts — время правки. */
export function normRec(r, nc, smax) {
  r = r && typeof r === "object" ? r : {};
  const s = Array.isArray(r.s) ? r.s.slice(0, nc) : [];
  while (s.length < nc) s.push(null);
  return {
    s: s.map(v => (v === null || v === "" || v === undefined ? null : Number(v))).map(v => (Number.isInteger(v) && v >= 1 && v <= smax ? v : null)),
    st: r.st === "absent" || r.st === "abstain" ? r.st : "",
    cm: typeof r.cm === "string" ? r.cm : "",
    ts: +r.ts || 0,
  };
}
export const filled = r => r.s.filter(v => v != null).length;
export const isComplete = r => !r.st && r.s.every(v => v != null);
export const isDone = r => !!r.st || isComplete(r);
export const sumOf = r => r.s.reduce((a, v) => a + (v || 0), 0);
export const fromRow = (row, nc, smax) => normRec({ s: row.scores, st: row.status, cm: row.comment, ts: row.ts }, nc, smax);

/** Строки сервера → { ключ эксперта: { name, data: { код: запись } } }. */
export function groupRows(rows, talks, nc, smax) {
  const known = {};
  talks.forEach(t => { known[t.code] = 1; });
  const all = {};
  rows.forEach(row => {
    const k = norm(row.juror);
    if (!k || !known[row.id]) return;
    (all[k] = all[k] || { name: row.juror, data: {} }).data[row.id] = fromRow(row, nc, smax);
  });
  return all;
}

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;

/** По докладу: засчитанные оценки, средняя сумма, разброс, средние по критериям. */
export function computeResults(all, talks, nc, smax) {
  const per = {};
  Object.keys(all).forEach(k => {
    const j = all[k];
    Object.keys(j.data || {}).forEach(id => {
      const r = normRec(j.data[id], nc, smax);
      if (!isComplete(r)) return;
      (per[id] = per[id] || []).push({ name: j.name, total: sumOf(r), s: r.s });
    });
  });
  return talks.filter(t => per[t.code]).map(t => {
    const list = per[t.code], tot = list.map(x => x.total), avg = mean(tot);
    const crit = [];
    for (let c = 0; c < nc; c++) crit.push(mean(list.map(x => x.s[c])));
    return { t, n: list.length, list, avg, min: Math.min.apply(null, tot), max: Math.max.apply(null, tot),
      sd: Math.sqrt(mean(tot.map(x => (x - avg) * (x - avg)))), crit };
  });
}

/** Одинаковые средние (до тысячных) получают одинаковое место. */
export function rankRows(rows) {
  const key = r => Math.round(r.avg * 1000);
  const s = rows.slice().sort((a, b) => key(b) - key(a) || a.t.idx - b.t.idx);
  s.forEach((r, i) => { r.rank = i && key(s[i - 1]) === key(r) ? s[i - 1].rank : i + 1; });
  return s;
}

export function jurorStats(all, talks, nc, smax) {
  return Object.keys(all).map(k => {
    const j = all[k];
    const recs = talks.map(t => (j.data && j.data[t.code] ? normRec(j.data[t.code], nc, smax) : null)).filter(r => r && r.ts);
    const comp = recs.filter(isComplete);
    return { key: k, name: j.name, done: recs.filter(isDone).length, n: comp.length,
      mean: comp.length ? mean(comp.map(sumOf)) : null, last: Math.max.apply(null, [0].concat(recs.map(r => r.ts))) };
  }).filter(j => j.last).sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

/** Статистика для администратора: плитки, секции, критерии, распределение баллов, эксперты, расхождения. */
export function stats(all, rows, talks, criteria, smax, sections) {
  const nc = criteria.length;
  const totals = [];
  rows.forEach(r => r.list.forEach(x => totals.push(x.total)));
  if (!totals.length) return null;
  const overall = mean(totals);
  const secNos = sections.length ? sections.map(s => s.no) : [];
  const bySection = secNos.map(no => {
    const rr = rankRows(rows.filter(r => r.t.section === no));
    const count = talks.filter(t => t.section === no).length;
    return { no, count, rated: rr.length, mean: rr.length ? mean(rr.map(r => r.avg)) : null,
      leaders: rr.filter(r => r.rank === 1) };
  }).filter(x => x.count);
  const crit = criteria.map((name, c) => {
    const v = [];
    rows.forEach(r => r.list.forEach(x => v.push(x.s[c])));
    return { name, mean: mean(v) };
  });
  const dist = [];
  for (let i = 0; i < smax; i++) dist.push(0);
  rows.forEach(r => r.list.forEach(x => x.s.forEach(v => { dist[v - 1]++; })));
  const spread = rows.filter(r => r.n > 1).sort((a, b) => (b.max - b.min) - (a.max - a.min) || b.sd - a.sd).slice(0, 5);
  return { overall, maxTotal: nc * smax, jurors: jurorStats(all, talks, nc, smax), counted: totals.length, ranked: rows.length,
    bySection, crit, dist, spread };
}

const q = v => { const s = String(v == null ? "" : v); return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const num = x => String(Math.round(x * 100) / 100).replace(".", ",");
const toCsv = rows => "﻿" + rows.map(r => r.map(q).join(";")).join("\r\n") + "\r\n";

/** Рейтинг в CSV (Excel в русской Windows: «;», BOM). */
export function csvRank(rows, criteria) {
  const out = [["Место", "Место в секции", "Секция", "Код", "Докладчик", "Доклад", "Средний балл", "Экспертов", "Мин", "Макс", "Ст. откл."].concat(criteria)];
  const inSec = {};
  const secs = {};
  rows.forEach(r => { secs[r.t.section] = 1; });
  Object.keys(secs).forEach(s => rankRows(rows.filter(r => String(r.t.section) === s)).forEach(r => { inSec[r.t.code] = r.rank; }));
  rankRows(rows).forEach(r => out.push([r.rank, inSec[r.t.code], r.t.section || "", r.t.code, r.t.speaker, r.t.title, num(r.avg), r.n, r.min, r.max, num(r.sd)].concat(r.crit.map(num))));
  return toCsv(out);
}

/** Все оценки в CSV. */
export function csvRaw(all, talks, criteria, smax) {
  const nc = criteria.length;
  const out = [["Эксперт", "Секция", "Код", "Докладчик", "Доклад"].concat(criteria, ["Сумма", "Статус", "Комментарий"])];
  const STATUS = { absent: "не состоялся", abstain: "воздерживается" };
  Object.keys(all).forEach(k => talks.forEach(t => {
    const raw = all[k].data && all[k].data[t.code];
    if (!raw) return;
    const r = normRec(raw, nc, smax);
    if (!r.ts && !filled(r) && !r.st) return;
    out.push([all[k].name, t.section || "", t.code, t.speaker, t.title].concat(r.s.map(v => (v == null ? "" : v)),
      [isComplete(r) ? sumOf(r) : "", STATUS[r.st] || "", r.cm]));
  }));
  return toCsv(out);
}
