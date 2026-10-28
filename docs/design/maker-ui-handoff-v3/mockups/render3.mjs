// Renders the v3.1 mockups to renders/*.png with the repo's playwright-core.
// Run from anywhere inside the checkout: node docs/design/maker-ui-handoff-v3/mockups/render3.mjs [job ...]
// Chromium comes from CHROMIUM_PATH, or the same default path as apps/web/e2e/shots.mjs.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";

const base = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(base, "renders");
fs.mkdirSync(out, { recursive: true });
const executablePath =
  process.env.CHROMIUM_PATH ??
  path.join(process.env.HOME ?? "/home/ubuntu", ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome");

if (!fs.existsSync(path.join(base, "mona.woff2"))) {
  console.warn("mona.woff2 is missing: cp docs/design/maker-ui-handoff/mockups/mona.woff2 into this folder first.");
}

// name, page, query, width, height, scale, full page, wait ms
const jobs = [
  ["landing", "landing.html", "", 1440, 900, 1, true, 6400],
  ["landing-dark", "landing.html", "?theme=dark", 1440, 900, 1, false, 6400],
  ["landing-phone", "landing.html", "", 390, 844, 2, false, 6500],
  ["learn", "learn.html", "", 1440, 900, 1, true, 7600],
  ["learn-dark", "learn.html", "?theme=dark", 1440, 900, 1, false, 7600],
  ["desk", "desk3.html", "?still=1", 1440, 900, 1, true, 4200],
  ["desk-dark", "desk3.html", "?theme=dark&still=1", 1440, 900, 1, true, 4200],
  ["desk-explain", "desk3.html", "?explain=1&still=1", 1440, 900, 1, false, 4200],
  ["bundles", "bundles.html", "", 1440, 900, 1, true, 600],
  ["strategy-markets", "strategy3.html", "", 1440, 900, 1, true, 600],
  ["strategy-limits", "strategy3.html", "?step=3", 1440, 900, 1, true, 600],
  ["strategy-dark", "strategy3.html", "?theme=dark", 1440, 900, 1, true, 600],
  ["performance", "performance3.html", "", 1440, 900, 1, true, 600],
  ["performance-dark", "performance3.html", "?theme=dark", 1440, 900, 1, true, 600],
  ["phone", "phone3.html", "?still=1", 390, 844, 2, false, 4200],
  ["phone-dark", "phone3.html", "?theme=dark&still=1", 390, 844, 2, false, 4200],
];
const only = new Set(process.argv.slice(2));

const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
try {
  for (const [name, file, query, width, height, scale, fullPage, wait] of jobs) {
    if (only.size && !only.has(name)) continue;
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto("file://" + path.join(base, file) + query);
    await page.waitForTimeout(wait);
    await page.screenshot({ path: path.join(out, name + ".png"), fullPage });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    console.log("rendered", name, errors.length ? errors : "", overflow ? "OVERFLOW" : "");
    await page.close();
  }
} finally {
  await browser.close();
}
