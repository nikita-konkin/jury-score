#!/usr/bin/env node
// Замер: насколько понятны схема и llms.txt модели без инструментов.
// Материалы → локальная модель (OpenAI-совместимый API LM Studio) → JSON → проверка model.js →
// при ошибках одна попытка исправления по отчёту → сравнение с эталоном.
//
//   node tests/bots/local_bench.mjs [--model qwen/qwen3.5-9b] [--set rwp-2026,school-2026] [--attempts 2]
//                                   [--url http://localhost:1234] [--save] [--dump]
// По умолчанию берётся загруженная в LM Studio модель. --save пишет tests/bots/results/<дата>-<модель>.json,
// --dump добавляет туда итоговые документы модели (для разбора ошибок).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import M from "../../shared/model.js";
import { renderText } from "./render_text.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = p => fs.readFileSync(path.join(ROOT, p), "utf8");
const arg = (name, def) => { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : def; };
const URL_BASE = arg("url", "http://localhost:1234").replace(/\/+$/, "");
const ATTEMPTS = +arg("attempts", 2);

// Наборы: материалы (текст или отрисованная программа) и эталон
const SETS = {
  "rwp-2026": { materials: () => renderText(M.normalize(JSON.parse(read("fixtures/rwp-2026.program.json"))).doc), reference: "fixtures/rwp-2026.program.json" },
  "school-2026": { materials: () => read("fixtures/materials/school-2026/materials.md"), reference: "fixtures/materials/school-2026/reference.json" },
};

async function pickModel() {
  const wanted = arg("model");
  if (wanted) return wanted;
  try {
    const r = await (await fetch(URL_BASE + "/api/v0/models")).json();
    const loaded = r.data.find(m => m.state === "loaded" && m.type !== "embeddings");
    if (loaded) return loaded.id;
  } catch (e) { /* нет API v0 */ }
  const r = await (await fetch(URL_BASE + "/v1/models")).json();
  return r.data[0].id;
}

async function chat(model, messages) {
  const t0 = Date.now();
  const res = await fetch(URL_BASE + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 16000 }),
  });
  if (!res.ok) throw new Error(`LM Studio ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  return { text: j.choices[0].message.content || "", ms: Date.now() - t0, tokens: j.usage ? j.usage.completion_tokens : null };
}

/** JSON из ответа модели: без <think>, без ```-ограждений, от первой { до последней }. */
export function extractJson(text) {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  const body = fenced ? fenced[1] : t;
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch (e) { return null; }
}

const titleKey = s => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim();
const items = doc => {
  const out = [];
  doc.days.forEach(d => d.sessions.forEach(s => s.items.forEach(it => out.push(Object.assign({ date: d.date }, it)))));
  return out;
};

/** Сравнение с эталоном по докладам (talk и plenary): найдены, докладчик, время, секция. */
export function compare(got, ref) {
  const R = items(ref).filter(it => it.type === "talk" || it.type === "plenary");
  const G = items(got).filter(it => it.type === "talk" || it.type === "plenary");
  const byTitle = {};
  G.forEach(it => { byTitle[titleKey(it.title)] = it; });
  let found = 0, speaker = 0, time = 0, section = 0;
  R.forEach(r => {
    const g = byTitle[titleKey(r.title)];
    if (!g) return;
    found++;
    if (r.speaker && g.speaker && M.personKey(r.speaker) === M.personKey(g.speaker)) speaker++;
    if (g.date === r.date && g.start === r.start) time++;
    if ((r.section || 0) === (g.section || 0)) section++;
  });
  const pct = n => (R.length ? Math.round(100 * n / R.length) : 100);
  return {
    talks: { ref: R.length, got: G.length }, found: pct(found), speaker: pct(speaker), time: pct(time), section: pct(section),
    sessions: { ref: ref.days.reduce((n, d) => n + d.sessions.length, 0), got: got.days.reduce((n, d) => n + d.sessions.length, 0) },
  };
}

function systemPrompt() {
  const schema = JSON.stringify(JSON.parse(read("public/schema/program.v1.json")));
  return "Ты помогаешь организаторам составлять программы мероприятий для сервиса conf-kit. " +
    "Инструментов у тебя нет: верни документ программы, его проверят и вернут отчёт.\n\n" +
    read("public/llms.txt") + "\n\n## JSON Schema документа\n\n" + schema;
}

async function runSet(model, name) {
  const set = SETS[name];
  const ref = M.normalize(JSON.parse(read(set.reference))).doc;
  const messages = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: "Материалы мероприятия:\n\n" + set.materials() + "\n\nСоставь документ conf.program/v1. Ответь только JSON, без пояснений." },
  ];
  const attempts = [];
  let doc = null, report = null;
  for (let a = 1; a <= ATTEMPTS; a++) {
    const r = await chat(model, messages);
    const json = extractJson(r.text);
    const res = json ? M.normalize(json) : { doc: null, report: { ok: false, errors: [{ code: "NO_JSON", path: "", message: "В ответе нет JSON" }], warnings: [] } };
    attempts.push({ attempt: a, ms: r.ms, tokens: r.tokens, ok: res.report.ok,
      errors: count(res.report.errors), warnings: count(res.report.warnings || []) });
    doc = res.doc; report = res.report;
    if (res.report.ok) break;
    messages.push({ role: "assistant", content: r.text });
    messages.push({ role: "user", content: "Проверка нашла ошибки, документ не сохранён:\n" +
      res.report.errors.slice(0, 30).map(e => `- ${e.code} ${e.path}: ${e.message}`).join("\n") +
      "\n\nИсправь и верни весь документ заново. Ответь только JSON." });
  }
  return {
    set: name, ok: report.ok, attempts,
    final_errors: (report.errors || []).slice(0, 20).map(e => `${e.code} ${e.path}: ${e.message}`),
    doc: process.argv.includes("--dump") ? doc : undefined,
    extra: (report.warnings || []).filter(w => w.code === "EXTRA_USED").length,
    match: doc ? compare(doc, ref) : null,
  };
}

function count(list) {
  const m = {};
  list.forEach(e => { m[e.code] = (m[e.code] || 0) + 1; });
  return m;
}

async function main() {
  const model = await pickModel();
  const sets = arg("set", Object.keys(SETS).join(",")).split(",");
  console.log(`Модель: ${model}; наборы: ${sets.join(", ")}; попыток: ${ATTEMPTS}`);
  const results = [];
  for (const name of sets) {
    process.stdout.write(`… ${name}\n`);
    const r = await runSet(model, name);
    results.push(r);
    const m = r.match;
    console.log(`${name}: ${r.ok ? "валиден" : "НЕ валиден"} с попытки ${r.attempts.length}` +
      (m ? `; доклады ${m.talks.got}/${m.talks.ref}, найдено ${m.found}%, докладчик ${m.speaker}%, время ${m.time}%, секция ${m.section}%, заседаний ${m.sessions.got}/${m.sessions.ref}` : "") +
      `; extra: ${r.extra}; ${r.attempts.map(a => `${Math.round(a.ms / 1000)} с`).join(" + ")}`);
    r.attempts.forEach(a => { if (!a.ok) console.log(`   попытка ${a.attempt}: ошибки ${JSON.stringify(a.errors)}`); });
    r.final_errors.forEach(e => console.log("   " + e));
  }
  const valid = results.filter(r => r.ok).length;
  console.log(`Итого: валидных ${valid} из ${results.length} (${Math.round(100 * valid / results.length)}%)`);
  if (process.argv.includes("--save")) {
    const dir = path.join(ROOT, "tests/bots/results");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}-${model.replace(/[^a-z0-9.-]+/gi, "_")}.json`);
    fs.writeFileSync(file, JSON.stringify({ model, date: new Date().toISOString(), attempts: ATTEMPTS, results }, null, 1) + "\n");
    console.log("Сохранено:", path.relative(ROOT, file));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exit(1); });
