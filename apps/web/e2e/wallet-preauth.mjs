/**
 * Verifies the wallet controls that must stay available after a wallet connects
 * but before the access signature completes.
 *
 * Usage: node apps/web/e2e/wallet-preauth.mjs [--base-url http://127.0.0.1:8788]
 *                                             [--scenario pending|denied|all]
 *                                             [--output <dir relative to repo>]
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";

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

const baseUrl = option(
  "--base-url",
  process.env.MAKER_SHOTS_URL ?? "http://127.0.0.1:8788",
);
const outputDirectory = path.resolve(
  projectRoot,
  option("--output", "apps/web/e2e/shots/wallet-preauth"),
);
const requestedScenario = option("--scenario", "all");

const FIRST_ADDRESS = `0x${"a1".repeat(32)}`;
const SECOND_ADDRESS = `0x${"b2".repeat(32)}`;

const scenarios = {
  // Wallet connected, signature prompt still open in the wallet.
  pending: { signPersonalMessage: "pending" },
  // Wallet connected, signature given, wallet not on the access list.
  denied: {
    signPersonalMessage: "resolve",
    accessRequestToken: "fixture-access-request-token",
  },
  request: {
    signPersonalMessage: "resolve",
    accessRequestToken: "fixture-access-request-token",
    accessFlow: "request",
  },
  registry503: { signPersonalMessage: "resolve", accessFlow: "registry503" },
  closed403: { signPersonalMessage: "resolve", accessFlow: "closed403" },
  expired410: {
    signPersonalMessage: "resolve",
    accessRequestToken: "fixture-access-request-token",
    accessFlow: "expired410",
  },
  rate429: {
    signPersonalMessage: "resolve",
    accessRequestToken: "fixture-access-request-token",
    accessFlow: "rate429",
  },
  // No injected extension: the Slush browser bridge must still be offered on
  // a phone, where a native wallet app is not a browser extension.
  slush: { mobileBridge: true },
};

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

function shortAddress(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

async function routeControlApi(page, scenario) {
  await page.route("**/api/control/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const routePath = url.pathname.slice(
      url.pathname.indexOf("/api/control/") + "/api/control/".length,
    );
    const json = (status, body) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (routePath === "api/auth/me") return json(401, { error: "No session" });
    if (routePath === "api/auth/challenge") {
      return json(200, {
        challengeId: "challenge-1",
        message: "Sign in to Maker\nNonce: 1",
      });
    }
    if (routePath === "api/auth/verify") {
      if (scenario.accessFlow === "closed403")
        return json(403, {
          error: "Requests are closed right now.",
          code: "access-requests-closed",
        });
      if (scenario.accessFlow === "registry503")
        return json(503, {
          error:
            "Maker couldn't check the access list right now. Try again in a minute.",
          code: "access-list-unavailable",
        });
      return json(200, {
        accessRequestToken: scenario.accessRequestToken,
        accessRequestExpiresAt: "2026-10-28T00:15:00.000Z",
        ownerAddress: FIRST_ADDRESS,
      });
    }
    if (routePath === "api/access-requests") {
      if (scenario.accessFlow === "expired410")
        return json(410, {
          error: "That check expired. Sign again to request access.",
          code: "access-check-expired",
        });
      if (scenario.accessFlow === "rate429")
        return json(429, {
          error: "You've sent 3 requests this hour. Try again later.",
          code: "access-request-limit",
        });
      return json(200, { ok: true });
    }
    if (routePath === "api/auth/logout") return json(200, { ok: true });
    return json(501, { error: `No preauth fixture for ${routePath}` });
  });

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin === "https://api.slush.app" &&
      url.pathname === "/api/wallet/metadata"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "com.mystenlabs.suiwallet.web",
          walletName: "Slush",
          icon: "data:image/svg+xml;base64,PHN2Zy8+",
          enabled: true,
        }),
      });
      return;
    }
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      await route.fallback();
      return;
    }
    await route.abort("blockedbyclient");
  });
}

async function connectMockWallet(page) {
  await page
    .getByRole("button", { name: "Continue with wallet", exact: false })
    .first()
    .click();
  await page
    .getByText("Mock Sui Wallet", { exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await page.waitForFunction(
    () => Boolean(window.__makerMockWallet?.lastSignRequest),
    undefined,
    { timeout: 15_000 },
  );
}

async function runSlushMobile(viewport, browser) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
  });
  const page = await context.newPage();
  const failures = [];
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  await routeControlApi(page, scenarios.slush);

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.getByRole("heading").first().waitFor();
    await page
      .getByRole("button", { name: "Continue with wallet", exact: false })
      .first()
      .click();

    const slush = page
      .locator("mysten-dapp-kit-connect-modal")
      .getByText("Slush", { exact: true })
      .filter({ visible: true })
      .first();
    await slush.waitFor({ timeout: 10_000 }).catch(() => {
      failures.push("Slush is not offered in the phone wallet picker");
    });

    await fs.mkdir(outputDirectory, { recursive: true });
    await page.screenshot({
      path: path.join(outputDirectory, "slush-phone-picker.png"),
      fullPage: false,
    });
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    await fs.mkdir(outputDirectory, { recursive: true });
    await page
      .screenshot({
        path: path.join(outputDirectory, "slush-phone-failure.png"),
      })
      .catch(() => undefined);
  } finally {
    await context.close();
  }

  return failures;
}

async function runAccessFlow(page, scenario, scenarioName, viewport, output) {
  await page
    .getByRole("button", { name: "Request access", exact: true })
    .first()
    .click();
  await page
    .getByRole("alert")
    .getByText(
      "Connect the wallet you want to use. You'll sign a free message so Maker can check the access list.",
    )
    .waitFor();
  await page
    .getByText("Mock Sui Wallet", { exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await page.waitForFunction(() =>
    Boolean(window.__makerMockWallet?.lastSignRequest),
  );
  if (scenario.accessFlow === "closed403") {
    await page
      .getByRole("alert")
      .getByText("Requests are closed right now.")
      .waitFor();
    if (await page.getByRole("button", { name: "Try again" }).count())
      throw new Error("closed access prompted a repeat signature");
    if (await page.getByRole("button", { name: "Retry sign in" }).count())
      throw new Error(
        "closed access still offered an unavailable signature loop",
      );
    if (
      await page
        .getByRole("button", { name: "Request access", exact: true })
        .count()
    )
      throw new Error(
        "closed access still offered an unavailable request flow",
      );
  } else if (scenario.accessFlow === "registry503") {
    await page
      .getByRole("alert")
      .getByText(
        "Maker couldn't check the access list right now. Try again in a minute.",
      )
      .waitFor();
    await page.getByRole("button", { name: "Try again" }).waitFor();
  } else {
    await page
      .getByRole("heading", { name: "This wallet is not on the list yet." })
      .waitFor();
    const form = page.locator(".access-request-form");
    await form.getByLabel("X / Twitter").fill("@maker_user");
    await form.getByRole("button", { name: "Send request" }).click();
    const expected =
      scenario.accessFlow === "expired410"
        ? "That check expired. Sign again to request access."
        : scenario.accessFlow === "rate429"
          ? "You've sent 3 requests this hour. Try again later."
          : "Request received";
    await (
      expected === "Request received"
        ? page.getByText(expected)
        : form.getByRole("alert").getByText(expected)
    ).waitFor();
  }
  await fs.mkdir(output, { recursive: true });
  await page.screenshot({
    path: path.join(output, `${scenarioName}-${viewport.name}-result.png`),
    fullPage: false,
  });
}

async function run(scenarioName, viewport, browser) {
  const scenario = scenarios[scenarioName];
  if (scenario.mobileBridge) return runSlushMobile(viewport, browser);

  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
  });
  const page = await context.newPage();
  const failures = [];
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));

  await page.addInitScript((value) => {
    window.__makerMockWallet = { signPersonalMessage: value };
  }, scenario.signPersonalMessage);
  await page.addInitScript({ path: mockWalletPath });
  await routeControlApi(page, scenario);

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.getByRole("heading").first().waitFor();
    if (scenario.accessFlow) {
      await runAccessFlow(
        page,
        scenario,
        scenarioName,
        viewport,
        outputDirectory,
      );
      return failures;
    }
    await connectMockWallet(page);

    const badge = page.locator("[data-wallet-control]");
    await badge.first().waitFor({ timeout: 10_000 });

    const box = await badge.first().boundingBox();
    if (!box) failures.push("wallet control is not visible");
    else if (box.x + box.width < viewport.width / 2) {
      failures.push(
        `wallet control is not in the top-right (x=${Math.round(box.x)})`,
      );
    }

    await badge.first().locator("summary").click();
    const popover = badge.first().locator("[data-wallet-popover]");
    await popover.waitFor({ timeout: 5_000 });
    for (const address of [FIRST_ADDRESS, SECOND_ADDRESS]) {
      if (!(await popover.getByText(shortAddress(address)).count())) {
        failures.push(`popover does not list ${shortAddress(address)}`);
      }
    }
    for (const label of ["Disconnect", "Connect another wallet"]) {
      if (!(await popover.getByRole("button", { name: label }).count())) {
        failures.push(`popover is missing the ${label} action`);
      }
    }

    await fs.mkdir(outputDirectory, { recursive: true });
    await page.screenshot({
      path: path.join(
        outputDirectory,
        `${scenarioName}-${viewport.name}-open.png`,
      ),
      fullPage: false,
    });

    await popover
      .getByRole("button", { name: "Connect another wallet" })
      .click();
    const modalWallet = page
      .locator("mysten-dapp-kit-connect-modal")
      .getByText("Mock Sui Wallet", { exact: true })
      .filter({ visible: true })
      .first();
    await modalWallet.waitFor({ timeout: 5_000 }).catch(() => {
      failures.push("connect-another-wallet did not open the wallet picker");
    });
    await page.keyboard.press("Escape");
    await badge.first().locator("summary").click();
    await popover.waitFor({ timeout: 5_000 });

    await popover.getByRole("button", { name: "Disconnect" }).click();
    await page
      .getByRole("button", { name: /wallet/i })
      .first()
      .waitFor({ timeout: 10_000 });
    await badge.first().waitFor({ state: "detached", timeout: 10_000 });
    await page.screenshot({
      path: path.join(
        outputDirectory,
        `${scenarioName}-${viewport.name}-disconnected.png`,
      ),
      fullPage: false,
    });
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    await fs.mkdir(outputDirectory, { recursive: true });
    await page
      .screenshot({
        path: path.join(
          outputDirectory,
          `${scenarioName}-${viewport.name}-failure.png`,
        ),
      })
      .catch(() => undefined);
  } finally {
    await context.close();
  }

  return failures;
}

const browser = await chromium.launch({ executablePath });
const results = [];
try {
  const selected =
    requestedScenario === "all" ? Object.keys(scenarios) : [requestedScenario];
  for (const scenarioName of selected) {
    if (!(scenarioName in scenarios)) {
      throw new Error(`Unknown scenario "${scenarioName}"`);
    }
    const scenarioViewports = scenarios[scenarioName].mobileBridge
      ? viewports.filter((viewport) => viewport.name === "phone")
      : viewports;
    for (const viewport of scenarioViewports) {
      const failures = await run(scenarioName, viewport, browser);
      results.push({ scenarioName, viewport: viewport.name, failures });
      console.log(
        `${failures.length ? "FAIL" : "ok  "} ${scenarioName}/${viewport.name}${
          failures.length ? `: ${failures.join("; ")}` : ""
        }`,
      );
    }
  }
} finally {
  await browser.close();
}

if (results.some((result) => result.failures.length)) process.exit(1);
console.log(`Screenshots in ${outputDirectory}`);
