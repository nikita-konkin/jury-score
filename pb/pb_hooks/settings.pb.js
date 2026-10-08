/// <reference path="../pb_data/types.d.ts" />
// Настройки сервера из переменных окружения при запуске (lib/env_settings.js).

onBootstrap((e) => {
  e.next();
  try {
    const changed = require(`${__hooks}/lib/env_settings.js`).apply(e.app);
    if (changed.length) e.app.logger().info("settings from env", "changed", changed.join(", "));
  } catch (err) {
    e.app.logger().error("settings from env", "error", String(err));
  }
});
