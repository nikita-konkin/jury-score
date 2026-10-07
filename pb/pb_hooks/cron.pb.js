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
