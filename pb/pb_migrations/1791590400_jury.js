/// <reference path="../pb_data/types.d.ts" />
// Этап 6: жюри — коды комиссии у мероприятия и оценки докладов (перенос jury-score с Google-таблицы).
// Оценки пишутся только через /api/jury/{id} (все правила null). Строка — эксперт × доклад, upsert по ts.
// Удалённые оценки эксперта не стираются, а переносятся в scores_deleted (как лист «Удалённые»).
migrate((app) => {
  const events = app.findCollectionByNameOrId("events");
  // коды видны владельцу через /api/v1/events/{id}/jury; hidden — не попадают в публичные ответы
  events.fields.add(new TextField({ name: "jury_code", hidden: true, max: 40 }));
  events.fields.add(new TextField({ name: "jury_admin_code", hidden: true, max: 40 }));
  app.save(events);

  const stamps = [
    { type: "autodate", name: "created", onCreate: true, onUpdate: false },
    { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
  ];
  const fields = () => [
    { type: "relation", name: "event", required: true, collectionId: events.id, cascadeDelete: true, maxSelect: 1 },
    { type: "text", name: "code", required: true, max: 40 }, // код элемента программы, s1-3
    { type: "text", name: "title", max: 600 },
    { type: "text", name: "juror", required: true, max: 100 },
    { type: "text", name: "juror_key", required: true, max: 100 },
    { type: "json", name: "scores", maxSize: 4000 },
    { type: "number", name: "total" }, // сумма только у засчитываемой оценки, иначе 0
    { type: "bool", name: "complete" },
    { type: "text", name: "status", max: 20 }, // "", absent, abstain
    { type: "text", name: "comment", max: 2000 },
    { type: "number", name: "ts", onlyInt: true },
  ];
  const scores = new Collection({
    type: "base", name: "scores",
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: fields().concat(stamps),
    indexes: ["CREATE UNIQUE INDEX idx_scores_unique ON scores (event, code, juror_key)", "CREATE INDEX idx_scores_juror ON scores (event, juror_key)"],
  });
  app.save(scores);

  const deleted = new Collection({
    type: "base", name: "scores_deleted",
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: fields().concat([
      { type: "text", name: "deleted_by", max: 100 },
      { type: "date", name: "deleted_at" },
    ], stamps),
    indexes: ["CREATE INDEX idx_scores_deleted_event ON scores_deleted (event)"],
  });
  app.save(deleted);
}, (app) => {
  ["scores_deleted", "scores"].forEach((name) => app.delete(app.findCollectionByNameOrId(name)));
  const events = app.findCollectionByNameOrId("events");
  ["jury_code", "jury_admin_code"].forEach((name) => events.fields.removeByName(name));
  app.save(events);
});
