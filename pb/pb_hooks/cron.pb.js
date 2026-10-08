/// <reference path="../pb_data/types.d.ts" />
// Плановые задачи (время сервера).

// Непринятые черновики ботов старше 30 дней
cronAdd("conf_cleanup_drafts", "30 3 * * *", () => {
  const n = require(`${__hooks}/lib/maintenance.js`).cleanupDrafts($app, 30);
  if (n) console.log(`conf-kit: удалено непринятых черновиков: ${n}`);
});

// Сводка обратной связи за сутки администраторам (если настроен SMTP)
cronAdd("conf_feedback_digest", "0 8 * * *", () => {
  require(`${__hooks}/lib/maintenance.js`).feedbackDigest($app);
});

// Контакты из заявок через год после мероприятия (срок согласия на обработку персональных данных)
cronAdd("conf_purge_contacts", "45 3 * * *", () => {
  const n = require(`${__hooks}/lib/apply_store.js`).purgeContacts($app, 365);
  if (n) console.log(`conf-kit: стёрты контакты в заявках: ${n}`);
});

// Задачи локального обработчика старше 30 дней (вместе с текстом материалов и результатом)
cronAdd("conf_purge_jobs", "15 4 * * *", () => {
  const n = require(`${__hooks}/lib/jobs_store.js`).purge($app, 30);
  if (n) console.log(`conf-kit: удалено старых задач обработчика: ${n}`);
});
