"use strict";
// PDF через Gotenberg: только вошедшим, разметка без скриптов уходит в /forms/chromium/convert/html,
// ответ — application/pdf с именем файла; GET /api/v1 сообщает features.pdf.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

let gb, gbUrl;
const seen = [];
let failNext = false;
const PDF = Buffer.from("%PDF-1.7\n\x00\xff fake\n%%EOF");

function fakeGotenberg() {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url, type: req.headers["content-type"], body: Buffer.concat(chunks).toString("utf8") });
      if (failNext) { failNext = false; res.statusCode = 500; return res.end("chromium crashed"); }
      res.setHeader("Content-Type", "application/pdf");
      res.end(PDF);
    });
  });
}

const srv = require("./pb_server.js").setup(test, {
  env: async () => {
    gb = fakeGotenberg();
    await new Promise(r => gb.listen(0, "127.0.0.1", r));
    gbUrl = "http://127.0.0.1:" + gb.address().port;
    return { CONF_GOTENBERG_URL: gbUrl + "/" };
  },
});
const { api, login, t } = srv;
let token;

test.before(async () => {
  await srv.ready;
  if (!srv.base) return;
  const u = { email: "pdf@example.com", password: "pdf-pass-12345", passwordConfirm: "pdf-pass-12345" };
  await api("POST", "/api/collections/users/records", u, srv.suToken);
  token = await login("users", u.email, u.password);
});
test.after(() => { if (gb) gb.close(); });

t("GET /api/v1 сообщает, что PDF на сервере есть", async () => {
  const r = await api("GET", "/api/v1");
  assert.equal(r.json.features.pdf, true);
});

t("PDF: только после входа; скрипты вырезаны; файл с именем", async () => {
  const doc = { html: "<div class=\"pd-flow\"><h1>Программа</h1><script>alert(1)</script><img src=x onerror=1></div>", landscape: true, name: "rwp-2026-программа", title: "Программа" };
  assert.equal((await api("POST", "/api/v1/pdf", doc)).status, 401);
  const res = await fetch(srv.base + "/api/v1/pdf", { method: "POST", headers: { Authorization: token, "Content-Type": "application/json" }, body: JSON.stringify(doc) });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.match(res.headers.get("content-disposition"), /attachment; filename="rwp-2026-_+\.pdf"; filename\*=UTF-8''rwp-2026-%D0%BF/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PDF, "двоичный ответ без искажений");
  const last = seen[seen.length - 1];
  assert.equal(last.url, "/forms/chromium/convert/html");
  assert.match(last.type, /^multipart\/form-data; boundary=/);
  assert.match(last.body, /name="files"; filename="index.html"/);
  assert.match(last.body, /name="preferCssPageSize"\r\n\r\ntrue/);
  assert.match(last.body, /@page \{ size: A4 landscape/);
  assert.match(last.body, /<div class="print-doc landscape"><div class="pd-flow"><h1>Программа<\/h1>/);
  assert.ok(last.body.indexOf("<script") < 0, "скрипты не уходят в Chromium");
});

t("PDF: пустой документ — 400, сбой Gotenberg — 502", async () => {
  assert.equal((await api("POST", "/api/v1/pdf", { html: " " }, token)).status, 400);
  failNext = true;
  const r = await api("POST", "/api/v1/pdf", { html: "<p>x</p>" }, token);
  assert.equal(r.status, 502);
  assert.match(r.json.message, /500/);
});
