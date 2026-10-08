"use strict";
// Интеграционный тест программы в /api/v1 против настоящего PocketBase (см. pb_server.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const M = require("../../shared/model.js");

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, "../../fixtures", name), "utf8"));
const srv = require("./pb_server.js").setup(test);
const { api, login, t } = srv;
let suToken;
test.before(async () => { await srv.ready; suToken = srv.suToken; });

t("GET /api/v1 и схема из public/", async () => {
  const r = await api("GET", "/api/v1");
  assert.equal(r.json.service, "conf-kit");
  assert.equal(r.json.schema, "conf.program/v1");
  assert.equal(r.json.docs.llms, "/llms.txt");
  const s = await api("GET", "/schema/program.v1.json");
  assert.equal(s.status, 200);
  assert.equal(s.json.$id !== undefined || s.json.title !== undefined, true);
});

t("коллекции совпадают с model.js: поля строк, типы и формы элементов", async () => {
  const fieldsOf = async name => {
    const r = await api("GET", "/api/collections/" + name, undefined, suToken);
    assert.equal(r.status, 200, r.text);
    return r.json.fields;
  };
  const map = { rooms: "room", sections: "section", days: "day", sessions: "session", items: "item" };
  for (const name of Object.keys(map)) {
    const names = (await fieldsOf(name)).map(f => f.name);
    M.ROW_FIELDS[map[name]].concat(["event", "sort"]).forEach(k => assert.ok(names.indexOf(k) >= 0, `${name}.${k}`));
  }
  const items = await fieldsOf("items");
  assert.deepEqual(items.find(f => f.name === "type").values, M.ITEM_TYPES);
  assert.deepEqual(items.find(f => f.name === "format").values, M.FORMATS);
});

t("validate: отчёт с ошибками, обёртка { program }, мусор, ничего не сохраняется", async () => {
  const bad = await api("POST", "/api/v1/programs/validate", fixture("rwp-2026.broken.json"));
  assert.equal(bad.status, 200);
  assert.equal(bad.json.ok, false);
  assert.deepEqual(bad.json.report.errors.map(e => e.code).sort(), ["TIME_BACKWARDS", "TIME_OVERLAP"]);
  assert.equal(bad.json.report.errors.find(e => e.code === "TIME_BACKWARDS").path, "days[0].sessions[1].items[3].end");

  const good = await api("POST", "/api/v1/programs/validate", { program: fixture("rwp-2026.program.json") });
  assert.equal(good.json.ok, true);
  assert.deepEqual(good.json.doc, M.normalize(fixture("rwp-2026.program.json")).doc);

  const junk = await api("POST", "/api/v1/programs/validate", "Вот программа: {не json");
  assert.equal(junk.json.ok, false);
  assert.equal(junk.json.report.errors[0].code, "BAD_JSON");

  const list = await api("GET", "/api/collections/events/records", undefined, suToken);
  assert.equal(list.json.totalItems, 0);
});

t("импорт, чтение, права, новая версия, отказ сохранять программу с ошибками", async () => {
  const program = fixture("rwp-2026.program.json");
  const expected = M.normalize(program).doc;

  // импорт — только суперпользователь
  assert.equal((await api("POST", "/api/v1/admin/events", { slug: "rwp-2026", program })).status, 401);
  const broken = await api("POST", "/api/v1/admin/events", { slug: "rwp-2026", program: fixture("rwp-2026.broken.json") }, suToken);
  assert.equal(broken.status, 422);
  assert.equal(broken.json.ok, false);

  // владелец — обычный пользователь; создать его может только суперпользователь
  const owner = { email: "owner@example.com", password: "owner-pass-12345", passwordConfirm: "owner-pass-12345" };
  assert.equal((await api("POST", "/api/collections/users/records", owner)).status, 403);
  const created = await api("POST", "/api/collections/users/records", owner, suToken);
  assert.equal(created.status, 200, created.text);
  const stranger = { email: "other@example.com", password: "other-pass-12345", passwordConfirm: "other-pass-12345" };
  assert.equal((await api("POST", "/api/collections/users/records", stranger, suToken)).status, 200);
  const ownerToken = await login("users", owner.email, owner.password);
  const strangerToken = await login("users", stranger.email, stranger.password);

  // поставить себе is_admin нельзя
  const selfAdmin = await api("PATCH", "/api/collections/users/records/" + created.json.id, { is_admin: true }, ownerToken);
  assert.notEqual(selfAdmin.status, 200);
  assert.equal((await api("GET", "/api/collections/users/records/" + created.json.id, undefined, suToken)).json.is_admin, false);

  const imp = await api("POST", "/api/v1/admin/events", { slug: "rwp-2026", owners: [created.json.id], note: "из фикстуры", program }, suToken);
  assert.equal(imp.status, 201, imp.text);
  assert.equal(imp.json.event.slug, "rwp-2026");
  assert.equal(imp.json.event.status, "draft");
  assert.equal(imp.json.event.version, 1);
  assert.equal((await api("POST", "/api/v1/admin/events", { slug: "rwp-2026", program }, suToken)).status, 409);

  // без slug адрес строится из названия и года; занятый получает суффикс
  const auto = await api("POST", "/api/v1/admin/events", program, suToken);
  assert.equal(auto.status, 201, auto.text);
  assert.equal(auto.json.event.slug, "rwp-2026-2");

  // черновик: чужим — 404, владельцу и суперпользователю — программа без потерь
  assert.equal((await api("GET", "/api/v1/events/rwp-2026/program")).status, 404);
  assert.equal((await api("GET", "/api/v1/events/rwp-2026/program", undefined, strangerToken)).status, 404);
  // и напрямую через коллекции черновики (в том числе без владельцев) не видны
  for (const name of ["events", "items", "sessions", "program_versions"]) {
    for (const token of [undefined, strangerToken]) {
      const r = await api("GET", `/api/collections/${name}/records`, undefined, token);
      assert.equal(r.json.totalItems, 0, `${name} ${token ? "чужой" : "аноним"}`);
    }
  }
  const mine = await api("GET", "/api/v1/events/rwp-2026/program", undefined, ownerToken);
  assert.equal(mine.status, 200, mine.text);
  assert.deepEqual(mine.json.program, expected);
  const byId = await api("GET", `/api/v1/events/${imp.json.event.id}/program`, undefined, suToken);
  assert.deepEqual(byId.json.program, expected);

  // владелец заменяет программу → версия 2, коды элементов прежние
  const changed = JSON.parse(JSON.stringify(expected));
  changed.days[0].sessions[0].items[0].title = "Новое название доклада";
  assert.equal((await api("PUT", "/api/v1/events/rwp-2026/program", { program: changed }, strangerToken)).status, 404);
  const put = await api("PUT", "/api/v1/events/rwp-2026/program", { program: changed, note: "правка" }, ownerToken);
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.event.version, 2);
  const after = await api("GET", "/api/v1/events/rwp-2026/program", undefined, ownerToken);
  assert.deepEqual(after.json.program, changed);
  assert.equal(after.json.program.days[0].sessions[0].items[0].code, "s1-1");

  // программа с ошибками не сохраняется, версия не растёт
  const rejected = await api("PUT", "/api/v1/events/rwp-2026/program", fixture("rwp-2026.broken.json"), ownerToken);
  assert.equal(rejected.status, 422);
  assert.deepEqual((await api("GET", "/api/v1/events/rwp-2026/program", undefined, ownerToken)).json.program, changed);

  const versions = await api("GET", `/api/collections/program_versions/records?filter=${encodeURIComponent(`event="${imp.json.event.id}"`)}&sort=no`, undefined, ownerToken);
  assert.equal(versions.status, 200, versions.text);
  assert.deepEqual(versions.json.items.map(v => [v.no, v.source]), [[1, "import"], [2, "api"]]);
  assert.equal(versions.json.items[1].author, created.json.id);
  assert.deepEqual(versions.json.items[1].doc, changed);

  // история через /api/v1: новые сверху, с автором; одна версия целиком; чужим — 404
  const hist = await api("GET", "/api/v1/events/rwp-2026/versions", undefined, ownerToken);
  assert.equal(hist.status, 200, hist.text);
  assert.deepEqual(hist.json.versions.map(v => [v.no, v.source, v.note]), [[2, "api", "правка"], [1, "import", "из фикстуры"]]);
  assert.equal(hist.json.versions[0].author, "owner@example.com");
  assert.equal(hist.json.versions[0].stats.items, M.normalize(changed).report.stats.items);
  assert.equal((await api("GET", "/api/v1/events/rwp-2026/versions", undefined, strangerToken)).status, 404);
  const v1 = await api("GET", "/api/v1/events/rwp-2026/versions/1", undefined, ownerToken);
  assert.deepEqual(v1.json.program, expected);
  assert.equal((await api("GET", "/api/v1/events/rwp-2026/versions/9", undefined, ownerToken)).status, 404);

  // base_version: правка по устаревшей копии — 409, версия не растёт
  const stale = await api("PUT", "/api/v1/events/rwp-2026/program", { program: expected, base_version: 1 }, ownerToken);
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json.version, 2);
  assert.equal((await api("PUT", "/api/v1/events/rwp-2026/program", { program: changed, base_version: "2" }, ownerToken)).status, 400);
  const fresh = await api("PUT", "/api/v1/events/rwp-2026/program", { program: changed, base_version: 2, note: "без изменений" }, ownerToken);
  assert.equal(fresh.status, 200, fresh.text);
  assert.equal(fresh.json.event.version, 3);

  // строки не дублируются после замены
  const items = await api("GET", `/api/collections/items/records?perPage=1&filter=${encodeURIComponent(`event="${imp.json.event.id}"`)}`, undefined, suToken);
  assert.equal(items.json.totalItems, M.normalize(changed).report.stats.items);

  // напрямую записи менять нельзя даже владельцу — только через /api/v1
  const item = (await api("GET", `/api/collections/items/records?perPage=1&filter=${encodeURIComponent(`event="${imp.json.event.id}"`)}`, undefined, ownerToken)).json.items[0];
  assert.notEqual((await api("PATCH", "/api/collections/items/records/" + item.id, { title: "x" }, ownerToken)).status, 200);

  // календарь .ics: черновик — только владельцу и без кэша
  assert.equal((await api("GET", "/api/v1/events/rwp-2026/program.ics")).status, 404);
  const draftIcs = await api("GET", "/api/v1/events/rwp-2026/program.ics", undefined, ownerToken);
  assert.equal(draftIcs.status, 200);
  assert.match(draftIcs.cache, /no-store/);

  // после публикации программа доступна всем
  await api("PATCH", "/api/collections/events/records/" + imp.json.event.id, { status: "published" }, suToken);
  const ics = await api("GET", "/api/v1/events/rwp-2026/program.ics");
  assert.equal(ics.status, 200);
  assert.match(ics.type, /^text\/calendar/);
  assert.match(ics.cache, /public/);
  const icsExpected = require("../../shared/ics.js").toIcs(changed, { uid: "rwp-2026" });
  const events = s => (s.match(/BEGIN:VEVENT/g) || []).length;
  assert.equal(events(ics.text), events(icsExpected));
  assert.match(ics.text, /DTSTART:20261007T060000Z/);
  assert.match(ics.text.replace(/\r\n /g, ""), /URL:http:\/\/127\.0\.0\.1:\d+\/#\/e\/rwp-2026/);
  const one = await api("GET", "/api/v1/events/rwp-2026/program.ics?item=s1-2");
  assert.equal(events(one.text), 1);
  assert.equal((await api("GET", "/api/v1/events/rwp-2026/program.ics?item=zz9")).status, 404);
  const perItem = await api("GET", "/api/v1/events/rwp-2026/program.ics?items=1");
  assert.ok((perItem.text.match(/BEGIN:VEVENT/g) || []).length > (ics.text.match(/BEGIN:VEVENT/g) || []).length);
  const pub = await api("GET", "/api/v1/events/rwp-2026/program");
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.json.program, changed);
  assert.equal((await api("PUT", "/api/v1/events/rwp-2026/program", { program: changed })).status, 403);
  const listed = await api("GET", "/api/collections/events/records");
  assert.deepEqual(listed.json.items.map(e => e.slug), ["rwp-2026"]);
});

t("РРВ-2023: 164 элемента в параллельных залах сохраняются и читаются без потерь", async () => {
  const program = fixture("rrv-2023.program.json");
  const imp = await api("POST", "/api/v1/admin/events", { program }, suToken);
  assert.equal(imp.status, 201, imp.text);
  assert.equal(imp.json.event.slug, "xxviii-vserossiyskaya-otkrytaya-2023");
  const got = await api("GET", `/api/v1/events/${imp.json.event.id}/program`, undefined, suToken);
  assert.deepEqual(got.json.program, M.normalize(program).doc);
});
