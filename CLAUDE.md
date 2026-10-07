# conf-kit

Универсальный сервис для конференций: конструктор программы, публичная программа, документы, жюри, заявки и API для чат-ботов. Полный план и решения — `docs/PLAN.md`.

Предшественник — оценка докладов RWP-2026 — заморожен в `legacy/jury-score/` (свой `CLAUDE.md` внутри). Корневой `index.html` переадресует туда старую ссылку GitHub Pages; его и `legacy/` не трогать без причины.

## Архитектура

- Сервер: PocketBase 0.40 + SQLite на VPS в РФ (`conf.konkin-nikita.ru`, пока не развёрнут).
  - `pb/pb_migrations/` — коллекции: `events`, `rooms`, `sections`, `days`, `sessions`, `items`, `program_versions`, поле `users.is_admin`.
  - `pb/pb_hooks/api_v1.pb.js` — маршруты `/api/v1`; `pb/pb_hooks/lib/program_store.js` — документ ↔ строки коллекций, версии, права.
- Фронтенд (план): Preact + esbuild под старые браузеры, `dist/` → `pb_public`. Сейчас `--publicDir` — `public/` (схема для ботов).
- MCP-сервер `mcp/` (план) — обёртка над `/api/v1` для чат-ботов.
- Центральный формат — документ программы `conf.program/v1` (`public/schema/program.v1.json`). Его используют API, импорт, экспорт, версии и шаблоны.

## shared/model.js

- Один файл для браузера, Node и goja (pb_hooks). **Синтаксис ES2015**: без `?.`, `??`, spread объектов, `Object.fromEntries/values/entries`, `Array.prototype.flat/includes`, `async/await`. goja и Safari 12 это не поддерживают.
- Подключение: `require("./shared/model.js")` в Node, `require(`${__hooks}/../../shared/model.js`)` в pb_hooks, глобальный `ConfModel` в браузере.
- `normalize(input)` → `{ doc, report }`. Документ с ошибками (`report.ok === false`) — только попытка починки: показывать можно, сохранять нельзя. `saveProgram` в pb_hooks нормализует заново и такой документ отклоняет (422).
- `fromDocument(doc)` → строки коллекций, `toDocument(rows)` → документ. Пустые значения из БД («», 0, false, null) считаются отсутствующими. Поля строк — `ROW_FIELDS`; они должны совпадать с миграцией (проверяет `tests/api`).
- Коды элементов: доклады `s<секция>-<n>` (совпадают с ID в jury-score), пленарные `p<n>`, прочее `x<n>`. Сохранённые коды не меняются: на них ссылаются оценки жюри, поэтому при замене программы строки пересоздаются, а коды остаются.
- Схема и model.js должны совпадать: типы, форматы и поля. Это проверяет `tests/unit/schema.test.js`. Новое поле добавляется в `KEYS` и `ROW_FIELDS` в model.js, в JSON Schema, в новую миграцию и в тесты.
- Сообщения отчёта — на русском, с путём вида `days[0].sessions[1].items[3]` и кодом элемента. Их читают и люди, и LLM.

## PocketBase: подводные камни

- Обработчики `routerAdd` выполняются в изолированных контекстах: `require` — внутри каждого обработчика, переменные уровня файла недоступны.
- Тело запроса читать через `toString(e.request.body)` + `JSON.parse`: `requestInfo().body` отдаёт Go-объекты, для которых `Array.isArray` ложно.
- В правилах доступа множественная связь сравнивается как `owners.id ?= @request.auth.id` (без `.id` не срабатывает) и всегда с `@request.auth.id != "" &&`: иначе пустая связь совпадает с пустым id анонима и черновик виден всем.
- Записи в коллекции программы идут только через `/api/v1` (create/update/deleteRule = null).
- `serve` по умолчанию с automigrate: правка коллекций в дашборде или через API создаёт файл в `pb/pb_migrations`. Такой файл либо осознанно коммитить, либо удалить. Тесты запускают сервер с `--automigrate=false`.
- Останавливать PocketBase только по PID, не `taskkill /IM pocketbase.exe`: на машине могут работать другие экземпляры.

## Правила

- Интерфейс и тексты на русском.
- Сначала мобильная версия (ширина 320–390 px), десктоп — отдельным этапом.
- Поддержка браузеров с 2018 года: iOS 12+, Chrome 61+, Firefox 60+, Edge 79+, Samsung Internet 8+, Яндекс.Браузер. В CSS нельзя `inset`, `gap` у flex, `color-mix()`, `:is()`, `:has()`, `aspect-ratio`.
- Кнопки не меньше 44 px, без горизонтальной прокрутки, тёмная тема через `prefers-color-scheme`.
- Внешние CDN не используются.

## Команды

Node установлен портативно: `N:\tools\node` (в PATH его нет). PocketBase 0.40.4: `N:\tools\pocketbase\pocketbase.exe` (или путь в `PB_BIN`).

```bash
export PATH="/n/tools/node:$PATH"
npm install
npm test                     # юнит-тесты: node --test "tests/unit/*.test.js"
npm run test:api             # /api/v1 против временного PocketBase (пропускается без бинарника)
npm run pb:superuser -- admin@example.com 'пароль'   # суперпользователь в pb/pb_data
npm run pb                   # serve --dev на 127.0.0.1:8090, дашборд /_/
```
