"use strict";
// Импорт докладов из таблиц (web/src/edit/table.js): CSV, xlsx, docx, сопоставление столбцов.
const test = require("node:test");
const assert = require("node:assert/strict");
const { zipSync, strToU8 } = require("fflate");

const T = () => import("../../web/src/edit/table.js");

const XLSX = {
  "xl/workbook.xml": '<workbook><sheets><sheet name="Заявки" sheetId="1" r:id="rId1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>',
  "xl/sharedStrings.xml": '<sst><si><t>ФИО докладчика</t></si><si><t>Тема доклада</t></si><si><r><t>Секция</t></r></si>' +
    '<si><t>E-mail</t></si><si><t>Иванов И. И.</t></si><si><t xml:space="preserve">Радары &amp; ионосфера </t></si><si><t>a@b.ru</t></si></sst>',
  "xl/worksheets/sheet1.xml": '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="E1" t="s"><v>3</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c><c r="C2"><v>2</v></c><c r="D2" s="1"/><c r="E2" t="s"><v>6</v></c></row>' +
    '<row r="3"><c r="A3" t="inlineStr"><is><t>Петров П. П.</t></is></c><c r="B3" t="str"><v>Без секции</v></c></row>' +
    '</sheetData></worksheet>',
};

test("xlsx: общие строки, пустые ячейки, inlineStr; контакты не сопоставляются", async () => {
  const t = await T();
  const files = {};
  Object.keys(XLSX).forEach(k => { files[k] = strToU8(XLSX[k]); });
  const rows = t.readTable("заявки.xlsx", zipSync(files));
  assert.deepEqual(rows[0], ["ФИО докладчика", "Тема доклада", "Секция", "", "E-mail"]);
  assert.deepEqual(rows[1], ["Иванов И. И.", "Радары & ионосфера", "2", "", "a@b.ru"]);
  assert.equal(rows[2][0], "Петров П. П.");
  const h = t.findHeader(rows);
  assert.equal(h, 0);
  const map = t.guessMapping(rows[h]);
  assert.deepEqual(map, ["speaker", "title", "section", "", ""]);
  const items = t.rowsToItems(rows.slice(1), map);
  assert.deepEqual(items[0], { type: "talk", title: "Радары & ионосфера", speaker: "Иванов И. И.", section: 2 });
  assert.equal(items.length, 2);
  assert.equal(t.rowsToItems(rows.slice(1), map, { section: 2 }).length, 1);
  assert.ok(JSON.stringify(items).indexOf("@") < 0);
});

test("CSV: «;» и кавычки, Windows-1251", async () => {
  const t = await T();
  const csv = 'Название;Авторы;Город\n"Доклад; с точкой с запятой";"Иванов И. И., Петров П. П.";Москва\r\nВторой;Сидоров С. С.;"г. Казань"\n';
  const rows = t.readTable("a.csv", strToU8(csv));
  assert.deepEqual(rows[1], ["Доклад; с точкой с запятой", "Иванов И. И., Петров П. П.", "Москва"]);
  const items = t.rowsToItems(rows.slice(1), t.guessMapping(rows[0]));
  assert.deepEqual(items[0].authors, ["Иванов И. И.", "Петров П. П."]);
  // «Доклад» в cp1251: Д=0xC4 о=0xEE к=0xEA л=0xEB а=0xE0 д=0xE4
  const cp = Uint8Array.from([0xc4, 0xee, 0xea, 0xeb, 0xe0, 0xe4, 0x3b, 0x31]);
  assert.deepEqual(t.readTable("b.csv", cp), [["Доклад", "1"]]);
});

test("docx: самая большая таблица, объединённые ячейки, переносы", async () => {
  const t = await T();
  const cell = (s, extra) => `<w:tc><w:tcPr>${extra || ""}</w:tcPr><w:p><w:r><w:t>${s}</w:t></w:r></w:p></w:tc>`;
  const doc = '<w:document><w:body>' +
    '<w:tbl><w:tr>' + cell("Шапка") + '</w:tr></w:tbl>' +
    '<w:tbl>' +
    '<w:tr>' + cell("Секция") + cell("Тема") + cell("Авторы") + '</w:tr>' +
    '<w:tr>' + cell("1", '<w:vMerge w:val="restart"/>') + cell("Первый") +
      '<w:tc><w:p><w:r><w:t>Иванов И. И.</w:t></w:r></w:p><w:p><w:r><w:t>Петров П. П.</w:t></w:r></w:p></w:tc></w:tr>' +
    '<w:tr>' + cell("", "<w:vMerge/>") + cell("Второй") + cell("Сидоров С. С.") + '</w:tr>' +
    '</w:tbl></w:body></w:document>';
  const rows = t.readTable("программа.docx", zipSync({ "word/document.xml": strToU8(doc) }));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[2], ["1", "Второй", "Сидоров С. С."]);
  const items = t.rowsToItems(rows.slice(1), t.guessMapping(rows[0]));
  assert.deepEqual(items[0].authors, ["Иванов И. И.", "Петров П. П."]);
  assert.equal(items[1].section, 1);
});

test("неподдерживаемые форматы — понятная ошибка", async () => {
  const t = await T();
  assert.throws(() => t.readTable("старый.xls", new Uint8Array(4)), /xlsx/);
  assert.throws(() => t.readTable("фото.png", new Uint8Array(4)), /Поддерживаются/);
  assert.equal(t.sectionNo("Секция 3"), 3);
  assert.equal(t.sectionNo("Дистанционное", [{ no: 2, title: "Дистанционное зондирование" }]), 2);
});
