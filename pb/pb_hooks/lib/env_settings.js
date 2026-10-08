// Настройки PocketBase из переменных окружения (deploy/.env): адрес сайта, почта, резервные копии в S3,
// доверенный прокси и встроенные лимиты запросов. Пустая переменная — настройка не трогается: её можно
// задать в дашборде /_/. Применяется при каждом запуске (settings.pb.js).
const env = (n) => String($os.getenv(n) || "").trim();
const yes = (v) => /^(1|true|yes|on|да)$/i.test(v);

/** Меняет настройки app по окружению; возвращает список изменённых ключей (пароли не показываются). */
function apply(app) {
  const s = app.settings();
  const changed = [];
  const set = (obj, path, key, value) => {
    if (obj[key] === value) return;
    obj[key] = value;
    changed.push(path + "." + key);
  };

  const url = env("CONF_PUBLIC_URL").replace(/\/+$/, "");
  if (url) set(s.meta, "meta", "appURL", url);
  if (env("CONF_APP_NAME")) set(s.meta, "meta", "appName", env("CONF_APP_NAME"));
  if (env("CONF_MAIL_FROM")) set(s.meta, "meta", "senderAddress", env("CONF_MAIL_FROM"));
  if (env("CONF_MAIL_NAME")) set(s.meta, "meta", "senderName", env("CONF_MAIL_NAME"));

  if (env("CONF_SMTP_HOST")) {
    set(s.smtp, "smtp", "enabled", true);
    set(s.smtp, "smtp", "host", env("CONF_SMTP_HOST"));
    set(s.smtp, "smtp", "port", +env("CONF_SMTP_PORT") || 465);
    if (env("CONF_SMTP_USER")) set(s.smtp, "smtp", "username", env("CONF_SMTP_USER"));
    if (env("CONF_SMTP_PASSWORD")) set(s.smtp, "smtp", "password", env("CONF_SMTP_PASSWORD"));
    // 465 — TLS сразу, 587 — STARTTLS (tls: false)
    set(s.smtp, "smtp", "tls", env("CONF_SMTP_TLS") ? yes(env("CONF_SMTP_TLS")) : (+env("CONF_SMTP_PORT") || 465) === 465);
  }

  if (env("CONF_BACKUP_CRON")) set(s.backups, "backups", "cron", env("CONF_BACKUP_CRON"));
  if (env("CONF_BACKUP_KEEP")) set(s.backups, "backups", "cronMaxKeep", +env("CONF_BACKUP_KEEP") || 7);
  if (env("CONF_S3_BUCKET")) {
    const b = s.backups.s3;
    set(b, "backups.s3", "enabled", true);
    set(b, "backups.s3", "bucket", env("CONF_S3_BUCKET"));
    set(b, "backups.s3", "endpoint", env("CONF_S3_ENDPOINT"));
    set(b, "backups.s3", "region", env("CONF_S3_REGION") || "ru-central1");
    if (env("CONF_S3_KEY")) set(b, "backups.s3", "accessKey", env("CONF_S3_KEY"));
    if (env("CONF_S3_SECRET")) set(b, "backups.s3", "secret", env("CONF_S3_SECRET"));
    set(b, "backups.s3", "forcePathStyle", yes(env("CONF_S3_PATH_STYLE")));
  }

  // за Caddy адрес клиента — в X-Forwarded-For; берётся правый (его дописал наш прокси), левый подделывается
  const proxy = env("CONF_TRUSTED_PROXY_HEADER");
  if (proxy && (s.trustedProxy.headers.length !== 1 || s.trustedProxy.headers[0] !== proxy)) {
    s.trustedProxy.headers = [proxy];
    changed.push("trustedProxy.headers");
  }
  if (proxy) set(s.trustedProxy, "trustedProxy", "useLeftmostIP", false);
  if (env("CONF_RATE_LIMITS")) set(s.rateLimits, "rateLimits", "enabled", yes(env("CONF_RATE_LIMITS")));

  if (changed.length) app.save(s);
  return changed;
}

module.exports = { apply };
