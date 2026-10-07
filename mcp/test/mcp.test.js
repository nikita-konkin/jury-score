// MCP-сервер против настоящего PocketBase: HTTP (ключ в заголовке и в адресе) и stdio.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "server.js");
const fixture = name => JSON.parse(fs.readFileSync(path.join(HERE, "../../fixtures", name), "utf8"));
const srv = require("../../tests/api/pb_server.js").setup(test);
const { api, t } = srv;

let key, mcp, mcpUrl;
const parse = r => JSON.parse(r.content[0].text);

test.before(async () => {
  await srv.ready;
  if (!srv.available) return;
  const r = srv.cli(["apikey", "create", "MCP-тест"]);
  key = /(ck_[a-z0-9]{8}_[A-Za-z0-9]{32})/.exec(r.stdout + r.stderr)[1];
  mcp = spawn(process.execPath, [SERVER, "--http", "--port", "0"], {
    env: Object.assign({}, process.env, { CONF_API_URL: srv.base }), stdio: ["ignore", "ignore", "pipe"],
  });
  mcpUrl = await new Promise((resolve, reject) => {
    let log = "";
    mcp.stderr.on("data", d => {
      log += d;
      const m = /(http:\/\/127\.0\.0\.1:\d+)\/mcp/.exec(log);
      if (m) resolve(m[1]);
    });
    mcp.on("exit", c => reject(new Error("MCP-сервер завершился: " + c + "\n" + log)));
  });
});

test.after(() => { if (mcp && mcp.exitCode == null) mcp.kill(); });

async function httpClient(url, headers) {
  const client = new Client({ name: "conf-kit-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: headers || {} } }));
  return client;
}

t("HTTP: инструменты, проверка, черновик, правка, приглашение, обратная связь", async () => {
  const client = await httpClient(mcpUrl + "/mcp", { Authorization: "Bearer " + key });
  const tools = (await client.listTools()).tools.map(x => x.name).sort();
  assert.deepEqual(tools, ["create_event", "get_changelog", "get_event_program", "get_program_schema", "new_invite_link",
    "send_feedback", "update_event_draft", "validate_program"]);
  assert.deepEqual((await client.listPrompts()).prompts.map(p => p.name), ["create_program"]);

  const schema = parse(await client.callTool({ name: "get_program_schema", arguments: {} }));
  assert.match(schema.rules, /validate_program/);
  assert.ok(schema.schema.$defs);

  const bad = parse(await client.callTool({ name: "validate_program", arguments: { program: fixture("rwp-2026.broken.json") } }));
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.report.errors.map(e => e.code).sort(), ["TIME_BACKWARDS", "TIME_OVERLAP"]);
  // программа строкой тоже принимается
  const asString = parse(await client.callTool({ name: "validate_program", arguments: { program: JSON.stringify(fixture("rwp-2026.program.json")) } }));
  assert.equal(asString.ok, true);

  const rejected = await client.callTool({ name: "create_event", arguments: { program: fixture("rwp-2026.broken.json") } });
  assert.equal(rejected.isError, true);

  const created = parse(await client.callTool({ name: "create_event", arguments: {
    program: fixture("rwp-2026.program.json"), slug: "rwp-mcp", idempotency_key: "mcp-1" } }));
  assert.equal(created.event.slug, "rwp-mcp");
  assert.match(created.invite_url, /#\/claim\/inv_/);
  const id = created.event.id;

  const prog = parse(await client.callTool({ name: "get_event_program", arguments: { event_id: "rwp-mcp" } }));
  prog.program.event.subtitle = "Правка через MCP";
  const upd = parse(await client.callTool({ name: "update_event_draft", arguments: { event_id: id, program: prog.program, note: "mcp" } }));
  assert.equal(upd.event.version, 2);
  const versions = await api("GET", `/api/collections/program_versions/records?sort=no&filter=${encodeURIComponent(`event="${id}"`)}`, undefined, srv.suToken);
  assert.deepEqual(versions.json.items.map(v => v.source), ["mcp", "mcp"]);

  const inv = parse(await client.callTool({ name: "new_invite_link", arguments: { event_id: id } }));
  const claim = await api("GET", "/api/v1/claim/" + inv.invite_url.split("#/claim/")[1]);
  assert.equal(claim.json.prepared_by, "MCP-тест");

  const fb = parse(await client.callTool({ name: "send_feedback", arguments: {
    kind: "missing_feature", area: "schema", summary: "Нет поля для ссылки на трансляцию", model: "Claude Opus 5.5", event_id: id } }));
  assert.equal(fb.ok, true);
  const stored = await api("GET", "/api/collections/feedback/records/" + fb.id, undefined, srv.suToken);
  assert.equal(stored.json.source, "mcp");
  assert.equal(stored.json.client, "mcp/conf-kit-test");
  assert.equal(stored.json.event, id);

  assert.ok(parse(await client.callTool({ name: "get_changelog", arguments: {} })).items.length);
  await client.close();
});

t("HTTP: ключ в адресе /mcp/k/<ключ>; без ключа — 401; неверный ключ — ошибка инструмента", async () => {
  const viaPath = await httpClient(`${mcpUrl}/mcp/k/${key}`);
  const r = parse(await viaPath.callTool({ name: "get_event_program", arguments: { event_id: "rwp-mcp" } }));
  assert.equal(r.event.slug, "rwp-mcp");
  await viaPath.close();

  const noKey = await fetch(mcpUrl + "/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(noKey.status, 401);

  const wrong = await httpClient(mcpUrl + "/mcp", { Authorization: "Bearer ck_aaaaaaaa_" + "x".repeat(32) });
  const res = await wrong.callTool({ name: "create_event", arguments: { program: fixture("rwp-2026.program.json") } });
  assert.equal(res.isError, true);
  assert.match(parse(res).message, /API-ключ не найден/);
  await wrong.close();
});

t("stdio: ключ из окружения, проверка программы", async () => {
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [SERVER],
    env: Object.assign({}, process.env, { CONF_API_URL: srv.base, CONF_API_KEY: key }),
  }));
  const r = parse(await client.callTool({ name: "validate_program", arguments: { program: fixture("rrv-2023.program.json") } }));
  assert.equal(r.ok, true);
  assert.equal(r.report.stats.items, 164);
  const p = parse(await client.callTool({ name: "get_event_program", arguments: { event_id: "rwp-mcp" } }));
  assert.equal(p.event.slug, "rwp-mcp");
  await client.close();
});
