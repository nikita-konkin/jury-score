"""Старые браузеры против развёрнутого стека: Chrome и Firefox 2018 года в образах Selenium 3.

Запускается из smoke.py (--old-browsers): контейнер Selenium подключается к сети стека и открывает сайт
по адресу http://caddy/. Протокол WebDriver — urllib, без пакета selenium: у Chrome из Selenium 3.6
диалект JSON Wire, у Firefox (geckodriver) — W3C. Действия выполняются скриптами в странице (input/change,
click) — проверяется, что код приложения работает в старом движке: главная, публичная программа с поиском,
форма заявки, вход эксперта и оценка, конструктор с листом, страница печати. Ошибки JS — window.onerror
после загрузки и журнал браузера (Chrome); незагрузившийся бандл виден по пустой странице.
"""
import json
import subprocess
import time
import urllib.error
import urllib.request

BROWSERS = [
    ("chrome", "selenium/standalone-chrome:3.6.0"),
    ("firefox", "selenium/standalone-firefox:3.12.0"),
]
SITE = "http://caddy"

# Помощники в странице: поле по подписи, ввод с событиями Preact, клик по кнопке с текстом
HELPERS = r"""
window.__h = {
  field: function (text, root) {
    var ls = (root || document).querySelectorAll('label');
    for (var i = 0; i < ls.length; i++) {
      var t = (ls[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (t.indexOf(text) === 0) return ls[i].querySelector('input, textarea, select');
    }
    return null;
  },
  set: function (el, value) {
    if (el.type === 'checkbox') { if (el.checked !== value) el.click(); return; }
    el.focus(); el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  },
  button: function (text, root) {
    var bs = (root || document).querySelectorAll('button, a');
    for (var i = 0; i < bs.length; i++) if ((bs[i].textContent || '').replace(/\s+/g, ' ').trim() === text) return bs[i];
    return null;
  },
  text: function () { return document.body ? document.body.textContent : ''; }
};
if (!window.__errs) { window.__errs = []; window.addEventListener('error', function (e) { window.__errs.push(String(e.message)); }); }
return true;
"""


class Driver:
    def __init__(self, url, browser):
        self.url = url.rstrip("/")
        caps = {"browserName": browser}
        if browser == "chrome":
            caps["loggingPrefs"] = {"browser": "ALL"}
        r = self._req("POST", "/session", {"desiredCapabilities": caps, "capabilities": {"alwaysMatch": {"browserName": browser}}})
        if "sessionId" in r and r.get("sessionId"):
            self.w3c, self.sid, c = False, r["sessionId"], r.get("value") or {}
        else:
            self.w3c, self.sid, c = True, r["value"]["sessionId"], r["value"].get("capabilities") or {}
        self.version = c.get("browserVersion") or c.get("version") or "?"

    def _req(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else (b"{}" if method == "POST" else None)
        req = urllib.request.Request(self.url + "/wd/hub" + path, data=data, method=method,
                                     headers={"Content-Type": "application/json;charset=utf-8"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                out = json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"WebDriver {method} {path}: {e.code} {e.read()[:500]!r}")
        if not self._ok(out):
            raise RuntimeError(f"WebDriver {method} {path}: {json.dumps(out, ensure_ascii=False)[:500]}")
        return out

    @staticmethod
    def _ok(out):
        if isinstance(out.get("status"), int) and out["status"] != 0:
            return False
        return not (isinstance(out.get("value"), dict) and "error" in out["value"])

    def go(self, url):
        self._req("POST", f"/session/{self.sid}/url", {"url": url})

    def js(self, script, *args):
        path = f"/session/{self.sid}/execute/sync" if self.w3c else f"/session/{self.sid}/execute"
        return self._req("POST", path, {"script": script, "args": list(args)}).get("value")

    def wait(self, script, what, timeout=20):
        end = time.time() + timeout
        while True:
            try:
                if self.js(script):
                    return
            except RuntimeError:
                pass
            if time.time() > end:
                body = self.js("return document.body ? document.body.textContent.slice(0, 400) : ''")
                raise AssertionError(f"не дождались: {what}; на странице: {body!r}")
            time.sleep(0.3)

    def open(self, hash_path, ready, what):
        """Полная загрузка страницы (через about:blank), помощники, ожидание признака готовности."""
        self.go("about:blank")
        self.go(SITE + "/" + hash_path)
        self.wait("return !!document.querySelector('.wrap') || /Браузер устарел/.test(document.body.textContent)", what + ": приложение")
        assert not self.js("return !!window.__confOld"), f"{what}: «Браузер устарел»"
        self.js(HELPERS)
        self.wait(ready, what)

    def logs(self):
        if self.w3c:
            return []
        try:
            return self._req("POST", f"/session/{self.sid}/log", {"type": "browser"}).get("value") or []
        except RuntimeError:
            return []

    def quit(self):
        try:
            self._req("DELETE", f"/session/{self.sid}")
        except Exception:
            pass


def start(image, network, name):
    subprocess.run(["docker", "rm", "-f", name], capture_output=True)
    subprocess.run(["docker", "run", "-d", "--rm", "--name", name, "--network", network, "--shm-size", "1g",
                    "-p", "127.0.0.1::4444", image], check=True, capture_output=True)
    port = subprocess.run(["docker", "port", name, "4444"], check=True, capture_output=True, text=True).stdout.split(":")[-1].strip()
    url = f"http://127.0.0.1:{port}"
    for _ in range(120):
        try:
            with urllib.request.urlopen(url + "/wd/hub/status", timeout=2) as r:
                if r.status == 200:
                    return url
        except Exception:
            time.sleep(0.5)
    raise RuntimeError(f"{image}: Selenium не запустился")


def check(d, data, label):
    """Сценарий в одном браузере; data — из smoke.py."""
    ev, slug = data["event_id"], data["slug"]
    # главная
    d.open("#/", "return document.querySelectorAll('.wrap a, .wrap button').length > 0", "главная")
    lite = d.js("return document.documentElement.className")

    # публичная программа (открывается на сегодняшнем дне) и поиск по всем дням
    d.open(f"#/e/{slug}", f"return __h.text().indexOf({json.dumps(data['title'])}) >= 0", "публичная программа")
    d.js(f"__h.set(document.querySelector('input[type=search]'), {json.dumps(data['search'])}); return true")
    d.wait(f"return __h.text().indexOf({json.dumps(data['talk'])}) >= 0", "программа: поиск нашёл доклад")

    # форма заявки
    d.go("about:blank")
    d.go(f"{SITE}/#/apply/{slug}")
    d.wait("return !!document.querySelector('.apply-form')", "заявка: форма")
    d.js(HELPERS)
    d.js("""
      var f = document.querySelector('.apply-form');
      __h.set(__h.field('Докладчик', f), 'Тестова Т. Т.');
      __h.set(__h.field('Название доклада', f), arguments[0]);
      var s = __h.field('Секция', f); __h.set(s, s.options[1].value);
      __h.set(__h.field('E-mail для связи', f), 'old-browser@example.com');
      __h.set(__h.field('Согласен', f), true);
      return true""", f"Доклад из старого браузера ({label})")
    time.sleep(3.2)  # антиспам: форма заполняется не быстрее 3 с
    d.js("__h.button('Отправить заявку').click(); return true")
    d.wait("return !!document.querySelector('.apply-done')", "заявка: отправлена")

    # жюри: вход по коду из ссылки, оценка первого доклада
    d.go("about:blank")
    d.go(f"{SITE}/#/jury/{slug}/{data['juror_code']}")
    d.wait("return !!document.querySelector('.wrap')", "жюри: приложение")
    d.js(HELPERS)
    d.wait("return !!__h.field('Эксперт')", "жюри: вход")
    d.js(f"__h.set(__h.field('Эксперт'), {json.dumps('Старов ' + label[0].upper() + '. Б.')}); return true")
    d.js("__h.button('Войти').click(); return true")  # отдельным вызовом: после перерисовки, как у человека
    d.wait("return document.querySelectorAll('.jcard').length > 0", "жюри: список докладов")
    d.js("document.querySelector('.jcard .jsum').click(); return true")
    d.wait("return document.querySelectorAll('.jcard .jcrit').length > 0", "жюри: критерии")
    d.js("""var cs = document.querySelector('.jcard').querySelectorAll('.jcrit');
      for (var i = 0; i < cs.length; i++) { var p = cs[i].querySelectorAll('.jpt'); p[p.length - 1].click(); }
      return true""")
    d.wait("var s = document.querySelector('.jcard .jsv'); return !!s && s.textContent.indexOf('Сохранено') >= 0", "жюри: оценка сохранена")
    d.wait("var s = document.querySelector('.sync'); return !!s && s.textContent.indexOf('всё отправлено') >= 0", "жюри: оценка отправлена", 30)

    # конструктор (вход владельца — через localStorage), лист настроек мероприятия
    d.go("about:blank")
    d.go(SITE + "/")
    d.wait("return !!document.querySelector('.wrap')", "вход: приложение")
    d.js("localStorage.setItem('conf_auth', arguments[0]); return true", json.dumps(data["auth"]))
    d.go("about:blank")
    d.go(f"{SITE}/#/edit/{ev}")
    d.wait("return !!document.querySelector('.wrap')", "конструктор: приложение")
    d.js(HELPERS)
    d.wait("return !!__h.button('Название, даты, регламент')", "конструктор: загружен editor.js", 30)
    d.js("__h.button('Название, даты, регламент').click(); return true")
    d.wait("return !!document.querySelector('.sheet') && !!__h.button('Готово', document.querySelector('.sheet'))", "конструктор: лист")
    d.js("__h.button('Готово', document.querySelector('.sheet')).click(); return true")
    d.wait("return !document.querySelector('.sheet')", "конструктор: лист закрыт")

    # печать
    d.go("about:blank")
    d.go(f"{SITE}/#/print/{ev}/program")
    d.wait("return !!document.querySelector('.wrap')", "печать: приложение")
    d.js(HELPERS)
    d.wait(f"var p = document.querySelector('.pd-program'); return !!p && p.textContent.indexOf({json.dumps(data['talk'])}) >= 0", "печать: программа")
    d.wait("return !!__h.button('Скачать PDF')", "печать: кнопка PDF")

    errs = d.js("return window.__errs || []") or []
    logs = [x for x in d.logs() if x.get("level") == "SEVERE" and "favicon" not in x.get("message", "")]
    assert not errs, f"{label}: ошибки JS {errs}"
    assert not logs, f"{label}: журнал браузера {logs}"
    return lite


def run(network, data):
    results = []
    for browser, image in BROWSERS:
        name = "conf-kit-old-" + browser
        url = start(image, network, name)
        try:
            d = Driver(url, browser)
            label = f"{browser} {d.version}"
            try:
                lite = check(d, data, label)
                results.append(label)
                print(f"  {label}: OK (класс <html>: {lite.strip() or '—'})")
            finally:
                d.quit()
        finally:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)
    return results
