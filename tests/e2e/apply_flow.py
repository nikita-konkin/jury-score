"""Сквозной тест заявок: владелец открывает приём в конструкторе, участник подаёт заявку с телефона
(согласие, черновик формы после перезагрузки, ссылка на заявку), владелец принимает её в программу и отклоняет другую,
участник видит решение и отзывает заявку.

    python tests/e2e/apply_flow.py [--shots каталог]
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from playwright.sync_api import expect, sync_playwright  # noqa: E402

from common import PHONE, call, check_layout, fixture, server, shot  # noqa: E402

OPERATOR = "ООО «Пример», г. Йошкар-Ола"


def main():
    with server() as (base, key):
        status, created = call(base, "POST", "/api/v1/events", {"program": fixture("rwp-2026.program.json")}, {"X-API-Key": key})
        assert status == 201, created
        ev_id, slug = created["event"]["id"], created["event"]["slug"]
        token = created["invite_url"].rsplit("/", 1)[1]
        status, claimed = call(base, "POST", f"/api/v1/claim/{token}", {"email": "org@example.com", "password": "org-pass-1234"})
        owner = {"Authorization": claimed["token"]}
        assert call(base, "POST", f"/api/v1/events/{ev_id}/publish", headers=owner)[0] == 200

        with sync_playwright() as p:
            browser = p.chromium.launch()
            errors = []

            def context(auth=False):
                ctx = browser.new_context(**PHONE, accept_downloads=True)
                if auth:
                    ctx.add_init_script("localStorage.setItem('conf_auth', JSON.stringify(%s))" % json.dumps({"token": claimed["token"], "record": claimed["record"]}))
                page = ctx.new_page()
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.on("dialog", lambda d: d.accept())
                return ctx, page

            # владелец открывает приём заявок в конструкторе
            octx, own = context(auth=True)
            own.goto(f"{base}/#/edit/{ev_id}")
            own.get_by_role("button", name="Название, даты, регламент").click()
            sheet = own.locator(".sheet")
            sheet.get_by_label("Принимать заявки через сайт").check()
            sheet.get_by_label("Оператор персональных данных").fill(OPERATOR)
            sheet.get_by_label("Контакт для отзыва согласия").fill("conf@example.com")
            sheet.get_by_label("Текст над формой").fill("Тезисы — до одной страницы.")
            check_layout(own, "лист мероприятия 320")
            sheet.get_by_role("button", name="Готово").click()
            own.get_by_role("button", name="Сохранить").click()
            own.get_by_text("Сохранено — версия 2").wait_for()

            # участник: из программы — в форму
            pctx, user = context()
            user.goto(f"{base}/#/e/{slug}")
            user.get_by_role("link", name="Подать заявку на доклад").click()
            form = user.locator(".apply-form")
            expect(form).to_contain_text("Тезисы — до одной страницы.")
            expect(user.locator(".consent")).to_contain_text(OPERATOR)
            # автозаполнение браузера: input в несколько полей до перерисовки — значения не затирают друг друга
            user.evaluate("""() => { for (const [id, v] of [["ap-speaker", "Иванова А. Б."], ["ap-email", "ivanova@example.com"]]) {
              const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); } }""")
            expect(user.get_by_label("Докладчик — фамилия и инициалы *")).to_have_value("Иванова А. Б.")
            expect(user.get_by_label("E-mail для связи *")).to_have_value("ivanova@example.com")
            user.get_by_label("Авторы").fill("Иванова А. Б.\nПетров В. Г.")
            user.get_by_label("Название доклада *").fill("Распространение радиоволн в тропосфере")
            user.get_by_label("Секция *").select_option("2")
            user.get_by_label("Форма участия").select_option("online")
            user.get_by_label("Организация").fill("Университет")
            user.get_by_label("E-mail для связи *").fill("ivanova@example.com")
            user.get_by_label("Телефон").fill("+7 900 000-00-00")
            check_layout(user, "форма заявки 320")
            shot(user, "50-apply-form-320")
            # без согласия — ошибка у флажка; заполненное переживает перезагрузку
            user.wait_for_timeout(3100)
            user.get_by_role("button", name="Отправить заявку").click()
            expect(user.locator(".check.bad")).to_be_visible()
            expect(user.locator(".apply-form .err")).to_contain_text("Без согласия")
            user.reload()
            expect(user.get_by_label("Название доклада *")).to_have_value("Распространение радиоволн в тропосфере")
            user.get_by_label("Согласен(на) на обработку персональных данных на этих условиях").check()
            user.wait_for_timeout(3100)
            user.get_by_role("button", name="Отправить заявку").click()
            expect(user.locator(".apply-done")).to_contain_text("Заявка №1 отправлена")
            link = user.locator(".apply-link").text_content()
            assert re.search(rf"#/apply/{slug}/ap_[A-Za-z0-9]{{24}}$", link), link
            shot(user, "51-apply-done-320")
            user.get_by_role("link", name="Открыть заявку").click()
            expect(user.locator(".apply-mine")).to_contain_text("на рассмотрении")
            check_layout(user, "своя заявка 320")

            # вторая заявка — через API
            status, second = call(base, "POST", f"/api/apply/{slug}", {
                "speaker": "Сидоров С. С.", "title": "Ионосфера", "section": 1, "email": "s@example.com", "consent": True, "elapsed": 60000})
            assert status == 201, second

            # владелец: заявки из «Моего мероприятия», принять первую, отклонить вторую
            own.goto(f"{base}/#/my/{ev_id}")
            own.get_by_role("link", name=re.compile(r"Заявки на доклады: 2, новых 2")).click()
            cards = own.locator(".app-card")
            expect(cards).to_have_count(2)
            first = cards.filter(has_text="Иванова А. Б.")
            expect(first).to_contain_text("ivanova@example.com")
            expect(first).to_contain_text("+7 900 000-00-00")
            check_layout(own, "заявки 320")
            shot(own, "52-applications-320")
            first.get_by_role("button", name="Принять…").click()
            expect(first.locator("select")).to_have_value(re.compile(r"\d+"))
            first.get_by_role("button", name="Добавить в программу").click()
            expect(own.locator(".toast")).to_contain_text("Доклад добавлен в программу: s2-")
            other = own.locator(".app-card").filter(has_text="Сидоров С. С.")
            other.get_by_role("button", name="Отклонить…").click()
            other.get_by_label("Причина — увидит участник").fill("Тема не соответствует секции")
            other.get_by_role("button", name="Отклонить заявку").click()
            expect(own.locator(".toast")).to_have_text("Заявка отклонена")
            own.get_by_role("tab", name=re.compile("^Принятые")).click()
            expect(own.locator(".app-card")).to_contain_text("В программе: s2-")
            with own.expect_download() as dl:
                own.get_by_role("button", name="⬇ CSV").click()
            csv = Path(dl.value.path()).read_text(encoding="utf-8-sig")
            assert "ivanova@example.com" in csv and "отклонена" in csv, csv

            # доклад в программе, контактов в ней нет
            program = call(base, "GET", f"/api/v1/events/{ev_id}/program")[1]["program"]
            talks = [it for d in program["days"] for s in d["sessions"] for it in s["items"] if it.get("title") == "Распространение радиоволн в тропосфере"]
            assert len(talks) == 1 and talks[0]["section"] == 2 and talks[0]["format"] == "online", talks
            assert "ivanova@" not in json.dumps(program, ensure_ascii=False)

            # участник видит решение; отклонённую заявку отзывает
            user.reload()
            expect(user.locator(".apply-mine")).to_contain_text("принята")
            user.goto(f"{base}/#/apply/{slug}/{second['token']}")
            expect(user.locator(".apply-mine")).to_contain_text("Тема не соответствует секции")
            user.get_by_role("button", name="Отозвать заявку").click()
            expect(user.locator(".apply-mine")).to_contain_text("отозвана")
            expect(user.locator(".apply-mine")).not_to_contain_text("s@example.com")

            assert not errors, errors
            browser.close()
    print("apply_flow: OK")


if __name__ == "__main__":
    main()
