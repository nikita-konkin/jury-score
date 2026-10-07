"""Сквозной тест фронтенда против настоящего PocketBase.

Бот создаёт черновик по API-ключу -> человек на телефоне (320 px) открывает приглашение,
заводит аккаунт, публикует программу; «Создать из ответа чат-бота»; экран «Браузер устарел»; режим lite.

    pip install playwright && playwright install chromium
    python tests/e2e/claim_flow.py [--shots каталог]

Нужны Node (PATH или N:/tools/node) и PocketBase (PB_BIN или N:/tools/pocketbase).
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
NODE = shutil.which("node") or "N:/tools/node/node.exe"
PB = os.environ.get("PB_BIN") or ("N:/tools/pocketbase/pocketbase.exe" if Path("N:/tools/pocketbase/pocketbase.exe").exists() else "pocketbase")
SHOTS = Path(sys.argv[sys.argv.index("--shots") + 1]) if "--shots" in sys.argv else None


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def call(base, method, url, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + url, data=data, method=method, headers=dict({"Content-Type": "application/json"}, **(headers or {})))
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def check_layout(page, label):
    """Без горизонтальной прокрутки; видимые кнопки и поля не ниже 44 px (40 — внутри переключателей)."""
    over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    assert over <= 0, f"{label}: горизонтальная прокрутка {over}px"
    small = page.evaluate("""() => [...document.querySelectorAll('button, a.btn, input, textarea, .who, .back, summary')]
      .filter(el => el.offsetParent !== null)
      .map(el => [el.textContent.trim().slice(0, 30) || el.tagName, el.getBoundingClientRect().height, !!el.closest('.seg')])
      .filter(([, h, seg]) => h < (seg ? 40 : 44))""")
    assert not small, f"{label}: мелкие элементы {small}"


def shot(page, name):
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f"{name}.png"))


def main():
    tmp = Path(tempfile.mkdtemp(prefix="conf-kit-e2e-"))
    dist, data = tmp / "dist", tmp / "pb_data"
    subprocess.run([NODE, str(ROOT / "web/build.mjs"), "--out", str(dist)], check=True)
    dirs = ["--dir", str(data), "--hooksDir", str(ROOT / "pb/pb_hooks"), "--migrationsDir", str(ROOT / "pb/pb_migrations"), "--publicDir", str(dist)]
    subprocess.run([PB, "migrate", "up"] + dirs, check=True, capture_output=True)
    out = subprocess.run([PB, "apikey", "create", "Claude — e2e"] + dirs, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace")
    key = re.search(r"ck_[a-z0-9]{8}_[A-Za-z0-9]{32}", out.stdout + out.stderr).group(0)
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    server = subprocess.Popen([PB, "serve", "--http", f"127.0.0.1:{port}", "--automigrate=false"] + dirs,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(base + "/api/health")
                break
            except Exception:
                time.sleep(0.1)
        program = json.loads((ROOT / "fixtures/rwp-2026.program.json").read_text(encoding="utf-8"))
        status, created = call(base, "POST", "/api/v1/events", {"program": program}, {"X-API-Key": key})
        assert status == 201, created
        invite = created["invite_url"]
        assert invite.startswith(base), invite

        with sync_playwright() as p:
            browser = p.chromium.launch()
            phone = dict(viewport={"width": 320, "height": 568}, is_mobile=True, has_touch=True, device_scale_factor=2)

            # приглашение → новый аккаунт
            ctx = browser.new_context(**phone)
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(invite)
            page.get_by_role("button", name="Забрать черновик").wait_for()
            assert page.get_by_text("Подготовил: Claude — e2e").is_visible()
            assert page.locator(".it").count() >= 20, "в предпросмотре должна быть программа"
            check_layout(page, "приглашение 320")
            shot(page, "01-claim-320")
            page.get_by_label("Имя").fill("Организатор")
            page.get_by_label("E-mail").fill("org@example.com")
            page.get_by_label("Пароль (не короче 8 символов)").fill("org-pass-1234")
            page.get_by_role("button", name="Забрать черновик").click()
            page.wait_for_url(re.compile(r"#/my/\w+"))
            page.get_by_role("button", name="Опубликовать").wait_for()
            check_layout(page, "моё мероприятие 320")
            shot(page, "02-my-event-320")

            # переключение дней и публикация
            page.get_by_role("tab", name=re.compile("8 октября")).click()
            assert page.get_by_text("Выездное заседание").first.is_visible()
            page.get_by_role("button", name="Опубликовать").click()
            page.get_by_role("button", name="Снять с публикации").wait_for()
            assert page.locator(".badge.published").first.is_visible()

            # список мероприятий
            page.goto(base + "/#/")
            page.get_by_text("RWP-2026").first.wait_for()
            check_layout(page, "мои мероприятия 320")
            shot(page, "03-home-320")

            # из ответа чат-бота: JSON в тексте, отчёт, черновик и обратная связь
            page.goto(base + "/#/new")
            answer = "Вот программа:\n```json\n" + json.dumps({
                "program": {"event": {"title": "Школа из чата", "date_from": "2026-12-01"},
                            "days": [{"date": "2026-12-01", "sessions": [{"title": "Открытие", "room": "ауд. 1", "start": "10:00",
                                      "items": [{"type": "ceremony", "title": "Открытие", "duration": 20},
                                                {"type": "talk", "title": "Доклад", "speaker": "А. А. Иванов", "stand": 5}]}]}]},
                "feedback": [{"kind": "schema_limitation", "area": "schema", "summary": "Нет номера стенда", "workaround": "extra.stand"}],
            }, ensure_ascii=False) + "\n```\nГотово!"
            page.get_by_label("Ответ чат-бота").fill(answer)
            page.get_by_role("button", name="Проверить").click()
            page.get_by_text("Ошибок нет").wait_for()
            check_layout(page, "из JSON 320")
            shot(page, "04-from-json-320")
            page.get_by_role("button", name="Создать черновик").click()
            page.wait_for_url(re.compile(r"#/my/\w+"))
            page.get_by_text("Школа из чата").first.wait_for()
            assert not errors, errors
            ctx.close()

            # опубликованная программа без входа: 390 px, тёмная тема
            ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, color_scheme="dark")
            page = ctx.new_page()
            page.goto(base + "/#/e/" + created["event"]["slug"])
            page.get_by_text("Заседание №1").first.wait_for()
            check_layout(page, "публичная 390")
            shot(page, "05-public-390-dark")
            ctx.close()

            # десктоп
            ctx = browser.new_context(viewport={"width": 1280, "height": 800})
            page = ctx.new_page()
            page.goto(base + "/#/e/" + created["event"]["slug"])
            page.get_by_text("Заседание №1").first.wait_for()
            check_layout(page, "публичная 1280")
            shot(page, "06-public-1280")

            # браузер без fetch — сообщение вместо пустой страницы
            page = ctx.new_page()
            page.add_init_script("delete window.fetch")
            page.goto(base + "/#/")
            assert page.get_by_text("Браузер устарел").is_visible()
            # режим lite: без размытия
            page = ctx.new_page()
            page.add_init_script("localStorage.setItem('conf_lite', '1')")
            page.goto(base + "/#/")
            assert "lite" in page.evaluate("document.documentElement.className")
            assert page.evaluate("getComputedStyle(document.querySelector('.top')).backdropFilter") in ("none", "")
            ctx.close()
            browser.close()

        # обратная связь из ответа бота дошла
        status, su = call(base, "GET", "/api/v1/changelog")
        assert status == 200
        print("e2e: OK")
    finally:
        server.terminate()  # только наш процесс
        server.wait(timeout=10)
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
