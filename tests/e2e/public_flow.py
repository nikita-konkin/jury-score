"""Сквозной тест публичной программы на телефоне (320 px) против настоящего PocketBase.

«Сейчас / далее» по часам мероприятия, поиск и фильтры, календарь, обновление без перезагрузки
(realtime и запасной опрос), копия программы без связи, отсчёт до начала.

    python tests/e2e/public_flow.py [--shots каталог]
"""
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from playwright.sync_api import sync_playwright  # noqa: E402

from common import PHONE, call, check_layout, fixture, server, shot  # noqa: E402

# 7 октября 2026, 09:20 по Москве
DURING = datetime(2026, 10, 7, 6, 20, tzinfo=timezone.utc)
BEFORE = datetime(2026, 10, 4, 9, 0, tzinfo=timezone.utc)


def main():
    with server() as (base, key):
        status, created = call(base, "POST", "/api/v1/events", {"program": fixture("rwp-2026.program.json")}, {"X-API-Key": key})
        assert status == 201, created
        ev_id, slug = created["event"]["id"], created["event"]["slug"]
        token = created["invite_url"].rsplit("/", 1)[1]
        status, claimed = call(base, "POST", f"/api/v1/claim/{token}", {"email": "org@example.com", "password": "org-pass-1234"})
        auth = {"Authorization": claimed["token"]}
        assert call(base, "POST", f"/api/v1/events/{ev_id}/publish", {}, auth)[0] == 200
        url = f"{base}/#/e/{slug}"

        def retitle(title):
            st, r = call(base, "GET", f"/api/v1/events/{ev_id}/program", headers=auth)
            r["program"]["event"]["title"] = title
            st, r = call(base, "PUT", f"/api/v1/events/{ev_id}/program", {"program": r["program"]}, auth)
            assert st == 200, r

        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx = browser.new_context(**PHONE)
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.clock.set_fixed_time(DURING)
            page.goto(url)

            # сейчас / далее и отметки в программе
            nn = page.locator(".nownext")
            nn.get_by_text("Сейчас").wait_for()
            assert "09:15" in nn.text_content() and "Далее" in nn.text_content(), nn.text_content()
            assert page.locator(".it.now").count() == 1
            assert page.locator(".it.past").count() >= 1
            assert page.get_by_role("tab", name=re.compile("7 октября")).get_attribute("aria-selected") == "true"
            check_layout(page, "публичная 320")
            shot(page, "20-public-now-320")

            # календарь: подписка и один доклад
            assert page.get_by_role("link", name="В календарь").first.get_attribute("href").startswith("webcal://")
            page.locator(".it.tap").first.click()
            link = page.locator(".it-actions a").first
            href = link.get_attribute("href")
            assert re.search(r"program\.ics\?item=s1-1$", href), href
            with urllib.request.urlopen(base + href) as r:
                assert r.headers["Content-Type"].startswith("text/calendar")
                assert r.read().decode().count("BEGIN:VEVENT") == 1

            # поиск и фильтры
            page.get_by_label("Поиск по программе").fill("ИОНОСФЕР")
            page.get_by_text(re.compile(r"Найдено: \d+")).wait_for()
            found = int(re.search(r"\d+", page.locator(".found").inner_text()).group())
            assert found >= 2, found
            page.get_by_role("button", name="Фильтры").click()
            page.get_by_label("Форма участия").select_option("online")
            fewer = int(re.search(r"\d+", page.locator(".found").inner_text()).group())
            assert 0 < fewer <= found
            check_layout(page, "поиск 320")
            shot(page, "21-public-search-320")
            page.get_by_role("button", name="Сбросить").click()
            assert page.locator(".nownext").count() == 1 and page.locator(".found").count() == 0

            # обновление без перезагрузки (realtime)
            retitle("RWP-2026 (обновлено)")
            page.get_by_text("Программа обновлена").wait_for()
            page.get_by_role("heading", name="RWP-2026 (обновлено)").wait_for()

            # без связи — сохранённая копия
            page.route("**/api/v1/events/*/program", lambda r: r.abort())
            page.reload()
            page.get_by_text("Нет связи — показана сохранённая копия").wait_for()
            page.get_by_role("heading", name="RWP-2026 (обновлено)").wait_for()
            page.unroute("**/api/v1/events/*/program")

            # старый браузер без EventSource: опрос при возвращении на вкладку
            old = ctx.new_page()
            old.add_init_script("delete window.EventSource")
            old.clock.set_fixed_time(DURING)
            old.goto(url)
            old.get_by_role("heading", name="RWP-2026 (обновлено)").wait_for()
            retitle("RWP-2026 (ещё раз)")
            old.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
            old.get_by_role("heading", name="RWP-2026 (ещё раз)").wait_for()

            # до начала — отсчёт
            soon = ctx.new_page()
            soon.clock.set_fixed_time(BEFORE)
            soon.goto(url)
            soon.get_by_text("До начала 3 дня").wait_for()
            assert soon.locator(".it.now, .it.past").count() == 0

            # тёмная тема и 390 px
            dark = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, color_scheme="dark")
            dp = dark.new_page()
            dp.clock.set_fixed_time(DURING)
            dp.goto(url)
            dp.locator(".nownext").wait_for()
            check_layout(dp, "публичная 390 тёмная")
            shot(dp, "22-public-now-390-dark")

            assert not errors, errors
            browser.close()
        print("e2e public: OK")


if __name__ == "__main__":
    main()
