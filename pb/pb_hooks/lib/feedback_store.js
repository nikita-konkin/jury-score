/// <reference path="../../pb_data/types.d.ts" />
// Обратная связь: сохранение с группировкой похожих сообщений, лимиты, changelog.

const F = require(`${__hooks}/../../shared/feedback.js`);

const PER_HOUR = { key: 60, user: 30 };

// Записи в changelog, не связанные с обратной связью
const STATIC_CHANGELOG = [
  { date: "2026-10-08", text: "API v1: проверка программы, черновик мероприятия по API-ключу, ссылка-приглашение, версии программы, обратная связь." },
];

/** Сколько сообщений отправлено ключом или пользователем за последний час. */
function recentCount(app, field, id) {
  const since = new DateTime().add(-3600 * 1000 * 1000 * 1000).string();
  return app.findRecordsByFilter("feedback", `${field} = {:id} && created >= {:t}`, "", 500, 0, { id: id, t: since }).length;
}

/**
 * Сохраняет нормализованное сообщение (см. F.normalizeFeedback) и относит его к группе.
 * meta: { source, apiKey?, user?, event? }. Возвращает { record, group }.
 */
function addFeedback(app, item, meta) {
  let record = null, group = null;
  app.runInTransaction((tx) => {
    const sig = F.signature(item.summary + " " + (item.context.field || ""));
    const candidates = tx.findRecordsByFilter("feedback_groups", "kind = {:k} && area = {:a}", "-last_at", 300, 0,
      { k: item.kind, a: item.area });
    const best = F.bestGroup(sig, candidates.map((g) => ({ rec: g, signature: g.getString("signature").split(" ").filter(Boolean) })));
    group = best ? best.rec : new Record(tx.findCollectionByNameOrId("feedback_groups"));
    if (!best) {
      group.set("kind", item.kind);
      group.set("area", item.area);
      group.set("title", item.summary);
      group.set("signature", sig.join(" "));
      group.set("status", "new");
    }
    group.set("count", group.getInt("count") + 1);
    if (item.impact === "blocker") group.set("blockers", group.getInt("blockers") + 1);
    group.set("last_at", new DateTime());
    tx.save(group);

    record = new Record(tx.findCollectionByNameOrId("feedback"));
    record.set("group", group.id);
    ["kind", "area", "summary", "details", "workaround", "impact", "context", "client", "model"]
      .forEach((k) => record.set(k, item[k]));
    record.set("source", meta.source);
    if (meta.apiKey) record.set("api_key", meta.apiKey);
    if (meta.user) record.set("user", meta.user);
    if (meta.event) record.set("event", meta.event);
    tx.save(record);
  });
  if (item.impact === "blocker") notifyBlocker(item, group);
  return { record: record, group: group };
}

function answer(res) {
  const out = { ok: true, id: res.record.id, status: res.group.getString("status"),
    group: { id: res.group.id, count: res.group.getInt("count") } };
  const w = res.group.getString("workaround");
  if (w) out.known_workaround = w;
  return out;
}

// Telegram о каждом blocker — только если заданы TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID
function notifyBlocker(item, group) {
  const token = $os.getenv("TELEGRAM_BOT_TOKEN"), chat = $os.getenv("TELEGRAM_CHAT_ID");
  if (!token || !chat) return;
  try {
    $http.send({
      url: `https://api.telegram.org/bot${token}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: `conf-kit · blocker (${item.kind}/${item.area}, ×${group.getInt("count")}):\n${item.summary}` }),
      timeout: 5,
    });
  } catch (err) {
    console.log("telegram:", err);
  }
}

/** Автоматические сообщения «данные вне схемы» по отчёту проверки. */
function addExtraFeedback(app, report, meta) {
  return F.fromExtraWarnings(report).map((raw) => {
    const n = F.normalizeFeedback(Object.assign({}, raw, { client: meta.client, model: meta.model }));
    return answer(addFeedback(app, n.item, meta));
  });
}

function changelog(app) {
  const done = app.findRecordsByFilter("feedback_groups", "status = 'done'", "-done_at", 100, 0).map((g) => ({
    date: g.getDateTime("done_at").isZero() ? g.getDateTime("updated").string().slice(0, 10) : g.getDateTime("done_at").string().slice(0, 10),
    text: g.getString("changelog") || g.getString("title"),
    kind: g.getString("kind"),
    area: g.getString("area"),
  }));
  return done.concat(STATIC_CHANGELOG).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

module.exports = { F, PER_HOUR, recentCount, addFeedback, addExtraFeedback, answer, changelog };
