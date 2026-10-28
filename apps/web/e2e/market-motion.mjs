import process from "node:process";

import { chromium } from "playwright-core";

import { apiResponse } from "./fixtures/api.mjs";
import { fixtureStates } from "./fixtures/control.ts";

const baseUrl = process.env.MAKER_SHOTS_URL ?? "http://127.0.0.1:8899";
const executablePath =
  process.env.CHROMIUM_PATH ??
  `${process.env.HOME ?? "/home/ubuntu"}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox"],
});

try {
  for (const [stateName, fixture] of [
    ["paper-running", fixtureStates["paper-running"]],
    ["paper-running-no-book", fixtureStates["paper-running-no-book"]],
  ]) {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      try {
        window.localStorage.setItem("maker:explain-seen", "1");
      } catch {
        // Storage is optional in the product.
      }
    });
    const page = await context.newPage();
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const response = apiResponse(fixture, url);
      await route.fulfill({
        status: response.status,
        contentType: "application/json",
        body: JSON.stringify(response.body),
      });
    });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
        await route.fallback();
      } else {
        await route.abort("blockedbyclient");
      }
    });
    await page.goto(`${baseUrl}#desk`, { waitUntil: "networkidle" });
    await page.locator('[data-view="desk"]:not([hidden])').waitFor();

    const expected =
      fixture.status.snapshot.market.book?.asks.length +
        fixture.status.snapshot.market.book?.bids.length || 2;
    const actual = await page.locator(".market-motion-book").count();
    if (actual !== expected) {
      throw new Error(
        `${stateName}: expected ${expected} real book bars, received ${actual}`,
      );
    }
    console.log(`ok   ${stateName}: ${actual} real book bars`);
    await context.close();
  }
} finally {
  await browser.close();
}
