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
import { Transaction } from "@mysten/sui/transactions";

import { apiResponse } from "./fixtures/api.mjs";
import { fixtureStates, ownerAddress } from "./fixtures/control.ts";

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
const port = Number(option("--port", process.env.MAKER_AUDIT_PORT ?? "8899"));
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
    updatedAt: bundle.updatedAt,
    usedBy: [{ id: bundle.id, name: bundle.name }],
    archivedAt: null,
  }));
}

function enableReserveUnhedgedStrategy(state) {
  const reserve = state.fixture.accounts.accounts.find(
    (account) => account.accountId === "1749",
  );
  state.fixture.setup.accounts.push({
    ownerAddress,
    accountId: reserve.accountId,
    accountCapId: reserve.accountCapId,
    collateralCoinType: reserve.collateralCoinType,
    addedAt: "2026-10-27T10:00:00Z",
    grantDigest: null,
    agentCapId: `0x${"ab".repeat(32)}`,
  });
  state.strategies.push({
    ...structuredClone(state.strategies[1]),
    id: "unhedged-strategy",
    name: "Unhedged",
    config: {
      ...state.strategies[1].config,
      maxGrossExposureUsd: 3,
      hedge: { ...state.strategies[1].config.hedge, enabled: false },
    },
    usedBy: [],
  });
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
    if (routePath === "api/auth/challenge" && request.method() === "POST")
      return json(200, {
        challengeId: "test-only",
        message: "Sign in to Maker test fixture",
      });
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
    if (
      routePath === "api/accounts/withdraw-transaction" &&
      request.method() === "POST"
    ) {
      const body = JSON.parse(request.postData() ?? "{}");
      const account = state.fixture.accounts.accounts.find(
        (candidate) => candidate.accountId === body.accountId,
      );
      if (!account) return json(404, { error: "Account was not found" });
      const amount = BigInt(Math.round(Number(body.amountUsdc) * 1_000_000));
      const protocolPackageId = `0x${"99".repeat(32)}`;
      const registryObjectId = `0x${"33".repeat(32)}`;
      const accountObjectId = `0x${"88".repeat(32)}`;
      const intent = {
        kind: "withdraw",
        sender: ownerAddress,
        protocolPackageId,
        registryObjectId,
        collateralCoinType: account.collateralCoinType,
        accountCapId: account.accountCapId,
        accountObjectId,
        allowedMarketIds: state.fixture.config.config.markets.map(
          (market) => market.marketId,
        ),
        amount,
        recipient: ownerAddress,
      };
      const transaction = new Transaction();
      transaction.setSender(ownerAddress);
      const withdrawn = transaction.moveCall({
        target: `${protocolPackageId}::account::withdraw_collateral`,
        typeArguments: [account.collateralCoinType],
        arguments: [
          transaction.object(accountObjectId),
          transaction.object(account.accountCapId),
          transaction.object(registryObjectId),
          transaction.pure.u64(amount),
        ],
      });
      transaction.transferObjects(
        [withdrawn],
        transaction.pure.address(ownerAddress),
      );
      state.lastWithdrawIntent = intent;
      return json(200, {
        transaction: await transaction.toJSON(),
        intent: { ...intent, amount: amount.toString() },
      });
    }
    if (routePath === "api/strategies") {
      if (request.method() === "GET") {
        if (state.strategyReadFailures > 0) {
          state.strategyReadFailures -= 1;
          return json(503, { error: "Readback unavailable" });
        }
        return json(200, { strategies: state.strategies });
      }
      if (request.method() === "POST") {
        const failure = state.strategyCreateFailures.shift();
        if (failure)
          return json(failure.status, {
            error: failure.message,
            code: failure.code,
          });
        const body = JSON.parse(request.postData() ?? "{}");
        const strategy = {
          id: `strategy-${state.strategies.length + 1}`,
          name: body.name,
          config: body.config,
          marketRule: body.marketRule,
          markets: body.markets,
          version: 1,
          updatedAt: new Date().toISOString(),
          usedBy: [],
          archivedAt: null,
        };
        state.strategies.unshift(strategy);
        return json(200, { strategy });
      }
    }
    const archiveMatch = routePath.match(/^api\/strategies\/([^/]+)\/archive$/);
    if (archiveMatch && request.method() === "POST") {
      state.strategyArchivePosts += 1;
      if (state.strategyArchiveDelayMs)
        await new Promise((resolve) =>
          setTimeout(resolve, state.strategyArchiveDelayMs),
        );
      const failure = state.strategyArchiveFailures.shift();
      if (failure)
        return json(failure, { error: "Archive temporarily unavailable" });
      const target = state.strategies.find(
        (candidate) =>
          candidate.id === archiveMatch[1] && !candidate.archivedAt,
      );
      if (!target) return json(404, { error: "Strategy was not found" });
      if (target.usedBy.length)
        return json(409, {
          error: "A strategy in use by a bundle cannot be archived",
        });
      target.archivedAt = new Date().toISOString();
      return json(200, { strategy: target });
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
        if (state.strategyPatchDelayMs)
          await new Promise((resolve) =>
            setTimeout(resolve, state.strategyPatchDelayMs),
          );
        const failure = state.strategyPatchFailures.shift();
        if (failure)
          return json(failure, {
            error:
              failure === 409
                ? "Strategy changed elsewhere; refresh before saving"
                : "Apply temporarily unavailable",
          });
        const body = JSON.parse(request.postData() ?? "{}");
        if (body.expectedVersion !== strategy.version)
          return json(409, {
            error: "Strategy changed elsewhere; refresh before saving",
          });
        Object.assign(strategy, {
          name: body.name ?? strategy.name,
          config: body.config,
          marketRule: body.marketRule,
          markets: body.markets,
          version: strategy.version + 1,
          updatedAt: new Date().toISOString(),
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
    if (
      /^api\/bundles\/[^/]+\/config$/.test(routePath) &&
      request.method() === "GET" &&
      state.postCreateReadFailures > 0
    ) {
      state.postCreateReadFailures -= 1;
      return json(503, {
        error: "Bundle configuration is temporarily unavailable",
      });
    }
    if (
      /^api\/bundles\/[^/]+\/(start|resume)$/.test(routePath) &&
      request.method() === "POST" &&
      state.startFailures.length
    ) {
      const failure = state.startFailures.shift();
      const bundleId = routePath.split("/")[2];
      state.fixture.events.events.unshift({
        id: 8891 + state.fixture.events.events.length,
        occurredAt: new Date().toISOString(),
        category: "request",
        action: "bundle-start",
        outcome: failure.status >= 500 ? "error" : "rejected",
        detail: {
          status: failure.status,
          ...(failure.code ? { code: failure.code } : {}),
          message:
            failure.status >= 500 ? "Internal server error" : failure.error,
          reference: failure.requestId ?? "req-audit",
          bundleId,
        },
        bundleId: null,
      });
      return json(failure.status, failure);
    }
    if (routePath === "api/bundles" && request.method() === "POST") {
      state.bundlePosts += 1;
      if (state.delayBundleCreate)
        await new Promise((resolve) => setTimeout(resolve, 250));
      const failure = state.bundleCreateFailures.shift();
      if (failure) return json(failure.status, { error: failure.message });
      const body = JSON.parse(request.postData() ?? "{}");
      const selectedStrategy = body.strategyId
        ? state.strategies.find((strategy) => strategy.id === body.strategyId)
        : null;
      if (selectedStrategy?.config.hedge.enabled && !body.takerAccountId)
        return json(400, {
          error:
            "This strategy requires a distinct authorized hedge account before bundle creation",
        });
      const createdAt = "2026-10-27T17:08:32.000Z";
      const next = {
        id: `audit-bundle-${state.bundlePosts}`,
        name: body.name,
        strategyId: selectedStrategy?.id ?? null,
        strategyName: selectedStrategy?.name ?? null,
        strategyVersionApplied: selectedStrategy?.version ?? null,
        needsStrategy: !selectedStrategy,
        makerAccountId: body.makerAccountId ?? body.config?.makerAccountId,
        takerAccountId:
          body.takerAccountId ?? body.config?.hedge?.accountId ?? null,
        mode: "paper",
        status: selectedStrategy ? "stopped" : "paused",
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

async function newPage(
  browser,
  viewport,
  { colorScheme = "light", deviceScaleFactor = 1 } = {},
) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor,
    colorScheme,
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
    bundlePosts: 0,
    bundleCreateFailures: [],
    postCreateReadFailures: 0,
    delayBundleCreate: false,
    strategyPatchFailures: [],
    strategyCreateFailures: [],
    strategyPatchDelayMs: 0,
    strategyArchiveFailures: [],
    strategyArchivePosts: 0,
    strategyArchiveDelayMs: 0,
    strategyReadFailures: 0,
    startFailures: [],
  };
  await page.addInitScript((address) => {
    window.__makerMockWallet = {
      addresses: [address],
      signPersonalMessage: "resolve",
    };
  }, ownerAddress);
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

async function goToStrategyStep(page, target) {
  if (await page.locator(".strategy-summary:visible").count())
    await page
      .locator(".strategy-summary:visible")
      .getByRole("button", { name: "Edit strategy", exact: true })
      .click();
  const form = page.locator(".settings-panel:visible");
  for (let count = 0; count < 5; count += 1) {
    const step = Number(await form.getAttribute("data-strategy-step"));
    if (step >= target) return;
    await form.getByRole("button", { name: /Save and continue to/ }).click();
    await page.waitForFunction(
      (next) =>
        Number(
          document
            .querySelector(".settings-panel")
            ?.getAttribute("data-strategy-step"),
        ) === next,
      step + 1,
    );
  }
  throw new Error(`Could not reach strategy step ${target}`);
}

async function nonCoreOnlyReport(browser) {
  const { context, page, state } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  try {
    state.fixture.status.bundles[1].snapshot = structuredClone(
      state.fixture.status.bundles[1].snapshot,
    );
    state.fixture.bundles.bundles[0].status = "stopped";
    state.fixture.status.snapshot.running = false;
    state.fixture.status.bundles[0].bundle.status = "stopped";
    state.fixture.status.bundles[0].snapshot.running = false;
    const rewards = state.fixture.status.bundles[1].snapshot;
    rewards.running = true;
    rewards.market.id = state.fixture.bundles.bundles[1].marketIds[0];
    rewards.market.symbol = "ETH";
    rewards.lastCycleAt = new Date().toISOString();
    rewards.market.updatedAt = rewards.lastCycleAt;
    rewards.markets.find(
      (market) => market.id === rewards.market.id,
    ).updatedAt = rewards.lastCycleAt;
    await goToDesk(page);
    await page
      .locator(".desk-narration")
      .getByText(/Rewards is reading markets in Paper/)
      .waitFor();
    await page
      .locator(".desk-facts")
      .getByText(/Maker equity · Rewards/)
      .waitFor();
    await page.getByRole("link", { name: "Markets", exact: true }).click();
    const marketsView = page.locator(
      '.maker-view[data-view="markets"]:not([hidden])',
    );
    await marketsView.waitFor();
    const ethRow = marketsView
      .locator(".market-clean-table tbody tr")
      .filter({ hasText: "ETH" })
      .first();
    await ethRow.getByText("Quoting", { exact: true }).waitFor();
    await capture(page, "r8-noncore-market-activity-desktop.png");
    await marketsView.getByRole("button", { name: "Edit ETH policy" }).click();
    await page.getByRole("dialog", { name: "ETH policy" }).waitFor();
    assert(
      (await page
        .locator('.maker-view[data-view="markets"]:not([hidden])')
        .count()) === 1,
      "Market policy editor navigated away from Markets",
    );
  } finally {
    await context.close();
  }
}

async function runControlMobile(browser) {
  const { context, page } = await newPage(browser, { width: 390, height: 844 });
  try {
    await goToDesk(page);
    await page.getByRole("button", { name: /Run status:/ }).click();
    const panel = page.getByRole("region", { name: "Run status" });
    await panel.waitFor();
    assert(
      (await panel.getByRole("button", { name: /Pause Core/ }).count()) > 0,
      "Run control panel did not name the active bundle",
    );
    assert(
      (await panel
        .getByRole("button", { name: "Stop all", exact: true })
        .count()) > 0,
      "Emergency Stop all is missing on the phone",
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 2,
    );
    assert(!overflow, "Run status overflows the 390px viewport");
    await capture(page, "r5-run-controls-phone.png");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("link", { name: "Strategy", exact: true }).click();
    assert(
      !(await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 2,
      )),
      "Strategy and Stop all controls overflow 390px",
    );
    await capture(page, "r5-strategy-phone.png");
  } finally {
    await context.close();
  }
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
        hasText:
          "Stopped in this view; confirm orders are cancelled on the venue. You still hold $1.04 of MON.",
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
    await page.getByText("Stopping…", { exact: true }).waitFor();
    await page
      .locator(".maker-nav-right")
      .getByRole("button", { name: "Stop all", exact: true })
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
    await goToStrategyStep(page, 2);
    await page
      .getByRole("textbox", { name: "Gross exposure (USD)" })
      .fill("1.50");
    await page
      .getByText("Save and continue to Hedging", { exact: true })
      .waitFor();
    assert(
      (await page
        .locator('.maker-view[data-view="desk"] .desk-risk-card')
        .getByText("$0.01 of $0.90", { exact: true })
        .count()) > 0,
      "Hidden Desk read the unsaved strategy draft",
    );
    await page.getByRole("link", { name: "Desk", exact: true }).click();
    assert(
      (await page
        .getByRole("dialog", { name: "Save strategy changes?" })
        .count()) === 0,
      "Leaving a strategy should keep a local draft without a competing save popup",
    );
    await page
      .locator(".desk-risk-card")
      .getByText("$0.01 of $0.90", { exact: true })
      .first()
      .waitFor();
    await capture(page, "v5-audit-saved-desk-desktop.png");
    await page.reload();
    await page.getByRole("link", { name: "Strategy", exact: true }).click();
    await goToStrategyStep(page, 2);
    assert(
      (await page
        .getByRole("textbox", { name: "Gross exposure (USD)" })
        .inputValue()) === "1.5",
      "Wallet-scoped draft did not survive reload",
    );
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

async function withdrawsToOwnerWallet(browser) {
  const { context, page, state } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  try {
    state.fixture.status.snapshot.running = false;
    state.fixture.status.bundles = state.fixture.status.bundles.map(
      (entry) => ({
        ...entry,
        bundle: { ...entry.bundle, status: "stopped" },
      }),
    );
    await goToDesk(page);
    await page.evaluate(() => {
      window.location.hash = "accounts";
    });
    await page
      .locator('.maker-view[data-view="accounts"]:not([hidden])')
      .waitFor();
    const withdraw = page
      .getByRole("button", { name: "Withdraw", exact: true })
      .first();
    await withdraw.waitFor();
    await withdraw.click();
    await page
      .getByText("Connect your owner wallet to withdraw", { exact: true })
      .waitFor();
    await page
      .locator("mysten-dapp-kit-connect-modal")
      .getByText("Mock Sui Wallet", { exact: true })
      .filter({ visible: true })
      .click();
    await page.waitForTimeout(100);
    assert(
      await withdraw.isEnabled(),
      "Withdraw did not become ready after the owner wallet connected",
    );
    await withdraw.click();
    const withdrawalNotice = page.getByText(
      "10 USDC withdrawn from account 1745.",
      { exact: true },
    );
    await page.waitForTimeout(1_500);
    assert(
      (await withdrawalNotice.count()) > 0,
      `Withdraw did not complete: ${JSON.stringify(await page.locator(".notice").allTextContents())}`,
    );
    assert(
      state.lastWithdrawIntent?.recipient === ownerAddress &&
        state.lastWithdrawIntent?.sender === ownerAddress,
      "Withdraw did not build an owner-wallet-only transaction",
    );
    await page
      .getByRole("link", { name: "View trading-key permission", exact: true })
      .first()
      .waitFor();
    await capture(page, "v8-withdraw-owner-wallet-desktop.png");
    await page.locator(".account-security").scrollIntoViewIfNeeded();
    await capture(page, "v8-account-security-desktop.png");
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
    await desktop.page
      .getByText("Stopped in this view", { exact: false })
      .waitFor();
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
  const { context, page, state } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  try {
    enableReserveUnhedgedStrategy(state);
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
      .getByLabel("Strategy", { exact: true })
      .selectOption({ label: "Unhedged" });
    await capture(page, "rfc-0002-new-bundle-desktop.png");
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await page
      .getByRole("heading", { name: "Audit reserve", exact: true })
      .waitFor();
    const start = page
      .getByRole("button", {
        name: "Audit reserve: Stopped. Open run status",
      })
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
    enableReserveUnhedgedStrategy(state);
    await goToDesk(page);
    await page.getByRole("link", { name: "Bundles", exact: true }).click();
    await page.getByRole("button", { name: "New bundle", exact: true }).click();
    const create = page.getByRole("dialog", { name: "New Paper bundle" });
    await create.getByLabel("Name").fill("Limits audit");
    await create.getByLabel("Maker account").selectOption({ label: "Reserve" });
    await create
      .getByLabel("Strategy", { exact: true })
      .selectOption({ label: "Unhedged" });
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
    const walletGross = confirmation.getByLabel("Gross exposure");
    await walletGross.fill("");
    assert(
      (await walletGross.getAttribute("aria-invalid")) === "true",
      "Blank wallet limit did not show a field error",
    );
    assert(
      !(await confirmation
        .getByRole("button", { name: "Confirm limits and create", exact: true })
        .isEnabled()),
      "Blank wallet limit could be saved",
    );
    await walletGross.fill("15.00");
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
    state.fixture.config.config.maxGrossExposureUsd = 3;
    state.strategies.forEach((strategy) => {
      strategy.config.maxGrossExposureUsd = 3;
    });

    await goToDesk(page);
    await page.getByRole("link", { name: "Strategy", exact: true }).click();
    const deleteAttached = page
      .locator(".strategy-summary")
      .getByRole("button", { name: "Delete strategy" });
    assert(
      !(await deleteAttached.isEnabled()),
      "Attached strategy Delete was enabled",
    );
    await page
      .getByText("Detach it from its bundles before deleting.")
      .waitFor();
    await page
      .getByRole("button", { name: "New strategy", exact: true })
      .click();
    await page
      .getByText(
        "Strategy created. Nothing changes for your bundles until you attach it.",
        {
          exact: true,
        },
      )
      .waitFor();

    await page.getByRole("link", { name: "Bundles", exact: true }).click();
    const card = page.locator(".bundle-card").filter({
      hasText: "Strategy audit",
    });
    await card.waitFor();
    const createdName = state.strategies[0].name;
    await card.getByRole("combobox").selectOption({ label: createdName });
    await page
      .getByText("Strategy attached. The bundle can now be started.", {
        exact: true,
      })
      .waitFor();
    await card.getByText(`From ${createdName}:`, { exact: false }).waitFor();
    await card
      .getByRole("button", {
        name: "Strategy audit: Stopped. Open run status",
      })
      .waitFor();
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
    await goToStrategyStep(page, 4);
    const trial = page.getByLabel("Three-cycle strategy trial");
    assert(
      await trial
        .getByRole("button", { name: "Paper test run: 3 cycles", exact: true })
        .isEnabled(),
      `Paper test run was blocked: ${await trial.textContent()}; notices: ${await page.locator(".notice").allTextContents()}`,
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

async function staleStrategyDraftCannotApply(browser) {
  const { context, page, state } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  try {
    state.fixture.config.config.maxGrossExposureUsd = 3;
    state.strategies[0].config.maxGrossExposureUsd = 3;
    await goToDesk(page);
    await page.getByRole("link", { name: "Strategy", exact: true }).click();
    await goToStrategyStep(page, 4);
    state.strategies[0].version += 1;
    const draftName = page.getByLabel("Strategy name", { exact: true });
    await draftName.fill("Unapplied stale draft");
    await page.getByRole("button", { name: "Save and finish" }).click();
    await page
      .getByText(/Strategy changed elsewhere\. Your draft is preserved/, {
        exact: false,
      })
      .waitFor();
    assert(
      (await draftName.inputValue()) === "Unapplied stale draft",
      "A version conflict lost the user's draft",
    );
    assert(
      state.strategies[0].name !== "Unapplied stale draft",
      "Stale draft incorrectly changed the active strategy",
    );
    const rebase = page.getByRole("button", {
      name: "Rebase draft after review",
    });
    await rebase.waitFor();
    await rebase.click();
    await page.getByRole("button", { name: "Save and finish" }).click();
    await page.getByText("Strategy saved.", { exact: true }).waitFor();
    assert(
      state.strategies[0].name === "Unapplied stale draft",
      "Reviewed rebase did not apply the preserved draft",
    );
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
    await lane
      .getByRole("button", {
        name: "Core: Needs attention. Open run status",
      })
      .waitFor();
    await page
      .locator(".desk-log-card")
      .getByText(/paper can't simulate/i)
      .waitFor();
    await capture(page, "paper-cycle-blocker-desktop.png");
  } finally {
    await context.close();
  }
}

async function round6MobilePicker(browser) {
  const { context, page, state } = await newPage(
    browser,
    { width: 390, height: 844 },
    { colorScheme: "dark" },
  );
  try {
    state.fixture.config.config.maxGrossExposureUsd = 3;
    state.strategies[0].config.maxGrossExposureUsd = 3;
    for (let index = 0; index < 10; index += 1) {
      state.strategies.push({
        ...structuredClone(state.strategies[0]),
        id: `strategy-long-${index}`,
        name: `Long reusable strategy number ${index} for many markets`,
        usedBy: [],
      });
    }
    await goToDesk(page);
    await page.getByRole("link", { name: "Strategy", exact: true }).click();
    await goToStrategyStep(page, 0);
    const strategy = page.locator(
      '.maker-view[data-view="strategy"]:not([hidden])',
    );
    assert(
      await strategy.getByLabel("Strategy name", { exact: true }).isVisible(),
      "Strategy name editor is hidden",
    );
    const picker = strategy
      .getByLabel("Choose strategy")
      .filter({ visible: true });
    await picker.click();
    const options = strategy
      .getByRole("listbox", { name: "Strategies" })
      .filter({ visible: true })
      .getByRole("option");
    assert(
      (await options.count()) === 12,
      "The rich picker lost one of many strategies",
    );
    await page.waitForTimeout(100);
    await capture(page, "r6-picker-options-phone-dark.png");
    await picker.press("ArrowDown");
    await page.keyboard.press("End");
    await page.keyboard.press("Escape");
    assert(
      await picker.evaluate((element) => document.activeElement === element),
      "Escape did not return focus on mobile",
    );
    await picker.click();
    await options.last().click();
    await page.waitForFunction(() =>
      (
        document.querySelector('input[aria-label="Strategy name"]')?.value ?? ""
      ).includes("Long reusable strategy number 9"),
    );
    assert(
      !(await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 2,
      )),
      "Rich picker or New strategy overflowed 390px",
    );
    await capture(page, "r6-picker-phone-dark.png");
  } finally {
    await context.close();
  }
}

async function round6PickerAndRename(browser) {
  const { context, page, state } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  try {
    state.fixture.config.config.maxGrossExposureUsd = 3;
    state.strategies[0].config.maxGrossExposureUsd = 3;
    await goToDesk(page);
    await page.getByRole("link", { name: "Strategy", exact: true }).click();
    const strategy = page.locator(
      '.maker-view[data-view="strategy"]:not([hidden])',
    );
    assert(
      (await strategy.locator(".strategy-library").count()) === 0,
      "Duplicate strategy cards remain",
    );
    await goToStrategyStep(page, 0);
    assert(
      await strategy.getByLabel("Strategy name", { exact: true }).isVisible(),
      "Strategy name editor is hidden",
    );
    const picker = strategy
      .getByLabel("Choose strategy")
      .filter({ visible: true });
    await picker.click();
    const options = strategy
      .getByRole("listbox", { name: "Strategies" })
      .filter({ visible: true })
      .getByRole("option");
    assert((await options.count()) === 2, "Rich picker lost strategy options");
    await page.waitForTimeout(100);
    await capture(page, "r6-picker-options-desktop-light.png");
    await picker.press("ArrowDown");
    await page.keyboard.press("Escape");
    assert(
      await picker.evaluate((element) => document.activeElement === element),
      "Escape did not return focus to the picker",
    );
    await strategy
      .getByLabel("Strategy name", { exact: true })
      .fill("Rewards strategy");
    await strategy
      .getByRole("button", { name: /Save and continue to/ })
      .click();
    assert(
      (await strategy
        .locator(".settings-panel")
        .getAttribute("data-strategy-step")) === "0",
      "Duplicate name advanced",
    );
    assert(
      (await strategy
        .getByLabel("Strategy name", { exact: true })
        .getAttribute("aria-invalid")) === "true",
      "Duplicate name lacked inline error",
    );
    await strategy
      .getByLabel("Strategy name", { exact: true })
      .fill("Applied B");
    assert(
      (await strategy.locator("#strategy-name-error").count()) === 0,
      "Corrected name error persisted",
    );
    await strategy
      .getByRole("button", { name: /Save and continue to/ })
      .click();
    await page.getByRole("link", { name: "Bundles", exact: true }).click();
    await page
      .locator(".bundle-card")
      .filter({ hasText: "Core" })
      .getByText(/^From Core strategy:/)
      .waitFor();
    await page.getByRole("link", { name: "Strategy", exact: true }).click();
    assert(
      (await strategy
        .getByLabel("Strategy name", { exact: true })
        .inputValue()) === "Applied B",
      "Draft name was not restored",
    );
    assert(
      (await strategy.locator(".strategy-name-status").count()) === 0,
      "Obsolete draft-status wording remained in edit mode",
    );
    await goToStrategyStep(page, 4);
    await strategy.getByRole("button", { name: "Save and finish" }).click();
    await page.getByText("Strategy saved.", { exact: true }).waitFor();
    assert(
      state.strategies[0].name === "Applied B",
      "Apply did not persist the rename",
    );
    await strategy
      .locator(".strategy-summary h1")
      .getByText("Applied B")
      .waitFor();
    await page.getByRole("link", { name: "Bundles", exact: true }).click();
    await page
      .locator(".bundle-card")
      .filter({ hasText: "Core" })
      .getByText(/^From Applied B:/)
      .waitFor();
    await page.reload();
    await page
      .locator(".bundle-card")
      .filter({ hasText: "Core" })
      .getByText(/^From Applied B:/)
      .waitFor();
    await capture(page, "r6-applied-name-desktop.png");
  } finally {
    await context.close();
  }
}

async function round6UniformMarketCards(browser) {
  const sizes = [
    { name: "phone", width: 390, height: 844, scale: 1 },
    { name: "tablet", width: 768, height: 900, scale: 1 },
    { name: "desktop", width: 1440, height: 900, scale: 1 },
    { name: "zoom200", width: 195, height: 422, scale: 2 },
  ];
  for (const size of sizes) {
    for (const colorScheme of ["light", "dark"]) {
      const { context, page, state } = await newPage(
        browser,
        { width: size.width, height: size.height },
        { colorScheme, deviceScaleFactor: size.scale },
      );
      try {
        state.fixture.config.config.maxGrossExposureUsd = 3;
        state.strategies[0].config.maxGrossExposureUsd = 3;
        state.fixture.markets.markets[0].symbol = "LONGMARKETSYMBOL2026";
        const opportunities =
          state.fixture.rewards.rewards.marketModel.opportunities;
        opportunities[0].reasons = [
          "A long market observation that explains liquidity and venue activity without truncating the evidence when expanded. ".repeat(
            3,
          ),
        ];
        opportunities[1].preRiskEdgeBps = null;
        opportunities[1].volume24hUsd = null;
        await goToDesk(page);
        await page.getByRole("link", { name: "Strategy", exact: true }).click();
        const strategy = page.locator(
          '.maker-view[data-view="strategy"]:not([hidden])',
        );
        if (size.name !== "tablet") {
          await strategy
            .locator(
              ".strategy-summary-header:visible, .strategy-select-row:visible",
            )
            .first()
            .scrollIntoViewIfNeeded();
          await capture(page, `r7-header-${size.name}-${colorScheme}.png`);
          if (size.name === "zoom200") {
            await goToStrategyStep(page, 0);
            await strategy
              .locator(".strategy-name-edit")
              .evaluate((element) =>
                element.scrollIntoView({ block: "center" }),
              );
            await capture(page, `r7-name-zoom200-${colorScheme}.png`);
          }
        }
        await goToStrategyStep(page, 1);
        if (size.name === "phone" || size.name === "zoom200") {
          await strategy
            .locator(".strategy-rotation-stage")
            .evaluate((element) => element.scrollIntoView({ block: "center" }));
          await capture(page, `r7-suggestions-${size.name}-${colorScheme}.png`);
        }
        const heights = await strategy
          .locator(".strategy-market-row")
          .evaluateAll((rows) =>
            rows.map((row) => row.getBoundingClientRect().height),
          );
        assert(
          heights.length >= 3 &&
            Math.max(...heights) - Math.min(...heights) < 1,
          `Unequal collapsed market card heights at ${size.name}/${colorScheme}: ${heights}`,
        );
        const overflow = await page.evaluate(() => ({
          body: document.documentElement.scrollWidth,
          viewport: window.innerWidth,
          elements: [...document.querySelectorAll("body *")]
            .filter(
              (element) =>
                element.getBoundingClientRect().right > window.innerWidth + 3,
            )
            .slice(0, 8)
            .map((element) => ({
              tag: element.tagName,
              className: String(element.className).slice(0, 80),
              right: Math.round(element.getBoundingClientRect().right),
              text: element.textContent?.trim().slice(0, 24),
              parent: String(element.parentElement?.className ?? "").slice(
                0,
                40,
              ),
            })),
        }));
        const clippedCards = await strategy
          .locator(".strategy-market-row")
          .evaluateAll((rows) =>
            rows.some(
              (row) =>
                row.getBoundingClientRect().right > window.innerWidth + 2,
            ),
          );
        assert(
          overflow.body <= overflow.viewport + 2 && !clippedCards,
          `Market picker overflow or clipped cards at ${size.name}/${colorScheme}: ${JSON.stringify(overflow)}`,
        );
        const explanation = strategy.getByText(
          /Why LONGMARKETSYMBOL2026 ranks here/,
        );
        await explanation.click();
        assert(
          (
            await strategy
              .locator(".strategy-market-reasons[open] p")
              .first()
              .textContent()
          )?.length > 100,
          "Long evidence reasons were truncated instead of expanded",
        );
        if (size.name !== "tablet") {
          await strategy
            .locator(".strategy-market-key")
            .evaluate((element) => element.scrollIntoView({ block: "center" }));
          await capture(page, `r7-market-key-${size.name}-${colorScheme}.png`);
        }
        if (size.name !== "zoom200")
          await capture(
            page,
            `r6-market-cards-${size.name}-${colorScheme}.png`,
          );
      } finally {
        await context.close();
      }
    }
  }
}

async function round6ContextLinksAndHelp(browser) {
  const { context, page, state } = await newPage(browser, {
    width: 390,
    height: 844,
  });
  try {
    state.fixture.config.config.maxGrossExposureUsd = 3;
    state.strategies[0].config.maxGrossExposureUsd = 3;
    await goToDesk(page);
    await page.getByRole("link", { name: "Strategy", exact: true }).click();
    await goToStrategyStep(page, 2);
    const strategy = page.locator(
      '.maker-view[data-view="strategy"]:not([hidden])',
    );
    const drawdownSentence = strategy
      .locator(".strategy-limit-sentences p")
      .filter({ hasText: "Stop everything if equity falls" });
    const help = drawdownSentence.locator(".glossary-term").last();
    assert(
      (await help.getAttribute("aria-label")) === "Explain run drawdown",
      "Help control lacks a field-specific accessible name",
    );
    assert(
      await drawdownSentence.evaluate((sentence) =>
        sentence.lastElementChild?.classList.contains("glossary-term"),
      ),
      "Help appears before the end of the full sentence",
    );
    await help.focus();
    await capture(page, "r6-size-help-phone.png");
    await strategy
      .getByRole("textbox", { name: "Quote size (USD)" })
      .fill("1.25");
    await strategy.getByRole("button", { name: "Edit wallet limits" }).click();
    const wallet = page.getByRole("dialog", { name: "Edit wallet limits" });
    await wallet.waitFor();
    await wallet.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Back to Strategy" }).click();
    assert(
      (await strategy
        .getByRole("textbox", { name: "Quote size (USD)" })
        .inputValue()) === "1.25",
      "Wallet editor navigation lost the local strategy draft",
    );
    await strategy
      .getByRole("button", { name: "View Maker account 1745" })
      .click();
    await page.locator('[id="account-1745"]').waitFor();
    await page.getByRole("button", { name: "Back to Strategy" }).click();
    await strategy.getByRole("button", { name: "Edit Core bundle" }).click();
    const bundle = page.getByRole("dialog", { name: "Edit Core" });
    await bundle
      .getByText(/Accounts change only while Core is paused\./)
      .waitFor();
    await bundle.getByRole("button", { name: "Pause in run status" }).waitFor();
    assert(
      !(await bundle
        .getByRole("button", { name: "Save allocation" })
        .isEnabled()),
      "Running Core allocation could be changed through a contextual link",
    );
    await bundle.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Back to Strategy" }).click();
    assert(
      (await strategy
        .locator(".settings-panel")
        .getAttribute("data-strategy-step")) === "2",
      "Bundle editor return lost Size and limits",
    );
  } finally {
    await context.close();
  }
}

async function round6AttachmentDestinations(browser) {
  {
    const { context, page, state } = await newPage(browser, {
      width: 1440,
      height: 900,
    });
    try {
      state.fixture.config.config.maxGrossExposureUsd = 3;
      state.strategies[0].config.maxGrossExposureUsd = 3;
      state.fixture.bundles.bundles.forEach((bundle) => {
        bundle.archivedAt = new Date().toISOString();
        bundle.status = "stopped";
      });
      state.strategies.forEach((strategy) => {
        strategy.usedBy = [];
      });
      await goToDesk(page);
      await page.getByRole("link", { name: "Strategy", exact: true }).click();
      await goToStrategyStep(page, 4);
      await page
        .getByRole("button", { name: "Create bundle", exact: true })
        .click();
      await page.getByRole("dialog", { name: "New Paper bundle" }).waitFor();
    } finally {
      await context.close();
    }
  }
  {
    const { context, page, state } = await newPage(browser, {
      width: 1440,
      height: 900,
    });
    try {
      state.fixture.config.config.maxGrossExposureUsd = 3;
      state.strategies.forEach((strategy) => {
        strategy.config.maxGrossExposureUsd = 3;
      });
      const detached = state.fixture.bundles.bundles.find(
        (bundle) => bundle.name === "Rewards",
      );
      detached.strategyId = null;
      detached.strategyName = null;
      detached.needsStrategy = true;
      detached.status = "paused";
      state.strategies[1].usedBy = [];
      await goToDesk(page);
      await page.getByRole("link", { name: "Strategy", exact: true }).click();
      const strategyView = page.locator(
        '.maker-view[data-view="strategy"]:not([hidden])',
      );
      await strategyView
        .getByLabel("Choose strategy")
        .filter({ visible: true })
        .click();
      await strategyView
        .getByRole("option", { name: /Rewards strategy;/ })
        .click();
      await goToStrategyStep(page, 4);
      await page.getByRole("button", { name: "Attach to Rewards" }).click();
      const edit = page.getByRole("dialog", { name: "Edit Rewards" });
      await edit.waitFor();
      assert(
        (await edit.locator("select").last().inputValue()) ===
          state.strategies[1].id,
        "Attach action did not open the exact bundle with the selected applied strategy",
      );
      assert(
        detached.strategyId === null,
        "Navigating into attachment silently changed the bundle",
      );
      await edit.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("button", { name: "Back to Strategy" }).click();
      assert(
        (await strategyView
          .locator(".settings-panel")
          .getAttribute("data-strategy-step")) === "4",
        "Cancel lost the Review step",
      );
    } finally {
      await context.close();
    }
  }
  {
    const { context, page, state } = await newPage(browser, {
      width: 390,
      height: 844,
    });
    try {
      state.fixture.config.config.maxGrossExposureUsd = 3;
      state.strategies[0].config.maxGrossExposureUsd = 3;
      state.fixture.bundles.bundles = [];
      state.fixture.status.bundles = [];
      state.fixture.bundles.walletLimits = null;
      state.strategies.forEach((strategy) => {
        strategy.usedBy = [];
      });
      await goToDesk(page);
      await page.getByRole("link", { name: "Strategy", exact: true }).click();
      await goToStrategyStep(page, 4);
      await page
        .getByRole("button", { name: "Create bundle", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "New Paper bundle" });
      await dialog
        .getByText(/Finish Core setup and configure wallet limits/)
        .waitFor();
      assert(
        !(await dialog.getByRole("button", { name: "Continue" }).isEnabled()),
        "Missing wallet limits permitted a create",
      );
      await dialog.getByRole("button", { name: "Open Accounts setup" }).click();
      await page
        .locator('.maker-view[data-view="accounts"]:not([hidden])')
        .waitFor();
      await page.getByRole("button", { name: "Back to Strategy" }).click();
      assert(
        (await page
          .locator(".settings-panel")
          .getAttribute("data-strategy-step")) === "4",
        "Setup navigation lost the strategy step",
      );
    } finally {
      await context.close();
    }
  }
}

async function round6ReviewCreatesBundle(browser) {
  const { context, page, state } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  try {
    state.fixture.bundles.bundles = [];
    state.fixture.status.bundles = [];
    state.fixture.status.snapshot.running = false;
    state.strategies.forEach((strategy) => {
      strategy.usedBy = [];
    });
    state.fixture.config.config.maxGrossExposureUsd = 3;
    state.strategies[0].config.maxGrossExposureUsd = 3;
    await goToDesk(page);
    await page.getByRole("link", { name: "Strategy", exact: true }).click();
    await goToStrategyStep(page, 4);
    await page
      .getByRole("button", { name: "Create bundle", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "New Paper bundle" });
    await dialog.waitFor();
    assert(
      (await dialog.getByLabel("Strategy", { exact: true }).inputValue()) ===
        state.strategies[0].id,
      "Review did not preselect its applied strategy",
    );
    await dialog.getByLabel("Name").fill("Duplicate");
    await dialog.getByLabel("Maker account").selectOption("1745");
    assert(
      !(await dialog.getByRole("button", { name: "Continue" }).isEnabled()),
      "Paired strategy allowed creation without a hedge account",
    );
    await dialog
      .getByText(/Choose a distinct authorized Taker account/)
      .waitFor();
    await dialog
      .getByLabel("Taker account (required for this strategy)")
      .selectOption("1746");
    state.bundleCreateFailures.push({
      status: 409,
      message: "A bundle already uses that name",
    });
    await dialog.getByRole("button", { name: "Continue" }).click();
    await dialog
      .getByRole("alert")
      .getByText("A bundle already uses that name")
      .waitFor();
    assert(
      (await dialog.getByLabel("Name").inputValue()) === "Duplicate",
      "Failed create discarded the form",
    );
    await dialog.getByLabel("Name").fill("Fresh Paper");
    assert(
      (await dialog.getByRole("alert").count()) === 0,
      "Corrected creation error did not clear",
    );
    state.postCreateReadFailures = 2;
    state.delayBundleCreate = true;
    await dialog
      .getByRole("button", { name: "Continue" })
      .evaluate((button) => {
        button.click();
        button.click();
      });
    await page
      .getByText(
        /Paper bundle Fresh Paper was created, but its latest configuration could not be reloaded/,
      )
      .waitFor();
    assert(
      state.bundlePosts === 2,
      `Rapid clicks created multiple bundles: ${state.bundlePosts} POSTs`,
    );
    const created = state.fixture.bundles.bundles.filter(
      (bundle) => bundle.name === "Fresh Paper",
    );
    assert(
      created.length === 1 &&
        created[0].mode === "paper" &&
        created[0].status === "stopped" &&
        created[0].strategyId === state.strategies[0].id,
      "Review creation did not yield exactly one attached, non-running Paper bundle",
    );
    assert(
      (await page.getByRole("dialog", { name: "New Paper bundle" }).count()) ===
        0,
      "Confirmed creation did not close its sheet",
    );
    await page.getByRole("button", { name: "Back to Strategy" }).click();
    assert(
      (await page
        .locator(
          '.maker-view[data-view="strategy"]:not([hidden]) .settings-panel',
        )
        .getAttribute("data-strategy-step")) === "4",
      "Returning from bundle creation lost the Review step",
    );
    await capture(page, "r6-review-created-bundle-desktop.png");
  } finally {
    await context.close();
  }
}

async function round6SuggestionRefresh(browser) {
  const { context, page, state } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  try {
    state.fixture.config.config.maxGrossExposureUsd = 3;
    state.strategies[0].config.maxGrossExposureUsd = 3;
    const originalCandidates = structuredClone(
      state.fixture.rewards.rewards.marketModel.opportunities,
    );
    const mon = state.fixture.markets.markets.find(
      (market) => market.symbol === "MON",
    );
    await goToDesk(page);
    await page.getByRole("link", { name: "Strategy", exact: true }).click();
    await goToStrategyStep(page, 1);
    const strategy = page.locator(
      '.maker-view[data-view="strategy"]:not([hidden])',
    );
    await strategy
      .getByRole("button", { name: "Balanced", exact: true })
      .click();
    await strategy.locator(".strategy-rotation-stage").scrollIntoViewIfNeeded();
    await capture(page, "r7-suggestions-desktop-light.png");
    await strategy.getByRole("button", { name: "Preview selection" }).click();
    await strategy.getByText(/Proposed 5 markets/).waitFor();
    await strategy.getByRole("button", { name: "Use these markets" }).click();
    await strategy.getByText(/Accepted draft selection \(5\/64\)/).waitFor();
    state.fixture.rewards.rewards.marketModel.opportunities =
      originalCandidates.slice(0, 2);
    await page.waitForTimeout(160);
    await strategy.getByText(/Accepted draft selection \(5\/64\)/).waitFor();
    await strategy
      .getByText(/Only 2 candidates|2 candidates available/)
      .waitFor();
    await strategy.getByRole("button", { name: "Preview selection" }).click();
    await strategy.getByText(/Proposed 2 markets/).waitFor();
    state.fixture.rewards.rewards.marketModel.opportunities = [];
    await strategy.getByRole("button", { name: "Refresh suggestions" }).click();
    await strategy
      .getByText(/No current candidates pass this preset and focus/)
      .waitFor();
    assert(
      (await strategy.getByText(/Proposed 2 markets/).count()) > 0,
      "Polling silently replaced the frozen proposal",
    );
    await strategy.getByRole("button", { name: "Thin books" }).click();
    assert(
      (await strategy.getByText(/Proposed 2 markets/).count()) === 0,
      "Changing Focus failed to discard the stale proposal",
    );
    assert(
      (await strategy.locator(".strategy-market-row").count()) === 5,
      "Focus hid accepted markets from the selection list",
    );
    const n = strategy.getByRole("textbox", {
      name: "Markets",
    });
    await n.fill("");
    assert(
      (await n.getAttribute("aria-invalid")) === "true",
      "Invalid suggestion count was not inline",
    );
    assert(
      !(await strategy
        .getByRole("button", { name: "Preview selection" })
        .isEnabled()),
      "Invalid helper input allowed Preview",
    );
    await goToStrategyStep(page, 4);
    assert(
      await strategy
        .getByRole("button", { name: "Save and finish" })
        .isEnabled(),
      "An advisory candidate refresh blocked a valid saved strategy",
    );
    await strategy.getByRole("button", { name: "Save and finish" }).click();
    await page.getByText("Strategy saved.", { exact: true }).waitFor();
    assert(
      state.strategies[0].markets.length === 5 &&
        state.strategies[0].markets.some(
          (market) => market.marketId === mon.id,
        ),
      "Accepted market membership was lost when rankings changed",
    );
    state.fixture.rewards.rewards.marketModel.opportunities =
      originalCandidates;
    await goToStrategyStep(page, 1);
    await strategy.getByRole("button", { name: "All eligible" }).click();
    await strategy.getByRole("button", { name: "Refresh suggestions" }).click();
    await strategy.getByText(/5 candidates available/).waitFor();
    await strategy.getByText(/Accepted draft selection \(5\/64\)/).waitFor();
    await n.fill("5");
    assert(
      (await n.getAttribute("aria-invalid")) === "false",
      "Correcting helper input left an inline error",
    );
    await n.fill("");
    await strategy.getByRole("button", { name: "Best for rewards" }).click();
    assert(
      (await n.inputValue()) === "3" &&
        (await n.getAttribute("aria-invalid")) === "false",
      "Changing presets did not reset invalid helper input",
    );
    await strategy
      .getByRole("button", { name: "Balanced", exact: true })
      .click();
    await capture(page, "r6-stable-markets-desktop.png");
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
      .locator(".market-clean-table .market-bundle-label strong")
      .filter({ hasText: "Core" })
      .first()
      .waitFor();
    await page
      .locator(".market-clean-table .market-bundle-label strong")
      .filter({ hasText: "Rewards" })
      .first()
      .waitFor();
    await capture(page, "r8-market-bundle-tags-desktop.png");

    await page.getByRole("link", { name: "Venues", exact: true }).click();
    await page
      .locator(".venue-accounts-card")
      .getByText(/Equity .* exposure .* wallet limit/)
      .waitFor();
    await page.locator(".venue-kit-table").waitFor();
    await page.locator(".venue-accounts-card").scrollIntoViewIfNeeded();
    await capture(page, "r8-venues-accounts-desktop.png");

    await page.getByRole("link", { name: "Strategy", exact: true }).click();
    const strategyView = page.locator(
      '.maker-view[data-view="strategy"]:not([hidden])',
    );
    await goToStrategyStep(page, 1);
    const builder = strategyView.locator(".strategy-builder");
    const marketStep = strategyView.locator(".strategy-markets-section");
    await builder.waitFor();
    await marketStep.waitFor();
    await strategyView.getByText("What the market evidence means").click();
    await strategyView.getByText(/Score is a 0–100 heuristic/).waitFor();
    await strategyView.getByText(/Why MON ranks here/).click();
    assert(
      (
        await strategyView
          .locator(".strategy-market-reasons[open] p")
          .first()
          .textContent()
      )?.length > 10,
      "Full market evidence is not expandable",
    );
    const builderBox = await builder.boundingBox();
    const marketStepBox = await marketStep.boundingBox();
    assert(
      builderBox && marketStepBox && builderBox.y < marketStepBox.y,
      "Strategy steps were not placed before the market table",
    );
    assert(
      (await strategyView.locator(".strategy-market-rule:visible").count()) ===
        0,
      "The retired market-rule control remained visible",
    );
    await strategyView.locator(".strategy-market-table").waitFor();
    await strategyView
      .getByRole("button", { name: "Balanced", exact: true })
      .click();
    await strategyView
      .getByRole("button", { name: "Preview selection" })
      .click();
    await strategyView
      .getByText(/Proposed .* market.*not yet used/, { exact: false })
      .waitFor();
    await strategyView
      .getByRole("button", { name: "Use these markets" })
      .click();
    await goToStrategyStep(page, 2);
    await page
      .getByRole("textbox", { name: "Gross exposure (USD)" })
      .fill("3.00");
    await page
      .getByRole("textbox", { name: "Maximum run drawdown (USD)" })
      .fill("1.00");
    const quoteSize = page.getByRole("textbox", { name: "Quote size (USD)" });
    await quoteSize.fill("");
    assert(
      (await quoteSize.getAttribute("aria-invalid")) === "true",
      "Blank quote size did not show a field error",
    );
    await strategyView
      .getByRole("button", { name: /Save and continue to/ })
      .click();
    assert(
      (await strategyView
        .locator(".settings-panel")
        .getAttribute("data-strategy-step")) === "2",
      "Invalid quote size advanced the wizard",
    );
    await quoteSize.fill("1.04");
    await page.getByLabel("Strategy name", { exact: true }).fill("Core maker");
    await goToStrategyStep(page, 4);
    const saveStrategy = page.getByRole("button", {
      name: "Save and finish",
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
    await page.getByRole("link", { name: "Bundles", exact: true }).click();
    await page
      .locator(".bundle-card")
      .filter({ hasText: "Core" })
      .getByText(/^From Core maker:/)
      .waitFor();
    await page.getByRole("link", { name: "Strategy", exact: true }).click();
    await goToStrategyStep(page, 1);
    await page
      .getByText(/Accepted draft selection/, { exact: false })
      .waitFor();
    await strategyView
      .locator(".strategy-market-table")
      .scrollIntoViewIfNeeded();
    await capture(page, "v8-strategy-market-table-desktop.png");
    await strategyView
      .getByRole("button", { name: "Edit MON policy" })
      .first()
      .click();
    await page.getByRole("dialog", { name: "MON policy" }).waitFor();
    assert(
      (await strategyView
        .locator(".settings-panel")
        .getAttribute("data-strategy-step")) === "1",
      "Policy editor navigated away from the Markets step",
    );
    await page.waitForTimeout(420);
    await capture(page, "r8-strategy-market-policy-desktop.png");
  } finally {
    await context.close();
  }
}

async function strategyPolishFlow(browser) {
  const { context, page, state } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  try {
    state.fixture.config.config.maxGrossExposureUsd = 3;
    state.strategies.forEach((strategy) => {
      strategy.config.maxGrossExposureUsd = 3;
    });
    await goToDesk(page);
    await page.getByRole("link", { name: "Strategy", exact: true }).click();
    const view = page.locator(
      '.maker-view[data-view="strategy"]:not([hidden])',
    );
    const summary = view.locator(".strategy-summary");
    await summary.getByRole("heading", { name: /Core strategy/ }).waitFor();
    await summary.getByText("Saved", { exact: true }).waitFor();
    assert(
      !(await summary
        .getByRole("button", { name: "Delete strategy" })
        .isEnabled()),
      "Attached strategy Delete was enabled",
    );
    await capture(page, "r8-strategy-summary-desktop-light.png");
    await summary.getByRole("button", { name: "Edit Markets" }).click();
    assert(
      (await view
        .locator(".settings-panel")
        .getAttribute("data-strategy-step")) === "1",
      "Markets cell did not open step 2",
    );
    await goToStrategyStep(page, 2);
    const quote = view
      .getByRole("textbox", { name: "Quote size (USD)" })
      .first();
    await quote.fill("1.25");
    await goToStrategyStep(page, 4);
    const review = view.locator(".strategy-review-changes");
    await review.waitFor();
    assert(!(await review.innerText()).includes("{"), "Review showed raw JSON");
    await view
      .getByRole("button", { name: "New strategy", exact: true })
      .click();
    const created = state.strategies[0];
    const name = view.getByLabel("Strategy name", { exact: true });
    await name.waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const input = document.getElementById("strategy-name");
      return (
        input instanceof HTMLInputElement &&
        document.activeElement === input &&
        input.selectionStart === 0 &&
        input.selectionEnd === input.value.length
      );
    });
    assert(
      (await view
        .locator(".settings-panel")
        .getAttribute("data-strategy-step")) === "0",
      "New strategy did not open on Goal",
    );
    await view.getByText(/Starts from Core strategy's settings/).waitFor();
    await capture(page, "r8-new-strategy-goal-desktop-light.png");
    await view
      .getByRole("button", { name: "New strategy", exact: true })
      .click();
    assert(
      state.strategies[0].name !== created.name,
      "Two New strategy clicks collided on a name",
    );
    await page.waitForFunction(
      (name) => document.querySelector("#strategy-name")?.value === name,
      state.strategies[0].name,
    );
    state.strategyCreateFailures.push({
      status: 409,
      code: "strategy-name-taken",
      message:
        "Another strategy already uses this name. Choose a different name.",
    });
    await view
      .getByRole("button", { name: "New strategy", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelector("#strategy-name")?.value === "Strategy 4",
    );
    assert(
      state.strategies[0].name === "Strategy 4",
      "Archived name collision was not retried",
    );
    await goToStrategyStep(page, 4);
    state.strategyPatchFailures.push(503);
    await view.getByRole("button", { name: "Save and finish" }).click();
    await page.getByText("Apply temporarily unavailable").waitFor();
    assert(
      (await summary.count()) === 0,
      "Failed strategy PATCH showed summary",
    );
    state.strategyReadFailures = 100;
    await view.getByRole("button", { name: "Save and finish" }).click();
    await summary.getByText("Saved", { exact: true }).waitFor();
    await page
      .getByText(/Strategy applied, but refresh failed: Readback unavailable/)
      .waitFor();
    state.strategyReadFailures = 0;
    await capture(page, "r8-strategy-summary-applied-desktop-light.png");
  } finally {
    await context.close();
  }
}

async function strategyApplyRaceAndAttach(browser) {
  const { context, page, state } = await newPage(
    browser,
    { width: 390, height: 844 },
    { colorScheme: "dark" },
  );
  try {
    state.fixture.config.config.maxGrossExposureUsd = 3;
    state.strategies.forEach((strategy) => {
      strategy.config.maxGrossExposureUsd = 3;
    });
    await goToDesk(page);
    await page.getByRole("link", { name: "Strategy", exact: true }).click();
    const view = page.locator(
      '.maker-view[data-view="strategy"]:not([hidden])',
    );
    await view.evaluate((element) => {
      element.scrollTop = 0;
    });
    await capture(page, "r8-strategy-summary-header-phone-dark.png");
    await view
      .getByRole("button", { name: "New strategy", exact: true })
      .click();
    const created = state.strategies[0];
    await view.locator(".strategy-new-label:visible").waitFor();
    await goToStrategyStep(page, 4);
    state.strategyPatchDelayMs = 2000;
    await view.getByRole("button", { name: "Save and finish" }).click();
    await view.getByRole("button", { name: "Saving…" }).waitFor();
    await view.getByRole("button", { name: "Back" }).click();
    await view.getByRole("button", { name: "Back" }).click();
    const drawdown = view.getByRole("textbox", {
      name: "Maximum run drawdown (USD)",
    });
    const old = await drawdown.inputValue();
    await drawdown.fill("0.6");
    await page.waitForTimeout(2200);
    assert(
      (await drawdown.inputValue()) === "0.6",
      "Slow PATCH overwrote a newer draft",
    );
    assert(
      (await view.locator(".strategy-summary").count()) === 0,
      "Slow PATCH completed a later edit",
    );
    await drawdown.fill(old);
    await goToStrategyStep(page, 4);
    await view.getByRole("button", { name: "Save and finish" }).click();
    await view.locator(".strategy-summary").waitFor();
    assert(
      created.version === 2,
      "Reverting an acknowledged edit sent an extra PATCH",
    );
    await capture(page, "r8-strategy-summary-phone-dark.png");
    await view
      .getByRole("button", { name: "Edit strategy", exact: true })
      .click();
    await view
      .getByLabel("Strategy name", { exact: true })
      .fill("Switch outcome");
    await goToStrategyStep(page, 4);
    await view.getByRole("button", { name: "Save and finish" }).click();
    await view.getByRole("button", { name: "Saving…" }).waitFor();
    await view.getByLabel("Choose strategy").filter({ visible: true }).click();
    await view
      .getByRole("listbox", { name: "Strategies" })
      .filter({ visible: true })
      .getByRole("option")
      .filter({ hasText: "Core strategy" })
      .click();
    await page.waitForTimeout(2200);
    assert(
      (await view.locator(".strategy-summary h1").innerText()).includes(
        "Core strategy",
      ),
      "Slow response completed another strategy",
    );
    await view.getByLabel("Choose strategy").filter({ visible: true }).click();
    await view
      .getByRole("listbox", { name: "Strategies" })
      .filter({ visible: true })
      .getByRole("option")
      .filter({ hasText: "Switch outcome" })
      .click();
    await view.locator(".strategy-summary").waitFor();
    await view.getByRole("button", { name: "Delete strategy" }).click();
    const dialog = page.getByRole("dialog", {
      name: "Delete “Switch outcome”?",
    });
    created.usedBy = [{ id: "new-attachment", name: "New bundle" }];
    await dialog.getByRole("button", { name: "Delete strategy" }).click();
    await dialog.getByText(/used by New bundle/).waitFor();
    assert(
      state.strategyArchivePosts === 0 && !created.archivedAt,
      "New attachment escaped server recheck",
    );
  } finally {
    await context.close();
  }
}

async function round8MarketPolicy(browser) {
  const { context, page, state } = await newPage(browser, {
    width: 1440,
    height: 900,
  });
  try {
    state.fixture.config.config.maxGrossExposureUsd = 3;
    state.strategies.forEach((strategy) => {
      strategy.config.maxGrossExposureUsd = 3;
    });
    await goToDesk(page);
    await page.getByRole("link", { name: "Markets", exact: true }).click();
    const table = page.locator(".market-clean-table");
    await table.waitFor();
    await page.getByText("Aftermath markets", { exact: true }).waitFor();
    assert(
      (await table.getByRole("columnheader", { name: "Venue" }).count()) === 0,
      "Removed Venue column returned",
    );
    const heights = await table
      .locator("tbody tr:not(.market-group-heading)")
      .evaluateAll((rows) =>
        rows.map((row) => row.getBoundingClientRect().height),
      );
    assert(
      heights.length === 5 && heights.every((height) => height <= 60.5),
      `Market row exceeded 60 px: ${heights}`,
    );
    await capture(page, "r8-markets-clean-desktop-light.png");
    const edit = table.getByRole("button", { name: "Edit MON policy" });
    await edit.click();
    const sheet = page.getByRole("dialog", { name: "MON policy" });
    await sheet.waitFor();
    await sheet.getByText("Strategy value").first().waitFor();
    await page.waitForTimeout(420);
    await capture(page, "r8-policy-inherited-desktop-light.png");
    const spread = sheet.getByRole("textbox", { name: "Spread on each side" });
    await spread.fill("700");
    await sheet.getByText("Spread must be between 8 and 500 bps.").waitFor();
    assert(
      !(await sheet
        .getByRole("button", { name: "Save to Core strategy" })
        .isEnabled()),
      "Invalid policy could save",
    );
    await capture(page, "r8-policy-invalid-desktop-light.png");
    await spread.fill("30");
    await sheet.getByRole("button", { name: "Save to Core strategy" }).click();
    await sheet.waitFor({ state: "hidden" });
    assert(
      state.strategies[0].markets[0].overrides?.spreadBps === 30,
      "Market spread override was not saved",
    );
    await page.getByText("Saved MON policy to Core strategy.").waitFor();
    await table
      .getByRole("cell", { name: /1 custom/ })
      .first()
      .waitFor();
    assert(
      await edit.evaluate((button) => document.activeElement === button),
      "Policy sheet did not return focus",
    );
    await capture(page, "r8-policy-saved-desktop-light.png");
    await page.getByRole("link", { name: "Strategy", exact: true }).click();
    await goToStrategyStep(page, 0);
    await page
      .getByLabel("Strategy name", { exact: true })
      .fill("Core unsaved draft");
    await page.getByRole("link", { name: "Markets", exact: true }).click();
    await page.getByRole("link", { name: "Markets", exact: true }).waitFor();
    await table.getByRole("button", { name: "Edit MON policy" }).click();
    await sheet.getByText(/has changes you haven't applied yet/).waitFor();
    assert(
      (await sheet
        .getByRole("button", { name: "Save to Core strategy" })
        .count()) === 0,
      "Unapplied draft allowed policy save",
    );
    await page.waitForTimeout(420);
    await capture(page, "r8-policy-blocked-desktop-light.png");
  } finally {
    await context.close();
  }
  const phone = await newPage(
    browser,
    { width: 390, height: 844 },
    { colorScheme: "dark" },
  );
  try {
    phone.state.fixture.config.config.maxGrossExposureUsd = 3;
    phone.state.strategies.forEach((strategy) => {
      strategy.config.maxGrossExposureUsd = 3;
    });
    await goToDesk(phone.page);
    await phone.page
      .getByRole("link", { name: "Markets", exact: true })
      .click();
    await phone.page
      .locator(".market-clean-table")
      .getByRole("button", { name: "Edit MON policy" })
      .click();
    const sheet = phone.page.getByRole("dialog", { name: "MON policy" });
    await sheet.waitFor();
    await phone.page.waitForTimeout(420);
    await capture(phone.page, "r8-policy-inherited-phone-dark.png");
  } finally {
    await phone.context.close();
  }
}

async function round8KitHeaders(browser) {
  const views = [
    ["desk", ".desk-hero"],
    ["strategy", ".strategy-summary-header"],
    ["markets", ".ui-page-header.markets-title"],
    ["bundles", ".ui-page-header.bundles-title"],
    ["performance", ".ui-page-header.performance-page-header"],
    ["venues", ".ui-page-header.venues-title"],
  ];
  for (const width of [1440, 1180, 1024]) {
    const { context, page, state } = await newPage(browser, {
      width,
      height: 900,
    });
    try {
      state.fixture.config.config.maxGrossExposureUsd = 3;
      state.strategies.forEach((strategy) => {
        strategy.config.maxGrossExposureUsd = 3;
      });
      await goToDesk(page);
      const edges = [];
      for (const [view, selector] of views) {
        if (view !== "desk")
          await page
            .getByRole("link", {
              name:
                view === "strategy"
                  ? "Strategy"
                  : view === "markets"
                    ? "Markets"
                    : view === "bundles"
                      ? "Bundles"
                      : view === "performance"
                        ? "Performance"
                        : "Venues",
              exact: true,
            })
            .click();
        const header = page
          .locator(`.maker-view[data-view="${view}"]:not([hidden]) ${selector}`)
          .first();
        await header.waitFor();
        const structure = await page
          .locator(`.maker-view[data-view="${view}"]:not([hidden])`)
          .evaluate((node) => ({
            nestedCards: node.querySelectorAll(".ui-card .ui-card").length,
            bareTables: node.querySelectorAll("table:not(.ui-table)").length,
          }));
        assert(
          structure.nestedCards === 0 && structure.bareTables === 0,
          `Maker Kit components drifted on ${view}: ${JSON.stringify(structure)}`,
        );
        edges.push({
          view,
          x: await header.evaluate(
            (element) => element.getBoundingClientRect().left,
          ),
        });
      }
      const xs = edges.map((item) => item.x);
      assert(
        Math.max(...xs) - Math.min(...xs) < 1.5,
        `Maker Kit header misalignment at ${width}: ${JSON.stringify(edges)}`,
      );
    } finally {
      await context.close();
    }
  }
}

async function round8LandingPending(browser) {
  for (const width of [390, 1440]) {
    const { context, page, state } = await newPage(browser, {
      width,
      height: width === 390 ? 844 : 900,
    });
    try {
      state.fixture.auth = structuredClone(fixtureStates["signed-out"].auth);
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page
        .getByRole("heading", {
          name: "Your own market-making desk. Working for you.",
        })
        .waitFor();
      await page.evaluate(() => {
        window.__makerMockWallet.signPersonalMessage = "pending";
      });
      await page
        .getByRole("button", { name: "Continue with wallet", exact: false })
        .first()
        .click();
      await page
        .getByText("Mock Sui Wallet", { exact: true })
        .filter({ visible: true })
        .first()
        .click();
      const waiting = page.getByRole("button", { name: "Check your wallet" });
      await waiting.waitFor();
      await page
        .getByRole("status")
        .getByText(/Signing is free and moves no funds/)
        .waitFor();
      await waiting.scrollIntoViewIfNeeded();
      await page.locator(".access-signin").screenshot({
        path: path.join(outputDirectory, `r8-landing-pending-${width}.png`),
        animations: "disabled",
      });
      const dimensions = await waiting.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const icon = button.querySelector("svg");
        return {
          width: rect.width,
          height: rect.height,
          iconHeight: Number(icon?.getAttribute("height") ?? 0),
          viewport: window.innerWidth,
          content: button.scrollHeight,
        };
      });
      assert(
        dimensions.width <= dimensions.viewport - 20 &&
          dimensions.iconHeight === 14 &&
          dimensions.content <= dimensions.height,
        `Waiting sign-in button wrapped or spinner exceeded 14px: ${JSON.stringify(dimensions)}`,
      );
    } finally {
      await context.close();
    }
  }
}

async function round8ErrorsAndLog(browser) {
  const { context, page, state } = await newPage(browser, {
    width: 390,
    height: 844,
  });
  try {
    state.fixture.bundles.bundles.forEach((bundle) => {
      bundle.status = "stopped";
    });
    state.fixture.status.snapshot.running = false;
    state.fixture.status.bundles.forEach((entry) => {
      entry.bundle.status = "stopped";
      if (entry.snapshot) entry.snapshot.running = false;
    });
    state.startFailures.push({
      status: 409,
      error:
        "Authorize the selected Maker account in Venues before starting this bundle.",
      code: "account-not-authorized",
      fix: { kind: "venues" },
    });
    await goToDesk(page);
    await page.getByRole("button", { name: /Run status:/ }).click();
    const status = page.getByRole("region", { name: "Run status" });
    await status.getByRole("button", { name: "Start Core" }).click();
    await status
      .getByText(/Authorize the selected Maker account in Venues/)
      .waitFor();
    await status
      .getByRole("button", { name: "Authorize it in Venues" })
      .waitFor();
    await capture(page, "r8-fixable-run-error-phone.png");
    state.startFailures.push({
      status: 500,
      error: "Internal server error",
      requestId: "req-9j3",
    });
    await status.getByRole("button", { name: "Start Core" }).click();
    await status
      .getByText(
        /Maker couldn't start Core. Reference req-9j3 is in your control log/,
      )
      .waitFor();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const controlLog = page.locator(".desk-log-card");
    await controlLog
      .getByText(/Reference req-9j3 is in your control log/)
      .waitFor();
    await controlLog.getByRole("tab", { name: "Problems" }).click();
    assert(
      (await controlLog.getByText(/unclassified/).count()) === 0,
      "Fixture or request errors were unclassified",
    );
    await capture(page, "r8-control-log-error-phone.png");
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
  if (process.argv.includes("--landing-only")) {
    await round8LandingPending(browser);
  } else if (process.argv.includes("--kit-only")) {
    await round8KitHeaders(browser);
  } else if (process.argv.includes("--visual-only")) {
    await round6UniformMarketCards(browser);
  } else {
    if (!process.argv.includes("--polish-only")) {
      await nonCoreOnlyReport(browser);
      await runControlMobile(browser);
      await stopWithInventory(browser);
      await stopAllShowsProgress(browser);
      await savedDeskOnly(browser);
      await cleanStrategyLeavesWithoutPrompt(browser);
      await plainControlLog(browser);
      await strategyLibraryAndBundleAttachment(browser);
      await paperTrialRunsBesideBundles(browser);
      await staleStrategyDraftCannotApply(browser);
      await paperSimulationBlockerStaysVisible(browser);
      await round6MobilePicker(browser);
      await round6PickerAndRename(browser);
      await round6UniformMarketCards(browser);
      await round6ContextLinksAndHelp(browser);
      await round6AttachmentDestinations(browser);
      await round6ReviewCreatesBundle(browser);
      await round6SuggestionRefresh(browser);
    }
    await round8KitHeaders(browser);
    await round8LandingPending(browser);
    await round8ErrorsAndLog(browser);
    await round8MarketPolicy(browser);
    await strategyPolishFlow(browser);
    await strategyApplyRaceAndAttach(browser);
    if (!process.argv.includes("--polish-only")) {
      await v7BundleDeskAndStrategy(browser);
      await revokeWithoutWallet(browser);
      await withdrawsToOwnerWallet(browser);
      await serviceAndSessionFailures(browser);
      await createBundleWithFreeChoices(browser);
      await lowerWalletLimitsWhenCreating(browser);
      await editWalletLimits(browser);
    }
  }
  process.stdout.write("customer journey: all stateful audit flows passed\n");
} finally {
  await browser.close();
  if (server) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
  }
}
