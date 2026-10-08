"""Сквозной тест десктопа (1280×800): дерево программы, перетаскивание мышью внутри заседания и в другое
заседание, горячие клавиши, боковые листы, предпросмотр печати рядом с конструктором, таблица людей,
широкие таблицы рейтинга жюри и заявок.

    python tests/e2e/desktop_flow.py [--shots каталог]
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from playwright.sync_api import expect, sync_playwright  # noqa: E402

from common import call, check_layout, fixture, server, shot  # noqa: E402

DESKTOP = dict(viewport={"width": 1280, "height": 800})


def main():
    with server() as (base, key):
        status, created = call(base, "POST", "/api/v1/events", {"program": fixture("rwp-2026.program.json")}, {"X-API-Key": key})
        assert status == 201, created
        ev_id, slug = created["event"]["id"], created["event"]["slug"]
        token = created["invite_url"].rsplit("/", 1)[1]
        status, claimed = call(base, "POST", f"/api/v1/claim/{token}", {"email": "org@example.com", "password": "org-pass-1234"})
        owner = {"Authorization": claimed["token"]}
        program = lambda: call(base, "GET", f"/api/v1/events/{ev_id}/program", headers=owner)[1]["program"]  # noqa: E731

        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx = browser.new_context(**DESKTOP, accept_downloads=True)
            ctx.add_init_script("localStorage.setItem('conf_auth', JSON.stringify(%s))" % json.dumps({"token": claimed["token"], "record": claimed["record"]}))
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("dialog", lambda d: d.accept())

            # дерево слева, заседание — по щелчку в дереве
            page.goto(f"{base}/#/edit/{ev_id}")
            tree = page.locator(".ed-tree")
            expect(tree).to_be_visible()
            main_box = page.locator(".ed-main").bounding_box()
            assert tree.bounding_box()["x"] + 200 < main_box["x"], "дерево слева от основной колонки"
            check_layout(page, "конструктор 1280")
            # заседание, где не меньше 4 элементов (номер в дереве — сквозной)
            flat = [(di, si, len(s["items"])) for di, d in enumerate(program()["days"]) for si, s in enumerate(d["sessions"])]
            pick = next(i for i, x in enumerate(flat) if x[2] >= 4)
            di, si = flat[pick][:2]
            tree.locator(".tr-ses").nth(pick).click()
            page.wait_for_url(re.compile(rf"/d/{di}/s/{si}$"))
            rows = page.locator("li.ed-it")
            titles = lambda: page.locator("li.ed-it .it-title").all_text_contents()  # noqa: E731
            rows.nth(3).wait_for()
            before = titles()
            n0 = len(before)

            # перетаскивание: первый элемент — в нижнюю половину третьего (после него)
            h = rows.nth(2).bounding_box()["height"]
            rows.nth(0).drag_to(rows.nth(2), target_position={"x": 60, "y": h - 6})
            assert titles()[:3] == [before[1], before[2], before[0]], titles()[:3]
            page.locator(".savebar").wait_for()
            shot(page, "60-desktop-editor")

            # перетаскивание на другое заседание в дереве; Ctrl+Z возвращает
            rows.nth(0).drag_to(tree.locator(".tr-ses").nth(pick + 1 if pick + 1 < len(flat) else 0))
            expect(page.locator(".toast")).to_contain_text("Перенесено")
            assert len(titles()) == n0 - 1
            page.locator("body").click(position={"x": 5, "y": 5})
            page.keyboard.press("Control+z")
            assert len(titles()) == n0 and titles()[:3] == [before[1], before[2], before[0]], titles()[:3]

            # Alt+↓ сдвигает элемент в фокусе, Ctrl+S сохраняет
            page.locator("#ed-it-0 .ed-open").focus()
            page.keyboard.press("Alt+ArrowDown")
            assert titles()[:2] == [before[2], before[1]], titles()[:2]
            expect(page.locator("#ed-it-1 .ed-open")).to_be_focused()
            page.keyboard.press("Control+s")
            page.get_by_text("Сохранено — версия 2").wait_for()
            saved = [it["title"] for it in program()["days"][di]["sessions"][si]["items"]][:3]
            assert [t.endswith(x) for t, x in zip(titles()[:3], saved)] == [True] * 3, (titles()[:3], saved)

            # лист — боковой панелью справа; Esc закрывает
            page.locator("#ed-it-0 .ed-open").click()
            sheet = page.locator(".sheet")
            box = sheet.bounding_box()
            assert box["x"] > 700 and box["height"] > 700, box
            page.keyboard.press("Escape")
            expect(page.locator(".sheet")).to_have_count(0)

            # предпросмотр печати рядом и обновляется по правке
            page.get_by_role("button", name="Предпросмотр печати").click()
            prev = page.locator(".ed-preview")
            expect(prev.locator(".pd-program")).to_be_visible()
            page.locator("#ed-it-0 .ed-open").click()
            sheet.get_by_label("Название").fill("Совсем новое название доклада")
            sheet.get_by_role("button", name="Готово").click()
            expect(prev).to_contain_text("Совсем новое название доклада")
            check_layout(page, "конструктор с предпросмотром 1280")
            shot(page, "61-desktop-preview")

            # люди программы: таблица, разное написание приводится к одному
            tree.locator(".tr-ev").click()
            page.get_by_role("button", name=re.compile("^Люди")).click()
            expect(sheet.locator("table.people tbody tr").first).to_be_visible()
            assert sheet.locator("table.people tbody tr").count() > 20
            page.keyboard.press("Escape")
            page.keyboard.press("Control+s")
            page.get_by_text("Сохранено — версия 3").wait_for()

            # рейтинг жюри таблицей: оценки двух экспертов через API, вход владельцем без кода
            jury = call(base, "GET", f"/api/v1/events/{ev_id}/jury", headers=owner)[1]
            nc = len(jury["criteria"])
            talks = call(base, "GET", f"/api/jury/{slug}?action=ping&code={jury['juror_code']}")[1]["talks"]
            for j, v in (("Иванов И. И.", 5), ("Петров П. П.", 4)):
                for t in talks[:3]:
                    r = call(base, "POST", f"/api/jury/{slug}", {"action": "save", "code": jury["juror_code"], "juror": j, "id": t["code"], "scores": [v] * nc, "ts": 1})
                    assert r[1]["ok"], r
            page.goto(f"{base}/#/jury/{slug}")
            page.get_by_label("Эксперт (фамилия и инициалы)").fill("Оргкомитет")
            page.get_by_role("button", name="Войти").click()
            page.get_by_role("tab", name="Итоги").click()
            table = page.locator("table.jtable")
            expect(table.locator("tbody tr")).to_have_count(3)
            expect(table.locator("thead")).to_contain_text(f"К{nc}")
            expect(table.locator("tbody tr").first).to_contain_text("27")
            check_layout(page, "рейтинг 1280")
            shot(page, "62-desktop-jury")

            # заявки таблицей: принять в программу из строки
            prog = program()
            prog["event"]["applications"] = {"operator": "ООО «Пример»"}
            assert call(base, "PUT", f"/api/v1/events/{ev_id}/program", {"program": prog}, owner)[0] == 200
            r = call(base, "POST", f"/api/apply/{slug}", {"speaker": "Иванова А. Б.", "title": "Новый доклад", "section": 1,
                                                         "email": "a@example.com", "consent": True, "elapsed": 60000})
            assert r[0] == 201, r
            page.goto(f"{base}/#/applications/{ev_id}")
            row = page.locator("table.apps-table tbody tr").first
            expect(row).to_contain_text("a@example.com")
            row.get_by_role("button", name="Принять…").click()
            page.locator("tr.app-decide").get_by_role("button", name="Добавить в программу").click()
            expect(page.locator(".toast")).to_contain_text("Доклад добавлен в программу")
            check_layout(page, "заявки 1280")
            shot(page, "63-desktop-applications")

            assert not errors, errors
            browser.close()
    print("desktop_flow: OK")


if __name__ == "__main__":
    main()
