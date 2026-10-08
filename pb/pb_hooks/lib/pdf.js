// PDF печатных документов через Gotenberg (CONF_GOTENBERG_URL). Клиент присылает разметку листа
// (то, что видно на #/print/…), сервер добавляет стили app.css и @page и отдаёт её Chromium в Gotenberg.
// Gotenberg запускается без сети и без JavaScript (deploy/docker-compose.yml), поэтому разметка от клиента
// может только нарисовать PDF. Доступ — вошедшим пользователям, с лимитом в час.
const MAX_HTML = 3 * 1024 * 1024;
const PER_HOUR = 60;
const TIMEOUT_S = 90;

const gotenbergUrl = () => String($os.getenv("CONF_GOTENBERG_URL") || "").replace(/\/+$/, "");
const enabled = () => !!gotenbergUrl();

/** Стили сайта: CONF_PDF_CSS или dist/app.css рядом с pb/ (так же лежат и в образе Docker). */
function siteCss() {
  const paths = [String($os.getenv("CONF_PDF_CSS") || ""), `${__hooks}/../../dist/app.css`].filter(Boolean);
  for (let i = 0; i < paths.length; i++) {
    try { return toString($os.readFile(paths[i])); } catch (err) { /* следующий путь */ }
  }
  return "";
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Полный HTML для Chromium: без скриптов и внешних ресурсов, лист A4 по @page. */
function page(body) {
  const html = String(body.html || "")
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<(script|iframe|object|embed|link|meta|base)\b[^>]*>/gi, "");
  const orient = body.landscape ? "landscape" : "portrait";
  return "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\"><title>" + esc(String(body.title || "Документ").slice(0, 200)) + "</title>"
    + "<style>" + siteCss().replace(/<\/style/gi, "") + "</style>"
    + "<style>@page { size: A4 " + orient + "; margin: 12mm 12mm 12mm 15mm; } html, body { background: #fff; margin: 0; }</style>"
    + "</head><body><div class=\"print-doc" + (body.landscape ? " landscape" : "") + "\">" + html + "</div></body></html>";
}

/** Не больше PER_HOUR документов в час на пользователя (счётчик в памяти сервера). */
function allow(app, who) {
  const now = Date.now();
  const key = "conf_pdf_" + who;
  const store = app.store();
  let list = [];
  try { list = JSON.parse(store.get(key) || "[]"); } catch (err) { /* пусто */ }
  list = list.filter((t) => now - t < 3600 * 1000);
  if (list.length >= PER_HOUR) return false;
  list.push(now);
  store.set(key, JSON.stringify(list)); // строкой: массив JS в хранилище Go вернулся бы срезом Go
  return true;
}

/** multipart/form-data для POST /forms/chromium/convert/html. */
function multipart(html) {
  const b = "----conf" + $security.randomString(24);
  const field = (name, value) => "--" + b + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" + value + "\r\n";
  const body = field("preferCssPageSize", "true") + field("printBackground", "true")
    + "--" + b + "\r\nContent-Disposition: form-data; name=\"files\"; filename=\"index.html\"\r\nContent-Type: text/html; charset=utf-8\r\n\r\n"
    + html + "\r\n--" + b + "--\r\n";
  return { body: body, type: "multipart/form-data; boundary=" + b };
}

/** { status, pdf } или { status, message }. */
function render(e, body) {
  if (!enabled()) return { status: 503, message: "PDF на сервере не настроен: печатайте из браузера" };
  const html = String(body.html || "");
  if (!html.trim()) return { status: 400, message: "Нет содержимого документа" };
  if (html.length > MAX_HTML) return { status: 413, message: "Документ слишком большой для PDF" };
  const mp = multipart(page(body));
  let res;
  try {
    res = $http.send({ url: gotenbergUrl() + "/forms/chromium/convert/html", method: "POST", body: mp.body,
      headers: { "Content-Type": mp.type }, timeout: TIMEOUT_S });
  } catch (err) {
    e.app.logger().error("pdf: gotenberg", "error", String(err));
    return { status: 502, message: "Сервис PDF не отвечает: попробуйте позже или печатайте из браузера" };
  }
  if (res.statusCode !== 200) {
    e.app.logger().error("pdf: gotenberg", "status", res.statusCode, "body", toString(res.body).slice(0, 300));
    return { status: 502, message: "Сервис PDF вернул ошибку " + res.statusCode };
  }
  return { status: 200, pdf: res.body };
}

/** Имя файла: латиница, цифры, дефис (кириллица в Content-Disposition — через filename*). */
function fileName(name) {
  const base = String(name || "document").replace(/[^\wЀ-ӿ.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "document";
  return /\.pdf$/i.test(base) ? base : base + ".pdf";
}

module.exports = { enabled, allow, page, render, fileName, MAX_HTML, PER_HOUR };
