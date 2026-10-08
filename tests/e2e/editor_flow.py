"""Сквозной тест конструктора на телефоне (320 px) против настоящего PocketBase.

Правка элемента в нижнем листе, порядок кнопками, ошибка и отмена, импорт CSV, черновик после
перезагрузки, конфликт версий, откат, «Назад» закрывает лист, новое мероприятие и «по образцу».

    python tests/e2e/editor_flow.py [--shots каталог]
"""
import json
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from playwright.sync_api import sync_playwright  # noqa: E402

from common import PHONE, call, check_layout, fixture, server, shot  # noqa: E402


def main():
    with server() as (base, key):
        status, created = call(base, "POST", "/api/v1/events", {"program": fixture("rwp-2026.program.json")}, {"X-API-Key": key})
        assert status == 201, created
        ev_id = created["event"]["id"]
        token = created["invite_url"].rsplit("/", 1)[1]
        status, claimed = call(base, "POST", f"/api/v1/claim/{token}", {"email": "org@example.com", "password": "org-pass-1234", "name": "Организатор"})
        assert status == 200, claimed
        auth = {"Authorization": claimed["token"]}

        def program():
            st, r = call(base, "GET", f"/api/v1/events/{ev_id}/program", headers=auth)
            assert st == 200, r
            return r

        def first_session_items():
            return program()["program"]["days"][0]["sessions"][0]["items"]

        csv = Path(tempfile.mkdtemp()) / "заявки.csv"
        csv.write_bytes("ФИО докладчика;Тема доклада;E-mail\nСидоров С. С.;Новый доклад из таблицы;s@example.com\nКузнецова К. К.;Второй доклад из таблицы;k@example.com\n".encode("cp1251"))

        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx = browser.new_context(**PHONE)
            ctx.add_init_script("localStorage.setItem('conf_auth', JSON.stringify(%s))" % json.dumps({"token": claimed["token"], "record": claimed["record"]}))
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("dialog", lambda d: d.accept())

            # уровень мероприятия
            page.goto(f"{base}/#/edit/{ev_id}")
            page.get_by_text("Дни", exact=True).wait_for()
            assert page.locator(".ed-row.ok").count() == 1, "проверка без ошибок"
            check_layout(page, "конструктор 320")
            shot(page, "10-editor-event-320")

            # день → заседание → элемент в нижнем листе
            page.locator("a.ed-row").first.click()
            page.wait_for_url(re.compile(r"/d/0$"))
            check_layout(page, "день 320")
            page.locator("a.ed-row").first.click()
            page.wait_for_url(re.compile(r"/d/0/s/0$"))
            check_layout(page, "заседание 320")
            shot(page, "11-editor-session-320")
            page.locator(".ed-open").first.click()
            sheet = page.locator(".sheet")
            sheet.wait_for()
            check_layout(page, "лист элемента 320")
            page.wait_for_timeout(300)  # анимация листа
            shot(page, "12-editor-item-sheet-320")
            sheet.get_by_label("Название").fill("Исправленное название доклада")
            sheet.get_by_role("button", name="Готово").click()
            page.locator(".savebar").wait_for()
            page.get_by_role("button", name="Сохранить").click()
            page.get_by_text("Сохранено — версия 2").wait_for()
            items = first_session_items()
            assert items[0]["title"] == "Исправленное название доклада", items[0]["title"]
            codes = [it["code"] for it in items]

            # порядок кнопками: второй вверх, время пересчитано
            page.get_by_role("button", name="Порядок").click()
            page.get_by_role("button", name="Выше").nth(1).click()  # второй элемент вверх
            page.get_by_role("button", name="Готово").click()
            page.get_by_role("button", name="Сохранить").click()
            page.get_by_text("Сохранено — версия 3").wait_for()
            items = first_session_items()
            assert [it["code"] for it in items][:2] == [codes[1], codes[0]], [it["code"] for it in items][:3]
            assert items[0]["start"] == "09:00"

            # закреплённое время с наложением → ошибка, сохранить нельзя; отмена убирает
            page.locator(".ed-open").nth(2).click()
            sheet.get_by_label("Начало").fill("09:05")
            sheet.get_by_role("button", name="Готово").click()
            page.get_by_role("button", name=re.compile(r"Ошибок: \d")).wait_for()
            assert page.locator(".ed-it.has-err").count() >= 1
            shot(page, "13-editor-error-320")
            page.get_by_role("button", name=re.compile(r"Ошибок: \d")).click()
            page.locator(".sheet .link-row").first.click()
            page.wait_for_url(re.compile(r"/d/0/s/0$"))
            assert not page.locator(".sheet").count()
            page.get_by_role("button", name="Отменить последнее действие").click()
            page.get_by_role("button", name="Сохранить").wait_for()

            # «Назад» закрывает лист и оставляет в заседании
            page.locator(".ed-open").first.click()
            sheet.wait_for()
            page.go_back()
            page.wait_for_timeout(300)
            assert not page.locator(".sheet").count(), "лист не закрылся"
            assert re.search(r"/d/0/s/0$", page.url), page.url

            # импорт из CSV в Windows-1251: e-mail не переносится
            page.get_by_role("button", name="Из таблицы…").click()
            sheet.locator("input[type=file]").set_input_files(str(csv))
            sheet.get_by_text("заголовок узнан").wait_for()
            check_layout(page, "импорт 320")
            shot(page, "14-editor-import-320")
            sheet.get_by_role("button", name=re.compile("Добавить 2")).click()
            page.locator(".it-title", has_text="Новый доклад из таблицы").wait_for()
            warned = page.locator(".ed-it.has-warn .it-note, .ed-it.has-err .it-note").all_inner_texts()
            assert not warned, warned

            # черновик переживает перезагрузку
            page.reload()
            page.get_by_text("Восстановлены несохранённые изменения").wait_for()
            page.locator(".it-title", has_text="Второй доклад из таблицы").wait_for()

            # конфликт: программу поменяли через API, пока правка не сохранена
            other = program()["program"]
            other["event"]["subtitle"] = "Изменено ботом"
            st, r = call(base, "PUT", f"/api/v1/events/{ev_id}/program", {"program": other}, auth)
            assert st == 200, r
            page.get_by_role("button", name="Сохранить").click()
            page.get_by_text("Программу изменили в другом месте").wait_for()
            shot(page, "15-editor-conflict-320")
            page.get_by_role("button", name="Сохранить поверх").click()
            page.get_by_text(re.compile("Сохранено — версия 5")).wait_for()
            saved = program()
            assert saved["event"]["version"] == 5
            texts = json.dumps(saved["program"], ensure_ascii=False)
            assert "Второй доклад из таблицы" in texts and "@example.com" not in texts

            # откат к версии 1
            page.goto(f"{base}/#/edit/{ev_id}")
            page.get_by_role("button", name=re.compile("История версий")).click()
            sheet.get_by_text("№1").wait_for()
            sheet.locator(".ver-list li").last.get_by_role("button", name="Открыть").click()
            page.get_by_role("button", name="Сохранить").click()
            page.get_by_text("Сохранено — версия 6").wait_for()
            st, hist = call(base, "GET", f"/api/v1/events/{ev_id}/versions", headers=auth)
            assert hist["versions"][0]["note"] == "Откат к версии 1", hist["versions"][0]
            assert first_session_items()[0]["title"] != "Исправленное название доклада"

            # новое мероприятие: дни по датам
            page.goto(f"{base}/#/")
            page.get_by_role("link", name="Новое мероприятие").click()
            page.get_by_label("Название").fill("Школа молодых учёных")
            page.get_by_label("Начало").fill("2026-12-01")
            page.get_by_label("Окончание").fill("2026-12-02")
            check_layout(page, "новое мероприятие 320")
            page.get_by_role("button", name="Создать и открыть конструктор").click()
            page.wait_for_url(re.compile(r"#/edit/\w+$"))
            page.get_by_text("Дни", exact=True).wait_for()
            assert page.locator("a.ed-row").count() == 2, page.locator("a.ed-row").all_inner_texts()
            page.locator("a.ed-row").first.click()
            page.get_by_role("button", name="+ Заседание").click()
            sheet.get_by_label("Зал", exact=True).fill("ауд. 101")
            sheet.get_by_label("Начало").fill("10:00")
            sheet.get_by_role("button", name="Добавить").click()
            page.wait_for_url(re.compile(r"/d/0/s/0$"))
            page.get_by_role("button", name="+ Доклад").click()
            sheet.get_by_label("Название").fill("Первый доклад школы")
            sheet.get_by_label("Докладчик").fill("А. А. Иванов")
            sheet.get_by_role("button", name="Добавить").click()
            page.get_by_role("button", name="Сохранить").click()
            page.get_by_text("Сохранено — версия 2").wait_for()

            # по образцу RWP: без докладов, даты сдвинуты
            page.goto(f"{base}/#/create/{ev_id}")
            page.get_by_label("Название").fill("RWP-2027")
            page.get_by_label("Начало").fill("2027-10-06")
            page.get_by_role("button", name="Создать и открыть конструктор").click()
            page.wait_for_url(re.compile(r"#/edit/\w+$"))
            new_id = page.url.rsplit("/", 1)[1]
            st, tpl = call(base, "GET", f"/api/v1/events/{new_id}/program", headers=auth)
            days = tpl["program"]["days"]
            assert days[0]["date"] == "2027-10-06", days[0]["date"]
            assert not any(it["type"] == "talk" for d in days for s in d["sessions"] for it in s["items"])

            assert not errors, errors
            browser.close()
        print("e2e editor: OK")


if __name__ == "__main__":
    main()
