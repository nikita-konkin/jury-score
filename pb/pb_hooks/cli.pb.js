/// <reference path="../pb_data/types.d.ts" />
// Консольные команды для сервера:
//   pocketbase apikey create "Claude — кафедра" [create_events,update_own,read_own,send_feedback]
//   pocketbase apikey list
//   pocketbase apikey revoke <prefix>
//   pocketbase admin <email>          — отметить пользователя администратором (users.is_admin)

$app.rootCmd.addCommand(new Command({
  use: "apikey",
  short: "API-ключи для чат-ботов: create <название> [права через запятую] | list | revoke <prefix>",
  run: (cmd, args) => {
    const A = require(`${__hooks}/lib/access.js`);
    const action = args[0] || "";
    if (action === "create" && args[1]) {
      const scopes = args[2] ? String(args[2]).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      const res = A.createKey($app, { name: args[1], scopes: scopes });
      console.log(`Ключ «${args[1]}» (права: ${res.record.getStringSlice("scopes").join(", ")}):\n${res.key}\nСохраните его: повторно он не показывается.`);
    } else if (action === "list") {
      $app.findRecordsByFilter("api_keys", "", "-created", 200, 0).forEach((k) => {
        console.log(`${k.getString("prefix")}  ${k.getBool("revoked") ? "ОТОЗВАН " : ""}${k.getString("name")}  [${k.getStringSlice("scopes").join(",")}]  использован: ${k.getDateTime("last_used").string() || "—"}`);
      });
    } else if (action === "revoke" && args[1]) {
      const k = $app.findFirstRecordByFilter("api_keys", "prefix = {:p}", { p: args[1] });
      k.set("revoked", true);
      $app.save(k);
      console.log(`Ключ ${args[1]} («${k.getString("name")}») отозван`);
    } else {
      console.log("Использование: apikey create <название> [права] | apikey list | apikey revoke <prefix>");
    }
  },
}));

$app.rootCmd.addCommand(new Command({
  use: "admin",
  short: "Отметить пользователя администратором сервиса: admin <email>",
  run: (cmd, args) => {
    if (!args[0]) { console.log("Использование: admin <email>"); return; }
    const u = $app.findAuthRecordByEmail("users", args[0]);
    u.set("is_admin", true);
    $app.save(u);
    console.log(`${args[0]} — администратор`);
  },
}));
