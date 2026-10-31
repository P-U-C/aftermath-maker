/**
 * Screenshot-only evidence capture for the pre-Kit worktree on a local server.
 * No assertions are disabled in shots.mjs; this does not run against production.
 *
 * node docs/design/round8/capture-baseline.mjs http://127.0.0.1:8897
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";
import { apiResponse } from "../../../apps/web/e2e/fixtures/api.mjs";
import { fixedNow, fixtureStates } from "../../../apps/web/e2e/fixtures/control.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const baseUrl = process.argv[2] ?? "http://127.0.0.1:8897";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) {
  throw new Error("Baseline capture accepts only a local 127.0.0.1 server.");
}
const out = path.join(root, "docs/design/round8/evidence/before");
const views = ["desk", "strategy", "markets", "bundles", "performance", "venues"];
const sizes = [
  ["desktop", 1440, 900],
  ["medium-1024", 1024, 900],
  ["phone", 390, 844],
];
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ??
    path.join(process.env.HOME ?? "/home/ubuntu",
      ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome"),
  headless: true,
  args: ["--no-sandbox"],
});
try {
  for (const [size, width, height] of sizes) {
    for (const scheme of ["light", "dark"]) {
      for (const view of views) {
        const context = await browser.newContext({
          viewport: { width, height },
          deviceScaleFactor: 2,
          colorScheme: scheme,
          locale: "en-US",
          timezoneId: "UTC",
        });
        try {
          const page = await context.newPage();
          page.on("pageerror", (error) => process.stderr.write("Browser: " + error.message + "\n"));
          await page.addInitScript((timestamp) => {
            Date.now = () => Date.parse(timestamp);
          }, fixedNow);
          const fixture = structuredClone(fixtureStates["paper-running"]);
          await page.route("**/api/control/**", (route) => {
            const answer = apiResponse(fixture, new URL(route.request().url()), route.request().method());
            return route.fulfill({
              status: answer.status,
              contentType: "application/json",
              body: JSON.stringify(answer.body),
            });
          });
          await page.route("**/*", (route) => {
            const url = new URL(route.request().url());
            if (url.hostname === "127.0.0.1") return route.fallback();
            if (url.href === "https://api.slush.app/api/wallet/metadata")
              return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
            return route.abort("blockedbyclient");
          });
          await page.goto(baseUrl + "#" + view, { waitUntil: "domcontentloaded" });
          await page.locator('nav[aria-label="Maker views"]').waitFor({ state: "attached", timeout: 10_000 }).catch(async (error) => {
            await page.screenshot({ path: "/tmp/maker-baseline-debug.png" });
            throw error;
          });
          await page.waitForTimeout(320);
          const name = `paper-running-${view}-${size}-${scheme}.png`;
          await page.screenshot({ path: path.join(out, name), fullPage: false });
          process.stdout.write(name + "\n");
        } finally {
          await context.close();
        }
      }
    }
  }
} finally {
  await browser.close();
}
