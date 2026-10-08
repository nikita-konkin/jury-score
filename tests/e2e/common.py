"""Общее для сквозных тестов: сборка фронтенда, временный PocketBase, ключ бота, проверки вёрстки."""
import contextlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NODE = shutil.which("node") or "N:/tools/node/node.exe"
PB = os.environ.get("PB_BIN") or ("N:/tools/pocketbase/pocketbase.exe" if Path("N:/tools/pocketbase/pocketbase.exe").exists() else "pocketbase")
SHOTS = Path(sys.argv[sys.argv.index("--shots") + 1]) if "--shots" in sys.argv else None
PHONE = dict(viewport={"width": 320, "height": 568}, is_mobile=True, has_touch=True, device_scale_factor=2)


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


def fixture(name):
    return json.loads((ROOT / "fixtures" / name).read_text(encoding="utf-8"))


@contextlib.contextmanager
def server():
    """Собранный dist/ и PocketBase на свободном порту; отдаёт (base, ключ бота)."""
    tmp = Path(tempfile.mkdtemp(prefix="conf-kit-e2e-"))
    dist, data = tmp / "dist", tmp / "pb_data"
    subprocess.run([NODE, str(ROOT / "web/build.mjs"), "--out", str(dist)], check=True)
    dirs = ["--dir", str(data), "--hooksDir", str(ROOT / "pb/pb_hooks"), "--migrationsDir", str(ROOT / "pb/pb_migrations"), "--publicDir", str(dist)]
    subprocess.run([PB, "migrate", "up"] + dirs, check=True, capture_output=True)
    out = subprocess.run([PB, "apikey", "create", "Claude — e2e"] + dirs, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace")
    key = re.search(r"ck_[a-z0-9]{8}_[A-Za-z0-9]{32}", out.stdout + out.stderr).group(0)
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = subprocess.Popen([PB, "serve", "--http", f"127.0.0.1:{port}", "--automigrate=false"] + dirs,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(base + "/api/health")
                break
            except Exception:
                time.sleep(0.1)
        yield base, key
    finally:
        proc.terminate()  # только наш процесс
        proc.wait(timeout=10)
        shutil.rmtree(tmp, ignore_errors=True)


def check_layout(page, label):
    """Без горизонтальной прокрутки; видимые кнопки и поля не ниже 44 px (40 — внутри переключателей)."""
    over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    assert over <= 0, f"{label}: горизонтальная прокрутка {over}px"
    small = page.evaluate("""() => [...document.querySelectorAll('button, a.btn, input, textarea, select, .who, .back, summary')]
      .filter(el => el.offsetParent !== null && el.type !== 'file')
      // у флажка нажимается вся строка-подпись
      .map(el => [el.textContent.trim().slice(0, 30) || el.tagName,
        (el.type === 'checkbox' && el.closest('label') ? el.closest('label') : el).getBoundingClientRect().height, !!el.closest('.seg')])
      .filter(([, h, seg]) => h < (seg ? 40 : 44))""")
    assert not small, f"{label}: мелкие элементы {small}"


def shot(page, name):
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f"{name}.png"))
