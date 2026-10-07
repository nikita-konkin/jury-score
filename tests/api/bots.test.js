"use strict";
// Этап 2: API-ключи, черновики ботов, приглашения, публикация, обратная связь (см. pb_server.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const M = require("../../shared/model.js");

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, "../../fixtures", name), "utf8"));
const srv = require("./pb_server.js").setup(test);
const { api, login, t } = srv;
const K = key => ({ "X-API-Key": key });
const claimToken = url => url.split("#/claim/")[1];
const previewToken = url => url.split("#/preview/")[1];

// Небольшая программа; extra-поле stand у доклада — данные вне схемы
const small = (title, more) => Object.assign({
  schema: "conf.program/v1",
  event: { title: title, date_from: "2026-11-10" },
  sections: [{ no: 1, title: "Секция" }],
  days: [{ date: "2026-11-10", sessions: [{ title: "Заседание", room: "ауд. 1", start: "10:00", items: [
    { type: "talk", section: 1, title: "Первый доклад", speaker: "А. А. Иванов" },
    { type: "talk", section: 1, title: "Второй доклад", speaker: "Б. Б. Петров" },
  ] }] }],
}, more);

let su, botKey, readerKey;
function newKey(name, scopes) {
  const r = srv.cli(["apikey", "create", name].concat(scopes ? [scopes] : []));
  assert.equal(r.status, 0, r.stderr);
  return /(ck_[a-z0-9]{8}_[A-Za-z0-9]{32})/.exec(r.stdout + r.stderr)[1];
}

test.before(async () => {
  await srv.ready;
  if (!srv.available) return;
  su = srv.suToken;
  botKey = newKey("Claude — тест");
  readerKey = newKey("Только чтение", "read_own,send_feedback");
});

t("ключи: нет, неверный формат, чужой, без права, отозванный; Bearer тоже работает", async () => {
  const doc = small("Проверка ключей");
  assert.equal((await api("POST", "/api/v1/events", doc)).status, 401);
  assert.equal((await api("POST", "/api/v1/events", doc, K("abc"))).status, 401);
  assert.equal((await api("POST", "/api/v1/events", doc, K("ck_aaaaaaaa_" + "x".repeat(32)))).status, 401);
  assert.equal((await api("POST", "/api/v1/events", doc, K(readerKey))).status, 403);
  const bearer = await api("POST", "/api/v1/events", doc, "Bearer " + botKey);
  assert.equal(bearer.status, 201, bearer.text);

  const tmp = newKey("Отзываемый");
  srv.cli(["apikey", "revoke", tmp.split("_")[1]]);
  const revoked = await api("POST", "/api/v1/events", doc, K(tmp));
  assert.equal(revoked.status, 401);
  assert.match(revoked.json.message, /отозван/);
});

t("черновик бота: токены, чтение и правка по X-Draft-Token, предпросмотр, программа с ошибками не сохраняется", async () => {
  const bad = await api("POST", "/api/v1/events", fixture("rwp-2026.broken.json"), K(botKey));
  assert.equal(bad.status, 422);
  assert.ok(bad.json.report.errors.length);

  const r = await api("POST", "/api/v1/events", { program: fixture("rwp-2026.program.json"), note: "из PDF" }, K(botKey));
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.event.status, "draft");
  assert.equal(r.json.event.claimed, false);
  assert.match(r.json.draft_token, /^dt_/);
  assert.match(r.json.invite_url, /#\/claim\/inv_/);
  assert.match(r.json.preview_url, /#\/preview\/pv_/);
  const id = r.json.event.id;
  const expected = M.normalize(fixture("rwp-2026.program.json")).doc;

  assert.equal((await api("GET", `/api/v1/events/${id}/program`)).status, 404);
  assert.equal((await api("GET", `/api/v1/events/${id}/program`, undefined, { "X-Draft-Token": "dt_wrong" })).status, 404);
  const byDraft = await api("GET", `/api/v1/events/${id}/program`, undefined, { "X-Draft-Token": r.json.draft_token });
  assert.deepEqual(byDraft.json.program, expected);
  assert.deepEqual((await api("GET", `/api/v1/events/${id}/program`, undefined, K(botKey))).json.program, expected);
  assert.deepEqual((await api("GET", `/api/v1/preview/${previewToken(r.json.preview_url)}`)).json.program, expected);

  const changed = JSON.parse(JSON.stringify(expected));
  changed.event.subtitle = "Правка бота";
  const put = await api("PUT", `/api/v1/events/${id}/program`, { program: changed }, { "X-Draft-Token": r.json.draft_token, "X-Conf-Client": "mcp/test" });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.event.version, 2);
  const versions = await api("GET", `/api/collections/program_versions/records?sort=no&filter=${encodeURIComponent(`event="${id}"`)}`, undefined, su);
  assert.deepEqual(versions.json.items.map(v => v.source), ["api", "mcp"]);
  assert.ok(versions.json.items.every(v => v.api_key));

  // секреты (хэши) не попадают в ответы API — их видит только суперпользователь
  const adm = { email: "adm@example.com", password: "adm-pass-12345", passwordConfirm: "adm-pass-12345" };
  await api("POST", "/api/collections/users/records", adm, su);
  srv.cli(["admin", adm.email]);
  const rec = await api("GET", `/api/collections/events/records/${id}`, undefined, await login("users", adm.email, adm.password));
  assert.equal(rec.status, 200, rec.text);
  ["draft_token_hash", "invite_hash", "preview_hash", "idempotency_key"].forEach(k => assert.equal(rec.json[k], undefined, k));
});

t("Idempotency-Key: повтор возвращает то же мероприятие с новыми токенами", async () => {
  const h = Object.assign(K(botKey), { "Idempotency-Key": "req-42" });
  const first = await api("POST", "/api/v1/events", small("Идемпотентность"), h);
  assert.equal(first.status, 201, first.text);
  const again = await api("POST", "/api/v1/events", small("Идемпотентность"), h);
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.replay, true);
  assert.equal(again.json.event.id, first.json.event.id);
  assert.notEqual(again.json.draft_token, first.json.draft_token);
  const id = first.json.event.id;
  assert.equal((await api("GET", `/api/v1/events/${id}/program`, undefined, { "X-Draft-Token": first.json.draft_token })).status, 404);
  assert.equal((await api("GET", `/api/v1/events/${id}/program`, undefined, { "X-Draft-Token": again.json.draft_token })).status, 200);
});

t("лимиты ключа: мероприятий в сутки и размер документа", async () => {
  const key = newKey("С лимитами");
  const prefix = key.split("_")[1];
  const rec = (await api("GET", `/api/collections/api_keys/records?filter=${encodeURIComponent(`prefix="${prefix}"`)}`, undefined, su)).json.items[0];
  await api("PATCH", `/api/collections/api_keys/records/${rec.id}`, { max_events_per_day: 2, max_doc_kb: 3 }, su);
  assert.equal((await api("POST", "/api/v1/events", small("Лимит 1"), K(key))).status, 201);
  assert.equal((await api("POST", "/api/v1/events", fixture("rwp-2026.broken.json"), K(key))).status, 413);
  assert.equal((await api("POST", "/api/v1/events", small("Лимит 2"), K(key))).status, 201);
  const third = await api("POST", "/api/v1/events", small("Лимит 3"), K(key));
  assert.equal(third.status, 429);
  assert.match(third.json.message, /2 мероприятий в сутки/);
});

t("приглашение: предпросмотр, новый аккаунт, одноразовость, черновой токен гаснет, публикует только человек", async () => {
  const r = await api("POST", "/api/v1/events", small("Школа-семинар"), K(botKey));
  const id = r.json.event.id;
  const draft = { "X-Draft-Token": r.json.draft_token };

  // новое приглашение по черновому токену — старое перестаёт действовать
  const inv2 = await api("POST", `/api/v1/events/${id}/invite`, undefined, draft);
  assert.equal(inv2.status, 200, inv2.text);
  assert.equal((await api("GET", `/api/v1/claim/${claimToken(r.json.invite_url)}`)).status, 404);
  const token = claimToken(inv2.json.invite_url);

  const look = await api("GET", `/api/v1/claim/${token}`);
  assert.equal(look.status, 200, look.text);
  assert.equal(look.json.prepared_by, "Claude — тест");
  assert.equal(look.json.program.event.title, "Школа-семинар");

  // боты публиковать не могут
  assert.equal((await api("POST", `/api/v1/events/${id}/publish`, undefined, draft)).status, 403);
  assert.equal((await api("POST", `/api/v1/events/${id}/publish`, undefined, K(botKey))).status, 403);

  // e-mail занят → 409; короткий пароль → 400
  const taken = { email: "taken@example.com", password: "taken-pass-123", passwordConfirm: "taken-pass-123" };
  assert.equal((await api("POST", "/api/collections/users/records", taken, su)).status, 200);
  assert.equal((await api("POST", `/api/v1/claim/${token}`, { email: "TAKEN@example.com", password: "x".repeat(10) })).status, 409);
  assert.equal((await api("POST", `/api/v1/claim/${token}`, { email: "new@example.com", password: "short" })).status, 400);

  const claim = await api("POST", `/api/v1/claim/${token}`, { email: "owner2@example.com", password: "owner2-pass-123", name: "Организатор" });
  assert.equal(claim.status, 200, claim.text);
  assert.ok(claim.json.token);
  assert.equal(claim.json.record.email, "owner2@example.com");
  assert.equal(claim.json.meta.event.claimed, true);
  const owner = claim.json.token;

  assert.equal((await api("POST", `/api/v1/claim/${token}`, { email: "other@example.com", password: "other-pass-123" })).status, 404);
  assert.equal((await api("GET", `/api/v1/events/${id}/program`, undefined, draft)).status, 404);
  // ключ, создавший черновик, продолжает работать (read_own, update_own)
  assert.equal((await api("GET", `/api/v1/events/${id}/program`, undefined, K(botKey))).status, 200);
  assert.equal((await api("GET", `/api/v1/events/${id}/program`, undefined, owner)).status, 200);
  assert.equal((await api("POST", `/api/v1/events/${id}/invite`, undefined, K(botKey))).status, 403);

  // соавтор: владелец приглашает, второй пользователь принимает под своим входом
  const co = await api("POST", `/api/v1/events/${id}/invite`, undefined, owner);
  assert.equal(co.json.co_owner, true);
  const takenToken = await login("users", taken.email, taken.password);
  const coClaim = await api("POST", `/api/v1/claim/${claimToken(co.json.invite_url)}`, undefined, takenToken);
  assert.equal(coClaim.status, 200, coClaim.text);
  const ev = await api("GET", `/api/collections/events/records/${id}`, undefined, su);
  assert.equal(ev.json.owners.length, 2);

  // публикация владельцем → программа видна всем
  assert.equal((await api("GET", `/api/v1/events/${id}/program`)).status, 404);
  assert.equal((await api("POST", `/api/v1/events/${id}/publish`, undefined, owner)).json.event.status, "published");
  assert.equal((await api("GET", `/api/v1/events/${r.json.event.slug}/program`)).status, 200);

  // просроченное приглашение → 410
  const late = await api("POST", "/api/v1/events", small("Просрочка"), K(botKey));
  await api("PATCH", `/api/collections/events/records/${late.json.event.id}`, { invite_expires: "2020-01-01 00:00:00.000Z" }, su);
  assert.equal((await api("GET", `/api/v1/claim/${claimToken(late.json.invite_url)}`)).status, 410);
});

t("обратная связь: группировка, вырезание контактов, обход для ботов, changelog, авто по extra", async () => {
  assert.equal((await api("POST", "/api/v1/feedback", { kind: "bug", summary: "x" })).status, 401);
  const bad = await api("POST", "/api/v1/feedback", { kind: "wish", summary: "" }, K(botKey));
  assert.equal(bad.status, 400);
  assert.equal(bad.json.errors.length, 2);

  const first = await api("POST", "/api/v1/feedback", {
    kind: "missing_feature", area: "schema", summary: "Не хватает стендовой сессии с номерами стендов",
    details: "Пользователь просил указать номера стендов. Контакт: org@conf.ru, +7 912 345-67-89",
    workaround: "положил номер стенда в extra.stand", impact: "degraded", model: "Claude Opus 5.5",
  }, Object.assign(K(botKey), { "X-Conf-Client": "mcp/claude-desktop" }));
  assert.equal(first.status, 201, first.text);
  assert.equal(first.json.status, "new");
  assert.equal(first.json.group.count, 1);
  const second = await api("POST", "/api/v1/feedback", {
    kind: "missing_feature", area: "schema", summary: "нет поддержки стендовой сессии и номеров стендов",
  }, K(readerKey));
  assert.equal(second.json.group.id, first.json.group.id);
  assert.equal(second.json.group.count, 2);
  const other = await api("POST", "/api/v1/feedback", { kind: "missing_feature", area: "documents", summary: "Нужна выгрузка программы в Word" }, K(botKey));
  assert.notEqual(other.json.group.id, first.json.group.id);

  const stored = await api("GET", `/api/collections/feedback/records/${first.json.id}`, undefined, su);
  assert.match(stored.json.details, /Контакт: \[e-mail\], \[телефон\]/);
  assert.equal(stored.json.source, "mcp");
  assert.equal(stored.json.model, "Claude Opus 5.5");

  // администратор описал обход → следующий похожий запрос получает его сразу
  await api("PATCH", `/api/collections/feedback_groups/records/${first.json.group.id}`, { status: "planned", workaround: "Пока используйте extra.stand у элемента" }, su);
  const third = await api("POST", "/api/v1/feedback", { kind: "missing_feature", area: "schema", summary: "Стендовая сессия: номера стендов" }, K(botKey));
  assert.equal(third.json.known_workaround, "Пока используйте extra.stand у элемента");
  assert.equal(third.json.status, "planned");

  await api("PATCH", `/api/collections/feedback_groups/records/${first.json.group.id}`, { status: "done", done_at: "2026-10-09 10:00:00.000Z", changelog: "Стендовые сессии: поле stand у элемента" }, su);
  const log = await api("GET", "/api/v1/changelog");
  assert.equal(log.json.items[0].text, "Стендовые сессии: поле stand у элемента");
  assert.ok(log.json.items.some(i => /API v1/.test(i.text)));

  // данные вне схемы → автоматическое сообщение, повтор увеличивает счётчик той же группы
  const doc = small("С extra", {});
  doc.days[0].sessions[0].items[0].poster_no = 12;
  const c1 = await api("POST", "/api/v1/events", doc, K(botKey));
  assert.equal(c1.json.auto_feedback, 1);
  await api("POST", "/api/v1/events", doc, K(botKey));
  const auto = await api("GET", `/api/collections/feedback_groups/records?filter=${encodeURIComponent('kind="schema_limitation"')}`, undefined, su);
  assert.equal(auto.json.items.length, 1);
  assert.equal(auto.json.items[0].count, 2);
  assert.match(auto.json.items[0].title, /poster_no/);

  // черновик из ответа чат-бота вошедшим пользователем: он сразу владелец, без токенов и приглашения
  const owner = { email: "paste@example.com", password: "paste-pass-123", passwordConfirm: "paste-pass-123" };
  await api("POST", "/api/collections/users/records", owner, su);
  const ot = await login("users", owner.email, owner.password);
  const pasted = await api("POST", "/api/v1/events", { program: small("Из ответа бота") }, ot);
  assert.equal(pasted.status, 201, pasted.text);
  assert.equal(pasted.json.event.claimed, true);
  assert.equal(pasted.json.invite_url, undefined);
  assert.equal((await api("GET", `/api/v1/events/${pasted.json.event.id}/program`, undefined, ot)).status, 200);
  const pfb = await api("POST", "/api/v1/feedback", { kind: "missing_feature", area: "documents", summary: "Нужен бейдж участника", source: "paste" }, ot);
  assert.equal((await api("GET", "/api/collections/feedback/records/" + pfb.json.id, undefined, su)).json.source, "paste");

  // обратная связь от вошедшего пользователя, лента — только администратору
  const u = { email: "fb@example.com", password: "fb-pass-12345", passwordConfirm: "fb-pass-12345" };
  await api("POST", "/api/collections/users/records", u, su);
  const ut = await login("users", u.email, u.password);
  const fromUser = await api("POST", "/api/v1/feedback", { kind: "bug", area: "ui", summary: "Кнопка не нажимается" }, ut);
  assert.equal(fromUser.status, 201);
  assert.equal((await api("GET", "/api/collections/feedback/records", undefined, ut)).json.totalItems, 0);
});

t("администратор: выдача ключа через API; очистка непринятых черновиков", async () => {
  const u = { email: "boss@example.com", password: "boss-pass-12345", passwordConfirm: "boss-pass-12345" };
  await api("POST", "/api/collections/users/records", u, su);
  let token = await login("users", u.email, u.password);
  assert.equal((await api("POST", "/api/v1/admin/keys", { name: "x" })).status, 401);
  assert.equal((await api("POST", "/api/v1/admin/keys", { name: "x" }, token)).status, 403);
  assert.equal(srv.cli(["admin", u.email]).status, 0);
  token = await login("users", u.email, u.password);
  const k = await api("POST", "/api/v1/admin/keys", { name: "GigaChat", scopes: ["create_events", "send_feedback"] }, token);
  assert.equal(k.status, 201, k.text);
  assert.deepEqual(k.json.scopes, ["create_events", "send_feedback"]);
  assert.equal((await api("POST", "/api/v1/events", small("От GigaChat"), K(k.json.key))).status, 201);
  const used = await api("GET", `/api/collections/api_keys/records/${k.json.id}`, undefined, su);
  assert.ok(used.json.last_used, "last_used отмечен");
  // администратор видит черновики, обычный пользователь — нет
  assert.ok((await api("GET", "/api/collections/events/records?perPage=200", undefined, token)).json.totalItems > 0);

  const before = (await api("GET", "/api/collections/events/records?perPage=200", undefined, su)).json.items;
  const claimed = before.filter(e => e.owners.length || e.status === "published").length;
  const del = await api("POST", "/api/v1/admin/cleanup?days=0", undefined, su);
  assert.equal(del.status, 200, del.text);
  const after = (await api("GET", "/api/collections/events/records?perPage=200", undefined, su)).json.items;
  assert.equal(del.json.deleted, before.length - claimed);
  assert.ok(after.every(e => e.owners.length || e.status === "published"));
  assert.equal((await api("POST", "/api/v1/admin/cleanup?days=0", undefined, token)).status, 403);
});
