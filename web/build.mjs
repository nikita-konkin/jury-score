#!/usr/bin/env node
// Сборка фронтенда в dist/: app.js, editor.js (конструктор) и app.css под браузеры 2018 года, index.html с проверкой браузера,
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

const SRC = path.join(ROOT, "web/src");
// Модули, которые конструктор получает у app.js через window.__confShared: один экземпляр preact
// (иначе хуки не работают) и общее состояние входа в api.js. Имена — ключи в app.jsx.
export const SHARED = {
  "preact": "preact", "preact/hooks": "preact/hooks", "preact/jsx-runtime": "preact/jsx-runtime",
  [path.join(SRC, "api.js")]: "api", [path.join(SRC, "util.js")]: "util", [path.join(SRC, "hooks.js")]: "hooks",
  [path.join(SRC, "components/Program.jsx")]: "program",
};
const sharedFromApp = {
  name: "shared-from-app",
  setup(b) {
    b.onResolve({ filter: /^preact(\/hooks|\/jsx-runtime)?$/ }, a => ({ path: SHARED[a.path], namespace: "shared" }));
    b.onResolve({ filter: /^\.\.?\// }, a => {
      const name = SHARED[path.resolve(a.resolveDir, a.path)];
      return name ? { path: name, namespace: "shared" } : undefined;
    });
    b.onLoad({ filter: /.*/, namespace: "shared" }, a => ({ contents: `module.exports = window.__confShared[${JSON.stringify(a.path)}];`, loader: "js" }));
  },
};

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
  const jsx = { format: "iife", jsx: "automatic", jsxImportSource: "preact" };
  // конструктор — отдельный файл, грузится только на #/edit и #/create; preact и общие модули берёт у app.js
  await esbuild.build(Object.assign({}, common, jsx, {
    entryPoints: [path.join(SRC, "editor.jsx")], outfile: path.join(out, "editor.js"), plugins: [sharedFromApp],
    define: { "process.env.NODE_ENV": '"production"' },
  }));
  const editor = fs.readFileSync(path.join(out, "editor.js"));
  await esbuild.build(Object.assign({}, common, jsx, {
    entryPoints: [path.join(SRC, "app.jsx")], outfile: path.join(out, "app.js"),
    define: { "process.env.NODE_ENV": '"production"', __EDITOR_JS__: JSON.stringify("editor.js?v=" + hash(editor)) },
  }));
  await esbuild.build(Object.assign({}, common, { entryPoints: [path.join(ROOT, "web/src/css/app.css")], outfile: path.join(out, "app.css") }));
  // проверка браузера — ES5, встраивается в <head>
  const gate = (await esbuild.transform(fs.readFileSync(path.join(ROOT, "web/src/gate.js"), "utf8"), { minify: true, target: "es5", charset: "utf8" })).code.trim();

  const js = fs.readFileSync(path.join(out, "app.js"));
  const css = fs.readFileSync(path.join(out, "app.css"));
  const html = fs.readFileSync(path.join(ROOT, "web/src/index.html"), "utf8")
    .replace("/*GATE*/", gate).replace("/*JS_HASH*/", hash(js)).replace("/*CSS_HASH*/", hash(css));
  fs.writeFileSync(path.join(out, "index.html"), html);
  return { out, js: { bytes: js.length, gzip: gz(js) }, editor: { bytes: editor.length, gzip: gz(editor) }, css: { bytes: css.length, gzip: gz(css) } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  const r = await build(i >= 0 ? process.argv[i + 1] : "dist");
  const kb = n => (n / 1024).toFixed(1) + " КБ";
  console.log(`${path.relative(ROOT, r.out)}: app.js ${kb(r.js.bytes)} (gzip ${kb(r.js.gzip)}), editor.js ${kb(r.editor.bytes)} (gzip ${kb(r.editor.gzip)}), app.css ${kb(r.css.bytes)} (gzip ${kb(r.css.gzip)})`);
  if (r.js.gzip > BUDGET_GZIP) { console.error(`app.js больше бюджета ${kb(BUDGET_GZIP)} в gzip`); process.exit(1); }
}
