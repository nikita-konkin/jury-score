"use strict";
// Сборка фронтенда: бюджет размера, совместимость CSS и JS с браузерами 2018 года.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.join(__dirname, "../..");
const srcFiles = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? srcFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const web = srcFiles(path.join(root, "web/src"));

test("сборка: index.html с проверкой браузера, app.js в бюджете, файлы для ботов", async () => {
  const { build, BUDGET_GZIP } = await import("../../web/build.mjs");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "conf-kit-dist-"));
  try {
    const r = await build(out);
    assert.ok(r.js.gzip < BUDGET_GZIP, `app.js ${r.js.gzip} байт в gzip`);
    const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
    assert.match(html, /Браузер устарел/);
    assert.match(html, /app\.js\?v=[0-9a-f]{10}/);
    assert.doesNotMatch(html, /\/\*(GATE|JS_HASH|CSS_HASH)\*\//);
    ["llms.txt", "openapi.json", "schema/program.v1.json"].forEach(f => assert.ok(fs.existsSync(path.join(out, f)), f));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("CSS: нет свойств, которых нет в Safari 12 и Chrome 61", () => {
  web.filter(f => f.endsWith(".css")).forEach(f => {
    const css = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    [/(^|[;{\s])inset\s*:/, /color-mix\(/, /:is\(/, /:has\(/, /aspect-ratio\s*:/, /:where\(/, /\bdvh\b(?![^;]*\bvh\b)/]
      .forEach(re => assert.doesNotMatch(css, re, `${path.basename(f)}: ${re}`));
    // gap — только у grid; у flex его нет в Safari < 14.1
    css.replace(/([^{}]+)\{([^{}]*)\}/g, (m, sel, body) => {
      if (/(^|;)\s*(gap|row-gap|column-gap)\s*:/.test(body)) {
        assert.match(body, /display\s*:\s*grid/, `gap без display:grid в «${sel.trim()}»`);
      }
      // env() и max() — только после запасного значения того же свойства
      const decls = body.split(";").map(d => d.trim()).filter(Boolean);
      decls.forEach((d, i) => {
        if (!/env\(|max\(|min\(|clamp\(/.test(d)) return;
        const prop = d.split(":")[0].trim();
        assert.ok(decls.slice(0, i).some(x => x.split(":")[0].trim() === prop), `«${sel.trim()}»: ${prop} без запасного значения перед env()/max()`);
      });
      return m;
    });
  });
});

test("JS: нет API без полифила для Chrome 61 / Safari 12", () => {
  const banned = [/\.replaceAll\(/, /structuredClone\(/, /\.at\(-?\d/, /\.findLast(Index)?\(/, /\bArray\.prototype\.group/,
    /Object\.hasOwn\(/, /\bnew\s+URLPattern/, /\.toSorted\(/, /\.toReversed\(/, /queueMicrotask\(/];
  web.filter(f => /\.(js|jsx)$/.test(f)).forEach(f => {
    const js = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    banned.forEach(re => assert.doesNotMatch(js, re, `${path.relative(root, f)}: ${re}`));
    if (/AbortController/.test(js)) assert.match(js, /typeof AbortController/, `${path.basename(f)}: AbortController без проверки (нет в iOS 12.0)`);
  });
});
