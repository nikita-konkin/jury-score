// Выгрузка в Word (.docx) без библиотеки docx: минимальный пакет WordprocessingML, zip через fflate.
// Блоки: { p: текст | [{ t, b, i, caps, br }], b, i, caps, size (pt), align, before, after, keep } | { table, widths (мм), header } | { pageBreak }.
import { zipSync, strToU8 } from "fflate";
import { programRows, protocols, datesLine } from "./data.js";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const mm = x => Math.round(x * 56.7); // миллиметры → twips
const esc = s => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function run(r, base) {
  const o = Object.assign({}, base, typeof r === "string" ? { t: r } : r);
  const pr = (o.b ? "<w:b/>" : "") + (o.i ? "<w:i/>" : "") + (o.caps ? "<w:caps/>" : "") + (o.size ? `<w:sz w:val="${o.size * 2}"/>` : "");
  const text = String(o.t == null ? "" : o.t).split("\n").map(x => `<w:t xml:space="preserve">${esc(x)}</w:t>`).join("<w:br/>");
  return `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ""}${o.br ? "<w:br/>" : ""}${text}</w:r>`;
}

function para(b) {
  const runs = Array.isArray(b.p) ? b.p : [b.p];
  const ppr = (b.keep ? "<w:keepNext/>" : "") + (b.align ? `<w:jc w:val="${b.align === "center" ? "center" : b.align === "right" ? "right" : "both"}"/>` : "")
    + `<w:spacing w:before="${(b.before || 0) * 20}" w:after="${(b.after == null ? 4 : b.after) * 20}"/>` + (b.indent ? `<w:ind w:left="${mm(b.indent)}"/>` : "");
  return `<w:p><w:pPr>${ppr}</w:pPr>${runs.map(r => run(r, { b: b.b, i: b.i, caps: b.caps, size: b.size })).join("")}</w:p>`;
}

function table(b, pageWidth) {
  const total = b.widths.reduce((a, x) => a + x, 0);
  const widths = b.widths.map(x => Math.round(mm(pageWidth) * x / total));
  const border = ["top", "left", "bottom", "right", "insideH", "insideV"].map(k => `<w:${k} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`).join("");
  const row = (cells, head) => `<w:tr>${head ? "<w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>" : "<w:trPr><w:cantSplit/></w:trPr>"}` + cells.map((c, i) =>
    `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/></w:tcPr>${para({ p: String(c == null ? "" : c), b: head, after: 0, size: 11, align: head ? "center" : "" })}</w:tc>`).join("") + "</w:tr>";
  return `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, x) => a + x, 0)}" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders><w:tblLayout w:type="fixed"/>`
    + `<w:tblCellMar><w:left w:w="57" w:type="dxa"/><w:right w:w="57" w:type="dxa"/></w:tblCellMar></w:tblPr>`
    + `<w:tblGrid>${widths.map(x => `<w:gridCol w:w="${x}"/>`).join("")}</w:tblGrid>`
    + (b.header ? row(b.header, true) : "") + b.table.map(r => row(r, false)).join("") + "</w:tbl>" + para({ p: "", after: 0 });
}

/** Блоки → .docx (Uint8Array). opts.landscape — альбомная страница. */
export function docx(blocks, opts) {
  opts = opts || {};
  const [pw, ph] = opts.landscape ? [297, 210] : [210, 297];
  const margin = { top: 15, right: 15, bottom: 15, left: 20 };
  const body = blocks.map(b => (b.pageBreak ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : b.table ? table(b, pw - margin.left - margin.right) : para(b))).join("");
  const sect = `<w:sectPr><w:pgSz w:w="${mm(pw)}" w:h="${mm(ph)}"${opts.landscape ? ' w:orient="landscape"' : ""}/>`
    + `<w:pgMar w:top="${mm(margin.top)}" w:right="${mm(margin.right)}" w:bottom="${mm(margin.bottom)}" w:left="${mm(margin.left)}" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>`;
  const xml = h => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + h;
  const files = {
    "[Content_Types].xml": xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'),
    "_rels/.rels": xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/_rels/document.xml.rels": xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
    "word/styles.xml": xml(`<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr>`
      + '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/>'
      + '<w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault>'
      + '<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
      + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>'),
    "word/document.xml": xml(`<w:document xmlns:w="${W}"><w:body>${body}${sect}</w:body></w:document>`),
  };
  const out = {};
  Object.keys(files).forEach(k => { out[k] = strToU8(files[k]); });
  return zipSync(out, { level: 6 });
}

/* ---------------- документы ---------------- */

export function programBlocks(doc) {
  const ev = doc.event;
  const blocks = [
    { p: ev.title, b: true, caps: true, size: 14, align: "center", after: 2 },
    ev.subtitle ? { p: ev.subtitle, align: "center", after: 2 } : null,
    { p: [datesLine(ev.date_from, ev.date_to), ev.venue, ev.city ? "г. " + ev.city.replace(/^г\.\s*/, "") : ""].filter(Boolean).join(" · "), align: "center", after: 10 },
  ].filter(Boolean);
  programRows(doc).forEach((d, i) => {
    if (i) blocks.push({ pageBreak: true });
    blocks.push({ p: d.heading + (d.title ? " · " + d.title : ""), b: true, size: 13, align: "center", before: 6, after: 6, keep: true });
    d.sessions.forEach(s => {
      blocks.push({ p: s.session.title || "Заседание", b: true, caps: true, before: 10, after: 2, keep: true });
      if (s.session.chair) blocks.push({ p: "Председатель: " + s.session.chair, size: 11, after: 0, keep: true });
      if (s.session.cochair) blocks.push({ p: "Сопредседатель: " + s.session.cochair, size: 11, after: 0, keep: true });
      if (s.session.secretary) blocks.push({ p: "Ученый секретарь: " + s.session.secretary, size: 11, after: 0, keep: true });
      if (s.place) blocks.push({ p: [{ t: "Место: ", b: true }, s.place], size: 11, after: 4, keep: true });
      s.rows.forEach(r => {
        if (r.kind === "section" || r.kind === "plenary-head") blocks.push({ p: r.text, b: true, caps: true, size: 11, before: 6, after: 2, keep: true });
        else if (r.kind === "talk") {
          if (r.authors) blocks.push({ p: r.authors, i: true, size: 11, after: 0, indent: 30, keep: true });
          blocks.push({ p: [{ t: r.time + "   ", b: true }, { t: r.item.title, b: true }], size: 11, after: 0, keep: !!r.speaker });
          if (r.speaker) blocks.push({ p: r.speaker, size: 10, after: 4, indent: 30 });
        } else {
          blocks.push({ p: [{ t: r.time + "   ", b: true }, { t: r.text, b: r.kind === "break", caps: r.kind === "break" }].concat(r.place ? [" (" + r.place + ")"] : []),
            size: 11, before: 2, after: 4 });
        }
      });
    });
  });
  return blocks;
}

export function protocolBlocks(doc, dayFilter) {
  const blocks = [];
  protocols(doc, dayFilter).forEach((pr, i) => {
    if (i) blocks.push({ pageBreak: true });
    blocks.push({ p: "ПРОТОКОЛ", b: true, size: 14, align: "center", after: 0 });
    blocks.push({ p: "заседания " + pr.title, b: true, align: "center", after: 2 });
    blocks.push({ p: doc.event.title, align: "center", after: 2 });
    blocks.push({ p: [pr.day.date.split("-").reverse().join("."), pr.place].filter(Boolean).join(", "), align: "center", after: 8 });
    blocks.push({ table: pr.rows.map(r => [r.no, r.speaker, r.title, r.org, r.format, ""]), widths: [8, 32, 55, 40, 18, 22],
      header: ["№", "ФИО докладчика", "Тема доклада", "Место работы", "Форма участия", "Примечание"] });
    blocks.push({ p: `Председатель ____________________ ${pr.chair ? "/ " + pr.chair + " /" : ""}`, before: 18, after: 10 });
    blocks.push({ p: `Секретарь ____________________ ${pr.secretary ? "/ " + pr.secretary + " /" : ""}` });
  });
  return blocks;
}
