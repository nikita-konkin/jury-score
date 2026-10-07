/// <reference path="../pb_data/types.d.ts" />
// Этап 2: API для чат-ботов — ключи, черновики с приглашением, обратная связь.
// Секреты (ключи, draft_token, приглашения) хранятся только как sha256; поля hidden не попадают в ответы API.
migrate((app) => {
  const ADMIN = "@request.auth.is_admin = true";
  const users = app.findCollectionByNameOrId("users");
  const events = app.findCollectionByNameOrId("events");
  const stamps = [
    { type: "autodate", name: "created", onCreate: true, onUpdate: false },
    { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
  ];
  const text = (name, more) => Object.assign({ type: "text", name: name }, more);
  const int = (name, more) => Object.assign({ type: "number", name: name, onlyInt: true }, more);

  // Ключи выдаёт администратор; сам ключ показывается один раз при создании
  const keys = new Collection({
    type: "base",
    name: "api_keys",
    listRule: ADMIN,
    viewRule: ADMIN,
    createRule: null,
    updateRule: ADMIN, // отзыв, лимиты, права
    deleteRule: ADMIN,
    fields: [
      text("name", { required: true }),
      text("prefix", { required: true, pattern: "^[a-z0-9]{8}$" }),
      text("hash", { required: true, hidden: true }),
      { type: "select", name: "scopes", maxSelect: 5,
        values: ["create_events", "update_own", "read_own", "send_feedback", "process_jobs"] },
      int("max_events_per_day", { min: 0 }), // 0 — по умолчанию (20)
      int("max_doc_kb", { min: 0 }), // 0 — по умолчанию (512)
      { type: "date", name: "expires" },
      { type: "bool", name: "revoked" },
      { type: "date", name: "last_used" },
      { type: "relation", name: "issued_by", collectionId: users.id, maxSelect: 1 },
      text("note"),
    ].concat(stamps),
    indexes: ["CREATE UNIQUE INDEX idx_api_keys_prefix ON api_keys (prefix)"],
  });
  app.save(keys);

  events.fields.add(new RelationField({ name: "created_by_key", collectionId: keys.id, maxSelect: 1 }));
  events.fields.add(new TextField({ name: "idempotency_key", hidden: true, max: 200 }));
  events.fields.add(new TextField({ name: "draft_token_hash", hidden: true }));
  events.fields.add(new TextField({ name: "invite_hash", hidden: true }));
  events.fields.add(new DateField({ name: "invite_expires" }));
  events.fields.add(new TextField({ name: "preview_hash", hidden: true }));
  events.fields.add(new DateField({ name: "claimed_at" }));
  events.addIndex("idx_events_idempotency", true, "created_by_key, idempotency_key", "idempotency_key != ''");
  events.addIndex("idx_events_invite", false, "invite_hash", "");
  events.addIndex("idx_events_preview", false, "preview_hash", "");
  app.save(events);

  const versions = app.findCollectionByNameOrId("program_versions");
  versions.fields.add(new RelationField({ name: "api_key", collectionId: keys.id, maxSelect: 1 }));
  app.save(versions);

  const KINDS = ["missing_feature", "schema_limitation", "bug", "unclear_docs", "validation_false_positive"];
  const AREAS = ["schema", "validate", "events", "invite", "documents", "jury", "mcp", "ui", "other"];

  // Группа похожих сообщений: счётчик, статус, обход для ботов, запись в changelog
  const groups = new Collection({
    type: "base",
    name: "feedback_groups",
    listRule: ADMIN,
    viewRule: ADMIN,
    createRule: null,
    updateRule: ADMIN,
    deleteRule: ADMIN,
    fields: [
      { type: "select", name: "kind", required: true, values: KINDS, maxSelect: 1 },
      { type: "select", name: "area", required: true, values: AREAS, maxSelect: 1 },
      text("title", { required: true, max: 300 }),
      text("signature", { hidden: true, max: 2000 }),
      int("count", { min: 0 }),
      int("blockers", { min: 0 }),
      { type: "select", name: "status", required: true, values: ["new", "planned", "done", "rejected"], maxSelect: 1 },
      text("workaround", { max: 2000 }), // обход для ботов: отдаётся в ответе на похожее сообщение
      text("changelog", { max: 2000 }), // запись для /api/v1/changelog при статусе «сделано»
      { type: "date", name: "done_at" },
      { type: "date", name: "last_at" },
    ].concat(stamps),
    indexes: ["CREATE INDEX idx_feedback_groups_kind_area ON feedback_groups (kind, area)"],
  });
  app.save(groups);

  const feedback = new Collection({
    type: "base",
    name: "feedback",
    listRule: ADMIN,
    viewRule: ADMIN,
    createRule: null,
    updateRule: null,
    deleteRule: ADMIN,
    fields: [
      { type: "relation", name: "group", collectionId: groups.id, maxSelect: 1, cascadeDelete: true },
      { type: "select", name: "kind", required: true, values: KINDS, maxSelect: 1 },
      { type: "select", name: "area", required: true, values: AREAS, maxSelect: 1 },
      text("summary", { required: true, max: 300 }),
      text("details", { max: 5000 }),
      text("workaround", { max: 2000 }),
      { type: "select", name: "impact", values: ["blocker", "degraded", "nice_to_have"], maxSelect: 1 },
      { type: "json", name: "context", maxSize: 20000 },
      text("client", { max: 200 }),
      text("model", { max: 200 }),
      { type: "select", name: "source", required: true, values: ["mcp", "api", "paste", "auto", "ui"], maxSelect: 1 },
      { type: "relation", name: "api_key", collectionId: keys.id, maxSelect: 1 },
      { type: "relation", name: "user", collectionId: users.id, maxSelect: 1 },
      { type: "relation", name: "event", collectionId: events.id, maxSelect: 1 },
    ].concat(stamps),
    indexes: [
      "CREATE INDEX idx_feedback_group ON feedback (\"group\")",
      "CREATE INDEX idx_feedback_key_created ON feedback (api_key, created)",
    ],
  });
  app.save(feedback);
}, (app) => {
  ["feedback", "feedback_groups"].forEach((name) => app.delete(app.findCollectionByNameOrId(name)));
  const versions = app.findCollectionByNameOrId("program_versions");
  versions.fields.removeByName("api_key");
  app.save(versions);
  const events = app.findCollectionByNameOrId("events");
  ["created_by_key", "idempotency_key", "draft_token_hash", "invite_hash", "invite_expires", "preview_hash", "claimed_at"]
    .forEach((name) => events.fields.removeByName(name));
  ["idx_events_idempotency", "idx_events_invite", "idx_events_preview"].forEach((name) => events.removeIndex(name));
  app.save(events);
  app.delete(app.findCollectionByNameOrId("api_keys"));
});
