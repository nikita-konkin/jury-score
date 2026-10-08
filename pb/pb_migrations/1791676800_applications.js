/// <reference path="../pb_data/types.d.ts" />
// Этап 7: заявки на доклады. Пишутся и читаются только через хуки (/api/apply/*, /api/v1/events/{id}/applications),
// все правила null. Контакты (email, phone) — персональные данные: видит только владелец мероприятия,
// через год после мероприятия их стирает плановая задача, при отзыве согласия — сразу.
migrate((app) => {
  const events = app.findCollectionByNameOrId("events");
  const users = app.findCollectionByNameOrId("users");
  const col = new Collection({
    type: "base", name: "applications",
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { type: "relation", name: "event", required: true, collectionId: events.id, cascadeDelete: true, maxSelect: 1 },
      { type: "number", name: "no", onlyInt: true, min: 1 }, // номер заявки в мероприятии
      { type: "text", name: "status", required: true, max: 20 }, // new, accepted, rejected, withdrawn
      { type: "text", name: "speaker", required: true, max: 200 },
      { type: "json", name: "authors", maxSize: 4000 },
      { type: "text", name: "title", required: true, max: 600 },
      { type: "number", name: "section", onlyInt: true },
      { type: "text", name: "format", max: 20 },
      { type: "text", name: "org", max: 300 },
      { type: "text", name: "city", max: 100 },
      { type: "text", name: "email", max: 200 },
      { type: "text", name: "phone", max: 40 },
      { type: "text", name: "note", max: 2000 },
      { type: "text", name: "consent_text", max: 4000 }, // текст согласия, как его видел участник
      { type: "date", name: "consent_at" },
      { type: "text", name: "token_hash", hidden: true, max: 100 }, // ссылка участника на свою заявку
      { type: "text", name: "ip_hash", hidden: true, max: 100 }, // ограничение частоты
      { type: "text", name: "item_code", max: 40 }, // элемент программы из принятой заявки
      { type: "text", name: "reason", max: 1000 }, // причина отклонения — видит участник
      { type: "relation", name: "decided_by", collectionId: users.id, maxSelect: 1 },
      { type: "date", name: "decided_at" },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_applications_no ON applications (event, no)",
      "CREATE INDEX idx_applications_token ON applications (token_hash)",
      "CREATE INDEX idx_applications_ip ON applications (event, ip_hash, created)",
    ],
  });
  app.save(col);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("applications"));
});
