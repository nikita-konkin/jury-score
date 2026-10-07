/// <reference path="../pb_data/types.d.ts" />
// Этап 1: мероприятия и программа conf.program/v1 в разобранном виде.
// Поля строк совпадают с ROW_FIELDS в shared/model.js, типы и формы — с ITEM_TYPES и FORMATS.
// Запись в эти коллекции идёт только через pb_hooks (они проверяют программу), поэтому
// createRule/updateRule/deleteRule = null: напрямую писать может только суперпользователь.
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.add(new BoolField({ name: "is_admin" }));
  // аккаунты появляются по приглашению или от администратора; флаг is_admin себе не поставить
  users.createRule = null;
  users.updateRule = "id = @request.auth.id && @request.body.is_admin:isset = false";
  app.save(users);

  const ADMIN = "@request.auth.is_admin = true";
  const stamps = [
    { type: "autodate", name: "created", onCreate: true, onUpdate: false },
    { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
  ];
  const text = (name, more) => Object.assign({ type: "text", name: name }, more);
  const int = (name, more) => Object.assign({ type: "number", name: name, onlyInt: true }, more);
  const bool = name => ({ type: "bool", name: name });
  const json = name => ({ type: "json", name: name });

  const events = new Collection({
    type: "base",
    name: "events",
    listRule: `status = "published" || (@request.auth.id != "" && owners.id ?= @request.auth.id) || ${ADMIN}`,
    viewRule: `status = "published" || (@request.auth.id != "" && owners.id ?= @request.auth.id) || ${ADMIN}`,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      text("slug", { required: true, pattern: "^[a-z0-9][a-z0-9-]{1,62}$" }),
      text("title", { required: true }),
      text("date_from"),
      text("date_to"),
      { type: "select", name: "status", required: true, values: ["draft", "published"], maxSelect: 1 },
      { type: "relation", name: "owners", collectionId: users.id, maxSelect: 50 },
      json("info"), // объект event из документа программы
      int("version"), // номер текущей версии программы
    ].concat(stamps),
    indexes: ["CREATE UNIQUE INDEX idx_events_slug ON events (slug)"],
  });
  app.save(events);

  const CHILD = `event.status = "published" || (@request.auth.id != "" && event.owners.id ?= @request.auth.id) || ${ADMIN}`;
  const child = (name, fields, indexes) => {
    const c = new Collection({
      type: "base",
      name: name,
      listRule: CHILD,
      viewRule: CHILD,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { type: "relation", name: "event", required: true, collectionId: events.id, cascadeDelete: true, maxSelect: 1 },
        int("sort"),
      ].concat(fields, stamps),
      indexes: [`CREATE INDEX idx_${name}_event ON ${name} (event)`].concat(indexes || []),
    });
    app.save(c);
    return c;
  };

  child("rooms", [text("name", { required: true }), text("building"), json("extra")]);
  child("sections", [int("no", { required: true, min: 1 }), text("title"), text("short"), json("extra")]);
  const days = child("days", [text("date", { required: true, pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), text("title"), json("extra")]);
  const sessions = child("sessions", [
    { type: "relation", name: "day", required: true, collectionId: days.id, cascadeDelete: true, maxSelect: 1 },
    text("title"), text("room"), text("start"), text("end"),
    text("chair"), text("cochair"), text("secretary"), json("extra"),
  ], ["CREATE INDEX idx_sessions_day ON sessions (day)"]);
  child("items", [
    { type: "relation", name: "session", required: true, collectionId: sessions.id, cascadeDelete: true, maxSelect: 1 },
    { type: "select", name: "type", required: true, values: ["talk", "plenary", "break", "lunch", "activity", "ceremony"], maxSelect: 1 },
    text("code", { required: true }),
    int("section"),
    text("title"),
    json("authors"),
    text("speaker"),
    { type: "select", name: "format", values: ["oral", "online", "poster"], maxSelect: 1 },
    text("org"), text("city"), text("room"), text("note"),
    bool("competitive"), bool("all_day"),
    text("start"), text("end"), int("duration"), bool("anchor"),
    json("extra"),
  ], [
    "CREATE UNIQUE INDEX idx_items_event_code ON items (event, code)",
    "CREATE INDEX idx_items_session ON items (session)",
  ]);

  // Каждое сохранение программы — новая версия с полным документом (откат и сравнение)
  const versions = new Collection({
    type: "base",
    name: "program_versions",
    listRule: `(@request.auth.id != "" && event.owners.id ?= @request.auth.id) || ${ADMIN}`,
    viewRule: `(@request.auth.id != "" && event.owners.id ?= @request.auth.id) || ${ADMIN}`,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: "relation", name: "event", required: true, collectionId: events.id, cascadeDelete: true, maxSelect: 1 },
      int("no", { required: true, min: 1 }),
      { type: "json", name: "doc", required: true, maxSize: 5 * 1024 * 1024 },
      json("stats"),
      { type: "select", name: "source", required: true, values: ["ui", "api", "mcp", "import"], maxSelect: 1 },
      { type: "relation", name: "author", collectionId: users.id, maxSelect: 1 },
      text("note"),
    ].concat(stamps),
    indexes: ["CREATE UNIQUE INDEX idx_program_versions_event_no ON program_versions (event, no)"],
  });
  app.save(versions);
}, (app) => {
  ["program_versions", "items", "sessions", "days", "sections", "rooms", "events"].forEach((name) => {
    app.delete(app.findCollectionByNameOrId(name));
  });
  const users = app.findCollectionByNameOrId("users");
  users.fields.removeByName("is_admin");
  users.createRule = "";
  users.updateRule = "id = @request.auth.id";
  app.save(users);
});
