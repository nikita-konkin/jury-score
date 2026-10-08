/// <reference path="../pb_data/types.d.ts" />
// Этап 9: задачи для локального обработчика. Владелец ставит задачу (текст материалов), обработчик на его ПК
// забирает её по API-ключу с правом process_jobs, прогоняет через локальную модель и возвращает результат.
// Все правила null: только через /api/v1/events/{id}/jobs и /api/v1/jobs/*. Текст задачи стирается,
// когда результат применён или задача отменена; старые задачи удаляет плановая задача.
migrate((app) => {
  const events = app.findCollectionByNameOrId("events");
  const users = app.findCollectionByNameOrId("users");
  const keys = app.findCollectionByNameOrId("api_keys");
  const col = new Collection({
    type: "base", name: "jobs",
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { type: "relation", name: "event", required: true, collectionId: events.id, cascadeDelete: true, maxSelect: 1 },
      { type: "text", name: "kind", required: true, max: 40 }, // program_from_text, talks_from_text
      { type: "text", name: "status", required: true, max: 20 }, // queued, running, done, failed, cancelled, applied
      { type: "text", name: "title", max: 200 },
      { type: "json", name: "input", maxSize: 2 * 1024 * 1024 },
      { type: "json", name: "result", maxSize: 2 * 1024 * 1024 },
      { type: "json", name: "report", maxSize: 200 * 1024 },
      { type: "text", name: "error", max: 2000 },
      { type: "text", name: "model", max: 200 }, // какая модель обработала
      { type: "relation", name: "created_by", collectionId: users.id, maxSelect: 1 },
      { type: "relation", name: "worker", collectionId: keys.id, maxSelect: 1 },
      { type: "number", name: "attempts", onlyInt: true },
      { type: "date", name: "claimed_at" },
      { type: "date", name: "finished_at" },
      { type: "number", name: "applied_version", onlyInt: true },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ],
    indexes: ["CREATE INDEX idx_jobs_status ON jobs (status, created)", "CREATE INDEX idx_jobs_event ON jobs (event, created)"],
  });
  app.save(col);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("jobs"));
});
