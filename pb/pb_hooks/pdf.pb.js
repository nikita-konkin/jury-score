/// <reference path="../pb_data/types.d.ts" />
// PDF печатных документов (#/print/…) через Gotenberg. Включается переменной CONF_GOTENBERG_URL;
// GET /api/v1 сообщает pdf: true/false. Логика и ограничения — lib/pdf.js.

routerAdd("POST", "/api/v1/pdf", (e) => {
  const A = require(`${__hooks}/lib/access.js`);
  const P = require(`${__hooks}/lib/pdf.js`);
  const a = A.actor(e);
  if (!a.user && !a.su) throw new UnauthorizedError("PDF на сервере — после входа");
  const body = A.readJson(e, P.MAX_HTML + 64 * 1024);
  if (!P.enabled()) return e.json(503, { ok: false, message: "PDF на сервере не настроен: печатайте из браузера" });
  if (!P.allow(e.app, a.user ? a.user.id : "su")) throw new TooManyRequestsError(`Не больше ${P.PER_HOUR} PDF в час`);
  const r = P.render(e, body);
  if (r.status !== 200) return e.json(r.status, { ok: false, message: r.message });
  const name = P.fileName(body.name);
  const ascii = name.replace(/[^\w.-]+/g, "_");
  e.response.header().set("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  e.response.header().set("Cache-Control", "no-store");
  return e.blob(200, "application/pdf", r.pdf);
});
