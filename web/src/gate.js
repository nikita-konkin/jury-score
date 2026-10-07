/* Встраивается в <head> index.html. Только ES5: должно отработать в любом браузере.
 * 1) Браузер без нужных возможностей — вместо пустой страницы сообщение «Браузер устарел».
 * 2) Нет backdrop-filter, слабое устройство или «меньше прозрачности» — класс lite у <html>. */
(function () {
  var d = document.documentElement, w = window;
  var ok = "fetch" in w && "Promise" in w && "assign" in Object && "keys" in Object &&
    "localStorage" in w && "addEventListener" in w && "classList" in d && "from" in Array;
  try { ok = ok && !!w.CSS && CSS.supports("display", "grid") && CSS.supports("--x", "1"); } catch (e) { ok = false; }
  if (!ok) {
    w.__confOld = true;
    document.write('<div style="font:16px/1.45 sans-serif;max-width:420px;margin:15vh auto;padding:0 20px;color:#222">' +
      '<h1 style="font-size:22px">Браузер устарел</h1>' +
      '<p>Эта страница работает в браузерах не старше 2018 года. Установите Яндекс.Браузер или Google Chrome ' +
      'или обновите систему телефона.</p></div>');
    return;
  }
  var blur = false;
  try { blur = CSS.supports("backdrop-filter", "blur(1px)") || CSS.supports("-webkit-backdrop-filter", "blur(1px)"); } catch (e) { /* нет */ }
  var nav = w.navigator || {};
  var weak = (nav.deviceMemory && nav.deviceMemory <= 2) || (nav.hardwareConcurrency && nav.hardwareConcurrency <= 4);
  var lessGlass = w.matchMedia && w.matchMedia("(prefers-reduced-transparency: reduce)").matches;
  var forced = null;
  try { forced = w.localStorage.getItem("conf_lite"); } catch (e) { /* приватный режим */ }
  if (forced === "1" || (forced !== "0" && (!blur || weak || lessGlass))) d.className += " lite";
})();
