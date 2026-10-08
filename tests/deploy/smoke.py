"""Проверка выкладки в локальном Docker: deploy/docker-compose.yml + docker-compose.local.yml.

Собирает образы, поднимает Caddy → PocketBase, MCP, Gotenberg на http://127.0.0.1:<порт> и проверяет:
сайт и API через прокси, настройки из окружения, ключ бота и приглашение, вход по приглашению,
«Скачать PDF» на странице печати (настоящий Gotenberg, текст и размер листа — pypdf), MCP по HTTP,
что у Gotenberg нет выхода в сеть, резервную копию. В конце — docker compose down -v (кроме --keep).
--old-browsers — ещё Chrome 62 и Firefox 60 из образов Selenium 3 (tests/deploy/old_browsers.py),
--save <каталог> — сохранить скачанные PDF.

    python tests/deploy/smoke.py [--port 8080] [--keep] [--old-browsers] [--save каталог]
"""
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "e2e"))
from common import ROOT, call, fixture  # noqa: E402

PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8080
KEEP = "--keep" in sys.argv
OLD = "--old-browsers" in sys.argv
SAVE = Path(sys.argv[sys.argv.index("--save") + 1]) if "--save" in sys.argv else None
BASE = f"http://127.0.0.1:{PORT}"
PROJECT = "conf-kit-smoke"
SU = ("su@example.com", "smoke-su-pass-12345")

tmp = Path(tempfile.mkdtemp(prefix="conf-kit-smoke-"))
env_file = tmp / "smoke.env"
env_file.write_text("\n".join([
    f"CONF_ENV_FILE={env_file.as_posix()}",
    f"CONF_LOCAL_PORT={PORT}",
    "CONF_DOMAIN=:80",
    f"CONF_PUBLIC_URL=http://127.0.0.1:{PORT}",
    "CONF_APP_NAME=conf-kit smoke",
    "CONF_BACKUP_CRON=0 3 * * *",
    "CONF_BACKUP_KEEP=3",
    "CONF_RATE_LIMITS=1",
]) + "\n", encoding="utf-8")
COMPOSE = ["docker", "compose", "-p", PROJECT, "-f", str(ROOT / "deploy/docker-compose.yml"),
           "-f", str(ROOT / "deploy/docker-compose.local.yml"), "--env-file", str(env_file)]


def compose(*args, check=True, capture=True):
    r = subprocess.run(COMPOSE + list(args), cwd=str(ROOT), capture_output=capture, text=True, encoding="utf-8", errors="replace")
    if check and r.returncode != 0:
        raise SystemExit(f"docker compose {' '.join(args)}: {r.returncode}\n{(r.stdout or '')[-3000:]}\n{(r.stderr or '')[-3000:]}")
    return r


def step(name):
    print("·", name, flush=True)


def main():
    step("сборка и запуск")
    compose("up", "-d", "--build", "--wait", "--wait-timeout", "180", capture=False)

    step("сайт и API через Caddy")
    with urllib.request.urlopen(BASE + "/") as r:
        html = r.read().decode()
        assert "app.js?v=" in html, html[:300]
        assert r.headers.get("X-Content-Type-Options") == "nosniff"
    with urllib.request.urlopen(urllib.request.Request(BASE + "/app.js", headers={"Accept-Encoding": "gzip"})) as r:
        assert r.headers.get("Content-Encoding") in ("gzip", "zstd"), "Caddy сжимает ответы"
    status, info = call(BASE, "GET", "/api/v1")
    assert status == 200 and info["features"]["pdf"] is True, info
    with urllib.request.urlopen(BASE + "/llms.txt") as r:
        assert "conf.program/v1" in r.read().decode()

    step("суперпользователь и настройки из окружения")
    compose("exec", "-T", "pocketbase", "pb", "superuser", "upsert", SU[0], SU[1])
    status, su = call(BASE, "POST", "/api/collections/_superusers/auth-with-password", {"identity": SU[0], "password": SU[1]})
    assert status == 200, su
    su_auth = {"Authorization": su["token"]}
    s = call(BASE, "GET", "/api/settings", headers=su_auth)[1]
    assert s["meta"]["appURL"] == BASE and s["meta"]["appName"] == "conf-kit smoke", s["meta"]
    assert s["trustedProxy"]["headers"] == ["X-Forwarded-For"] and s["rateLimits"]["enabled"], s["trustedProxy"]
    assert s["backups"]["cron"] == "0 3 * * *" and s["backups"]["cronMaxKeep"] == 3

    step("ключ бота, черновик, приглашение, вход")
    out = compose("exec", "-T", "pocketbase", "pb", "apikey", "create", "smoke", "create_events,update_own,read_own,send_feedback")
    key = re.search(r"ck_[a-z0-9]{8}_[A-Za-z0-9]{32}", out.stdout + out.stderr).group(0)
    status, created = call(BASE, "POST", "/api/v1/events", {"program": fixture("rwp-2026.program.json")}, {"X-API-Key": key})
    assert status == 201, created
    assert created["invite_url"].startswith(BASE + "/#/claim/"), created["invite_url"]
    ev_id = created["event"]["id"]
    token = created["invite_url"].rsplit("/", 1)[1]
    status, claimed = call(BASE, "POST", f"/api/v1/claim/{token}", {"email": "org@example.com", "password": "org-pass-1234"})
    assert status == 200, claimed
    auth = {"Authorization": claimed["token"]}
    assert call(BASE, "POST", f"/api/v1/events/{ev_id}/publish", {}, auth)[0] == 200

    step("PDF: страница печати → «Скачать PDF» → Gotenberg")
    pdf_check(ev_id, claimed)

    step("MCP по HTTP через Caddy")
    req = urllib.request.Request(BASE + "/mcp", method="POST", data=json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "smoke", "version": "0"}},
    }).encode(), headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": "Bearer " + key})
    with urllib.request.urlopen(req) as r:
        body = r.read().decode()
    assert "conf-kit" in body and "serverInfo" in body, body[:300]

    step("у Gotenberg нет выхода в сеть, PocketBase до него доходит")
    r = compose("exec", "-T", "gotenberg", "curl", "-sS", "-m", "5", "-o", "/dev/null", "https://ya.ru", check=False)
    assert r.returncode != 0, "Gotenberg достучался до внешнего сайта"
    r = compose("exec", "-T", "pocketbase", "wget", "-q", "-O", "-", "http://gotenberg:3000/health", check=False)
    assert r.returncode == 0 and '"up"' in r.stdout, r.stdout + r.stderr

    step("резервная копия")
    status, _ = call(BASE, "POST", "/api/backups", {"name": "smoke.zip"}, su_auth)
    assert status == 204, status
    backups = call(BASE, "GET", "/api/backups", headers=su_auth)[1]
    assert any(b["key"] == "smoke.zip" for b in backups), backups
    if OLD:
        step("старые браузеры")
        old_browsers(ev_id, claimed, auth)
    print("OK: выкладка работает")


def old_browsers(ev_id, claimed, auth):
    import old_browsers as ob
    prog = call(BASE, "GET", f"/api/v1/events/{ev_id}/program", headers=auth)[1]
    program, version = prog["program"], prog["event"]["version"]
    program["event"]["applications"] = {"enabled": True, "operator": "ФГБОУ ВО «ПГТУ» (проверка)", "contact": "conf@example.com"}
    status, saved = call(BASE, "PUT", f"/api/v1/events/{ev_id}/program", {"program": program, "base_version": version}, auth)
    assert status == 200, saved
    jury = call(BASE, "GET", f"/api/v1/events/{ev_id}/jury", headers=auth)[1]
    first = program["days"][0]["sessions"][0]["items"][0]["title"]
    data = {
        "event_id": ev_id, "slug": prog["event"]["slug"], "title": program["event"]["title"],
        "talk": first, "search": " ".join(first.split()[3:5]), "juror_code": jury["juror_code"],
        "auth": {"token": claimed["token"], "record": claimed["record"]},
    }
    ob.run(PROJECT + "_web", data)


def pdf_check(ev_id, claimed):
    from playwright.sync_api import sync_playwright
    from pypdf import PdfReader
    program = call(BASE, "GET", f"/api/v1/events/{ev_id}/program")[1]["program"]
    title = program["event"]["title"]
    talk = program["days"][0]["sessions"][0]["items"][0]["title"]
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 800}, accept_downloads=True)
        ctx.add_init_script("localStorage.setItem('conf_auth', JSON.stringify(%s))" % json.dumps({"token": claimed["token"], "record": claimed["record"]}))
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        for kind, landscape in (("program", False), ("doors", True)):
            page.goto(f"{BASE}/#/print/{ev_id}/{kind}")
            btn = page.get_by_role("button", name="Скачать PDF")
            btn.wait_for(timeout=15000)
            with page.expect_download(timeout=90000) as dl:
                btn.click()
            data = Path(dl.value.path()).read_bytes()
            if SAVE:
                SAVE.mkdir(parents=True, exist_ok=True)
                (SAVE / dl.value.suggested_filename).write_bytes(data)
            assert data[:5] == b"%PDF-", data[:20]
            assert dl.value.suggested_filename.endswith(f"-{kind}.pdf"), dl.value.suggested_filename
            reader = PdfReader(io.BytesIO(data))
            text = " ".join(pg.extract_text() or "" for pg in reader.pages)
            box = reader.pages[0].mediabox
            w, h = float(box.width), float(box.height)
            assert (w > h) == landscape and abs(max(w, h) - 842) < 3, (kind, w, h)
            if kind == "program":
                assert title.split()[0] in text and talk.split()[0] in text, text[:300]
                assert len(reader.pages) >= 2, len(reader.pages)
            print(f"  {kind}: {len(reader.pages)} стр., {w:.0f}×{h:.0f} pt, {len(data) // 1024} КБ")
        assert not errors, errors
        browser.close()


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        print(compose("logs", "--tail", "40", check=False).stdout[-6000:])
        raise
    finally:
        if KEEP:
            print(f"Стек оставлен: {BASE}; остановить: {' '.join(COMPOSE)} down -v")
        else:
            compose("down", "-v", "--remove-orphans", check=False)
            env_file.unlink()
            tmp.rmdir()
