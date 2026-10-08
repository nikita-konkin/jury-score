"use strict";
// Временный PocketBase для интеграционных тестов: свой pb_data, свободный порт, суперпользователь.
// Бинарник ищется как в scripts/pb.js (PB_BIN, N:\tools\pocketbase, PATH); без него тесты пропускаются.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { pbBin, pbDirs } = require("../../scripts/pb.js");

const SU = { identity: "su@example.com", password: "su-password-12345" };
const BIN = pbBin();
const available = spawnSync(BIN, ["--version"]).status === 0;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

/** Регистрирует before/after в node:test и возвращает помощники. opts.env — переменные сервера (или async-функция). */
function setup(test, opts) {
  const srv = { available, base: "", dataDir: "", suToken: "", log: "" };
  let server = null, started;
  // before-хуки тестов могут выполняться раньше запуска — им нужно дождаться srv.ready()
  srv.ready = new Promise(resolve => { started = resolve; });

  // auth: строка — заголовок Authorization; объект — произвольные заголовки
  srv.api = async (method, url, body, auth) => {
    const headers = typeof auth === "string" ? { Authorization: auth } : Object.assign({}, auth || {});
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(srv.base + url, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* не JSON */ }
    return { status: res.status, json, text, type: res.headers.get("content-type") || "", cache: res.headers.get("cache-control") || "" };
  };

  srv.login = async (collection, identity, password) => {
    const r = await srv.api("POST", `/api/collections/${collection}/auth-with-password`, { identity, password });
    assert.equal(r.status, 200, r.text);
    return r.json.token;
  };

  /** Консольная команда pocketbase с каталогами теста (apikey, admin, …). */
  srv.cli = args => {
    assert.ok(srv.dataDir, "сервер ещё не запущен — дождитесь srv.ready()");
    return spawnSync(BIN, args.concat(pbDirs(srv.dataDir)), { encoding: "utf8" });
  };

  srv.t = (name, fn) => test(name, { skip: !available && "нет бинарника PocketBase (PB_BIN)" }, fn);

  test.before(async () => {
    if (!available) return started();
    srv.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "conf-kit-pb-"));
    const up = srv.cli(["superuser", "upsert", SU.identity, SU.password]);
    assert.equal(up.status, 0, up.stderr || up.stdout);
    const port = await freePort();
    srv.base = `http://127.0.0.1:${port}`;
    const extra = opts && opts.env ? (typeof opts.env === "function" ? await opts.env() : opts.env) : {};
    server = spawn(BIN, ["serve", "--http", `127.0.0.1:${port}`, "--automigrate=false"].concat(pbDirs(srv.dataDir)),
      { stdio: ["ignore", "pipe", "pipe"], env: Object.assign({}, process.env, extra) });
    server.stdout.on("data", d => { srv.log += d; });
    server.stderr.on("data", d => { srv.log += d; });
    for (let i = 0; ; i++) {
      try { if ((await fetch(srv.base + "/api/health")).ok) break; } catch (e) { /* ещё стартует */ }
      if (i > 100 || server.exitCode != null) throw new Error("PocketBase не запустился:\n" + srv.log);
      await new Promise(r => setTimeout(r, 100));
    }
    srv.suToken = await srv.login("_superusers", SU.identity, SU.password);
    started();
  });

  test.after(() => {
    // останавливается только наш процесс (по PID), другие PocketBase на машине не трогаются
    if (server && server.exitCode == null) server.kill();
    if (srv.dataDir) setTimeout(() => fs.rmSync(srv.dataDir, { recursive: true, force: true }), 300).unref();
  });

  return srv;
}

module.exports = { setup, SU };
