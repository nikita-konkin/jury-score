import json, re, sys, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

# Тест идёт в демо-режиме: берём копию index.html с пустым SCRIPT_URL,
# чтобы не писать в боевую таблицу, даже если URL уже вставлен.
SRC = Path(__file__).resolve().parent.parent / "index.html"
TMP = Path(tempfile.mkdtemp(prefix="jury_page_"))
html = re.sub(r'SCRIPT_URL:\s*"[^"]*"', 'SCRIPT_URL: ""', SRC.read_text(encoding="utf-8"), count=1)
(TMP / "index.html").write_text(html, encoding="utf-8")
PAGE = (TMP / "index.html").as_uri()
OUT = tempfile.mkdtemp(prefix="jury_shots_") + "/"
errors = []

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(PAGE)
    pg.screenshot(path=OUT + "1_login.png")
    pg.fill("#inName", "Петров П. П.")
    pg.click("#btnLogin")
    pg.wait_for_selector("#appView:not([hidden])")
    pg.screenshot(path=OUT + "2_list.png")
    # open first talk, rate all criteria
    pg.click('.card[data-id="s1-1"] .sum')
    for c, v in enumerate([5, 4, 4, 5, 3]):
        pg.click(f'.card[data-id="s1-1"] .pt[data-c="{c}"][data-v="{v}"]')
    pg.fill('.card[data-id="s1-1"] textarea', "Хороший доклад")
    pg.wait_for_timeout(700)
    pg.screenshot(path=OUT + "3_rated.png")
    # partial rating of another, absent on a third
    pg.click('.card[data-id="s1-2"] .sum')
    pg.click('.card[data-id="s1-2"] .pt[data-c="0"][data-v="3"]')
    pg.click('.card[data-id="s1-3"] .sum')
    pg.click('.card[data-id="s1-3"] .flag[data-flag="absent"]')
    pg.wait_for_timeout(700)
    # reload -> persisted?
    pg.reload()
    pg.wait_for_selector("#appView:not([hidden])")
    s11 = pg.inner_text('.card[data-id="s1-1"] .score')
    s12 = pg.inner_text('.card[data-id="s1-2"] .score')
    s13 = pg.inner_text('.card[data-id="s1-3"] .score')
    comment = pg.input_value('.card[data-id="s1-1"] textarea')
    prog = pg.inner_text("#progTxt")
    # second juror
    pg.once("dialog", lambda d: d.accept())
    pg.click("#btnWho")
    pg.fill("#inName", "Сидоров С. С.")
    pg.click("#btnLogin")
    pg.wait_for_selector("#appView:not([hidden])")
    pg.click('.card[data-id="s1-1"] .sum')
    for c in range(5):
        pg.click(f'.card[data-id="s1-1"] .pt[data-c="{c}"][data-v="4"]')
    pg.click('.card[data-id="s4-6"] .sum')
    for c in range(5):
        pg.click(f'.card[data-id="s4-6"] .pt[data-c="{c}"][data-v="5"]')
    pg.wait_for_timeout(700)
    pg.click('.tab[data-tab="res"]')
    pg.wait_for_timeout(300)
    pg.screenshot(path=OUT + "4_results.png", full_page=False)
    first = pg.inner_text(".rrow >> nth=0")
    second = pg.inner_text(".rrow >> nth=1")
    sw = pg.evaluate("document.documentElement.scrollWidth")
    # sections and statistics views
    pg.click('#resMode [data-mode="sec"]')
    sec_rows = pg.locator(".rrow").count()
    pg.click('#resMode [data-mode="stats"]')
    pg.wait_for_timeout(200)
    stats = pg.inner_text("#resList")
    sw_stats = pg.evaluate("document.documentElement.scrollWidth")
    pg.screenshot(path=OUT + "5_stats.png", full_page=True)
    pg.emulate_media(color_scheme="dark")
    pg.click('#resMode [data-mode="all"]')
    pg.screenshot(path=OUT + "6_results_dark.png")
    pg.click('.tab[data-tab="rate"]')
    pg.click('.card[data-id="s2-1"] .sum')
    pg.wait_for_timeout(400)
    pg.screenshot(path=OUT + "7_dark.png")
    b.close()

print(json.dumps({"errors": errors, "s11": s11, "s12": s12, "s13": s13, "comment": comment, "prog": prog,
                  "first": first, "second": second, "secRows": sec_rows, "scrollWidth": [sw, sw_stats],
                  "stats": stats[:400]}, ensure_ascii=False, indent=1))

assert not errors, errors
assert "21" in s11 and "не было" in s13 and comment == "Хороший доклад", (s11, s13, comment)
assert "Короткова" in first and "25" in first, first
assert "Беленя" in second and "20,5" in second, second
assert sec_rows == 2, sec_rows
assert "Распределение баллов" in stats and "Наибольшие расхождения" in stats, stats
assert sw <= 390 and sw_stats <= 390, (sw, sw_stats)
print("OK, скриншоты:", OUT)
