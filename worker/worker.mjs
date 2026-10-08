#!/usr/bin/env node
// Локальный обработчик задач conf-kit. Забирает задачи своих мероприятий с сервера по ключу process_jobs,
// обрабатывает их локальной моделью (OpenAI-совместимый API LM Studio) и возвращает результат.
// Соединение только исходящее: работает за NAT, порты открывать не нужно. Материалы с персональными
// данными обрабатывает ваша видеокарта, а не внешний сервис.
//
//   node worker/worker.mjs --server https://conf.konkin-nikita.ru --key ck_…
//        [--lm http://localhost:1234] [--model qwen/qwen3.5-9b] [--interval 30] [--attempts 2] [--once]
//
// Вместо флагов — переменные окружения CONF_URL, CONF_WORKER_KEY, LMSTUDIO_URL, LMSTUDIO_MODEL.
// Ключ выдаётся в интерфейсе: «Моё мероприятие» → «Обработка на своём компьютере» → «Подключить компьютер».
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import M from "../shared/model.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString("ru-RU");

/** JSON из ответа модели: без <think>, без ```-ограждений, от первой { до последней }. */
export function extractJson(text) {
  const t = String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  const body = fenced ? fenced[1] : t;
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch (e) { return null; }
}

export async function pickModel(lm, wanted) {
  if (wanted) return wanted;
  try {
    const r = await (await fetch(lm + "/api/v0/models")).json();
    const loaded = (r.data || []).find(m => m.state === "loaded" && m.type !== "embeddings");
    if (loaded) return loaded.id;
  } catch (e) { /* нет API v0 */ }
  const r = await (await fetch(lm + "/v1/models")).json();
  if (!r.data || !r.data.length) throw new Error("В LM Studio не загружена ни одна модель");
  return r.data[0].id;
}

async function chat(lm, model, messages) {
  const res = await fetch(lm + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 16000 }),
  });
  if (!res.ok) throw new Error(`LM Studio ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  return j.choices[0].message.content || "";
}

const PEOPLE = "Люди — строкой «И. О. Фамилия» (регалии после запятой). Ничего не выдумывай: чего нет в материалах — не заполняй. " +
  "Не включай e-mail, телефоны и почтовые адреса.";

function programTask(job, docs) {
  return {
    system: "Ты помогаешь организаторам составлять программы мероприятий для сервиса conf-kit. " +
      "Инструментов у тебя нет: верни документ программы, его проверят и вернут отчёт.\n\n" + docs.llms +
      "\n\n## JSON Schema документа\n\n" + docs.schema,
    user: `Мероприятие: «${job.event.title}»${job.event.date_from ? ", с " + job.event.date_from : ""}${job.event.city ? ", " + job.event.city : ""}.\n` +
      (job.input.note ? "Пожелание организатора: " + job.input.note + "\n" : "") +
      "\nМатериалы:\n\n" + job.input.text + "\n\nСоставь документ conf.program/v1. " + PEOPLE + " Ответь только JSON.",
    check(json) {
      const r = M.normalize(json || {});
      return { ok: r.report.ok, errors: r.report.errors, result: { program: json } };
    },
  };
}

function talksTask(job) {
  const secs = (job.event.sections || []).map(s => `${s.no} — ${s.title}`).join("\n");
  return {
    system: "Ты извлекаешь доклады из материалов конференции (заявки, списки, письма) для сервиса conf-kit.\n" +
      'Верни JSON {"items": [...]}, каждый элемент — доклад:\n' +
      '{ "type": "talk", "title": "Название", "authors": ["И. О. Фамилия"], "speaker": "И. О. Фамилия", ' +
      '"org": "Организация", "city": "Город", "format": "oral | online | poster", "section": номер секции }\n' +
      (secs ? "Секции мероприятия:\n" + secs + "\nСекцию указывай, только если она ясна из материалов.\n" : "Секций нет — поле section не указывай.\n") +
      PEOPLE + " Ответь только JSON.",
    user: (job.input.note ? "Пожелание организатора: " + job.input.note + "\n\n" : "") + "Материалы:\n\n" + job.input.text,
    check(json) {
      const items = json && Array.isArray(json.items) ? json.items : null;
      if (!items || !items.length) return { ok: false, errors: [{ code: "NO_ITEMS", path: "items", message: "Нужен массив items с докладами" }] };
      const doc = { schema: M.SCHEMA_ID, event: { title: "x", date_from: "2000-01-01" }, sections: job.event.sections || [],
        days: [{ date: "2000-01-01", sessions: [{ title: "x", start: "09:00", items: items.map(it => Object.assign({}, it, { type: "talk" })) }] }] };
      const r = M.normalize(doc);
      const errors = r.report.errors.map(e => Object.assign({}, e, { path: e.path.replace("days[0].sessions[0].", "") }));
      return { ok: !errors.length, errors, result: { items } };
    },
  };
}

/**
 * Одна задача: запрос к модели, проверка model.js, при ошибках — исправление по отчёту.
 * → { result, model } или { error, model }
 */
export async function processJob(job, opts) {
  const model = await pickModel(opts.lm, opts.model);
  const task = job.kind === "program_from_text" ? programTask(job, opts.docs) : job.kind === "talks_from_text" ? talksTask(job) : null;
  if (!task) return { error: "Неизвестный вид задачи: " + job.kind, model };
  const messages = [{ role: "system", content: task.system }, { role: "user", content: task.user }];
  let last = null;
  for (let a = 1; a <= (opts.attempts || 2); a++) {
    const text = await chat(opts.lm, model, messages);
    const json = extractJson(text);
    last = json ? task.check(json) : { ok: false, errors: [{ code: "NO_JSON", path: "", message: "В ответе нет JSON" }] };
    if (opts.log) opts.log(`  попытка ${a}: ${last.ok ? "без ошибок" : "ошибок " + last.errors.length}`);
    if (last.ok) return { result: last.result, model };
    messages.push({ role: "assistant", content: text });
    messages.push({ role: "user", content: "Проверка нашла ошибки:\n" + last.errors.slice(0, 30).map(e => `- ${e.code} ${e.path}: ${e.message}`).join("\n") +
      "\n\nИсправь и верни весь JSON заново. Ответь только JSON." });
  }
  // с ошибками результат всё равно уходит на сервер: владелец увидит отчёт проверки
  return last && last.result ? { result: last.result, model } : { error: last.errors.map(e => e.message).join("; ").slice(0, 1500), model };
}

async function server(opts, method, url, body) {
  const res = await fetch(opts.server + url, {
    method, headers: { "Content-Type": "application/json", "X-API-Key": opts.key, "X-Conf-Client": "worker" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Сервер ${res.status}: ${json.message || ""}`);
  return json;
}

async function loadDocs(opts) {
  const get = async (url, file) => {
    try { const r = await fetch(opts.server + url); if (r.ok) return await r.text(); } catch (e) { /* без сети — локальная копия */ }
    return fs.readFileSync(path.join(ROOT, file), "utf8");
  };
  return { llms: await get("/llms.txt", "public/llms.txt"), schema: JSON.stringify(JSON.parse(await get("/schema/program.v1.json", "public/schema/program.v1.json"))) };
}

/** Забрать и обработать одну задачу. → задача после обработки или null, если очередь пуста. */
export async function runOnce(opts) {
  const { job } = await server(opts, "POST", "/api/v1/jobs/claim");
  if (!job) return null;
  const log = opts.log || (() => {});
  log(`${stamp()} задача «${job.title}» (${job.kind}), мероприятие «${job.event.title}», текст ${job.input.text.length} символов`);
  let out;
  try {
    out = await processJob(job, Object.assign({ docs: opts.docs || await loadDocs(opts) }, opts));
  } catch (e) {
    out = { error: "Обработчик: " + e.message };
  }
  const res = await server(opts, "POST", `/api/v1/jobs/${job.id}/result`, out);
  log(`${stamp()} готово: ${res.job.status}${res.job.error ? " — " + res.job.error : ""}`);
  return res.job;
}

function args() {
  const arg = (name, env, def) => { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : process.env[env] || def; };
  return {
    server: String(arg("server", "CONF_URL", "") || "").replace(/\/+$/, ""),
    key: arg("key", "CONF_WORKER_KEY", ""),
    lm: String(arg("lm", "LMSTUDIO_URL", "http://localhost:1234")).replace(/\/+$/, ""),
    model: arg("model", "LMSTUDIO_MODEL", ""),
    interval: +arg("interval", "", 30) * 1000,
    attempts: +arg("attempts", "", 2),
    once: process.argv.includes("--once"),
    log: s => console.log(s),
  };
}

async function main() {
  const opts = args();
  if (!opts.server || !opts.key) {
    console.error("Нужны --server <адрес сервиса> и --key <ключ обработчика> (или CONF_URL и CONF_WORKER_KEY)");
    process.exit(2);
  }
  opts.docs = await loadDocs(opts);
  console.log(`${stamp()} обработчик conf-kit: ${opts.server}, модель ${await pickModel(opts.lm, opts.model).catch(e => "— " + e.message)}`);
  for (;;) {
    let job = null;
    try { job = await runOnce(opts); } catch (e) { console.error(`${stamp()} ${e.message}`); }
    if (opts.once) break;
    if (!job) await sleep(opts.interval);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
