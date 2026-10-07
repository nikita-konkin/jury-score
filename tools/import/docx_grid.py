# docx → JSON: блоки документа; таблицы с позициями ячеек в сетке (gridSpan, vMerge) и вложенными таблицами
import sys, json, zipfile, xml.etree.ElementTree as ET
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
def ptext(p):
    out = []
    for n in p.iter():
        if n.tag == W + "t" and n.text: out.append(n.text)
        elif n.tag == W + "tab": out.append("\t")
        elif n.tag in (W + "br", W + "cr"): out.append("\n")
    return "".join(out).strip()
def cell(tc, col):
    pr = tc.find(W + "tcPr")
    span, vm = 1, None
    if pr is not None:
        g = pr.find(W + "gridSpan")
        if g is not None: span = int(g.get(W + "val"))
        v = pr.find(W + "vMerge")
        if v is not None: vm = v.get(W + "val") or "continue"
    paras, nested = [], []
    for el in tc:
        if el.tag == W + "p":
            t = ptext(el)
            if t: paras.append(t)
        elif el.tag == W + "tbl": nested.append(table(el))
    return {"col": col, "span": span, "vmerge": vm, "paras": paras, "nested": nested}
def table(tbl):
    rows = []
    for tr in tbl.findall(W + "tr"):
        col, cells = 0, []
        for tc in tr.findall(W + "tc"):
            c = cell(tc, col); cells.append(c); col += c["span"]
        rows.append(cells)
    return {"rows": rows}
def body(root):
    out = []
    for el in root.find(W + "body"):
        if el.tag == W + "p":
            t = ptext(el)
            if t: out.append({"p": t})
        elif el.tag == W + "tbl": out.append({"table": table(el)})
    return out
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as z: root = ET.fromstring(z.read("word/document.xml"))
json.dump(body(root), open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
