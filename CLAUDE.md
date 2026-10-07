# conf-kit

Универсальный сервис для конференций: конструктор программы, публичная программа, документы, жюри, заявки и API для чат-ботов. Полный план и решения — `docs/PLAN.md`. Предшественник — `N:\jury-score` (оценка докладов RWP-2026); его не менять ради этого проекта.

## Архитектура (целевая)

- Сервер: PocketBase + SQLite на VPS в РФ (`conf.konkin-nikita.ru`), свои маршруты в `pb/pb_hooks`, миграции в `pb/pb_migrations`.
- Фронтенд: Preact + сборка esbuild под старые браузеры, `dist/` → `pb_public`.
- MCP-сервер `mcp/` (Node) — обёртка над `/api/v1` для чат-ботов.
- Центральный формат — документ программы `conf.program/v1` (`public/schema/program.v1.json`). Его используют API, импорт, экспорт, версии и шаблоны.

## shared/model.js

- Один файл для браузера, Node и goja (pb_hooks). **Синтаксис ES2015**: без `?.`, `??`, spread объектов, `Object.fromEntries/values/entries`, `Array.prototype.flat/includes`, `async/await`. goja и Safari 12 это не поддерживают.
- Подключение: `require("./shared/model.js")` в Node и goja, глобальный `ConfModel` в браузере.
- `normalize(input)` → `{ doc, report }`. Документ с ошибками (`report.ok === false`) — только попытка починки: показывать можно, сохранять нельзя.
- Коды элементов: доклады `s<секция>-<n>` (совпадают с ID в jury-score), пленарные `p<n>`, прочее `x<n>`. Сохранённые коды не меняются.
- Схема и model.js должны совпадать: типы, форматы и поля. Это проверяет `tests/unit/schema.test.js`. Новое поле добавляется в `KEYS` в model.js, в JSON Schema и в тесты.
- Сообщения отчёта — на русском, с путём вида `days[0].sessions[1].items[3]` и кодом элемента. Их читают и люди, и LLM.

## Правила

- Интерфейс и тексты на русском.
- Сначала мобильная версия (ширина 320–390 px), десктоп — отдельным этапом.
- Поддержка браузеров с 2018 года: iOS 12+, Chrome 61+, Firefox 60+, Edge 79+, Samsung Internet 8+, Яндекс.Браузер. В CSS нельзя `inset`, `gap` у flex, `color-mix()`, `:is()`, `:has()`, `aspect-ratio`.
- Кнопки не меньше 44 px, без горизонтальной прокрутки, тёмная тема через `prefers-color-scheme`.
- Внешние CDN не используются.

## Команды

Node установлен портативно: `N:\tools\node` (в PATH его нет).

```bash
export PATH="/n/tools/node:$PATH"
npm install
npm test          # node --test "tests/unit/*.test.js"
```
