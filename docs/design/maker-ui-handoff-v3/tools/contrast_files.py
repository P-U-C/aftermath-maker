import sys, json, os
from playwright.sync_api import sync_playwright
fn = open(os.path.join(os.path.dirname(__file__), "contrast_fn.js")).read()
base = sys.argv[1]; pages = sys.argv[2:]
with sync_playwright() as p:
    b = p.chromium.launch()
    for page in pages:
        for theme in ["light", "dark"]:
            pg = b.new_page(viewport={"width": 1440, "height": 900})
            pg.goto(f"file://{base}/{page}{'&' if '?' in page else '?'}theme={theme}")
            pg.wait_for_timeout(900)
            r = pg.evaluate(fn)
            worst = sorted(r["fails"], key=lambda x: x["ratio"])[:4]
            print(f"{page:28s} {theme:5s} texts {r['total']:4d} fails {len(r['fails']):3d} under12 {r['small']:3d}", [(w['text'][:24], w['ratio'], w['size']) for w in worst])
            pg.close()
    b.close()
