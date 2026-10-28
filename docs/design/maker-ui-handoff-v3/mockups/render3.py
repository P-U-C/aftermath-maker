# Renders the v3.1 mockups to renders/*.png. Needs: pip install playwright && playwright install chromium
# Usage: python3 render3.py [job ...]
import os, sys
from playwright.sync_api import sync_playwright
base = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(base, "renders"); os.makedirs(out, exist_ok=True)
jobs = [
    ("landing", "landing.html", "", 1440, 900, 1, True, 6400),
    ("landing-dark", "landing.html", "?theme=dark", 1440, 900, 1, False, 6400),
    ("landing-phone", "landing.html", "", 390, 844, 2, False, 6500),
    ("learn", "learn.html", "", 1440, 900, 1, True, 7600),
    ("learn-dark", "learn.html", "?theme=dark", 1440, 900, 1, False, 7600),
    ("desk", "desk3.html", "?still=1", 1440, 900, 1, True, 4200),
    ("desk-dark", "desk3.html", "?theme=dark&still=1", 1440, 900, 1, True, 4200),
    ("desk-explain", "desk3.html", "?explain=1&still=1", 1440, 900, 1, False, 4200),
    ("bundles", "bundles.html", "", 1440, 900, 1, True, 600),
    ("strategy-markets", "strategy3.html", "", 1440, 900, 1, True, 600),
    ("strategy-limits", "strategy3.html", "?step=3", 1440, 900, 1, True, 600),
    ("strategy-dark", "strategy3.html", "?theme=dark", 1440, 900, 1, True, 600),
    ("performance", "performance3.html", "", 1440, 900, 1, True, 600),
    ("performance-dark", "performance3.html", "?theme=dark", 1440, 900, 1, True, 600),
    ("phone", "phone3.html", "?still=1", 390, 844, 2, False, 4200),
    ("phone-dark", "phone3.html", "?theme=dark&still=1", 390, 844, 2, False, 4200),
]
only = set(sys.argv[1:])
with sync_playwright() as p:
    b = p.chromium.launch()
    for name, f, q, w, h, sc, full, wait in jobs:
        if only and name not in only: continue
        path = os.path.join(base, f)
        if not os.path.exists(path): continue
        pg = b.new_page(viewport={"width": w, "height": h}, device_scale_factor=sc)
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto("file://" + path + q); pg.wait_for_timeout(wait)
        pg.screenshot(path=os.path.join(out, name + ".png"), full_page=full)
        over = pg.evaluate("document.documentElement.scrollWidth > innerWidth")
        print("rendered", name, "errors" if errs else "", errs, "OVERFLOW" if over else "")
        pg.close()
    b.close()
