"""Сквозной тест локального обработчика: владелец получает ключ, ставит задачу из .docx с телефона,
worker/worker.mjs (отдельный процесс, --once) обрабатывает её поддельной моделью LM Studio,
владелец смотрит результат и добавляет доклады в заседание.

    python tests/e2e/jobs_flow.py [--shots каталог]
"""
import io
import json
import re
import subprocess
import sys
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from playwright.sync_api import expect, sync_playwright  # noqa: E402

from common import NODE, PHONE, ROOT, call, check_layout, fixture, server, shot  # noqa: E402

ITEMS = {"items": [
    {"title": "Рефракция радиоволн в приземном слое", "speaker": "Иванова А. Б.", "org": "Университет", "section": 2, "email": "a@example.com"},
    {"title": "Ионосферные бури 2026 года", "speaker": "П. П. Петров", "format": "онлайн"},
]}


class FakeLm(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.send({"data": [{"id": "fake-model"}]} if self.path == "/v1/models" else {}, 200 if self.path == "/v1/models" else 404)

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.send({"choices": [{"message": {"content": "```json\n" + json.dumps(ITEMS, ensure_ascii=False) + "\n```"}}]})


def docx_bytes(paragraphs):
    body = "".join(f"<w:p><w:r><w:t>{p}</w:t></w:r></w:p>" for p in paragraphs)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", f"<w:document><w:body>{body}</w:body></w:document>")
    return buf.getvalue()


def main():
    lm = ThreadingHTTPServer(("127.0.0.1", 0), FakeLm)
    threading.Thread(target=lm.serve_forever, daemon=True).start()
    lm_url = f"http://127.0.0.1:{lm.server_address[1]}"
    with server() as (base, key):
        status, created = call(base, "POST", "/api/v1/events", {"program": fixture("rwp-2026.program.json")}, {"X-API-Key": key})
        assert status == 201, created
        ev_id = created["event"]["id"]
        token = created["invite_url"].rsplit("/", 1)[1]
        status, claimed = call(base, "POST", f"/api/v1/claim/{token}", {"email": "org@example.com", "password": "org-pass-1234"})
        owner = {"Authorization": claimed["token"]}

        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx = browser.new_context(**PHONE)
            ctx.add_init_script("localStorage.setItem('conf_auth', JSON.stringify(%s))" % json.dumps({"token": claimed["token"], "record": claimed["record"]}))
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("dialog", lambda d: d.accept())

            page.goto(f"{base}/#/my/{ev_id}")
            page.get_by_role("link", name="Обработка на своём компьютере").click()
            expect(page.locator(".jobs-worker")).to_have_text("Компьютер ещё не подключён")
            page.get_by_role("button", name="Получить ключ обработчика").click()
            cmd = page.locator(".jobs-key pre").text_content()
            worker_key = re.search(r"--key (ck_[a-z0-9]{8}_[A-Za-z0-9]{32})", cmd).group(1)
            assert f"--server {base}" in cmd, cmd
            check_layout(page, "обработчик 320")

            # задача из .docx
            page.locator("summary", has_text="Новая задача").click()
            page.locator("input[type=file]").set_input_files(files=[{
                "name": "заявки.docx", "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "buffer": docx_bytes(["Иванова А. Б., a@example.com, Рефракция радиоволн", "П. П. Петров — Ионосферные бури"])}])
            expect(page.get_by_label("Текст материалов")).to_have_value(re.compile("Рефракция радиоволн"))
            expect(page.get_by_label("Название задачи")).to_have_value("заявки")
            page.get_by_role("button", name="Поставить в очередь").click()
            card = page.locator(".job").first
            expect(card).to_contain_text("в очереди")
            shot(page, "70-jobs-queued-320")

            # обработчик — отдельным процессом, как на компьютере организатора
            run = subprocess.run([NODE, "worker/worker.mjs", "--server", base, "--key", worker_key, "--lm", lm_url, "--once"],
                                 cwd=str(ROOT), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
            assert run.returncode == 0 and "готово: done" in run.stdout, run.stdout + run.stderr

            page.reload()
            expect(page.locator(".jobs-worker")).to_contain_text("на связи")
            card = page.locator(".job").first
            expect(card).to_contain_text("готово")
            expect(card).to_contain_text("Докладов: 2")
            card.get_by_role("button", name="Посмотреть").click()
            expect(card.locator(".job-items li")).to_have_count(2)
            expect(card).not_to_contain_text("example.com")
            check_layout(page, "результат 320")
            shot(page, "71-jobs-done-320")
            card.get_by_role("button", name="Добавить в заседание").click()
            expect(page.locator(".toast")).to_contain_text("Доклады добавлены — версия 2")
            expect(page.locator(".job").first).to_contain_text("применена")

            program = call(base, "GET", f"/api/v1/events/{ev_id}/program", headers=owner)[1]["program"]
            titles = [it["title"] for d in program["days"] for s in d["sessions"] for it in s["items"]]
            assert "Ионосферные бури 2026 года" in titles, titles[-5:]
            assert "example.com" not in json.dumps(program, ensure_ascii=False)

            assert not errors, errors
            browser.close()
    lm.shutdown()
    print("jobs_flow: OK")


if __name__ == "__main__":
    main()
