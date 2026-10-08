"use strict";
// Настройки из окружения (deploy/.env): адрес сайта, почта, резервные копии, доверенный прокси, лимиты.
const test = require("node:test");
const assert = require("node:assert/strict");

const srv = require("./pb_server.js").setup(test, {
  env: {
    CONF_PUBLIC_URL: "https://conf.example.org/", CONF_APP_NAME: "conf-kit test",
    CONF_MAIL_FROM: "noreply@example.org", CONF_MAIL_NAME: "Конференции",
    CONF_SMTP_HOST: "smtp.example.org", CONF_SMTP_PORT: "587", CONF_SMTP_USER: "noreply@example.org", CONF_SMTP_PASSWORD: "secret-1",
    CONF_BACKUP_CRON: "0 3 * * *", CONF_BACKUP_KEEP: "5",
    CONF_S3_BUCKET: "conf-backups", CONF_S3_ENDPOINT: "https://storage.example.org", CONF_S3_KEY: "k", CONF_S3_SECRET: "s",
    CONF_TRUSTED_PROXY_HEADER: "X-Forwarded-For", CONF_RATE_LIMITS: "1",
  },
});
const { api, t } = srv;

t("настройки PocketBase берутся из окружения", async () => {
  await srv.ready;
  const r = await api("GET", "/api/settings", undefined, srv.suToken);
  assert.equal(r.status, 200, r.text);
  const s = r.json;
  assert.equal(s.meta.appURL, "https://conf.example.org");
  assert.equal(s.meta.appName, "conf-kit test");
  assert.equal(s.meta.senderAddress, "noreply@example.org");
  assert.equal(s.meta.senderName, "Конференции");
  assert.deepEqual([s.smtp.enabled, s.smtp.host, s.smtp.port, s.smtp.username, s.smtp.tls], [true, "smtp.example.org", 587, "noreply@example.org", false]);
  assert.equal(s.backups.cron, "0 3 * * *");
  assert.equal(s.backups.cronMaxKeep, 5);
  assert.deepEqual([s.backups.s3.enabled, s.backups.s3.bucket, s.backups.s3.endpoint, s.backups.s3.region], [true, "conf-backups", "https://storage.example.org", "ru-central1"]);
  assert.deepEqual(s.trustedProxy, { headers: ["X-Forwarded-For"], useLeftmostIP: false });
  assert.equal(s.rateLimits.enabled, true);
  // ссылки в ответах — от адреса сайта
  const key = await api("POST", "/api/v1/admin/keys", { name: "бот" }, srv.suToken);
  const ev = await api("POST", "/api/v1/events", require("../../fixtures/rwp-2026.program.json"), { "X-API-Key": key.json.key });
  assert.match(ev.json.invite_url, /^https:\/\/conf\.example\.org\/#\/claim\//);
  assert.equal((await api("GET", "/api/v1")).json.features.pdf, false, "без CONF_GOTENBERG_URL PDF выключен");
});
