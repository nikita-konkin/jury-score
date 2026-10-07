#!/usr/bin/env node
// Сборка фронтенда в dist/: app.js и app.css под браузеры 2018 года, index.html с проверкой браузера,
// файлы из public/ (схема, llms.txt, openapi.json). dist/ раздаёт PocketBase (--publicDir).
//   node web/build.mjs [--out dist]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TARGETS = ["chrome61", "firefox60", "safari12", "ios12", "edge79"];
export const BUDGET_GZIP = 80 * 1024; // публичная программа и жюри: не больше 80 КБ JS в gzip

const hash = buf => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 10);
const gz = buf => zlib.gzipSync(buf, { level: 9 }).length;

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

/** Собирает в outDir; возвращает размеры. */
export async function build(outDir) {
  const out = path.resolve(ROOT, outDir || "dist");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  copyDir(path.join(ROOT, "public"), out);

  // esbuild считает деструктуризацию неподдерживаемой в Safari < 14 из-за редкого крайнего случая и не умеет
  // её понижать; обычная деструктуризация (параметры, [a, b] = useState()) работает в Safari 10+
  const common = { bundle: true, minify: true, target: TARGETS, supported: { destructuring: true }, charset: "utf8", legalComments: "none", logLevel: "warning" };
  await esbuild.build(Object.assign({}, common, {
    entryPoints: [path.join(ROOT, "web/src/app.jsx")], outfile: path.join(out, "app.js"), format: "iife",
    jsx: "automatic", jsxImportSource: "preact", define: { "process.env.NODE_ENV": '"production"' },
  }));
  await esbuild.build(Object.assign({}, common, { entryPoints: [path.join(ROOT, "web/src/css/app.css")], outfile: path.join(out, "app.css") }));
  // проверка браузера — ES5, встраивается в <head>
  const gate = (await esbuild.transform(fs.readFileSync(path.join(ROOT, "web/src/gate.js"), "utf8"), { minify: true, target: "es5", charset: "utf8" })).code.trim();

  const js = fs.readFileSync(path.join(out, "app.js"));
  const css = fs.readFileSync(path.join(out, "app.css"));
  const html = fs.readFileSync(path.join(ROOT, "web/src/index.html"), "utf8")
    .replace("/*GATE*/", gate).replace("/*JS_HASH*/", hash(js)).replace("/*CSS_HASH*/", hash(css));
  fs.writeFileSync(path.join(out, "index.html"), html);
  return { out, js: { bytes: js.length, gzip: gz(js) }, css: { bytes: css.length, gzip: gz(css) } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  const r = await build(i >= 0 ? process.argv[i + 1] : "dist");
  const kb = n => (n / 1024).toFixed(1) + " КБ";
  console.log(`${path.relative(ROOT, r.out)}: app.js ${kb(r.js.bytes)} (gzip ${kb(r.js.gzip)}), app.css ${kb(r.css.bytes)} (gzip ${kb(r.css.gzip)})`);
  if (r.js.gzip > BUDGET_GZIP) { console.error(`app.js больше бюджета ${kb(BUDGET_GZIP)} в gzip`); process.exit(1); }
}
