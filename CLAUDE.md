# conf-kit

Универсальный сервис для конференций: конструктор программы, публичная программа, документы, жюри, заявки и API для чат-ботов. Полный план и решения — `docs/PLAN.md`.

Предшественник — оценка докладов RWP-2026 — заморожен в `legacy/jury-score/` (свой `CLAUDE.md` внутри). Корневой `index.html` переадресует туда старую ссылку GitHub Pages; его и `legacy/` не трогать без причины.

## Архитектура

- Сервер: PocketBase 0.40 + SQLite на VPS в РФ (`conf.konkin-nikita.ru`, пока не развёрнут).
  - `pb/pb_migrations/` — коллекции программы (`events`, `rooms`, `sections`, `days`, `sessions`, `items`, `program_versions`, `users.is_admin`) и ботов (`api_keys`, `feedback`, `feedback_groups`, токены черновика и приглашения в `events`), жюри (`scores`, `scores_deleted`, коды комиссии в `events`) и заявки (`applications`).
  - `pb/pb_hooks/api_v1.pb.js` — маршруты `/api/v1`. Логика — в `pb/pb_hooks/lib/`: `program_store.js` (документ ↔ строки, версии), `access.js` (ключи, токены, права, лимиты, `baseUrl`), `feedback_store.js` (группировка, ответ боту, changelog), `maintenance.js` (очистка черновиков, сводка). `cron.pb.js` — расписание, `cli.pb.js` — команды `pocketbase apikey …` и `pocketbase admin <email>`.
  - `pb/pb_hooks/jury.pb.js` + `lib/jury_store.js` — жюри `/api/jury/{id}` (перенос `Code.gs`) и коды комиссии `/api/v1/events/{id}/jury`.
  - `pb/pb_hooks/apply.pb.js` + `lib/apply_store.js` — заявки: форма `/api/apply/{id}`, своя заявка по токену, модерация `/api/v1/events/{id}/applications`.
  - Ссылки в ответах (`invite_url`, `preview_url`) строятся от `CONF_PUBLIC_URL`, затем от Application URL из настроек (если не по умолчанию), затем от хоста запроса.
- Фронтенд `web/`: Preact + esbuild (`web/build.mjs`) → `dist/`, его раздаёт PocketBase (`--publicDir`). Бандлы iife (динамического import нет в Chrome 61–62 и Firefox 60–66): `app.js` (бюджет 80 КБ gzip) и `editor.js` — конструктор, грузится тегом `<script>` только на `#/edit` и `#/create`. preact, `api.js`, `util.js`, `hooks.js`, `Program.jsx` конструктор берёт у `app.js` через `window.__confShared` (плагин `sharedFromApp` в `build.mjs`): второй экземпляр preact ломает хуки. Новый общий модуль добавляется и в `SHARED` в `build.mjs`, и в `window.__confShared` в `app.jsx`. Маршруты на хэше: `#/claim/<токен>`, `#/preview/<токен>`, `#/e/<slug>`, `#/my/<id>`, `#/new` (вставка ответа чат-бота). `web/src/gate.js` (ES5, встраивается в `<head>`) показывает «Браузер устарел» и включает класс `lite`.
- Конструктор `#/edit/<id>[/d/<день>[/s/<заседание>]]` (`web/src/pages/Editor.jsx`): правка идёт в копии документа, после каждого действия — `ConfModel.normalize` (время и проверки на месте), «Сохранить» шлёт документ целиком с `base_version` (409 — программу изменили в другом месте). Несохранённое пишется в localStorage сразу в `commit` (не в эффекте — иначе теряется при мгновенной перезагрузке). Нижние листы — `web/src/edit/sheets.jsx`; лист открывается с `history.pushState`, чтобы «Назад» на телефоне закрывал его.
  - Чистая логика — `web/src/edit/ops.js` (перемещения, форма элемента, шаблон, пустая программа) и `table.js` (импорт .xlsx/.csv/.docx без SheetJS: zip через fflate, XML регулярками). Их тесты — `tests/unit/edit_*.test.js`; `web/package.json` с `"type": "module"` нужен, чтобы Node импортировал эти файлы.
  - Время элемента: `anchor: true` — закреплено, иначе считается по порядку. При применении формы `end` всегда удаляется, иначе старый конец перебьёт новую длительность.
- Публичная программа `#/e/<адрес>` (`web/src/pages/View.jsx`, логика — `web/src/public/live.js`): «сейчас / далее» по поясу `event.timezone`, поиск и фильтры, обновление через realtime PocketBase (подписка `events/<id>`) с запасным опросом, копия в localStorage на случай без связи.
- Печатные документы `#/print/<id>/<вид>` (`web/src/print/`, в `editor.js`): программа в виде официальной программы RWP-2026, таблички «на дверь», протоколы секций, сертификаты. `data.js` — общие данные для HTML и Word, `docx.js` — .docx без библиотеки (WordprocessingML + fflate). Печать — браузерная с `@page`; PDF на сервере (Gotenberg) — при выкладке на VPS. e2e проверяет PDF через pypdf и Word через python-docx.
- `shared/ics.js` — календарь iCalendar для goja и браузера: `GET /api/v1/events/{id}/program.ics` (заседания; `?items=1` — все элементы; `?item=<код>` — один). Время в UTC по таблице поясов РФ (летнего времени нет); незнакомый пояс — «плавающее» время.
- MCP-сервер `mcp/` — обёртка над `/api/v1` (stdio и Streamable HTTP), см. `mcp/README.md`.
- Инструкции для ботов: `public/llms.txt`, `public/openapi.json`. Правила формата в `llms.txt` должны совпадать с поведением `model.js`.
- Центральный формат — документ программы `conf.program/v1` (`public/schema/program.v1.json`). Его используют API, импорт, экспорт, версии и шаблоны.

## shared/model.js

- Один файл для браузера, Node и goja (pb_hooks). **Синтаксис ES2015**: без `?.`, `??`, spread объектов, `Object.fromEntries/values/entries`, `Array.prototype.flat/includes`, `async/await`. goja и Safari 12 это не поддерживают.
- Подключение: `require("./shared/model.js")` в Node, `require(`${__hooks}/../../shared/model.js`)` в pb_hooks, глобальный `ConfModel` в браузере.
- `normalize(input)` → `{ doc, report }`. Документ с ошибками (`report.ok === false`) — только попытка починки: показывать можно, сохранять нельзя. `saveProgram` в pb_hooks нормализует заново и такой документ отклоняет (422).
- `fromDocument(doc)` → строки коллекций, `toDocument(rows)` → документ. Пустые значения из БД («», 0, false, null) считаются отсутствующими. Поля строк — `ROW_FIELDS`; они должны совпадать с миграцией (проверяет `tests/api`).
- Коды элементов: доклады `s<секция>-<n>` (совпадают с ID в jury-score), пленарные `p<n>`, прочее `x<n>`. Сохранённые коды не меняются: на них ссылаются оценки жюри, поэтому при замене программы строки пересоздаются, а коды остаются.
- Схема и model.js должны совпадать: типы, форматы и поля. Это проверяет `tests/unit/schema.test.js`. Новое поле добавляется в `KEYS` и `ROW_FIELDS` в model.js, в JSON Schema, в новую миграцию и в тесты.
- Сообщения отчёта — на русском, с путём вида `days[0].sessions[1].items[3]` и кодом элемента. Их читают и люди, и LLM.

## Жюри

- Эксперт открывает `#/jury/<slug>[/<код>]`, вводит фамилию и код комиссии; аккаунт не нужен. Коды — скрытые поля `events.jury_code` и `jury_admin_code`, создаются при первом `GET /api/v1/events/{id}/jury`. Владелец мероприятия — администратор жюри без кода.
- Жюри включено, если в `event.jury` есть `enabled` и критерии. Оцениваются элементы с `competitive` и кодом; оценки ссылаются на код элемента.
- `scores`: upsert по (event, code, juror_key) с проверкой `ts`, сумму считает сервер, удаление переносит строки в `scores_deleted`. Правила коллекций null — только через хуки.
- `/api/jury/{id}` всегда отвечает 200 с `{ok, role, rows, error}` (404 — нет мероприятия), POST — с любым Content-Type: `sendBeacon` шлёт text/plain.
- `norm` в `web/src/jury/results.js` и `jury_store.js` должны совпадать: от него зависят ключ эксперта и ключи localStorage.
- Клиент: `web/src/jury/queue.js` — офлайн-очередь, `results.js` — итоги, рейтинг, статистика, CSV, `pages/Jury.jsx` — экран. Жюри входит в `app.js` (бюджет 80 КБ gzip); итоги и дипломы для печати — в `editor.js`.

## Заявки

- Приём включается в `event.applications` (`enabled`, `deadline`, `operator`, `contact`, `note`). Без оператора персональных данных (или `organizer`) форма закрыта: согласие должно называть оператора.
- Текст согласия строит сервер (`consentText`) и сохраняет с заявкой вместе с временем. Контакты (`email`, `phone`) видит только владелец; при отзыве заявки они стираются сразу, остальные — плановой задачей через год после `date_to`.
- Антиспам: скрытое поле `website` (заполнено — делаем вид, что приняли), время заполнения `elapsed` от 3 с, не больше 10 заявок в час с адреса, дубль по e-mail и названию — 409.
- «Принять» добавляет доклад в заседание и сохраняет новую версию программы с `base_version`; `item_code` заявки — код этого доклада. Контакты в программу не попадают.
- Форма (`pages/Apply.jsx`) — в `app.js`, модерация (`pages/Applications.jsx`) — в `editor.js`; общие функции — `web/src/apply/data.js`.

## PocketBase: подводные камни

- Обработчики `routerAdd` выполняются в изолированных контекстах: `require` — внутри каждого обработчика, переменные уровня файла недоступны.
- Тело запроса читать через `toString(e.request.body)` + `JSON.parse`: `requestInfo().body` отдаёт Go-объекты, для которых `Array.isArray` ложно.
- В правилах доступа множественная связь сравнивается как `owners.id ?= @request.auth.id` (без `.id` не срабатывает) и всегда с `@request.auth.id != "" &&`: иначе пустая связь совпадает с пустым id анонима и черновик виден всем.
- Записи в коллекции программы идут только через `/api/v1` (create/update/deleteRule = null).
- `serve` по умолчанию с automigrate: правка коллекций в дашборде или через API создаёт файл в `pb/pb_migrations`. Такой файл либо осознанно коммитить, либо удалить. Тесты запускают сервер с `--automigrate=false`.
- Останавливать PocketBase только по PID, не `taskkill /IM pocketbase.exe`: на машине могут работать другие экземпляры.

## Замер на локальной модели

`node tests/bots/local_bench.mjs [--model id] [--set имя] [--save]` — материалы из `fixtures/materials/<набор>/materials.md` → LM Studio (`localhost:1234`) → JSON → `normalize` с повтором по отчёту → сравнение с `reference.json`. Результаты `--save` — в `tests/bots/results/`. Прогонять после правок схемы, `llms.txt` и проверок в `model.js`. Модель отвечает минутами — запускать в фоне.

## Правила

- Интерфейс и тексты на русском.
- Сначала мобильная версия (ширина 320–390 px). Десктоп — от 900 px: `useWide()` из `hooks.js` и класс `page-wide` у `<html>` (`useHtmlClass`) расширяют страницу; без него `.wrap` остаётся 720 px. Листы конструктора на десктопе — боковая панель (CSS), перетаскивание — HTML5 drag-and-drop только на широком экране, на телефоне — кнопки «↑ / ↓».
- Поддержка браузеров с 2018 года: iOS 12+, Chrome 61+, Firefox 60+, Edge 79+, Samsung Internet 8+, Яндекс.Браузер. В CSS нельзя `inset`, `gap` у flex, `color-mix()`, `:is()`, `:has()`, `aspect-ratio`.
- Кнопки не меньше 44 px, без горизонтальной прокрутки, тёмная тема через `prefers-color-scheme`.
- Внешние CDN не используются.
- Совместимость фронтенда проверяет `tests/unit/web.test.js` (запрещённый CSS, `env()`/`max()` без запасного значения, API без полифила). Синтаксис понижает esbuild; `supported: { destructuring: true }` в `build.mjs` — сознательное исключение.

## Команды

Node установлен портативно: `N:\tools\node` (в PATH его нет). PocketBase 0.40.4: `N:\tools\pocketbase\pocketbase.exe` (или путь в `PB_BIN`).

```bash
export PATH="/n/tools/node:$PATH"
npm install
npm test                     # юнит-тесты: node --test "tests/unit/*.test.js"
npm run test:api             # /api/v1 против временного PocketBase (пропускается без бинарника)
npm run test:mcp             # MCP-сервер против временного PocketBase
npm run test:e2e             # Playwright: приглашение и конструктор на 320 px (tests/e2e/*.py, --shots каталог)
npm run build                # dist/
npm run pb:superuser -- admin@example.com 'пароль'   # суперпользователь в pb/pb_data
npm run pb                   # сборка и serve --dev на 127.0.0.1:8090, дашборд /_/
node scripts/pb.js apikey create "Claude" create_events,update_own,read_own,send_feedback
```
