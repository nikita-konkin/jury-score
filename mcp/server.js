#!/usr/bin/env node
// MCP-сервер conf-kit: инструменты для чат-ботов поверх /api/v1.
//
// stdio (Claude Desktop/Code, LM Studio):
//   CONF_API_URL=https://conf.konkin-nikita.ru CONF_API_KEY=ck_… node mcp/server.js
// Streamable HTTP (за обратным прокси; сессии в памяти, простаивающие закрываются через час):
//   CONF_API_URL=http://127.0.0.1:8090 node mcp/server.js --http [--port 8091]
//   POST /mcp с заголовком Authorization: Bearer ck_… или персональный адрес POST /mcp/k/<ключ>
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8")).version;
const args = process.argv.slice(2);
const HTTP_MODE = args.includes("--http");
const PORT = +(args.indexOf("--port") >= 0 ? args[args.indexOf("--port") + 1] : process.env.CONF_MCP_PORT || 8091);
const API = String(process.env.CONF_API_URL || (HTTP_MODE ? "http://127.0.0.1:8090" : "https://conf.konkin-nikita.ru")).replace(/\/+$/, "");
const MAX_BODY = 2.5 * 1024 * 1024;

const RULES = [
  "Порядок: validate_program → исправить ошибки → create_event → отдать пользователю invite_url.",
  "Не выдумывай докладчиков, время, залы и организации: если данных нет — спроси пользователя или не заполняй поле.",
  "start и duration можно не указывать — время считается по регламенту; явный start — якорь.",
  "Данные, которым нет места в схеме, клади в extra, скажи об этом пользователю и вызови send_feedback.",
  "Опубликовать мероприятие может только человек.",
].join("\n");

// Документ программы: объект или JSON-строка (некоторые клиенты передают строкой)
const Program = z.union([z.record(z.string(), z.any()), z.string()])
  .describe("Документ conf.program/v1 (объект или JSON-строка). Схема — инструмент get_program_schema");

function asProgram(p) {
  if (typeof p !== "string") return p;
  try { return JSON.parse(p); } catch (e) { return p; } // строку с ошибкой разберёт и опишет сервер
}

/** Клиент API с ключом и пометкой клиента MCP. */
function apiClient(key, clientName) {
  return async (method, url, body, extraHeaders) => {
    const headers = Object.assign({ "X-Conf-Client": "mcp/" + (clientName() || "unknown") }, extraHeaders || {});
    if (key) headers["X-API-Key"] = key;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(API + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = { message: text.slice(0, 500) }; }
    return { status: res.status, json };
  };
}

const out = (data, isError) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 1) }], isError: !!isError });
const failed = r => r.status >= 400;
// Отчёт без info: бот читает ошибки и предупреждения
const brief = report => report && { ok: report.ok, errors: report.errors, warnings: report.warnings, stats: report.stats };

function buildServer(key) {
  const server = new McpServer({ name: "conf-kit", version: VERSION }, {
    instructions: "Сервис программ конференций. " + RULES,
  });
  const clientName = () => {
    const v = server.server.getClientVersion();
    return v ? v.name : "";
  };
  const api = apiClient(key, clientName);
  const draftHeader = t => (t ? { "X-Draft-Token": t } : {});

  server.registerTool("get_program_schema", {
    title: "Схема документа программы",
    description: "JSON Schema документа conf.program/v1 с описаниями полей и правила работы. Вызови перед составлением программы.",
    annotations: { readOnlyHint: true },
  }, async () => {
    let schema;
    try { schema = JSON.parse(fs.readFileSync(path.join(HERE, "../public/schema/program.v1.json"), "utf8")); } catch (e) {
      schema = (await api("GET", "/schema/program.v1.json")).json;
    }
    return out({ rules: RULES, schema });
  });

  server.registerTool("validate_program", {
    title: "Проверить программу",
    description: "Проверка без сохранения: ошибки (исправить), предупреждения (показать пользователю), рассчитанное время. Ключ не нужен.",
    inputSchema: { program: Program, include_doc: z.boolean().optional().describe("Вернуть нормализованный документ") },
    annotations: { readOnlyHint: true },
  }, async ({ program, include_doc }) => {
    const r = await api("POST", "/api/v1/programs/validate", asProgram(program));
    if (failed(r)) return out(r.json, true);
    return out(Object.assign({ ok: r.json.ok, report: brief(r.json.report) }, include_doc ? { doc: r.json.doc } : {}));
  });

  server.registerTool("create_event", {
    title: "Создать черновик мероприятия",
    description: "Сохраняет программу как черновик. Программа с ошибками не сохраняется. Отдай пользователю invite_url; draft_token сохрани для правок.",
    inputSchema: {
      program: Program,
      slug: z.string().optional().describe("Желаемый адрес латиницей, например rrv-2027"),
      note: z.string().optional().describe("Комментарий к версии"),
      idempotency_key: z.string().max(200).optional().describe("Повтор с тем же значением не создаёт дубль"),
    },
  }, async ({ program, slug, note, idempotency_key }) => {
    const r = await api("POST", "/api/v1/events", { program: asProgram(program), slug, note },
      idempotency_key ? { "Idempotency-Key": idempotency_key } : {});
    if (failed(r)) return out(Object.assign({}, r.json, { report: brief(r.json.report) }), true);
    return out(Object.assign({}, r.json, { report: brief(r.json.report) }));
  });

  server.registerTool("update_event_draft", {
    title: "Заменить программу черновика",
    description: "Полная замена программы (новая версия). Доступно ключу, создавшему черновик, или с draft_token.",
    inputSchema: {
      event_id: z.string().describe("id или адрес мероприятия"),
      program: Program,
      note: z.string().optional(),
      draft_token: z.string().optional(),
      base_version: z.number().int().min(0).optional()
        .describe("event.version из get_event_program: если программу успели изменить, вернётся 409 и чужие правки не затрутся"),
    },
  }, async ({ event_id, program, note, draft_token, base_version }) => {
    const body = { program: asProgram(program), note };
    if (base_version != null) body.base_version = base_version;
    const r = await api("PUT", `/api/v1/events/${encodeURIComponent(event_id)}/program`, body, draftHeader(draft_token));
    return out(Object.assign({}, r.json, { report: brief(r.json.report) }), failed(r));
  });

  server.registerTool("get_event_program", {
    title: "Прочитать программу мероприятия",
    description: "Текущая программа в формате conf.program/v1 — чтобы доработать и отправить через update_event_draft.",
    inputSchema: { event_id: z.string(), draft_token: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async ({ event_id, draft_token }) => {
    const r = await api("GET", `/api/v1/events/${encodeURIComponent(event_id)}/program`, undefined, draftHeader(draft_token));
    return out(r.json, failed(r));
  });

  server.registerTool("new_invite_link", {
    title: "Новая ссылка-приглашение",
    description: "Если пользователь потерял ссылку или она истекла (14 дней). Прежняя ссылка перестаёт действовать.",
    inputSchema: { event_id: z.string(), draft_token: z.string().optional() },
  }, async ({ event_id, draft_token }) => {
    const r = await api("POST", `/api/v1/events/${encodeURIComponent(event_id)}/invite`, undefined, draftHeader(draft_token));
    return out(r.json, failed(r));
  });

  server.registerTool("send_feedback", {
    title: "Сообщить, чего не хватило",
    description: "Если функции не хватает, схема не вмещает данные, проверка ошибается или документация непонятна. Не выдумывай обходы молча.",
    inputSchema: {
      kind: z.enum(["missing_feature", "schema_limitation", "bug", "unclear_docs", "validation_false_positive"]),
      area: z.enum(["schema", "validate", "events", "invite", "documents", "jury", "mcp", "ui", "other"]).optional(),
      summary: z.string().max(300).describe("Одна строка"),
      details: z.string().max(5000).optional().describe("Что просил пользователь, что пытался сделать, что получил"),
      workaround: z.string().max(2000).optional().describe("Как обошёлся, например extra.stand"),
      impact: z.enum(["blocker", "degraded", "nice_to_have"]).optional(),
      model: z.string().optional().describe("Модель, например Claude Opus 5.5"),
      event_id: z.string().optional(),
    },
  }, async (input) => {
    const r = await api("POST", "/api/v1/feedback", input);
    return out(r.json, failed(r));
  });

  server.registerTool("get_changelog", {
    title: "Что нового в API",
    description: "Изменения API и схемы, в том числе сделанные по обратной связи ботов.",
    annotations: { readOnlyHint: true },
  }, async () => {
    const r = await api("GET", "/api/v1/changelog");
    return out(r.json, failed(r));
  });

  server.registerPrompt("create_program", {
    title: "Создать программу мероприятия из материалов",
    description: "Сценарий: материалы → программа → проверка → черновик → ссылка для пользователя",
    argsSchema: { materials: z.string().describe("Информационное письмо, список докладов, регламент — как есть") },
  }, ({ materials }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: "Составь программу мероприятия по материалам ниже.\n\n" + RULES +
          "\n\nСначала вызови get_program_schema. Затем validate_program, исправляй ошибки, пока ok не станет true; " +
          "предупреждения перескажи мне. Потом create_event и дай мне invite_url и preview_url. " +
          "Если чего-то в схеме не хватает — используй extra и send_feedback.\n\nМатериалы:\n" + materials,
      },
    }],
  }));

  return server;
}

/* ---------------- транспорты ---------------- */

async function runStdio() {
  const server = buildServer(process.env.CONF_API_KEY || "");
  await server.connect(new StdioServerTransport());
}

function keyFrom(req) {
  const m = /^\/mcp\/k\/(ck_[A-Za-z0-9_]+)\/?$/.exec(req.url.split("?")[0]);
  if (m) return m[1];
  const a = /^Bearer\s+(ck_\S+)$/.exec(String(req.headers.authorization || ""));
  return a ? a[1] : String(req.headers["x-api-key"] || "");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("too large")); req.destroy(); } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const rpcError = (res, status, message) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
};

const SESSION_IDLE_MS = 60 * 60 * 1000;

function runHttp() {
  const sessions = new Map(); // id → { transport, server, key, last }
  const closeSession = id => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    s.transport.close();
    s.server.close();
  };
  setInterval(() => {
    const now = Date.now();
    sessions.forEach((s, id) => { if (now - s.last > SESSION_IDLE_MS) closeSession(id); });
  }, 10 * 60 * 1000).unref();

  const srv = http.createServer(async (req, res) => {
    const url = req.url.split("?")[0];
    if (url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, api: API, sessions: sessions.size }));
    }
    if (url !== "/mcp" && !/^\/mcp\/k\//.test(url)) return rpcError(res, 404, "Not found");
    const key = keyFrom(req);
    if (!key) return rpcError(res, 401, "Нужен API-ключ: Authorization: Bearer ck_… или адрес /mcp/k/<ключ>");
    let body;
    if (req.method === "POST") {
      try { body = JSON.parse(await readBody(req)); } catch (e) { return rpcError(res, 400, "Тело запроса — не JSON или слишком большое"); }
    }
    const sid = String(req.headers["mcp-session-id"] || "");
    try {
      if (sid) {
        const s = sessions.get(sid);
        if (!s) return rpcError(res, 404, "Сессия не найдена — начните заново (initialize)");
        if (s.key !== key) return rpcError(res, 403, "Сессия открыта с другим ключом");
        s.last = Date.now();
        return await s.transport.handleRequest(req, res, body);
      }
      if (req.method !== "POST" || !isInitializeRequest(body)) return rpcError(res, 400, "Нет сессии: первым запросом должен быть initialize");
      const server = buildServer(key);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => { sessions.set(id, { transport, server, key, last: Date.now() }); },
      });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) rpcError(res, 500, "Внутренняя ошибка MCP-сервера");
    }
  });
  srv.listen(PORT, process.env.CONF_MCP_HOST || "127.0.0.1", () => {
    console.error(`conf-kit MCP: http://${process.env.CONF_MCP_HOST || "127.0.0.1"}:${srv.address().port}/mcp → ${API}`);
  });
}

if (HTTP_MODE) runHttp();
else runStdio().catch(e => { console.error(e); process.exit(1); });
