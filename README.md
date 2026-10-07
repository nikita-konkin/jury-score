# conf-kit

Универсальный сервис для конференций и мероприятий: конструктор программы, публичная программа для участников, печатные документы (программа, «на дверь», протоколы, дипломы), конкурс докладов с оценкой жюри и приём заявок.

Главный сценарий — создание программы чат-ботом: бот получает материалы мероприятия, через API собирает программу целиком и отдаёт человеку ссылку-приглашение на готовый черновик.

Вырос из инструмента оценки докладов RWP-2026 — он сохранён в [`legacy/jury-score/`](legacy/jury-score/), старая ссылка GitHub Pages продолжает работать.

## Состояние

Готовы ядро (этап 1) и API для чат-ботов (этап 2):

- [`public/schema/program.v1.json`](public/schema/program.v1.json) — JSON Schema документа программы `conf.program/v1`;
- [`shared/model.js`](shared/model.js) — нормализация, авто-время по регламенту, проверки (наложения залов, докладчик в двух местах, время «наоборот» и т. д.), разбор документа на строки БД и сборка обратно;
- [`pb/`](pb/) — PocketBase: коллекции программы с версиями, API-ключи, обратная связь от ботов, API:

  | Метод | Назначение |
  |---|---|
  | `POST /api/v1/programs/validate` | проверка программы без сохранения |
  | `POST /api/v1/events` | черновик по API-ключу (или вошедшим пользователем): `invite_url`, `preview_url`, `draft_token` |
  | `GET`/`PUT /api/v1/events/{id или slug}/program` | программа в формате `conf.program/v1`; замена — новая версия |
  | `GET`/`POST /api/v1/claim/{токен}` | предпросмотр по приглашению и принятие черновика в свой аккаунт |
  | `POST /api/v1/events/{id}/invite`, `/publish`, `/unpublish` | приглашение соавтора, публикация |
  | `POST /api/v1/feedback`, `GET /api/v1/changelog` | обратная связь от ботов и список изменений |

- [`public/llms.txt`](public/llms.txt) и [`public/openapi.json`](public/openapi.json) — инструкции для ботов и GPT Actions;
- [`mcp/`](mcp/) — MCP-сервер для Claude, LM Studio и других клиентов (stdio и HTTP);
- [`web/`](web/) — мобильный фронтенд для браузеров с 2018 года: принятие приглашения, мои мероприятия, публикация, публичная программа, «Создать из ответа чат-бота» (для ботов без инструментов);
- [`tests/bots/local_bench.mjs`](tests/bots/local_bench.mjs) — замер того, как локальная модель в LM Studio собирает программу из материалов;
- [`fixtures/`](fixtures/) — программы RWP-2026 (и вариант со сбитым временем секции 4) и РРВ-2023.

План развития — [`docs/PLAN.md`](docs/PLAN.md).

## Проверка

```bash
npm install
npm test             # юнит-тесты
npm run test:api     # API против временного PocketBase (нужен бинарник, путь — в PB_BIN)
npm run test:mcp     # MCP-сервер
python tests/e2e/claim_flow.py   # сквозной сценарий в Playwright
```

## Запуск

```bash
npm run pb:superuser -- admin@example.com 'пароль'
npm run pb                                   # сборка фронтенда и PocketBase на 127.0.0.1:8090
node scripts/pb.js apikey create "Claude"    # ключ для бота
```

Адрес для ссылок-приглашений задаётся переменной `CONF_PUBLIC_URL` или полем Application URL в настройках PocketBase.
