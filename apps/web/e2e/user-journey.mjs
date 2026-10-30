/**
 * Stateful customer audit for the client. It deliberately exercises the UI
 * against a browser-local control mock: no wallet, control service, or trading
 * endpoint is contacted.
 *
 * Usage:
 *   node apps/web/e2e/user-journey.mjs --spawn-server
 *   node apps/web/e2e/user-journey.mjs --base-url http://127.0.0.1:8899
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";

import { apiResponse } from "./fixtures/api.mjs";
import { fixtureStates } from "./fixtures/control.ts";

const projectRoot = path.resolve(import.meta.dirname, "../../..");
const mockWalletPath = path.join(
  import.meta.dirname,
  "fixtures/mock-wallet.mjs",
);
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

const spawnServer = process.argv.includes("--spawn-server");
const port = Number(option("--port", "8899"));
const baseUrl = option("--base-url", `http://127.0.0.1:${port}`);
const outputDirectory = path.resolve(
  projectRoot,
  option("--output", "apps/web/e2e/shots/audit-journey"),
);

function assert(value, message) {
  if (!value) throw new Error(message);
}

function cloneFixture() {
  const fixture = structuredClone(fixtureStates["paper-running"]);
  fixture.config.config.maxGrossExposureUsd = 0.9;
  fixture.config.config.maxRunDrawdownUsd = 0.9;
  fixture.status.snapshot.portfolio.grossExposureUsd = 0.01;
  fixture.status.snapshot.balances.inventoryUsd = 1.04;
  fixture.status.snapshot.lastSuccessfulCycleAt = "2026-10-27T10:08:00.000Z";
  fixture.status.snapshot.market.updatedAt = "2026-10-27T10:08:00.000Z";
  fixture.status.snapshot.risk.measuredAt = "2026-10-27T10:08:00.000Z";
  fixture.accounts.accounts.push(
    {
      ...fixture.accounts.accounts[0],
      accountId: "1747",
      accountCapId: `0x${"67".repeat(32)}`,
      label: "Rewards maker",
    },
    {
      ...fixture.accounts.accounts[0],
      accountId: "1748",
      accountCapId: `0x${"68".repeat(32)}`,
      label: "Rewards hedge",
    },
    {
      ...fixture.accounts.accounts[0],
      accountId: "1749",
      accountCapId: `0x${"69".repeat(32)}`,
      label: "Reserve",
    },
  );
  return fixture;
}

function initialStrategies(fixture) {
  const {
    markets,
    mode: _mode,
    makerAccountId: _makerAccountId,
    hedge,
    ...config
  } = fixture.config.config;
  const { accountId: _accountId, ...sharedHedge } = hedge;
  return fixture.bundles.bundles.map((bundle) => ({
    id: bundle.strategyId,
    name: bundle.strategyName,
    config: { ...config, hedge: sharedHedge },
    marketRule: { kind: "preferred-list", marketIds: bundle.marketIds },
    markets: bundle.marketIds.map((marketId) => {
      const market = fixture.markets.markets.find(
        (item) => item.id === marketId,
      );
      return { marketId, symbol: market?.symbol ?? marketId };
    }),
    version: 1,
    usedBy: [{ id: bundle.id, name: bundle.name }],
    archivedAt: null,
  }));
}

function routePathFor(url) {
  const marker = "/api/control/";
  return url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
}

async function installStatefulControl(page, state) {
  await page.route("**/api/control/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const routePath = routePathFor(url);
    const json = (status, body) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (routePath === "api/auth/logout") return json(200, { ok: true });
    if (state.sessionExpired && routePath !== "api/runtime/stop") {
      return json(401, { error: "Session expired" });
    }
    if (state.serviceDown && routePath === "api/status") {
      return json(503, { error: "Maker is temporarily unavailable" });
    }
    if (routePath === "api/runtime/stop" && request.method() === "POST") {
      if (state.delayStop) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      state.fixture.status.snapshot.running = false;
      state.fixture.status.bundles = (state.fixture.status.bundles ?? []).map(
        (entry) => ({
          ...entry,
          bundle: { ...entry.bundle, status: "stopped" },
        }),
      );
      state.fixture.bundles.bundles = state.fixture.bundles.bundles.map(
        (bundle) =>
          bundle.status === "running"
            ? { ...bundle, status: "stopped" }
            : bundle,
      );
      return json(200, { ok: true });
    }
    if (
      routePath === "api/runtime/paper-trial" &&
      request.method() === "POST"
    ) {
      state.paperTrialRequests += 1;
      const now = "2026-10-27T10:08:30.000Z";
      return json(200, {
        result: {
          mode: "paper",
          marketId: state.fixture.config.config.markets[0]?.marketId ?? "0x1",
          symbol: state.fixture.config.config.markets[0]?.symbol ?? "MON",
          cadenceMs: 2000,
          startedAt: now,
          completedAt: now,
          rounds: ["farming", "profit", "both"].map((objective) => ({
            objective,
            profile: "balanced",
            score: 70,
            quoteSizeUsd: 1.04,
            spreadBps: 16,
            outcome: "simulated",
            digest: null,
            startedAt: now,
            completedAt: now,
          })),
          recovery: null,
          restoredConfig: state.fixture.config.config,
        },
        snapshot: state.fixture.status.snapshot,
      });
    }
    if (routePath === "api/strategies") {
      if (request.method() === "GET") {
        return json(200, { strategies: state.strategies });
      }
      if (request.method() === "POST") {
        const body = JSON.parse(request.postData() ?? "{}");
        const strategy = {
          id: `strategy-${state.strategies.length + 1}`,
          name: body.name,
          config: body.config,
          marketRule: body.marketRule,
          markets: body.markets,
          version: 1,
          usedBy: [],
          archivedAt: null,
        };
        state.strategies.unshift(strategy);
        return json(200, { strategy });
      }
    }
    const strategyMatch = routePath.match(
      /^api\/strategies\/([^/]+)(?:\/(duplicate))?$/,
    );
    if (strategyMatch) {
      const [, strategyId, action] = strategyMatch;
      const strategy = state.strategies.find(
        (candidate) => candidate.id === strategyId,
      );
      if (!strategy) return json(404, { error: "Strategy was not found" });
      if (request.method() === "GET") return json(200, { strategy });
      if (action === "duplicate" && request.method() === "POST") {
        const duplicate = {
          ...structuredClone(strategy),
          id: `strategy-${state.strategies.length + 1}`,
          name: `${strategy.name} copy`,
          version: 1,
          usedBy: [],
        };
        state.strategies.unshift(duplicate);
        return json(200, { strategy: duplicate });
      }
      if (request.method() === "PATCH") {
        const body = JSON.parse(request.postData() ?? "{}");
        Object.assign(strategy, {
          name: body.name ?? strategy.name,
          config: body.config,
          marketRule: body.marketRule,
          markets: body.markets,
          version: strategy.version + 1,
        });
        for (const used of strategy.usedBy) {
          const bundle = state.fixture.bundles.bundles.find(
            (candidate) => candidate.id === used.id,
          );
          if (bundle)
            bundle.marketIds = strategy.markets.map(
              (market) => market.marketId,
            );
        }
        return json(200, { strategy, affectedBundles: strategy.usedBy });
      }
    }
    const bundleMatch = routePath.match(/^api\/bundles\/([^/]+)$/);
    if (bundleMatch && request.method() === "PATCH") {
      const bundle = state.fixture.bundles.bundles.find(
        (candidate) => candidate.id === bundleMatch[1],
      );
      if (!bundle) return json(404, { error: "Bundle was not found" });
      const body = JSON.parse(request.postData() ?? "{}");
      if (body.strategyId !== undefined) {
        const hadStrategy = Boolean(bundle.strategyId);
        const previous = state.strategies.find(
          (candidate) => candidate.id === bundle.strategyId,
        );
        previous &&
          (previous.usedBy = previous.usedBy.filter(
            (used) => used.id !== bundle.id,
          ));
        const strategy = state.strategies.find(
          (candidate) => candidate.id === body.strategyId,
        );
        bundle.strategyId = body.strategyId;
        bundle.strategyName = strategy?.name ?? null;
        bundle.strategyVersionApplied = strategy?.version ?? null;
        bundle.needsStrategy = !strategy;
        if (strategy && !hadStrategy) bundle.status = "stopped";
        if (strategy) {
          bundle.marketIds = strategy.markets.map((market) => market.marketId);
          strategy.usedBy.push({ id: bundle.id, name: bundle.name });
        }
      }
      if (body.makerAccountId !== undefined)
        bundle.makerAccountId = body.makerAccountId;
      if (body.takerAccountId !== undefined)
        bundle.takerAccountId = body.takerAccountId;
      if (body.mode !== undefined) bundle.mode = body.mode;
      if (body.markets !== undefined) {
        bundle.marketIds = body.markets.map((market) => market.marketId);
      }
      bundle.updatedAt = "2026-10-27T17:09:00.000Z";
      return json(200, { bundle, config: state.fixture.config.config });
    }
    if (routePath === "api/bundles" && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}");
      const selectedStrategy = body.strategyId
        ? state.strategies.find((strategy) => strategy.id === body.strategyId)
        : null;
      const createdAt = "2026-10-27T17:08:32.000Z";
      const next = {
        id: "audit-bundle",
        name: body.name,
        strategyId: selectedStrategy?.id ?? null,
        strategyName: selectedStrategy?.name ?? null,
        strategyVersionApplied: selectedStrategy?.version ?? null,
        needsStrategy: !selectedStrategy,
        makerAccountId: body.makerAccountId ?? body.config?.makerAccountId,
        takerAccountId:
          body.takerAccountId ?? body.config?.hedge?.accountId ?? null,
        mode: "paper",
        status: "paused",
        marketIds: (
          selectedStrategy?.markets ??
          body.config?.markets ??
          []
        ).map((market) => market.marketId),
        createdAt,
        updatedAt: createdAt,
        lastError: null,
        archivedAt: null,
      };
      state.fixture.bundles.bundles.push(next);
      if (selectedStrategy) {
        selectedStrategy.usedBy.push({ id: next.id, name: next.name });
      }
      state.fixture.status.bundles = [
        ...(state.fixture.status.bundles ?? []),
        { bundle: next, snapshot: null },
      ];
      return json(200, {
        bundle: next,
        walletLimits: state.fixture.bundles.walletLimits,
      });
    }
    if (
      routePath === "api/bundles/wallet-limits" &&
      request.method() === "POST"
    ) {
      const body = JSON.parse(request.postData() ?? "{}");
      if (body.confirmed !== true) {
        return json(400, { error: "Confirm the wallet limits before saving" });
      }
      state.fixture.bundles.walletLimits = {
        maxRunDrawdownUsd: body.maxRunDrawdownUsd,
        maxInventoryUsd: body.maxInventoryUsd,
        maxGrossExposureUsd: body.maxGrossExposureUsd,
        maxUnrealizedLossUsd: body.maxUnrealizedLossUsd,
        updatedAt: "2026-10-27T17:09:00.000Z",
        confirmedAt: state.fixture.bundles.walletLimits.confirmedAt,
      };
      return json(200, { walletLimits: state.fixture.bundles.walletLimits });
    }
    if (routePath === "api/config" && request.method() === "POST") {
      state.fixture.config.config = JSON.parse(request.postData() ?? "{}");
      return json(200, { config: state.fixture.config.config });
    }
    const response = apiResponse(state.fixture, url);
    return json(response.status, response.body);
  });

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      return route.fallback();
    }
    return route.abort("blockedbyclient");
  });
}

async function waitForPort(portNumber) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: portNumber });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function ensurePortFree(portNumber) {
  if (await waitForPort(portNumber)) {
    throw new Error(
      `Port ${portNumber} is already in use; audit will not reuse an unknown server.`,
    );
  }
}

async function startServer() {
  await ensurePortFree(port);
  const next = path.join(projectRoot, "node_modules/next/dist/bin/next");
  const child = spawn(process.execPath, [next, "start", "-p", String(port)], {
    cwd: path.join(projectRoot, "apps/web"),
    stdio: "inherit",
  });
  let output = "";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await waitForPort(port)) return child;
    if (child.exitCode !== null) {
      throw new Error(`Next start exited early: ${output.slice(-2_000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill("SIGTERM");
  throw new Error(`Timed out starting Next: ${output.slice(-2_000)}`);
}

async function newPage(browser, viewport) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  const fixture = cloneFixture();
  const state = {
    fixture,
    strategies: initialStrategies(fixture),
    serviceDown: false,
    sessionExpired: false,
    delayStop: false,
    paperTrialRequests: 0,
  };
  await page.addInitScript({ path: mockWalletPath });
  await page.addInitScript(() => {
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: undefined,
    });
    const nativeSetInterval = window.setInterval;
    window.setInterval = (handler, timeout, ...args) =>
      nativeSetInterval(handler, Math.min(Number(timeout) || 0, 60), ...args);
  });
  await installStatefulControl(page, state);
  return { context, page, state };
}

async function goToDesk(page) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("navigation", { name: "Maker views" }).waitFor();
  await page.locator('.maker-view[data-view="desk"]:not([hidden])').waitFor();
}

async function capture(page, name) {
  await page.screenshot({
    path: path.join(outputDirectory, name),
    fullPage: false,
  });
}

async function stopWithInventory(browser) {
  const { context, page } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  try {
    await goToDesk(page);
    await page
      .getByRole("button", { name: "Stop all", exact: true })
      .first()
      .click();
    await page
      .locator(".desk-narration")
      .filter({
        hasText: "Stopped. Orders are cancelled; you still hold $1.04 of MON.",
      })
      .waitFor();
    await capture(page, "v5-audit-stopped-inventory-desktop.png");
  } finally {
    await context.close();
  }
}

async function stopAllShowsProgress(browser) {
  const { context, page, state } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  try {
    state.delayStop = true;
    await goToDesk(page);
    await page
      .locator(".maker-nav-right")
      .getByRole("button", { name: "Stop all", exact: true })
      .click();
    await page
      .locator(".maker-nav-right")
      .getByRole("button", { name: "Stopping…", exact: true })
      .waitFor();
    await page
      .locator(".maker-nav-right")
      .getByRole("button", { name: "Stopped", exact: true })
      .waitFor();
    await capture(page, "v6-stop-progress-desktop.png");
  } finally {
    await context.close();
  }
}

async function savedDeskOnly(browser) {
  const { context, page } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  try {
    await goToDesk(page);
    await page
      .locator(".desk-risk-card")
      .getByText("$0.01 of $0.90", { exact: true })
      .first()
      .waitFor();
    await page.getByRole("link", { name: "Strategy", exact: true }).click();
    await page
      .getByRole("button", { name: /Size and limits/ })
      .first()
      .click();
    await page
      .getByRole("spinbutton", { name: "Maximum gross exposure in USD" })
      .fill("1.50");
    await page
      .getByText("Unsaved changes, review and save", { exact: true })
      .waitFor();
    assert(
      (await page
        .locator('.maker-view[data-view="desk"] .desk-risk-card')
        .getByText("$0.01 of $0.90", { exact: true })
        .count()) > 0,
      "Hidden Desk read the unsaved strategy draft",
    );
    await page.getByRole("link", { name: "Desk", exact: true }).click();
    const leaveSheet = page.getByRole("dialog", {
      name: "Save strategy changes?",
    });
    await leaveSheet.waitFor();
    await leaveSheet
      .getByRole("button", { name: "Discard", exact: true })
      .click();
    await page
      .locator(".desk-risk-card")
      .getByText("$0.01 of $0.90", { exact: true })
      .first()
      .waitFor();
    await capture(page, "v5-audit-saved-desk-desktop.png");
  } finally {
    await context.close();
  }
}

async function revokeWithoutWallet(browser) {
  const { context, page } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  try {
    await goToDesk(page);
    await page.evaluate(() => {
      window.location.hash = "accounts";
    });
    await page
      .locator('.maker-view[data-view="accounts"]:not([hidden])')
      .waitFor();
    await page
      .getByRole("button", { name: "Revoke trading key for account 1745" })
      .click();
    await page
      .getByText("Connect your owner wallet to revoke", { exact: true })
      .waitFor();
    await page
      .locator("mysten-dapp-kit-connect-modal")
      .getByText("Mock Sui Wallet", { exact: true })
      .filter({ visible: true })
      .waitFor();
    await capture(page, "v5-audit-revoke-wallet-desktop.png");
  } finally {
    await context.close();
  }
}

async function serviceAndSessionFailures(browser) {
  const desktop = await newPage(browser, { width: 1440, height: 900 });
  try {
    await goToDesk(desktop.page);
    desktop.state.serviceDown = true;
    await desktop.page.waitForTimeout(300);
    await desktop.page
      .getByText("Can't reach Maker. Showing data from 10:08 AM.", {
        exact: true,
      })
      .waitFor();
    const stale = desktop.page.locator(".desk-freshness.is-stale");
    assert(
      (await stale.count()) > 0,
      "Control outage did not turn timestamps amber.",
    );
    await desktop.page
      .getByRole("button", { name: "Stop all", exact: true })
      .first()
      .click();
    await desktop.page.getByText("Stopped.", { exact: false }).waitFor();
    await capture(desktop.page, "v5-audit-service-down-desktop.png");
  } finally {
    await desktop.context.close();
  }

  const phone = await newPage(browser, { width: 390, height: 844 });
  try {
    await goToDesk(phone.page);
    phone.state.sessionExpired = true;
    await phone.page.waitForTimeout(300);
    await phone.page
      .locator(".access-notice")
      .getByText("Your session ended. Sign in again,", { exact: true })
      .waitFor();
    await phone.page
      .getByRole("heading", {
        name: "Your own market-making desk. Working for you.",
      })
      .waitFor();
    await capture(phone.page, "v5-audit-session-expired-phone.png");
  } finally {
    await phone.context.close();
  }
}

async function createBundleWithFreeChoices(browser) {
  const { context, page } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  try {
    await goToDesk(page);
    await page.getByRole("link", { name: "Bundles", exact: true }).click();
    await page.getByRole("button", { name: "New bundle", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New Paper bundle" });
    await dialog.waitFor();
    const makerOptions = await dialog
      .getByLabel("Maker account")
      .locator("option")
      .allTextContents();
    assert(
      !makerOptions.some((label) =>
        /Core maker|Neutral hedge|Rewards maker|Rewards hedge/.test(label),
      ),
      `Taken accounts were offered: ${JSON.stringify(makerOptions)}`,
    );
    assert(
      (await dialog.getByLabel("Market").count()) === 0,
      "Bundle creation still offered a market picker",
    );
    await dialog.getByLabel("Name").fill("Audit reserve");
    await dialog.getByLabel("Maker account").selectOption({ label: "Reserve" });
    await dialog
      .getByLabel("Strategy")
      .selectOption({ label: "Rewards strategy" });
    await capture(page, "rfc-0002-new-bundle-desktop.png");
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await page
      .getByRole("heading", { name: "Audit reserve", exact: true })
      .waitFor();
    const start = page
      .getByRole("button", { name: "Start", exact: true })
      .last();
    await start.waitFor();
    await start.scrollIntoViewIfNeeded();
    await capture(page, "v5-audit-bundle-free-options-desktop.png");
  } finally {
    await context.close();
  }
}

async function lowerWalletLimitsWhenCreating(browser) {
  const { context, page, state } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  try {
    state.fixture.bundles.walletLimits.confirmedAt = null;
    await goToDesk(page);
    await page.getByRole("link", { name: "Bundles", exact: true }).click();
    await page.getByRole("button", { name: "New bundle", exact: true }).click();
    const create = page.getByRole("dialog", { name: "New Paper bundle" });
    await create.getByLabel("Name").fill("Limits audit");
    await create.getByLabel("Maker account").selectOption({ label: "Reserve" });
    await create
      .getByLabel("Strategy")
      .selectOption({ label: "Rewards strategy" });
    await create.getByRole("button", { name: "Continue", exact: true }).click();
    const confirmation = page.getByRole("dialog", {
      name: "Confirm wallet limits",
    });
    await confirmation.waitFor();
    await confirmation
      .getByText(
        "These limits apply across every bundle. You can lower them here. To raise them, edit wallet limits.",
        { exact: true },
      )
      .waitFor();
    await confirmation.getByLabel("Gross exposure").fill("15.00");
    assert(
      await confirmation
        .getByRole("button", { name: "Confirm limits and create", exact: true })
        .isEnabled(),
      "Lower wallet limits could not be confirmed before creating a bundle",
    );
    await capture(page, "v6-lower-wallet-limits-desktop.png");
    await confirmation.screenshot({
      path: path.join(outputDirectory, "v6-lower-wallet-limits-sheet.png"),
    });
  } finally {
    await context.close();
  }
}

async function editWalletLimits(browser) {
  const { context, page } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  try {
    await goToDesk(page);
    await page.getByRole("link", { name: "Bundles", exact: true }).click();
    await page
      .getByRole("button", { name: "Edit wallet limits", exact: true })
      .click();
    const editor = page.getByRole("dialog", { name: "Edit wallet limits" });
    await editor.waitFor();
    await editor.getByLabel("Gross exposure").fill("18.25");
    await editor.getByRole("button", { name: "Continue", exact: true }).click();
    const confirmation = page.getByRole("dialog", {
      name: "Confirm wallet limits",
    });
    await confirmation.waitFor();
    await confirmation.getByText("$18.25", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    await capture(page, "v5-wallet-limits-confirm-desktop.png");
    await confirmation
      .getByRole("button", { name: "Confirm changes", exact: true })
      .click();
    await page
      .getByText("Wallet limits updated across your bundles.", {
        exact: true,
      })
      .waitFor();
    await page
      .locator(".bundle-wallet-limits")
      .getByText("$18.25", { exact: true })
      .waitFor();
    await capture(page, "v5-wallet-limits-edit-desktop.png");
  } finally {
    await context.close();
  }
}

async function cleanStrategyLeavesWithoutPrompt(browser) {
  const { context, page } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  try {
    await goToDesk(page);
    await page.getByRole("link", { name: "Strategy", exact: true }).click();
    await page
      .locator('.maker-view[data-view="strategy"]:not([hidden])')
      .waitFor();
    await page.getByRole("link", { name: "Desk", exact: true }).click();
    await page.locator('.maker-view[data-view="desk"]:not([hidden])').waitFor();
    assert(dialogs.length === 0, `Unexpected browser prompt: ${dialogs}`);
    assert(
      (await page
        .getByRole("dialog", { name: "Save strategy changes?" })
        .count()) === 0,
      "Clean Strategy showed the unsaved-changes sheet",
    );
    await capture(page, "v6-clean-strategy-leave-desktop.png");
  } finally {
    await context.close();
  }
}

async function plainControlLog(browser) {
  const { context, page, state } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  try {
    state.fixture.events.events = [
      {
        id: 98,
        occurredAt: "2026-10-27T10:08:00.000Z",
        category: "onboarding",
        action: "agent.grant",
        outcome: "confirmed",
        detail: { accountId: "1745" },
      },
      {
        id: 99,
        occurredAt: "2026-10-27T10:07:00.000Z",
        category: "accounts",
        action: "metadata.update",
        outcome: "success",
        detail: { accountId: "1745" },
      },
      ...state.fixture.events.events,
    ];
    await goToDesk(page);
    const audit = page.locator(".desk-log-card");
    await page.waitForTimeout(200);
    const auditText = await audit.textContent();
    assert(
      auditText?.includes("Core · account 1745: trading key approved."),
      `Trading-key copy was not shown: ${auditText}`,
    );
    assert(
      auditText?.includes("Core · account 1745: account name and tags saved."),
      `Account metadata copy was not shown: ${auditText}`,
    );
    assert(
      (await audit.getByText("error", { exact: true }).count()) === 0,
      "Routine control events were shown as errors",
    );
    await audit.scrollIntoViewIfNeeded();
    await capture(page, "v6-plain-control-log-desktop.png");
  } finally {
    await context.close();
  }
}

async function strategyLibraryAndBundleAttachment(browser) {
  const { context, page, state } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  try {
    const draftBundle = {
      id: "strategy-audit-bundle",
      name: "Strategy audit",
      strategyId: null,
      strategyName: null,
      strategyVersionApplied: null,
      needsStrategy: true,
      makerAccountId: "1749",
      takerAccountId: null,
      mode: "paper",
      status: "paused",
      marketIds: [
        state.fixture.markets.markets.find((market) => market.symbol === "HYPE")
          .id,
      ],
      createdAt: "2026-10-27T17:10:00.000Z",
      updatedAt: "2026-10-27T17:10:00.000Z",
      lastError: null,
      archivedAt: null,
    };
    state.fixture.bundles.bundles.push(draftBundle);
    state.fixture.status.bundles.push({ bundle: draftBundle, snapshot: null });

    await goToDesk(page);
    await page.getByRole("link", { name: "Strategy", exact: true }).click();
    await page
      .getByRole("button", { name: "New strategy", exact: true })
      .click();
    await page
      .getByText("Strategy created. Attach it to a bundle when ready.", {
        exact: true,
      })
      .waitFor();
    await page.getByRole("button", { name: "Duplicate", exact: true }).click();
    await page
      .getByText("Strategy duplicated. It can now be edited independently.", {
        exact: true,
      })
      .waitFor();

    await page.getByRole("link", { name: "Bundles", exact: true }).click();
    const card = page.locator(".bundle-card").filter({
      hasText: "Strategy audit",
    });
    await card.waitFor();
    await card.getByRole("combobox").selectOption({ label: "Strategy 3" });
    await page
      .getByText("Strategy attached. The bundle can now be started.", {
        exact: true,
      })
      .waitFor();
    await card.getByText(/^From Strategy 3:/, { exact: false }).waitFor();
    await card.getByRole("button", { name: "Start", exact: true }).waitFor();
    await capture(page, "rfc-0002-strategy-attachment-desktop.png");
  } finally {
    await context.close();
  }
}

async function paperTrialRunsBesideBundles(browser) {
  const { context, page, state } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  try {
    // Start from a valid saved strategy: the enabled control must prove that
    // another running bundle does not block this isolated Paper trial.
    state.fixture.config.config.maxGrossExposureUsd = 3;
    state.fixture.config.config.maxRunDrawdownUsd = 1;
    state.strategies[0].config.maxGrossExposureUsd = 3;
    state.strategies[0].config.maxRunDrawdownUsd = 1;
    await goToDesk(page);
    await page.getByRole("link", { name: "Strategy", exact: true }).click();
    await page
      .getByRole("button", { name: /Review/ })
      .first()
      .click();
    const trial = page.getByLabel("Three-cycle strategy trial");
    assert(
      await trial
        .getByRole("button", { name: "Paper test run: 3 cycles", exact: true })
        .isEnabled(),
      "Paper test run was blocked by another running bundle",
    );
    await trial
      .getByRole("button", { name: "Paper test run: 3 cycles", exact: true })
      .click();
    await page
      .getByText(/Paper test run completed: 3 dry-run cycles/, { exact: false })
      .waitFor();
    assert(state.paperTrialRequests === 1, "Paper test request was not sent");
    await trial.scrollIntoViewIfNeeded();
    await capture(page, "rfc-0003-paper-trial-desktop.png");
  } finally {
    await context.close();
  }
}

async function paperSimulationBlockerStaysVisible(browser) {
  const { context, page, state } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  try {
    const message =
      "Paper can't simulate: the trading key for account 1745 has no SUI for gas. Send 0.1 SUI to 0xagent; Maker will keep reading the market.";
    const core = state.fixture.status.bundles.find(
      (entry) => entry.bundle.id === "core-fixture",
    );
    core.snapshot = structuredClone(core.snapshot);
    core.snapshot.lastError = message;
    state.fixture.events.events.unshift({
      id: 884,
      occurredAt: "2026-10-30T02:00:00.000Z",
      category: "paper",
      action: "simulation",
      outcome: "blocked",
      detail: { message, accountId: "1745" },
    });

    await goToDesk(page);
    const lane = page.locator(".bundle-desk-lane").filter({ hasText: "Core" });
    await lane.getByText(message, { exact: true }).waitFor();
    await lane.getByText("Watching · Paper", { exact: true }).waitFor();
    await page
      .locator(".desk-log-card")
      .getByText(/paper can't simulate/i)
      .waitFor();
    await capture(page, "paper-cycle-blocker-desktop.png");
  } finally {
    await context.close();
  }
}

async function v7BundleDeskAndStrategy(browser) {
  const { context, page, state } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  try {
    const rewardsBundle = state.fixture.bundles.bundles.find(
      (bundle) => bundle.name === "Rewards",
    );
    const rewardsStatus = state.fixture.status.bundles.find(
      (entry) => entry.bundle.name === "Rewards",
    );
    const eth = state.fixture.markets.markets.find(
      (market) => market.symbol === "ETH",
    );
    assert(rewardsBundle && rewardsStatus && eth, "Missing rewards fixture");
    rewardsBundle.status = "paused";
    rewardsStatus.bundle.status = "paused";
    rewardsStatus.snapshot = {
      ...structuredClone(rewardsStatus.snapshot),
      market: {
        ...structuredClone(rewardsStatus.snapshot.market),
        id: eth.id,
        symbol: eth.symbol,
        indexPrice: eth.indexPrice,
      },
      markets: structuredClone(rewardsStatus.snapshot.markets).map(
        (market, index) =>
          index === 0
            ? {
                ...market,
                id: eth.id,
                symbol: eth.symbol,
                indexPrice: eth.indexPrice,
              }
            : market,
      ),
    };

    await goToDesk(page);
    await page
      .locator(".bundle-desk-lane")
      .filter({ hasText: "Core" })
      .waitFor();
    await page
      .locator(".bundle-desk-lane")
      .filter({ hasText: "Rewards" })
      .waitFor();
    await page.getByText("Paused", { exact: true }).first().waitFor();
    await page.locator(".maker-wallet-menu > summary").click();
    await page.getByText("Aftermath ✓", { exact: true }).waitFor();
    await page.getByText("1 running of 2", { exact: true }).waitFor();
    await page.getByText("2 authorized", { exact: true }).waitFor();
    await capture(page, "v7-bundle-lanes-and-wallet-desktop.png");

    rewardsBundle.status = "running";
    rewardsStatus.bundle.status = "running";
    await page.getByRole("link", { name: "Markets", exact: true }).click();
    await page.waitForTimeout(120);
    await page
      .locator(".market-active-bundle")
      .filter({ hasText: "Core" })
      .first()
      .waitFor();
    await page
      .locator(".market-active-bundle")
      .filter({ hasText: "Rewards" })
      .first()
      .waitFor();
    await capture(page, "v7-market-bundle-tags-desktop.png");

    await page.getByRole("link", { name: "Venues", exact: true }).click();
    await page
      .getByText(/All venues: equity .* wallet limit .* 5 accounts/, {
        exact: false,
      })
      .waitFor();
    await page.locator(".venue-exposure-table").waitFor();
    await page.locator(".venue-exposure-card").scrollIntoViewIfNeeded();
    await capture(page, "v7-venues-wallet-total-desktop.png");

    await page.getByRole("link", { name: "Strategy", exact: true }).click();
    const strategyView = page.locator(
      '.maker-view[data-view="strategy"]:not([hidden])',
    );
    await strategyView
      .getByRole("button", { name: /Markets/ })
      .first()
      .click();
    const builder = strategyView.locator(".strategy-builder");
    const marketRule = strategyView.locator(".strategy-market-rule");
    await builder.waitFor();
    await marketRule.waitFor();
    const builderBox = await builder.boundingBox();
    const marketRuleBox = await marketRule.boundingBox();
    assert(
      builderBox && marketRuleBox && builderBox.y < marketRuleBox.y,
      "Strategy steps were not placed before the market rule",
    );
    await strategyView.getByLabel("Rule").selectOption("preferred-list");
    await strategyView
      .getByRole("button", { name: /Size and limits/ })
      .first()
      .click();
    await strategyView.locator(".strategy-advanced > summary").click();
    await page
      .getByRole("spinbutton", { name: "Maximum gross exposure in USD" })
      .fill("3.00");
    await page
      .getByRole("spinbutton", { name: "Maximum run drawdown in USD" })
      .fill("1.00");
    await page.getByLabel("Strategy name").fill("Core maker");
    const saveStrategy = page.getByRole("button", {
      name: "Save strategy",
      exact: true,
    });
    assert(
      await saveStrategy.isEnabled(),
      `Strategy save stayed disabled: ${await strategyView.textContent()}`,
    );
    await saveStrategy.click();
    await page.waitForTimeout(300);
    assert(
      state.strategies.some((strategy) => strategy.name === "Core maker"),
      "Strategy rename did not reach the API",
    );
    await strategyView
      .getByRole("button", { name: /Markets/ })
      .first()
      .click();
    await page.getByText("5 markets included", { exact: false }).waitFor();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
    await capture(page, "v7-strategy-builder-desktop.png");
  } finally {
    await context.close();
  }
}

await fs.mkdir(outputDirectory, { recursive: true });
const server = spawnServer ? await startServer() : null;
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox"],
});

try {
  await stopWithInventory(browser);
  await stopAllShowsProgress(browser);
  await savedDeskOnly(browser);
  await cleanStrategyLeavesWithoutPrompt(browser);
  await plainControlLog(browser);
  await strategyLibraryAndBundleAttachment(browser);
  await paperTrialRunsBesideBundles(browser);
  await paperSimulationBlockerStaysVisible(browser);
  await v7BundleDeskAndStrategy(browser);
  await revokeWithoutWallet(browser);
  await serviceAndSessionFailures(browser);
  await createBundleWithFreeChoices(browser);
  await lowerWalletLimitsWhenCreating(browser);
  await editWalletLimits(browser);
  process.stdout.write("customer journey: all stateful audit flows passed\n");
} finally {
  await browser.close();
  if (server) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
  }
}
