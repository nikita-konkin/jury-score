# Выкладка conf-kit на VPS

Один `docker compose` поднимает четыре контейнера:

| Сервис | Что делает | Порт внутри |
|---|---|---|
| `caddy` | HTTPS (Let's Encrypt), сжатие; `/mcp` → `mcp`, остальное → `pocketbase` | 80, 443 наружу |
| `pocketbase` | сайт (`dist/`), `/api/v1`, жюри, заявки, realtime, дашборд `/_/`; данные в томе `pb_data` | 8090 |
| `mcp` | MCP-сервер для чат-ботов (Streamable HTTP) поверх `/api/v1` | 8091 |
| `gotenberg` | PDF печатных документов (Chromium) | 3000, только сеть `pdf` |

Gotenberg работает **без выхода в сеть** (сеть `pdf` с `internal: true`), с выключенным JavaScript и
запретом любых адресов, кроме присланного файла. Разметку для PDF присылает браузер вошедшего
пользователя (`POST /api/v1/pdf`), поэтому всё, что она может сделать, — нарисовать PDF. Лимит — 60 PDF
в час на пользователя.

## Что нужно

- VPS с 2 ГБ памяти (Chromium в Gotenberg занимает 300–500 МБ), Docker 24+ с `docker compose` v2.
- DNS: A-запись `conf.konkin-nikita.ru` → IP сервера; порты 80 и 443 открыты.
- Почтовый ящик для писем сайта (SMTP) — для сброса пароля.
- По желанию — бакет в S3-совместимом хранилище для резервных копий.

Docker Hub и GitHub из РФ иногда недоступны. Если `docker compose build` не скачивает образы,
пропишите зеркало в `/etc/docker/daemon.json` (`{"registry-mirrors": ["https://mirror.gcr.io"]}`) и
перезапустите Docker. Бинарник PocketBase скачивается с GitHub и проверяется по sha256 (`deploy/Dockerfile`).

## Первый запуск

```bash
git clone https://github.com/nikita-konkin/jury-score.git conf-kit && cd conf-kit
cp deploy/.env.example deploy/.env      # домен, почта, резервные копии
nano deploy/.env
docker compose -f deploy/docker-compose.yml up -d --build
```

Через минуту сайт откроется по `https://<домен>/`. Проверка: `https://<домен>/api/health` и
`https://<домен>/api/v1` (`"features": {"pdf": true}`).

Суперпользователь (дашборд `/_/`), администратор сайта и ключ для чат-бота:

```bash
alias dc='docker compose -f deploy/docker-compose.yml'
dc exec pocketbase pb superuser upsert admin@example.com 'длинный-пароль'
dc exec pocketbase pb admin organizer@example.com          # после регистрации на сайте
dc exec pocketbase pb apikey create "Claude" create_events,update_own,read_own,send_feedback
```

`pb` в контейнере — это `pocketbase` с каталогами conf-kit (`deploy/pb.sh`); доступны все его команды и
команды conf-kit (`apikey list`, `apikey revoke <prefix>`).

## Настройки из `.env`

При каждом запуске хук `pb/pb_hooks/settings.pb.js` переносит переменные в настройки PocketBase: адрес сайта
(`CONF_PUBLIC_URL`), отправитель и SMTP, расписание резервных копий и S3, доверенный прокси
(`X-Forwarded-For` от Caddy — для лимитов по адресу), встроенные лимиты запросов. Пустая переменная —
настройка не трогается, её можно задать в дашборде. Изменили `.env` — `dc up -d`.

## Обновление

```bash
git pull
dc up -d --build
```

Миграции из `pb/pb_migrations` применяются при запуске. Правка коллекций в дашборде на сервере не создаёт
файлов миграций (`--automigrate=false`): коллекции меняются только миграциями из репозитория.

## Резервные копии

PocketBase делает копию `pb_data` по `CONF_BACKUP_CRON` и хранит `CONF_BACKUP_KEEP` последних — в бакете S3,
если он задан, иначе в томе `pb_data`. Восстановление — дашборд `/_/` → Settings → Backups. Копия тома
вручную:

```bash
docker run --rm -v conf-kit_pb_data:/data -v "$PWD":/out alpine tar czf /out/pb_data.tgz -C /data .
```

## Журналы и неполадки

```bash
dc ps
dc logs -f pocketbase          # ошибки хуков, «settings from env», «pdf: gotenberg»
dc logs --tail 50 gotenberg
dc restart gotenberg           # если PDF перестал собираться
```

## Проверка на своём компьютере

`tests/deploy/smoke.py` поднимает тот же стек в локальном Docker (Caddy без HTTPS на `127.0.0.1:8080`,
`deploy/docker-compose.local.yml`), проходит основные сценарии — вход по приглашению, «Скачать PDF» через
Gotenberg, MCP, изоляцию Gotenberg, резервную копию — и удаляет стек:

```bash
python tests/deploy/smoke.py                   # --keep — оставить стек, --save <каталог> — сохранить PDF
python tests/deploy/smoke.py --old-browsers    # ещё Chrome 62 и Firefox 60 из образов Selenium 3
```

Нужны Docker, Python с Playwright (`pip install playwright pypdf && playwright install chromium`).
