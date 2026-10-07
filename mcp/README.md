# MCP-сервер conf-kit

Инструменты для чат-ботов поверх `/api/v1`: бот составляет программу мероприятия, проверяет её, создаёт черновик и отдаёт человеку ссылку-приглашение.

| Инструмент | Что делает |
|---|---|
| `get_program_schema` | схема `conf.program/v1` и правила работы |
| `validate_program` | проверка без сохранения: ошибки, предупреждения, рассчитанное время |
| `create_event` | черновик мероприятия → `invite_url`, `preview_url`, `draft_token` |
| `update_event_draft` | заменить программу (новая версия) |
| `get_event_program` | прочитать текущую программу |
| `new_invite_link` | новая ссылка-приглашение |
| `send_feedback` | сообщить, чего не хватило |
| `get_changelog` | что нового в API |

Промпт `create_program` задаёт весь сценарий: материалы → программа → проверка → черновик → ссылка.

Нужен API-ключ `ck_…`. Его выдаёт администратор: `pocketbase apikey create "Claude — кафедра"` на сервере или `POST /api/v1/admin/keys`.

## Установка

```bash
cd mcp
npm ci
```

## Claude Desktop, LM Studio (stdio)

`claude_desktop_config.json` или `mcp.json` в LM Studio:

```json
{
  "mcpServers": {
    "conf-kit": {
      "command": "node",
      "args": ["N:/jury-score/mcp/server.js"],
      "env": { "CONF_API_URL": "https://conf.konkin-nikita.ru", "CONF_API_KEY": "ck_…" }
    }
  }
}
```

## Claude Code

```bash
claude mcp add conf-kit -e CONF_API_URL=https://conf.konkin-nikita.ru -e CONF_API_KEY=ck_… -- node N:/jury-score/mcp/server.js
```

## По HTTP (на сервере)

```bash
CONF_API_URL=http://127.0.0.1:8090 node mcp/server.js --http --port 8091
```

Обратный прокси отдаёт `https://conf.konkin-nikita.ru/mcp` на `127.0.0.1:8091`. Ключ — в заголовке `Authorization: Bearer ck_…`. Для клиентов, где заголовок задать нельзя, есть персональный адрес `https://conf.konkin-nikita.ru/mcp/k/<ключ>`; такой адрес равносилен ключу, при утечке ключ отзывают.

Сессии хранятся в памяти процесса; простаивающие дольше часа закрываются. Проверка: `GET /health`.

## Тесты

```bash
npm run test:mcp    # из корня репозитория; нужен бинарник PocketBase
```
