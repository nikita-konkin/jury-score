#!/usr/bin/env node
// Запуск PocketBase с каталогами проекта: node scripts/pb.js serve --dev
// Бинарник: переменная PB_BIN, затем N:\tools\pocketbase\pocketbase.exe, затем pocketbase из PATH.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

function pbBin() {
  const candidates = [process.env.PB_BIN, "N:/tools/pocketbase/pocketbase.exe"].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return process.platform === "win32" ? "pocketbase.exe" : "pocketbase";
}

// Каталоги проекта; dataDir можно заменить (тесты используют временный), publicDir по умолчанию — public/
function pbDirs(dataDir, publicDir) {
  return [
    "--dir", dataDir || path.join(ROOT, "pb", "pb_data"),
    "--hooksDir", path.join(ROOT, "pb", "pb_hooks"),
    "--migrationsDir", path.join(ROOT, "pb", "pb_migrations"),
    "--publicDir", publicDir || path.join(ROOT, "public"),
  ];
}

module.exports = { ROOT, pbBin, pbDirs };

if (require.main === module) {
  const args = process.argv.slice(2);
  // вручную раздаём собранный фронтенд, если он есть; иначе только файлы для ботов
  const dist = path.join(ROOT, "dist");
  const child = spawn(pbBin(), args.concat(pbDirs(null, fs.existsSync(path.join(dist, "index.html")) ? dist : null)), { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code == null ? 1 : code));
  child.on("error", (err) => {
    console.error("Не удалось запустить PocketBase:", err.message, "\nУкажите путь в переменной PB_BIN.");
    process.exit(1);
  });
}
