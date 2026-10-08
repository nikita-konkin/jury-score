"""Сквозной тест жюри (#/jury/<адрес>): два эксперта на телефонах, офлайн-очередь, итоги администратора,
удаление оценок эксперта, CSV, панель владельца, печать итогов и дипломов, смена кода комиссии.

    python tests/e2e/jury_flow.py [--shots каталог]
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from playwright.sync_api import expect, sync_playwright  # noqa: E402

from common import PHONE, call, check_layout, fixture, server, shot  # noqa: E402


def login(page, base, slug, name, code=None, link_code=""):
    page.goto(f"{base}/#/jury/{slug}" + (f"/{link_code}" if link_code else ""))
    page.get_by_label("Эксперт (фамилия и инициалы)").fill(name)
    if code is not None:
        page.get_by_label("Код комиссии").fill(code)
    page.get_by_role("button", name="Войти").click()


def rate(card, value, n):
    """Все критерии доклада — одним баллом."""
    for c in range(n):
        card.locator(".jcrit").nth(c).locator(".jpt").nth(value - 1).click()


def main():
    with server() as (base, key):
        status, created = call(base, "POST", "/api/v1/events", {"program": fixture("rwp-2026.program.json")}, {"X-API-Key": key})
        assert status == 201, created
        ev_id, slug = created["event"]["id"], created["event"]["slug"]
        token = created["invite_url"].rsplit("/", 1)[1]
        status, claimed = call(base, "POST", f"/api/v1/claim/{token}", {"email": "org@example.com", "password": "org-pass-1234"})
        owner = {"Authorization": claimed["token"]}
        status, jury = call(base, "GET", f"/api/v1/events/{ev_id}/jury", headers=owner)
        assert status == 200 and jury["enabled"], jury
        nc, top = len(jury["criteria"]), len(jury["criteria"]) * jury["scale_max"]
        talks = jury["talks"]

        with sync_playwright() as p:
            browser = p.chromium.launch()
            errors = []

            def context(width=320, auth=False):
                ctx = browser.new_context(**dict(PHONE, viewport={"width": width, "height": 640}), accept_downloads=True)
                if auth:
                    ctx.add_init_script("localStorage.setItem('conf_auth', JSON.stringify(%s))" % json.dumps({"token": claimed["token"], "record": claimed["record"]}))
                page = ctx.new_page()
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.on("dialog", lambda d: d.accept())
                return ctx, page

            # неверный код
            ctx0, page = context()
            login(page, base, slug, "Сидоров С. С.", "zzzz-zzzz")
            expect(page.locator(".err")).to_have_text("Неверный код комиссии")
            ctx0.close()

            # эксперт 1 по ссылке с кодом: оценки, сохранение, список докладов как в программе
            ctx1, a = context()
            login(a, base, slug, "Иванов И. И.", link_code=jury["juror_code"])
            expect(a.locator(".jury-who")).to_contain_text("эксперт")
            expect(a.locator(".jury-prog")).to_contain_text(f"Оценено 0 из {talks}")
            assert a.locator(".jcard").count() == talks
            first = a.locator(".jcard").nth(0)
            first.locator(".jsum").click()
            rate(first, 5, nc)
            expect(first.locator(".jsv")).to_have_text("✓ Сохранено")
            expect(first.locator(".jscore")).to_have_text(f"{top}/{top}")
            check_layout(a, "жюри 320")
            shot(a, "40-jury-card-320")

            # без связи: оценка остаётся на телефоне, после восстановления связи уходит сама
            first.get_by_role("button", name="Следующий →").click()
            second = a.locator(".jcard").nth(1)
            ctx1.set_offline(True)
            rate(second, 5, nc)
            expect(a.locator(".sync")).to_contain_text("не отправлено: 1", timeout=10000)
            expect(second.locator(".jsv")).to_have_text("⚠ Не отправлено")
            ctx1.set_offline(False)
            expect(a.locator(".sync")).to_have_text("✓ всё отправлено", timeout=10000)
            third = a.locator(".jcard").nth(2)
            third.locator(".jsum").click()
            third.get_by_role("button", name="Доклад не состоялся").click()
            expect(third.locator(".jscore")).to_have_text("не было")
            fourth = a.locator(".jcard").nth(3)
            fourth.locator(".jsum").click()
            fourth.locator(".jcrit").nth(0).locator(".jpt").nth(3).click()
            fourth.locator(".jcomment").fill("Хороший доклад")
            fourth.locator(".jcomment").blur()
            expect(a.locator(".sync")).to_have_text("✓ всё отправлено", timeout=10000)
            expect(a.locator(".jury-prog")).to_contain_text(f"Оценено 3 из {talks}")

            # после перезагрузки вход и оценки на месте
            a.reload()
            expect(a.locator(".jcard").nth(0).locator(".jscore")).to_have_text(f"{top}/{top}")
            expect(a.locator(".jcard").nth(3).locator(".jscore")).to_have_text(f"4 · 1/{nc}")
            a.locator(".jcard").nth(3).locator(".jsum").click()
            expect(a.locator(".jcard").nth(3).locator(".jcomment")).to_have_value("Хороший доклад")
            # эксперт видит только свои итоги
            a.get_by_role("tab", name="Итоги").click()
            expect(a.locator(".jrank")).to_have_count(2)
            assert a.get_by_role("button", name="⬇ Рейтинг, CSV").count() == 0

            # эксперт 2 на экране 390 px, код вводит вручную
            ctx2, b = context(390)
            login(b, base, slug, "Петров П. П.", jury["juror_code"].upper())
            expect(b.locator(".jury-prog")).to_contain_text(f"Оценено 0 из {talks}")
            for i, v in ((0, 4), (1, 3)):
                card = b.locator(".jcard").nth(i)
                card.locator(".jsum").click()
                rate(card, v, nc)
            expect(b.locator(".sync")).to_have_text("✓ всё отправлено", timeout=10000)
            check_layout(b, "жюри 390")

            # администратор: рейтинг, секции, статистика, CSV, удаление эксперта
            ctx3, adm = context()
            login(adm, base, slug, "Председатель Ж. Ю.", jury["admin_code"])
            expect(adm.locator(".jury-who")).to_contain_text("администратор")
            adm.get_by_role("tab", name="Итоги").click()
            expect(adm.locator(".jury-note")).to_contain_text("Обновлено в")
            ranks = adm.locator(".jrank")
            expect(ranks).to_have_count(2)
            expect(ranks.nth(0).locator(".javg b")).to_have_text(str((top + 4 * nc) // 2))
            expect(ranks.nth(0).locator(".javg span")).to_have_text("2 эксперта")
            expect(ranks.nth(1).locator(".javg b")).to_have_text(str((top + 3 * nc) // 2))
            check_layout(adm, "итоги 320")
            shot(adm, "41-jury-results-320")
            adm.get_by_role("button", name="Секции", exact=True).click()
            expect(adm.locator(".jury-sech").first).to_be_visible()
            adm.get_by_role("button", name="Статистика", exact=True).click()
            expect(adm.locator(".jtile").nth(0)).to_contain_text("2")
            expect(adm.locator(".jtile").nth(1)).to_contain_text("4")
            check_layout(adm, "статистика 320")
            shot(adm, "42-jury-stats-320")
            adm.get_by_role("button", name="Рейтинг", exact=True).click()
            with adm.expect_download() as dl:
                adm.get_by_role("button", name="⬇ Рейтинг, CSV").click()
            csv = Path(dl.value.path()).read_text(encoding="utf-8-sig")
            assert csv.startswith("Место;Место в секции;Секция;Код"), csv[:80]
            assert f";{(top + 4 * nc) // 2};2;" in csv, csv
            with adm.expect_download() as dl:
                adm.get_by_role("button", name="⬇ Все оценки, CSV").click()
            raw = Path(dl.value.path()).read_text(encoding="utf-8-sig")
            assert "не состоялся" in raw and "Хороший доклад" in raw, raw
            adm.get_by_role("button", name="Удалить оценки: Петров П. П.").click()
            expect(adm.locator(".toast")).to_have_text("Удалено оценок: 2")
            expect(ranks.nth(0).locator(".javg b")).to_have_text(str(top))
            expect(ranks.nth(0).locator(".javg span")).to_have_text("1 эксперт")
            status, all_rows = call(base, "GET", f"/api/jury/{slug}?action=all&code={jury['admin_code']}")
            assert all(r["juror"] != "Петров П. П." for r in all_rows["rows"]), all_rows

            # владелец: панель жюри, итоги без кода, печать итогов и дипломов
            ctx4, own = context(auth=True)
            own.goto(f"{base}/#/my/{ev_id}")
            own.locator(".jury-panel summary").click()
            expect(own.locator(".jury-codes")).to_contain_text(jury["juror_code"])
            check_layout(own, "панель жюри 320")
            own.get_by_role("link", name="Итоги и дипломы для печати").click()
            expect(own.locator(".pd-results tbody tr")).to_have_count(2)
            expect(own.locator(".pd-results")).to_contain_text("Итоги конкурса докладов")
            own.get_by_role("tab", name="Дипломы").click()
            expect(own.locator(".pd-diploma")).to_have_count(2)
            expect(own.locator(".pd-diploma").first).to_contain_text("I степени")
            shot(own, "43-jury-diplomas-320")
            login(own, base, slug, "Оргкомитет")
            expect(own.locator(".jury-who")).to_contain_text("администратор")

            # новый код экспертов: старый перестаёт работать, правка остаётся на телефоне
            status, reset = call(base, "POST", f"/api/v1/events/{ev_id}/jury", {"reset": "juror"}, owner)
            assert status == 200, reset
            a.get_by_role("tab", name="Оценки").click()
            card = a.locator(".jcard").nth(4)
            card.locator(".jsum").click()
            card.locator(".jcrit").nth(0).locator(".jpt").nth(1).click()
            expect(a.locator(".pill.warn")).to_contain_text("Код комиссии больше не действует", timeout=10000)
            assert "conf_jury_pending" in a.evaluate("Object.keys(localStorage).join(' ')")

            assert not errors, errors
            browser.close()
    print("jury_flow: OK")


if __name__ == "__main__":
    main()
