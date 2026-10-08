// Импорт докладов из таблицы: .xlsx, .csv (UTF-8 или Windows-1251) и таблицы в .docx.
// Разбор без SheetJS: zip распаковывает fflate, XML читается регулярными выражениями
// (так код работает и в старых браузерах, и в Node для тестов).
import { unzipSync, strFromU8 } from "fflate";

const MAX_UNZIPPED = 20 * 1024 * 1024;

const ENT = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
export function xmlText(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
    if (e[0] !== "#") return ENT[e.toLowerCase()];
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
  });
}

function unzip(bytes, wanted) {
  let total = 0;
  return unzipSync(bytes, {
    filter: f => {
      if (!wanted(f.name)) return false;
      total += f.originalSize;
      if (total > MAX_UNZIPPED) throw new Error("Файл слишком большой после распаковки");
      return true;
    },
  });
}

/* ---------------- CSV ---------------- */

export function decodeText(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (e) {
    // Excel в русской Windows сохраняет CSV в Windows-1251
    return new TextDecoder("windows-1251").decode(bytes);
  }
}

/** CSV с разделителем «;», «,» или табуляцией; кавычки и переносы внутри кавычек. */
export function parseCsv(text) {
  const first = text.split(/\r?\n/)[0] || "";
  const count = ch => first.split(ch).length - 1;
  const sep = [";", "\t", ","].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ";");
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"' && cell === "") q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/* ---------------- XLSX ---------------- */

const colIndex = ref => {
  let n = 0;
  for (let i = 0; i < ref.length; i++) n = n * 26 + (ref.charCodeAt(i) - 64);
  return n - 1;
};

const joinT = xml => {
  let out = "";
  xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (m, t) => { out += xmlText(t); return m; });
  return out;
};

export function xlsxRows(files) {
  const read = name => (files[name] ? strFromU8(files[name]) : "");
  const strings = [];
  read("xl/sharedStrings.xml").replace(/<si>([\s\S]*?)<\/si>/g, (m, si) => { strings.push(joinT(si)); return m; });
  // первый лист книги
  const wb = read("xl/workbook.xml");
  const rid = (/<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb) || [])[1];
  let target = "";
  if (rid) {
    const rels = read("xl/_rels/workbook.xml.rels");
    const re = /<Relationship\b([^>]*)\/?>/g;
    let m;
    while ((m = re.exec(rels))) {
      if (new RegExp('\\bId="' + rid + '"').test(m[1])) target = (/\bTarget="([^"]+)"/.exec(m[1]) || [])[1] || "";
    }
  }
  const path = target ? (target[0] === "/" ? target.slice(1) : "xl/" + target.replace(/^\.\//, "")) : "";
  const sheet = files[path] ? path : Object.keys(files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if (!sheet) throw new Error("В книге нет листов");
  const rows = [];
  read(sheet).replace(/<row\b[^>]*>([\s\S]*?)<\/row>/g, (m, body) => {
    const row = [];
    let next = 0;
    body.replace(/<c\b([^>/]*)(?:\/>|>([\s\S]*?)<\/c>)/g, (mc, attrs, inner) => {
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs);
      const ci = ref ? colIndex(ref[1]) : next;
      next = ci + 1;
      const t = (/\bt="(\w+)"/.exec(attrs) || [])[1] || "n";
      const v = (/<v>([\s\S]*?)<\/v>/.exec(inner || "") || [])[1];
      let val = "";
      if (t === "s") val = strings[+v] || "";
      else if (t === "inlineStr") val = joinT(inner || "");
      else if (v != null) val = xmlText(v);
      while (row.length < ci) row.push("");
      row[ci] = val;
      return mc;
    });
    rows.push(row);
    return m;
  });
  return rows;
}

/* ---------------- DOCX ---------------- */

const cellText = xml => {
  const paras = [];
  xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, p => {
    let s = "";
    p.replace(/<w:(t)(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br)\b[^>]*\/>/g, (m, t, txt, br) => {
      s += t ? xmlText(txt) : br === "tab" ? " " : "\n";
      return m;
    });
    paras.push(s);
    return p;
  });
  return paras.join("\n").replace(/[ \t]+/g, " ").trim();
};

/** Строки самой большой таблицы документа; объединённые ячейки разворачиваются. */
export function docxRows(files) {
  const xml = files["word/document.xml"] ? strFromU8(files["word/document.xml"]) : "";
  const tables = [];
  xml.replace(/<w:tbl>([\s\S]*?)<\/w:tbl>/g, (m, tbl) => {
    const rows = [];
    tbl.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, tr => {
      const row = [];
      tr.replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, tc => {
        const span = +((/<w:gridSpan w:val="(\d+)"/.exec(tc) || [])[1] || 1);
        const vm = /<w:vMerge(?: w:val="(\w+)")?\s*\/>/.exec(tc);
        const prev = rows.length ? rows[rows.length - 1] : null;
        const text = vm && vm[1] !== "restart" && prev ? prev[row.length] || "" : cellText(tc);
        row.push(text);
        for (let i = 1; i < span; i++) row.push("");
        return tc;
      });
      rows.push(row);
      return tr;
    });
    tables.push(rows);
    return m;
  });
  if (!tables.length) throw new Error("В документе нет таблиц");
  return tables.reduce((a, b) => (b.length > a.length ? b : a));
}

/** Файл → строки таблицы. */
export function readTable(name, bytes) {
  const ext = (/\.(\w+)$/.exec(String(name).toLowerCase()) || [])[1];
  let rows;
  if (ext === "csv" || ext === "txt" || ext === "tsv") rows = parseCsv(decodeText(bytes));
  else if (ext === "xlsx") rows = xlsxRows(unzip(bytes, n => /^xl\/(sharedStrings|workbook|worksheets\/sheet\d+)\.xml$|^xl\/_rels\/workbook\.xml\.rels$/.test(n)));
  else if (ext === "docx") rows = docxRows(unzip(bytes, n => n === "word/document.xml"));
  else if (ext === "xls" || ext === "doc") throw new Error("Старый формат: сохраните файл как .xlsx (или .docx) и загрузите снова");
  else throw new Error("Поддерживаются .xlsx, .csv и таблицы в .docx");
  return rows.map(r => r.map(c => String(c == null ? "" : c).trim())).filter(r => r.some(Boolean));
}

/* ---------------- столбцы → доклады ---------------- */

// Порядок важен: «докладчик» проверяется раньше «доклада». Контакты не импортируются никогда.
export const FIELDS = [
  { key: "speaker", label: "Докладчик", re: /докладчик|выступающ|спикер|фио|speaker|presenter/ },
  { key: "authors", label: "Авторы", re: /автор|author|соавтор/ },
  { key: "title", label: "Название", re: /назван|тема|доклад|title|topic/ },
  { key: "org", label: "Организация", re: /организац|место работы|вуз|учрежд|аффил|affil|organi[sz]/ },
  { key: "city", label: "Город", re: /город|city/ },
  { key: "section", label: "Секция", re: /секци|section|направлен/ },
  { key: "format", label: "Форма участия", re: /(^|\s)форма\b|формат|участи|format/ },
  { key: "duration", label: "Длительность, мин", re: /длител|минут|duration/ },
  { key: "type", label: "Тип", re: /^тип|type/ },
  { key: "note", label: "Примечание", re: /примеч|коммент|note|comment/ },
];
const CONTACT = /mail|почт|телефон|phone|тел\.|контакт|адрес|паспорт|снилс/;

export function guessMapping(header) {
  const used = {};
  return header.map(h => {
    const s = String(h || "").toLowerCase().replace(/ё/g, "е");
    if (!s || CONTACT.test(s)) return "";
    const f = FIELDS.find(x => !used[x.key] && x.re.test(s));
    if (!f) return "";
    used[f.key] = 1;
    return f.key;
  });
}

/** Строка заголовка — первая, где узнаны хотя бы два столбца; -1, если такой нет. */
export function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if (guessMapping(rows[i]).filter(Boolean).length >= 2) return i;
  }
  return -1;
}

/** Номер секции: «2», «Секция 2», или по началу названия из списка секций. */
export function sectionNo(value, sections) {
  const s = String(value || "").trim();
  if (!s) return null;
  const m = /\d+/.exec(s);
  if (m) return +m[0];
  const key = s.toLowerCase().replace(/ё/g, "е");
  const hit = (sections || []).find(x => x.title && x.title.toLowerCase().replace(/ё/g, "е").indexOf(key) === 0);
  return hit ? hit.no : null;
}

/** Строки данных → элементы программы (без строк без названия). section — только эта секция. */
export function rowsToItems(rows, mapping, opts) {
  opts = opts || {};
  const items = [];
  rows.forEach(r => {
    const get = key => {
      const i = mapping.indexOf(key);
      return i >= 0 ? String(r[i] == null ? "" : r[i]).trim() : "";
    };
    const title = get("title").replace(/\s+/g, " ");
    if (!title) return;
    const it = { type: get("type") || "talk", title };
    const authors = get("authors").split(/[;\n]+|,(?=\s*[А-ЯЁA-Z])/).map(x => x.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (authors.length) it.authors = authors;
    const speaker = get("speaker").replace(/\s+/g, " ");
    if (speaker) it.speaker = speaker.split(/[;\n]/)[0].trim();
    ["org", "city", "format", "note"].forEach(k => { const v = get(k).replace(/\s+/g, " "); if (v) it[k] = v; });
    const sec = sectionNo(get("section"), opts.sections);
    if (sec) it.section = sec;
    const dur = parseInt(get("duration"), 10);
    if (dur >= 1 && dur <= 600) it.duration = dur;
    if (opts.section && it.section !== opts.section) return;
    items.push(it);
  });
  return items;
}
