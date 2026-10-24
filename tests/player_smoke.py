from pathlib import Path
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]


def canvas_point(canvas, col, row):
    box = canvas.bounding_box()
    return box["x"] + col / 40 * box["width"], box["y"] + row / 25 * box["height"]


def drag(page, canvas, source, target):
    sx, sy = canvas_point(canvas, *source)
    tx, ty = canvas_point(canvas, *target)
    page.mouse.move(sx, sy)
    page.mouse.down()
    page.mouse.move(tx, ty, steps=8)
    page.mouse.up()
    page.wait_for_timeout(80)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1100, "height": 760}, device_scale_factor=1)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.goto("http://127.0.0.1:8064/player/?game=demo")
    page.wait_for_load_state("networkidle")
    page.wait_for_function("document.querySelector('#status').textContent === 'GAME READY'")

    canvas = page.locator("#screen")
    assert canvas.get_attribute("width") == "320"
    assert page.locator("#gameTitle").inner_text() == "THE CELLAR"
    assert page.locator("#status").inner_text() == "GAME READY"

    before = canvas.screenshot()
    drag(page, canvas, (4.5, 9.5), (30, 4.5))    # stick -> inventory
    drag(page, canvas, (13.5, 11.5), (30, 5.5))  # cloth -> inventory
    drag(page, canvas, (30, 4.5), (30, 5.5))     # stick + cloth
    drag(page, canvas, (22.5, 6.5), (30, 4.5))   # oil -> free slot
    drag(page, canvas, (30, 5.5), (30, 4.5))     # rag stick + oil -> torch
    after = canvas.screenshot()
    assert before != after, "crafting a torch did not redraw the room"

    # SEARCH is enabled after the torch lights the room.
    x, y = canvas_point(canvas, 36, 19.5)
    page.mouse.click(x, y)
    page.wait_for_timeout(100)
    assert not errors, "browser errors: " + " | ".join(errors)
    page.screenshot(path=str(ROOT / "build" / "html5-player.png"), full_page=True)

    # The editor exposes the saved game directly to the HTML5 player.
    page.goto("http://127.0.0.1:8064/")
    page.wait_for_load_state("networkidle")
    page.wait_for_selector("#btnPlay")
    assert page.locator("#btnPlay").inner_text() == "Play HTML5"
    browser.close()
