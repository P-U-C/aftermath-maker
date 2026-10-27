# Renders the mockups to renders/*.png. Needs: pip install playwright && playwright install chromium
# Usage: python3 render2.py [job ...]   (no args renders all jobs)
import os
import sys
from playwright.sync_api import sync_playwright

base = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(base, "renders")
os.makedirs(out, exist_ok=True)

jobs = [
    ("desk-light", "desk.html", "", 1440, 900, 1, True),
    ("desk-dark", "desk.html", "?theme=dark", 1440, 900, 1, True),
    ("golive-sheet", "desk.html", "?sheet=1", 1440, 900, 1, False),
    ("signin", "signin.html", "", 1440, 900, 1, False),
    ("venues", "venues.html", "", 1440, 900, 1, True),
    ("brand", "brand.html", "", 1440, 900, 1, True),
    ("phone-light", "phone.html", "", 390, 844, 2, False),
    ("phone-dark", "phone.html", "?theme=dark", 390, 844, 2, False),
]
only = set(sys.argv[1:])

with sync_playwright() as p:
    browser = p.chromium.launch()
    for name, file, query, w, h, scale, full in jobs:
        if only and name not in only:
            continue
        path = os.path.join(base, file)
        if not os.path.exists(path):
            continue
        page = browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=scale)
        page.goto("file://" + path + query)
        page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(out, name + ".png"), full_page=full)
        page.close()
        print("rendered", name)
    browser.close()
