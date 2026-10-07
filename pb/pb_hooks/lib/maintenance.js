/// <reference path="../../pb_data/types.d.ts" />
// Плановые задачи: удаление непринятых черновиков и сводка обратной связи на почту.

/** Удаляет черновики без владельца старше days дней. Возвращает число удалённых. */
function cleanupDrafts(app, days) {
  const before = new DateTime().addDate(0, 0, -days).string();
  const list = app.findRecordsByFilter("events", "status = 'draft' && owners:length = 0 && created <= {:t}", "", 1000, 0, { t: before });
  list.forEach((ev) => app.delete(ev));
  return list.length;
}

/**
 * Сводка новой обратной связи за сутки администраторам (users.is_admin).
 * Отправляется, только если в настройках PocketBase включён SMTP. Возвращает текст сводки.
 */
function feedbackDigest(app) {
  const since = new DateTime().addDate(0, 0, -1).string();
  const items = app.findRecordsByFilter("feedback", "created >= {:t}", "-created", 500, 0, { t: since });
  if (!items.length) return "";
  const byGroup = {};
  items.forEach((f) => {
    const g = f.getString("group");
    (byGroup[g] = byGroup[g] || []).push(f);
  });
  const lines = Object.keys(byGroup).map((gid) => {
    const list = byGroup[gid];
    let total = list.length, title = list[0].getString("summary"), status = "";
    try {
      const g = app.findRecordById("feedback_groups", gid);
      total = g.getInt("count"); title = g.getString("title"); status = g.getString("status");
    } catch (err) { /* группа удалена */ }
    const blockers = list.filter((f) => f.getString("impact") === "blocker").length;
    return `• ${title} — +${list.length} за сутки, всего ${total}${blockers ? `, blocker ×${blockers}` : ""}${status ? ` [${status}]` : ""}`;
  });
  const text = `Обратная связь за сутки: ${items.length} сообщ., групп: ${lines.length}\n\n${lines.join("\n")}`;
  if (!app.settings().smtp.enabled) return text;
  const admins = app.findRecordsByFilter("users", "is_admin = true", "", 20, 0);
  admins.forEach((u) => {
    try {
      app.newMailClient().send(new MailerMessage({
        from: { address: app.settings().meta.senderAddress, name: app.settings().meta.senderName },
        to: [{ address: u.email() }],
        subject: `conf-kit: обратная связь (${items.length})`,
        text: text,
      }));
    } catch (err) {
      console.log("digest mail:", err);
    }
  });
  return text;
}

module.exports = { cleanupDrafts, feedbackDigest };
