import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";
import { apiResponse, controlRequestHangs } from "./fixtures/api.mjs";
import { fixedNow, fixtureStates } from "./fixtures/control.ts";

const projectRoot = path.resolve(import.meta.dirname, "../../..");
const defaultOutput = path.join(projectRoot, "apps/web/e2e/shots/current");
const executablePath =
  process.env.CHROMIUM_PATH ??
  path.join(
    process.env.HOME ?? "/home/ubuntu",
    ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  );

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function selectedStates() {
  const requested = option("--state", null);
  if (!requested) return Object.keys(fixtureStates);
  if (!(requested in fixtureStates)) {
    throw new Error(
      `Unknown fixture "${requested}". Choose: ${Object.keys(fixtureStates).join(", ")}`,
    );
  }
  return [requested];
}

const baseUrl = option(
  "--base-url",
  process.env.MAKER_SHOTS_URL ?? "http://127.0.0.1:8788",
);
const showFlattenSheet = process.argv.includes("--flatten-sheet");
const showLiveSheet = process.argv.includes("--live-sheet");
const showAccountEditor = process.argv.includes("--account-editor");
const verifyConfigSave = process.argv.includes("--verify-config-save");
const verifyStrategyBuilder = process.argv.includes(
  "--verify-strategy-builder",
);
const verifyPerformance = process.argv.includes("--verify-performance");
const verifyPadding = process.argv.includes("--verify-padding");
const verifyFavicon = process.argv.includes("--verify-favicon");
const verifyMarketTable = process.argv.includes("--verify-market-table");
const verifyExplain = process.argv.includes("--verify-explain");
const verifyLearn = process.argv.includes("--verify-learn");
const verifyMotion = process.argv.includes("--verify-motion");
const showRunStatus = process.argv.includes("--run-status");
const showWalletMenu = process.argv.includes("--wallet-menu");
const verifyPaperBlocked = process.argv.includes("--verify-paper-blocked");
const verifyLaneHeight = process.argv.includes("--verify-lane-height");
const beginStop = process.argv.includes("--begin-stop");
const waitForStopTimeout = process.argv.includes("--wait-stop-timeout");
const exerciseAccessRequest = process.argv.includes("--access-request");
const outputDirectory = path.resolve(
  projectRoot,
  option("--output", defaultOutput),
);
const deviceScaleFactor = Number(option("--scale", "2"));
const learnChapter = option("--learn-chapter", null);

const makerViews = [
  "desk",
  "strategy",
  "markets",
  "bundles",
  "performance",
  "accounts",
  "venues",
  "learn",
];

const navigationViews = makerViews.filter(
  (view) => view !== "accounts" && view !== "learn",
);

function selectedViews(stateName) {
  const requested = option("--view", null);
  if (!requested) return [null];
  if (requested === "all") {
    const fixture = fixtureStates[stateName];
    return fixture.auth.status === 200 && fixture.setup.setup
      ? makerViews
      : [null];
  }
  if (!makerViews.includes(requested)) {
    throw new Error(
      `Unknown view "${requested}". Choose: ${makerViews.join(", ")}, all`,
    );
  }
  return [requested];
}

const captures = [
  {
    name: "desktop-light",
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    reducedMotion: "no-preference",
  },
  {
    name: "desktop-dark",
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    reducedMotion: "no-preference",
  },
  {
    name: "medium-1180",
    viewport: { width: 1180, height: 900 },
    colorScheme: "light",
    reducedMotion: "no-preference",
  },
  {
    name: "medium-1024",
    viewport: { width: 1024, height: 900 },
    colorScheme: "light",
    reducedMotion: "no-preference",
  },
  {
    name: "medium-1024-dark",
    viewport: { width: 1024, height: 900 },
    colorScheme: "dark",
    reducedMotion: "no-preference",
  },
  {
    name: "phone-light",
    viewport: { width: 390, height: 844 },
    colorScheme: "light",
    reducedMotion: "no-preference",
  },
  {
    name: "phone-dark",
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
    reducedMotion: "no-preference",
  },
  {
    name: "desktop-reduced",
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    reducedMotion: "reduce",
  },
];

function selectedCaptures() {
  const requested = option("--capture", null);
  if (!requested) return captures;
  const capture = captures.find((candidate) => candidate.name === requested);
  if (!capture) {
    throw new Error(
      `Unknown capture "${requested}". Choose: ${captures.map((candidate) => candidate.name).join(", ")}`,
    );
  }
  return [capture];
}

async function waitForFixture(page, stateName) {
  if (stateName === "signed-out") {
    await page
      .getByRole("heading", {
        name: "Your own market-making desk. Working for you.",
      })
      .waitFor();
    return;
  }
  if (stateName === "not-on-list") {
    await page
      .getByRole("heading", {
        name: "This wallet is not on the list yet.",
      })
      .waitFor();
    return;
  }

  await page
    .locator('nav[aria-label="Maker views"]')
    .waitFor({ state: "attached" });
  if (stateName === "onboarding") {
    await page
      .getByRole("heading", { name: "Authorize once. Run unattended." })
      .waitFor();
  }
}

async function capture(browser, stateName, captureConfig, view) {
  const fixture = structuredClone(fixtureStates[stateName]);
  // Bundles deliberately replace the legacy market card. Retain one isolated
  // legacy state only to exercise the card's manual refresh and motion path.
  if (
    verifyMotion &&
    stateName === "paper-running" &&
    captureConfig.name === "desktop-light" &&
    view === "desk"
  ) {
    fixture.bundles.bundles = [];
    fixture.status.bundles = [];
  }
  const context = await browser.newContext({
    viewport: captureConfig.viewport,
    deviceScaleFactor,
    colorScheme: captureConfig.colorScheme,
    reducedMotion: captureConfig.reducedMotion,
    locale: "en-US",
    timezoneId: "UTC",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  const browserErrors = [];
  const remoteRequests = [];
  let capturedConfigBody = null;
  let motionChangeArmed = false;
  const exerciseStop =
    stateName === "live-running" &&
    captureConfig.name === "desktop-light" &&
    (view === null || view === "desk") &&
    !showFlattenSheet;

  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    const expectedAuthFailure =
      fixture.auth.status !== 200 &&
      text.startsWith("Failed to load resource:") &&
      text.includes(String(fixture.auth.status));
    const expectedDevDiagnostic =
      text.startsWith("eval() is not supported in this environment") ||
      text.startsWith("Error fetching metadata");
    if (!expectedAuthFailure && !expectedDevDiagnostic)
      browserErrors.push(text);
  });

  await page.addInitScript((timestamp) => {
    const fixed = Date.parse(timestamp);
    Date.now = () => fixed;
  }, fixedNow);

  if (fixture.scenario === "config-dirty") {
    const maker = fixture.config.config;
    const {
      markets,
      mode: _mode,
      makerAccountId: _makerAccountId,
      hedge,
      ...settings
    } = maker;
    const { accountId: _hedgeAccountId, ...sharedHedge } = hedge;
    await page.addInitScript(
      ({ ownerAddress, draft }) => {
        localStorage.setItem(
          `maker:strategy-draft:v1:${ownerAddress.toLowerCase()}:core-strategy`,
          JSON.stringify(draft),
        );
      },
      {
        ownerAddress: fixture.auth.body.ownerAddress,
        draft: {
          baseVersion: 1,
          name: "Core strategy",
          settings: {
            ...settings,
            spreadBps: settings.spreadBps + 1,
            hedge: sharedHedge,
          },
          marketRule: {
            kind: "preferred-list",
            marketIds: markets.map((market) => market.marketId),
          },
          markets,
          savedAt: fixedNow,
        },
      },
    );
  }

  await page.route("**/api/control/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() === "PUT" &&
      /\/api\/accounts\/\d+\/metadata$/.test(url.pathname)
    ) {
      const accountId = url.pathname.split("/").at(-2);
      const body = JSON.parse(request.postData() ?? "{}");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          metadata: {
            accountId,
            label: body.label ?? null,
            tags: body.tags ?? [],
            updatedAt: fixedNow,
          },
        }),
      });
      return;
    }
    if (
      verifyConfigSave &&
      request.method() === "POST" &&
      url.pathname.endsWith("/api/config")
    ) {
      capturedConfigBody = request.postData();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          config: JSON.parse(capturedConfigBody ?? "{}"),
        }),
      });
      return;
    }
    if (
      verifyConfigSave &&
      request.method() === "PATCH" &&
      /\/api\/strategies\/[^/]+$/.test(url.pathname)
    ) {
      capturedConfigBody = request.postData();
      const current = fixture.config.config;
      const { markets, mode, makerAccountId, hedge, ...settings } = current;
      const { accountId, ...sharedHedge } = hedge;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          strategy: {
            id: "core-strategy",
            name: "Core strategy",
            config: { ...settings, hedge: sharedHedge },
            marketRule: {
              kind: "preferred-list",
              marketIds: markets.map((market) => market.marketId),
            },
            version: 2,
            usedBy: [{ id: "core", name: "Core" }],
            archivedAt: null,
          },
          affectedBundles: [],
        }),
      });
      return;
    }
    if (
      verifyMotion &&
      request.method() === "POST" &&
      url.pathname.endsWith("/api/runtime/cycle")
    ) {
      motionChangeArmed = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
      return;
    }
    if (
      exerciseStop &&
      request.method() === "POST" &&
      url.pathname.endsWith("/api/runtime/cycle")
    ) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
      return;
    }
    if (
      exerciseStop &&
      request.method() === "POST" &&
      url.pathname.endsWith("/api/runtime/stop")
    ) {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Stop is already reconciling orders",
        }),
      });
      return;
    }

    if (controlRequestHangs(fixture, url)) {
      await new Promise(() => {});
      return;
    }
    const response = apiResponse(fixture, url, request.method());
    if (
      verifyMotion &&
      motionChangeArmed &&
      stateName === "paper-running" &&
      url.pathname.endsWith("/api/status") &&
      response.status === 200
    ) {
      const body = structuredClone(response.body);
      body.snapshot.balances.equityUsd =
        (body.snapshot.balances.equityUsd ?? 0) + 1;
      body.snapshot.portfolio.grossExposureUsd += 1;
      await route.fulfill({
        status: response.status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
      return;
    }
    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      body: JSON.stringify(response.body),
    });
  });

  await page.route(
    "https://api.slush.app/api/wallet/metadata",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    },
  );

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.href === "https://api.slush.app/api/wallet/metadata") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
      return;
    }
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      await route.fallback();
      return;
    }
    remoteRequests.push(url.href);
    await route.abort("blockedbyclient");
  });

  try {
    const hash =
      view === "learn" && learnChapter
        ? "#learn/" + encodeURIComponent(learnChapter)
        : view
          ? "#" + view
          : "";
    await page.goto(baseUrl + hash, {
      waitUntil: "domcontentloaded",
    });
    await waitForFixture(page, stateName);
    if (verifyFavicon) {
      const iconHrefs = await page
        .locator('link[rel~="icon"]')
        .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
      if (!iconHrefs.length) {
        throw new Error(
          `${stateName}/${view}/${captureConfig.name} has no favicon`,
        );
      }
      if (stateName === "signed-out") {
        if (iconHrefs.some((href) => href?.includes("icon-stopped"))) {
          throw new Error(
            "Landing retained the stopped favicon instead of the brand mark",
          );
        }
      } else {
        const expectedState =
          stateName === "live-running"
            ? "live"
            : stateName === "paper-running"
              ? "paper"
              : "stopped";
        if (
          !iconHrefs.every((href) =>
            href?.includes(`icon-${expectedState}.svg`),
          )
        ) {
          throw new Error(
            `${stateName}/${view}/${captureConfig.name} favicon did not follow ${expectedState}: ${JSON.stringify(iconHrefs)}`,
          );
        }
      }
      process.stdout.write(
        `${stateName}/${view}/${captureConfig.name}: favicon follows the landing or runtime state\n`,
      );
    }
    if (exerciseAccessRequest && stateName === "not-on-list") {
      await page
        .getByRole("textbox", { name: "Sui wallet address" })
        .fill(`0x${"9".repeat(64)}`);
      await page
        .getByRole("textbox", { name: "X / Twitter" })
        .fill("@maker_tester");
      await page.getByRole("button", { name: "Send request" }).click();
      await page.getByText("Request received", { exact: true }).waitFor();
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    if (
      fixture.auth.status === 200 &&
      !(captureConfig.viewport.width <= 700 && view === "strategy")
    ) {
      const tabStops = await page
        .getByRole("navigation", { name: "Maker views" })
        .getByRole("link")
        .evaluateAll((links) => links.map((link) => link.tabIndex));
      if (
        tabStops.length !== navigationViews.length ||
        tabStops.some((tab) => tab < 0)
      ) {
        throw new Error(
          `${stateName}/${captureConfig.name} has unreachable view tabs`,
        );
      }
      if (captureConfig.name === "desktop-light" && view === null) {
        const walletMenu = page.locator(".maker-wallet-menu");
        await walletMenu.locator("summary").click();
        await walletMenu
          .getByRole("button", { name: "Copy address" })
          .waitFor();
        await walletMenu.getByRole("button", { name: /authorized/ }).waitFor();
        await walletMenu.getByRole("button", { name: "Disconnect" }).waitFor();
        await walletMenu.locator("summary").click();

        if (stateName === "stopped") {
          await walletMenu.locator("summary").click();
          await walletMenu.getByRole("button", { name: /authorized/ }).click();
          const hedgeAccount = page.locator("article").filter({
            hasText: "Account 1746",
          });
          await hedgeAccount
            .getByRole("button", {
              name: "Edit name and tags for account 1746",
            })
            .click();
          await hedgeAccount
            .getByRole("textbox", { name: "Name for account 1746" })
            .fill("Canary hedge");
          await hedgeAccount
            .getByRole("textbox", {
              name: "Comma-separated tags for account 1746",
            })
            .fill("hedge, canary");
          await hedgeAccount
            .getByRole("button", { name: "Save details" })
            .click();
          await page
            .locator(".notice.notice-success")
            .getByText("Account name and tags saved.")
            .waitFor();
          await hedgeAccount
            .getByText("Canary hedge", { exact: true })
            .waitFor();
          await hedgeAccount.getByText("canary", { exact: true }).waitFor();
          await hedgeAccount.getByRole("button", { name: "Maker" }).click();
          await page.getByRole("button", { name: "Save assignments" }).click();
          await page
            .locator(".notice.notice-success")
            .getByText("Account assignments saved.")
            .waitFor();
        }

        for (const targetView of makerViews) {
          if (navigationViews.includes(targetView)) {
            await page
              .getByRole("link", { name: targetView, exact: false })
              .click();
          } else {
            await page.evaluate((nextView) => {
              window.location.hash = nextView;
            }, targetView);
          }
          await page
            .locator(`[data-view="${targetView}"]:not([hidden])`)
            .first()
            .waitFor();
        }
        if (stateName !== "onboarding") {
          await page.getByRole("link", { name: "Performance" }).click();
          await page
            .getByRole("button", { name: "Epoch", exact: true })
            .click();
          await page
            .getByText(/Epoch 128/)
            .first()
            .waitFor();
          await page
            .getByRole("button", { name: "All time", exact: true })
            .click();
          await page.getByText("All time").first().waitFor();
        }
        const resetView = stateName === "onboarding" ? "accounts" : "desk";
        if (navigationViews.includes(resetView)) {
          await page
            .getByRole("link", { name: resetView, exact: false })
            .click();
        } else {
          await page.evaluate((nextView) => {
            window.location.hash = nextView;
          }, resetView);
        }
        await page
          .locator(`[data-view="${resetView}"]:not([hidden])`)
          .first()
          .waitFor();
      }
    }
    if (view && stateName !== "onboarding") {
      await page
        .locator(`[data-view="${view}"]:not([hidden])`)
        .first()
        .waitFor();
    }
    if (beginStop) {
      const stop = page.getByRole("button", { name: "Stop all", exact: true });
      await stop.waitFor();
      await stop.click();
      await page.getByText("Stopping…", { exact: true }).waitFor();
      if (waitForStopTimeout) {
        await page.getByText("Stop not confirmed", { exact: true }).waitFor({
          timeout: 22_000,
        });
      }
    }
    if (showRunStatus) {
      const trigger = page.getByRole("button", { name: /Run status:/ });
      await trigger.waitFor();
      await trigger.click();
      const status = page.getByRole("region", { name: "Run status" });
      await status.waitFor();
      if (captureConfig.viewport.width > 700) {
        const heading = status.getByRole("heading").first();
        if (
          !(await heading.evaluate((node) => node === document.activeElement))
        ) {
          throw new Error("Run status did not move focus to its heading");
        }
        await page.keyboard.press("Escape");
        await status.waitFor({ state: "hidden" });
        if (
          !(await trigger.evaluate((node) => node === document.activeElement))
        ) {
          throw new Error("Run status did not restore focus to its trigger");
        }
        await trigger.click();
        await status.waitFor();
      }
      await page.waitForTimeout(250);
    }
    const hasRunningBundle =
      fixture.auth.status === 200 &&
      (fixture.status.bundles ?? []).some(
        (entry) => entry.bundle.status === "running",
      );
    if (
      captureConfig.viewport.width <= 700 &&
      view !== null &&
      view !== "desk" &&
      hasRunningBundle
    ) {
      const stopAll = page.getByRole("button", {
        name: "Stop all",
        exact: true,
      });
      await stopAll.waitFor();
      if (!(await stopAll.isEnabled())) {
        throw new Error(
          `${stateName}/${view}/${captureConfig.name} disabled Stop all while a bundle was running`,
        );
      }
    }
    if (
      showAccountEditor &&
      view === "accounts" &&
      fixture.auth.status === 200
    ) {
      await page
        .getByRole("button", { name: /Edit name and tags for account/ })
        .first()
        .click();
      await page.getByRole("button", { name: "Save details" }).waitFor();
    }
    if (
      showFlattenSheet &&
      stateName === "live-running" &&
      (view === null || view === "desk")
    ) {
      const flattenName =
        captureConfig.viewport.width <= 390 ? "Flatten…" : "Flatten positions…";
      await page.getByRole("button", { name: flattenName }).click();
      const dialog = page.getByRole("dialog", { name: "Flatten positions?" });
      await dialog.waitFor();
      if (captureConfig.name === "desktop-light") {
        await page.waitForTimeout(50);
        if (
          !(await dialog.evaluate((node) =>
            node.contains(document.activeElement),
          ))
        ) {
          throw new Error("Flatten sheet did not move focus inside the dialog");
        }
        await page.keyboard.press("Shift+Tab");
        if (
          !(await dialog.evaluate((node) =>
            node.contains(document.activeElement),
          ))
        ) {
          throw new Error("Flatten sheet allowed focus to escape");
        }
      }
    }
    if (
      verifyPerformance &&
      stateName === "paper-running" &&
      captureConfig.name === "desktop-light" &&
      view === "performance"
    ) {
      await page.getByRole("button", { name: "MON", exact: true }).click();
      const monFills = page.locator(".performance-market-fills");
      await monFills.waitFor();
      const monText = await monFills.textContent();
      if (monText?.includes("NEAR")) {
        throw new Error("MON volume row included a fill from NEAR");
      }
      await page.getByRole("button", { name: "NEAR", exact: true }).click();
      await page
        .locator(".performance-market-fills")
        .getByText(/Sold \$1\.04/)
        .waitFor();
      await page
        .locator(".fill-table")
        .getByText("−$0.0008", { exact: true })
        .waitFor();
    }
    if (
      verifyMarketTable &&
      stateName === "paper-running" &&
      captureConfig.name === "desktop-light" &&
      view === "markets"
    ) {
      const headers = page.locator(".market-table thead th button");
      const headerCount = await headers.count();
      if (headerCount !== 9) {
        throw new Error(
          `Market table exposed ${headerCount} sortable headers, expected 9`,
        );
      }
      for (let index = 0; index < headerCount; index += 1) {
        await headers.nth(index).click();
        const sort = await headers
          .nth(index)
          .locator("..")
          .getAttribute("aria-sort");
        if (sort === "none" || !sort) {
          throw new Error(`Market header ${index} did not sort when clicked`);
        }
      }
      const groups = await page
        .locator(".market-table .market-group-heading")
        .allTextContents();
      if (
        groups.map((group) => group.replace(/\s+/g, " ").trim()).join("|") !==
        "In use 4|Available 1"
      ) {
        throw new Error(
          `Market groups were not ordered In use then Available with correct counts: ${groups}`,
        );
      }
      process.stdout.write(
        `${stateName}/${view}/${captureConfig.name}: all market headers sort within In use and Available groups\n`,
      );
    }
    if (
      showLiveSheet &&
      stateName === "stopped" &&
      (view === null || view === "strategy")
    ) {
      if (view === null) {
        await page.getByRole("link", { name: "Strategy" }).click();
      }
      await page
        .locator(".strategy-builder")
        .getByRole("button", { name: /Review/ })
        .click();
      const reviewLive = page.getByRole("button", {
        name: "Review live setup",
      });
      if (await reviewLive.count()) {
        await reviewLive.click();
        await page.getByRole("dialog", { name: "Use Live mode?" }).waitFor();
        if (
          await page.getByRole("button", { name: "Use Live mode" }).isEnabled()
        ) {
          throw new Error(
            "Live mode was selectable while deployment gates were off",
          );
        }
      } else {
        const liveTrial = page.getByRole("button", {
          name: "Live",
          exact: true,
        });
        if ((await liveTrial.count()) && (await liveTrial.isEnabled())) {
          throw new Error(
            "Live mode was selectable while deployment gates were off",
          );
        }
      }
    }
    if (
      verifyConfigSave &&
      stateName === "stopped" &&
      captureConfig.name === "desktop-light" &&
      view === "strategy"
    ) {
      if (verifyStrategyBuilder) {
        for (const step of [
          "Goal",
          "Markets",
          "Size and limits",
          "Hedging",
          "Review",
        ]) {
          await page
            .getByRole("button", { name: new RegExp(step) })
            .first()
            .click();
          await page
            .locator(
              `.settings-panel[data-strategy-step="${["Goal", "Markets", "Size and limits", "Hedging", "Review"].indexOf(step)}"]`,
            )
            .waitFor();
        }
        await page
          .getByRole("button", { name: /Size and limits/ })
          .first()
          .click();
      }
      const nextSpread = fixture.config.config.spreadBps + 1;
      await page
        .getByRole("spinbutton", { name: "Spread in basis points" })
        .fill(String(nextSpread));
      if (verifyStrategyBuilder) {
        await page
          .getByRole("button", { name: /Review/ })
          .first()
          .click();
      }
      await page.getByRole("button", { name: "Save strategy" }).click();
      await page
        .getByText("Unsaved changes, review and save", { exact: true })
        .waitFor({ state: "hidden" });
      const successNotice = page.locator(".notice.notice-success");
      await successNotice.getByText(/Strategy saved\./).waitFor();
      if (
        !(await successNotice.evaluate((node) =>
          node.matches("[role='status']"),
        ))
      ) {
        throw new Error(
          "Successful strategy save did not use a polite status notice",
        );
      }
      const {
        markets,
        mode: _mode,
        makerAccountId,
        hedge,
        ...settings
      } = fixture.config.config;
      const { accountId: _accountId, ...sharedHedge } = hedge;
      const expectedBody = JSON.stringify({
        name: "Core strategy",
        config: {
          ...settings,
          spreadBps: nextSpread,
          hedge: sharedHedge,
        },
        marketRule: {
          kind: "preferred-list",
          marketIds: markets.map((market) => market.marketId),
        },
        expectedVersion: 1,
      });
      if (capturedConfigBody !== expectedBody) {
        throw new Error(
          `Strategy save body changed. Expected ${expectedBody}, received ${capturedConfigBody}`,
        );
      }
      process.stdout.write(
        `${stateName}/${view}/${captureConfig.name}: strategy request body is allocation-free\n`,
      );
    }
    await page.waitForTimeout(100);

    if (
      verifyLearn &&
      stateName === "paper-running" &&
      view === "learn" &&
      captureConfig.name === "desktop-light"
    ) {
      const expectedScenes = [
        ["spread", "play spread"],
        ["fills", "play fills"],
        ["skew", "play skew"],
        ["hedge", "play hedge"],
        ["rewards", "rewards"],
      ];
      // Let the mounted view register its hash listener before simulating a
      // customer opening a chapter link.
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        window.location.hash = "learn/hedge";
      });
      await page.locator('[data-view="learn"]:not([hidden])').waitFor();
      await page.waitForTimeout(600);
      const deepLinkState = await page.evaluate(() => ({
        hash: window.location.hash,
        active: document.querySelector(".learn-chapters button.is-active")
          ?.parentElement?.id,
      }));
      if (deepLinkState.active !== "hedge") {
        throw new Error(
          "Learn deep link selected " + JSON.stringify(deepLinkState),
        );
      }
      for (const [id, scene] of expectedScenes) {
        await page
          .locator("#" + id)
          .getByRole("button")
          .click();
        await page.getByText("Scene: " + scene, { exact: true }).waitFor();
      }
      process.stdout.write(
        `${stateName}/${view}/${captureConfig.name}: Learn chapters and deep link play their scenes\n`,
      );
    }

    if (
      verifyExplain &&
      fixture.auth.status === 200 &&
      makerViews.includes(view) &&
      ["desktop-light", "phone-light"].includes(captureConfig.name)
    ) {
      const explain =
        captureConfig.viewport.width <= 390
          ? view === "strategy"
            ? page.locator(".strategy-mobile-explain")
            : page.locator(".maker-phone-explain")
          : page.locator(".maker-explain-toggle");
      if (await page.locator(".maker-coach").count()) {
        throw new Error("Explain opened before the user opted in");
      }
      const notNow = page.getByRole("button", { name: "Not now", exact: true });
      if (await notNow.count()) await notNow.click({ force: true });
      await explain.click();
      await page.locator(".maker-coach").waitFor();
      await page.waitForTimeout(300);
      if (captureConfig.viewport.width <= 390) {
        const phoneTarget = await page.evaluate(() => {
          const target = document.querySelector("[data-coach-target]");
          const nav = document
            .querySelector(".maker-nav")
            ?.getBoundingClientRect();
          return target && nav
            ? { top: target.getBoundingClientRect().top, navBottom: nav.bottom }
            : null;
        });
        if (!phoneTarget || phoneTarget.top < phoneTarget.navBottom) {
          throw new Error(
            `${stateName}/${view}/${captureConfig.name} Explain hid its target under the phone header: ${JSON.stringify(phoneTarget)}`,
          );
        }
      }
      const collisions = await page.evaluate(() => {
        const overlaps = (first, second) =>
          first.left < second.right &&
          first.right > second.left &&
          first.top < second.bottom &&
          first.bottom > second.top;
        const notes = Array.from(
          document.querySelectorAll(".maker-coach-note"),
        ).map((node) => node.getBoundingClientRect());
        const targets = [
          ...Array.from(document.querySelectorAll(".maker-coach-target")),
          ...Array.from(document.querySelectorAll(".desk-hero")),
        ].map((node) => node.getBoundingClientRect());
        const noteOverlap = notes.some((note, index) =>
          notes.slice(index + 1).some((other) => overlaps(note, other)),
        );
        const targetOverlap = notes.some((note) =>
          targets.some((target) => overlaps(note, target)),
        );
        return {
          noteOverlap,
          targetOverlap,
          notes: notes.length,
          targets: targets.length,
        };
      });
      if (collisions.noteOverlap || collisions.targetOverlap) {
        throw new Error(
          `${stateName}/${view}/${captureConfig.name} Explain overlaps: ${JSON.stringify(collisions)}`,
        );
      }
      await page.keyboard.press("Escape");
      await page.locator(".maker-coach").waitFor({ state: "hidden" });
      if (
        !(await explain.evaluate((node) => node === document.activeElement))
      ) {
        throw new Error("Explain did not return focus to its switch");
      }
      process.stdout.write(
        `${stateName}/${view}/${captureConfig.name}: Explain targets and notes do not overlap\n`,
      );
    }

    if (
      verifyMotion &&
      stateName === "paper-running" &&
      captureConfig.name === "desktop-light" &&
      view === "desk"
    ) {
      const number = page.locator('[data-motion-number="maker-exposure"]');
      await page.getByRole("button", { name: "Refresh market" }).click();
      await number.locator("..").waitFor();
      await page
        .locator('[data-motion-number="maker-exposure"].is-changing')
        .waitFor();
      await page.screenshot({
        path: path.join(outputDirectory, "motion-number-mid.png"),
        fullPage: false,
      });
      await page.waitForTimeout(260);
      if (
        await number.evaluate((node) => node.classList.contains("is-changing"))
      ) {
        throw new Error("Number transition did not settle after 200ms");
      }
      await page.screenshot({
        path: path.join(outputDirectory, "motion-number-settled.png"),
        fullPage: false,
      });
      await page.waitForTimeout(10_000);
      const lingeringAnimations = await page.evaluate(() =>
        document.getAnimations().map((animation) => animation.animationName),
      );
      if (lingeringAnimations.length) {
        throw new Error(
          `Motion remained after ten seconds without data: ${lingeringAnimations.join(", ")}`,
        );
      }
      process.stdout.write(
        `${stateName}/${view}/${captureConfig.name}: captured number mid-transition and settled; no idle motion after ten seconds\n`,
      );
    }

    if (
      fixture.auth.status === 200 &&
      stateName !== "onboarding" &&
      captureConfig.name === "desktop-light" &&
      (view === null || view === "desk")
    ) {
      const logViewport = await page
        .locator(".desk-event-list")
        .evaluate((node) => {
          const style = getComputedStyle(node);
          return {
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
            overflowY: style.overflowY,
          };
        });
      if (
        logViewport.overflowY !== "auto" ||
        logViewport.scrollHeight <= logViewport.clientHeight
      ) {
        throw new Error(
          `Control log is not constrained after ten rows: ${JSON.stringify(logViewport)}`,
        );
      }
    }

    if (
      ["medium-1024", "medium-1180"].includes(captureConfig.name) &&
      fixture.auth.status === 200
    ) {
      const navLayout = await page.evaluate(() => {
        const nav = document
          .querySelector(".maker-nav")
          ?.getBoundingClientRect();
        const tabs = document
          .querySelector(".maker-view-tabs")
          ?.getBoundingClientRect();
        const controls = document
          .querySelector(".maker-nav-right")
          ?.getBoundingClientRect();
        if (!nav || !tabs || !controls) return null;
        const overlaps = (first, second) =>
          first.left < second.right &&
          first.right > second.left &&
          first.top < second.bottom &&
          first.bottom > second.top;
        return {
          sameRow: Math.abs(tabs.top - controls.top) < 3,
          singleLine: tabs.height <= 40,
          overlaps: overlaps(tabs, controls),
        };
      });
      if (!navLayout?.sameRow || !navLayout.singleLine || navLayout.overlaps) {
        throw new Error(
          `${stateName}/${view}/${captureConfig.name} header layout failed: ${JSON.stringify(navLayout)}`,
        );
      }
      process.stdout.write(
        `${stateName}/${view}/${captureConfig.name}: single-row tabs do not overlap controls\n`,
      );
    }

    if (verifyPadding) {
      const paddingViolations = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-padding-check]")).flatMap(
          (container) => {
            const outer = container.getBoundingClientRect();
            return Array.from(
              container.querySelectorAll(":scope > header, :scope > div"),
            )
              .filter((child) => {
                const style = getComputedStyle(child);
                return (
                  style.display !== "none" && style.visibility !== "hidden"
                );
              })
              .map((child) => {
                const rect = child.getBoundingClientRect();
                return {
                  check: container.getAttribute("data-padding-check"),
                  left: Math.round(rect.left - outer.left),
                  right: Math.round(outer.right - rect.right),
                  top: Math.round(rect.top - outer.top),
                  bottom: Math.round(outer.bottom - rect.bottom),
                };
              })
              .filter(
                (measurement) =>
                  measurement.left < 12 ||
                  measurement.right < 12 ||
                  measurement.top < 12 ||
                  measurement.bottom < 12,
              );
          },
        ),
      );
      if (paddingViolations.length) {
        throw new Error(
          `${stateName}/${view}/${captureConfig.name} card padding is under 12px: ${JSON.stringify(paddingViolations)}`,
        );
      }
      process.stdout.write(
        `${stateName}/${view}/${captureConfig.name}: card text and tables have at least 12px of inner padding\n`,
      );
    }

    const dimensions = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    const clippedText = await page.evaluate(() => {
      const selectors = [
        ".desk-market-row > *",
        ".desk-fill-row > *",
        ".desk-event-row > *",
        ".market-table th",
        ".market-table td",
        ".reward-table th",
        ".reward-table td",
        ".performance-volume-table-wrap th",
        ".performance-volume-table-wrap td",
        ".performance-metrics strong",
        ".performance-v3-stats strong",
      ];
      return selectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .filter((element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          const text = element.textContent?.trim() ?? "";
          return (
            text.length > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            element.getBoundingClientRect().width > 0 &&
            element.scrollWidth > element.clientWidth + 1
          );
        })
        .slice(0, 20)
        .map((element) => ({
          selector: element.className,
          text: element.textContent?.trim().slice(0, 80),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        }));
    });
    if (clippedText.length) {
      throw new Error(
        `${stateName}/${captureConfig.name} clips table or log text: ${JSON.stringify(clippedText)}`,
      );
    }
    const contrastFailures = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const rgb = (token) => {
        const declared = style.getPropertyValue(token).trim();
        const probe = document.createElement("span");
        probe.style.color = `var(${token})`;
        document.body.append(probe);
        const value = getComputedStyle(probe).color || declared;
        probe.remove();
        const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
        if (hex) {
          const raw =
            hex.length === 3
              ? hex
                  .split("")
                  .map((channel) => channel + channel)
                  .join("")
              : hex;
          return [0, 2, 4].map((offset) =>
            Number.parseInt(raw.slice(offset, offset + 2), 16),
          );
        }
        const functional = value.match(
          /^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i,
        );
        if (functional) {
          return functional.slice(1, 4).map(Number);
        }
        throw new Error(`Expected a solid color value for ${token}`);
      };
      const luminance = (color) => {
        const channels = color.map((value) => {
          const normalized = value / 255;
          return normalized <= 0.04045
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return (
          0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
        );
      };
      const ratio = (foreground, background) => {
        const first = luminance(rgb(foreground));
        const second = luminance(rgb(background));
        return (
          (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
        );
      };
      const pairs = [
        ["--ink", "--surface"],
        ["--ink-2", "--surface"],
        ["--tide-text", "--surface"],
        ["--ember-text", "--surface"],
        ["--amber-text", "--surface"],
        ["--on-primary", "--primary"],
      ];
      return pairs
        .map(([foreground, background]) => ({
          foreground,
          background,
          ratio: ratio(foreground, background),
        }))
        .filter((pair) => pair.ratio < 4.5);
    });
    if (contrastFailures.length) {
      throw new Error(
        `${stateName}/${captureConfig.name} fails token contrast: ${JSON.stringify(contrastFailures)}`,
      );
    }
    if (captureConfig.reducedMotion === "reduce") {
      const movingElements = await page.evaluate(() =>
        Array.from(document.querySelectorAll("*"))
          .filter((element) => {
            if (!(element instanceof HTMLElement)) return false;
            const style = getComputedStyle(element);
            return (
              style.animationName !== "none" ||
              style.transitionDuration
                .split(",")
                .some((duration) => Number.parseFloat(duration) > 0)
            );
          })
          .slice(0, 10)
          .map((element) => ({
            element: element.tagName.toLowerCase(),
            className: element.className,
          })),
      );
      if (movingElements.length) {
        throw new Error(
          `${stateName}/${captureConfig.name} retains motion under reduced-motion: ${JSON.stringify(movingElements)}`,
        );
      }
    }

    // Chromium reserves an 8 px scrollbar gutter for the onboarding fixture.
    // Treat that browser chrome as neutral; any content overflow remains a failure.
    if (dimensions.scrollWidth > dimensions.innerWidth + 8) {
      const offenders = await page.evaluate(() =>
        Array.from(document.querySelectorAll("body *"))
          .filter(
            (element) =>
              element.getBoundingClientRect().right > window.innerWidth + 8,
          )
          .slice(0, 8)
          .map((element) => ({
            tag: element.tagName,
            className: element instanceof HTMLElement ? element.className : "",
            right: Math.round(element.getBoundingClientRect().right),
            width: Math.round(element.getBoundingClientRect().width),
          })),
      );
      const containers = await page.evaluate(() => {
        const table = document.querySelector(".market-clean-table");
        const result = [];
        for (
          let node = table?.parentElement;
          node && result.length < 5;
          node = node.parentElement
        ) {
          const rect = node.getBoundingClientRect();
          result.push({
            className: node.className,
            width: Math.round(rect.width),
            right: Math.round(rect.right),
            scrollWidth: node.scrollWidth,
          });
        }
        result.push({
          className: "document",
          width: document.documentElement.clientWidth,
          right: document.documentElement.scrollWidth,
          scrollWidth: document.body.scrollWidth,
        });
        return result;
      });
      throw new Error(
        `${stateName}/${captureConfig.name} has horizontal overflow: ${dimensions.scrollWidth}px > ${dimensions.innerWidth}px ${JSON.stringify(offenders)} ${JSON.stringify(containers)}`,
      );
    }
    if (
      view === "desk" &&
      fixture.auth.status === 200 &&
      fixture.bundles.bundles.some(
        (bundle) =>
          !bundle.archivedAt &&
          (bundle.status === "running" ||
            bundle.status === "paused" ||
            bundle.status === "error"),
      ) &&
      (await page.locator(".desk-ladder-card").count())
    ) {
      throw new Error(
        `${stateName}/${captureConfig.name} showed the legacy market lane beside bundles`,
      );
    }
    if (captureConfig.viewport.width <= 390 && fixture.auth.status === 200) {
      const phoneCriteria = await page.evaluate(() => {
        const isVisible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          if (element.closest('[aria-hidden="true"]')) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity) > 0 &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        const all = Array.from(document.body.querySelectorAll("*"));
        const smallText = all
          .filter((element) => {
            if (!isVisible(element)) return false;
            const hasDirectText = Array.from(element.childNodes).some(
              (node) =>
                node.nodeType === Node.TEXT_NODE &&
                Boolean(node.textContent?.trim()),
            );
            return (
              hasDirectText &&
              Number.parseFloat(getComputedStyle(element).fontSize) < 12
            );
          })
          .slice(0, 50)
          .map((element) => ({
            element: element.tagName.toLowerCase(),
            className: element instanceof HTMLElement ? element.className : "",
            size: getComputedStyle(element).fontSize,
            text: element.textContent?.trim().slice(0, 50),
          }));
        const controls = Array.from(
          document.querySelectorAll(
            'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"]',
          ),
        );
        const targetRect = (element) => {
          if (element instanceof HTMLInputElement) {
            const label = element.closest("label");
            if (label && isVisible(label)) return label.getBoundingClientRect();
          }
          return element.getBoundingClientRect();
        };
        const smallTargets = controls
          .filter(isVisible)
          .filter((element) => {
            const rect = targetRect(element);
            return rect.width < 44 || rect.height < 44;
          })
          .slice(0, 50)
          .map((element) => {
            const rect = targetRect(element);
            return {
              element: element.tagName.toLowerCase(),
              label:
                element.getAttribute("aria-label") ??
                element.textContent?.trim().slice(0, 50),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          });
        return { smallText, smallTargets };
      });
      if (phoneCriteria.smallText.length) {
        throw new Error(
          `${stateName}/${captureConfig.name} has text below 12px: ${JSON.stringify(phoneCriteria.smallText)}`,
        );
      }
      if (phoneCriteria.smallTargets.length) {
        throw new Error(
          `${stateName}/${captureConfig.name} has tap targets below 44px: ${JSON.stringify(phoneCriteria.smallTargets)}`,
        );
      }
    }
    if (remoteRequests.length) {
      throw new Error(
        `${stateName}/${captureConfig.name} attempted remote requests: ${[...new Set(remoteRequests)].join(", ")}`,
      );
    }
    if (browserErrors.length) {
      throw new Error(
        `${stateName}/${captureConfig.name} emitted browser errors: ${browserErrors.join(" | ")}`,
      );
    }

    if (verifyLaneHeight && view === "desk" && fixture.auth.status === 200) {
      const heights = await page
        .locator(".bundle-lane-motion svg")
        .evaluateAll((nodes) =>
          nodes.map((node) => ({
            rendered: node.getBoundingClientRect().height,
            viewBox: node.getAttribute("viewBox"),
          })),
        );
      console.log("Lane chart heights:", JSON.stringify(heights));
      if (heights.some((height) => height.rendered > 200))
        throw new Error(
          `Sparse desk chart exceeds 200px: ${JSON.stringify(heights)}`,
        );
    }
    const file = path.join(
      outputDirectory,
      `${stateName}${view ? `-${view}` : ""}${learnChapter ? `-${learnChapter}` : ""}${showFlattenSheet ? "-flatten" : ""}${showLiveSheet ? "-live" : ""}${showRunStatus ? "-run-status" : ""}${beginStop ? "-stopping" : ""}${waitForStopTimeout ? "-timeout" : ""}-${captureConfig.name}.png`,
    );
    if (
      verifyPaperBlocked &&
      stateName === "paper-blocked" &&
      view === "desk"
    ) {
      const runStatus = page.getByRole("region", { name: "Run status" });
      if (!(await runStatus.isVisible())) {
        await page
          .getByRole("button", { name: /needs attention/i })
          .first()
          .click();
      }
      await runStatus
        .getByText("Paper is waiting on account 1757.", { exact: false })
        .waitFor();
      await runStatus.getByRole("button", { name: "Open Venues" }).waitFor();
      await runStatus.getByRole("button", { name: "Edit strategy" }).waitFor();
      await page.keyboard.press("Escape");
      await runStatus.waitFor({ state: "hidden" });
      const list = page.locator(".desk-log-card .desk-event-row");
      await page.getByRole("button", { name: "Show more" }).click();
      if ((await list.count()) !== 50)
        throw new Error("Show more did not reveal events 13–50");
      await page.getByRole("tab", { name: "Problems" }).click();
      await page
        .locator(".desk-log-card")
        .getByText("Paper is waiting on account 1757.", { exact: false })
        .waitFor();
      if ((await list.count()) !== 1)
        throw new Error("Server-side Problems did not find the buried blocker");
      await page
        .locator(".desk-log-card")
        .getByRole("button", { name: "Open Venues" })
        .waitFor();
      await page.locator(".desk-log-card").scrollIntoViewIfNeeded();
    }
    if (showWalletMenu && fixture.auth.status === 200) {
      await page.locator(".maker-wallet-menu > summary").click();
      await page.locator(".maker-build-info").waitFor();
    }
    await page.screenshot({ path: file, fullPage: false });
    process.stdout.write(
      `${stateName}${view ? `/${view}` : ""}/${captureConfig.name}: ${file} (${dimensions.scrollWidth}px wide)\n`,
    );

    if (
      stateName === "paper-running" &&
      view === "bundles" &&
      captureConfig.name === "desktop-light"
    ) {
      await page.getByRole("button", { name: "New bundle" }).click();
      const dialog = page.getByRole("dialog", { name: "New Paper bundle" });
      await dialog.waitFor();
      const marketPicker = dialog.getByLabel("Market");
      if (await marketPicker.count()) {
        throw new Error(
          "Bundle creation still offers a market picker; markets belong to the selected strategy.",
        );
      }
      await dialog.getByRole("button", { name: "Cancel" }).click();
    }

    if (
      showFlattenSheet &&
      captureConfig.name === "desktop-light" &&
      stateName === "live-running" &&
      (view === null || view === "desk")
    ) {
      await page.keyboard.press("Escape");
      await page
        .getByRole("dialog", { name: "Flatten positions?" })
        .waitFor({ state: "hidden" });
      const flattenButton = page.getByRole("button", {
        name:
          captureConfig.viewport.width <= 390
            ? "Flatten…"
            : "Flatten positions…",
      });
      if (
        !(await flattenButton.evaluate(
          (node) => node === document.activeElement,
        ))
      ) {
        throw new Error("Flatten sheet did not restore focus after Escape");
      }
      process.stdout.write(
        `${stateName}${view ? `/${view}` : ""}/${captureConfig.name}: sheet trapped and restored focus\n`,
      );
    }

    if (
      verifyPaperBlocked &&
      stateName === "paper-blocked" &&
      view === "desk"
    ) {
      await page
        .getByRole("button", { name: "Stop all", exact: true })
        .first()
        .click();
      await page.getByRole("link", { name: "Bundles", exact: true }).click();
      const coreCard = page.locator(".bundle-card").filter({
        has: page.getByRole("heading", { name: "Core", exact: true }),
      });
      await coreCard.waitFor();
      await page.waitForFunction(() => {
        const card = Array.from(document.querySelectorAll(".bundle-card")).find(
          (element) => element.querySelector("h2")?.textContent === "Core",
        );
        return (
          card &&
          !card.querySelector(".bundle-error") &&
          !card.querySelector(".bundle-stale")
        );
      });
    }
    if (exerciseStop) {
      const stop = page
        .getByRole("button", { name: "Stop all", exact: true })
        .first();
      if (!(await stop.isEnabled())) {
        throw new Error("Stop was disabled before its request began");
      }
      await stop.click();
      await page.getByText("Stop not confirmed", { exact: true }).waitFor();
      if (!(await stop.isEnabled())) {
        throw new Error("Stop became disabled after a server error");
      }
      process.stdout.write(
        `${stateName}${view ? `/${view}` : ""}/${captureConfig.name}: Stop stayed enabled after a server error\n`,
      );
    }
    if (
      captureConfig.name === "phone-light" &&
      view === "strategy" &&
      stateName !== "onboarding"
    ) {
      await page.getByRole("button", { name: "Close strategy" }).click();
      await page.locator('[data-view="desk"]:not([hidden])').waitFor();
      if (new URL(page.url()).hash !== "#desk") {
        throw new Error(
          "Closing the phone strategy sheet did not return to Desk",
        );
      }
      process.stdout.write(
        `${stateName}/strategy/${captureConfig.name}: strategy sheet closed to Desk\n`,
      );
    }
  } finally {
    await context.close();
  }
}

await fs.mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox"],
});

try {
  for (const stateName of selectedStates()) {
    for (const view of selectedViews(stateName)) {
      for (const captureConfig of selectedCaptures()) {
        await capture(browser, stateName, captureConfig, view);
      }
    }
  }
} finally {
  await browser.close();
}
