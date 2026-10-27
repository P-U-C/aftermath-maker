import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";
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
const outputDirectory = path.resolve(
  projectRoot,
  option("--output", defaultOutput),
);

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

function apiResponse(fixture, url) {
  const marker = "/api/control/";
  const routePath = url.pathname.slice(
    url.pathname.indexOf(marker) + marker.length,
  );

  if (routePath === "api/auth/me") return fixture.auth;
  if (routePath === "api/status") {
    return { status: 200, body: fixture.status };
  }
  if (routePath === "api/config") {
    return { status: 200, body: fixture.config };
  }
  if (routePath === "api/setup") {
    return { status: 200, body: fixture.setup };
  }
  if (routePath === "api/events") {
    return { status: 200, body: fixture.events };
  }
  if (routePath === "api/performance") {
    return { status: 200, body: fixture.performance };
  }
  if (routePath === "api/rewards") {
    return { status: 200, body: fixture.rewards };
  }
  if (routePath === "api/markets") {
    return { status: 200, body: fixture.markets };
  }
  if (routePath === "api/accounts") {
    return { status: 200, body: fixture.accounts };
  }
  if (routePath === "api/operator/status") {
    return { status: 200, body: fixture.operator };
  }

  return {
    status: 501,
    body: { error: `No screenshot fixture for ${routePath}` },
  };
}

async function waitForFixture(page, stateName) {
  if (stateName === "signed-out" || stateName === "not-on-list") {
    await page
      .getByRole("heading", { name: "Your wallet is the key." })
      .waitFor();
    return;
  }

  await page.getByRole("heading", { name: "Maker controls" }).waitFor();
  if (stateName === "onboarding") {
    await page
      .getByRole("heading", { name: "Authorize once. Run unattended." })
      .waitFor();
  }
}

async function capture(browser, stateName, captureConfig) {
  const fixture = fixtureStates[stateName];
  const context = await browser.newContext({
    viewport: captureConfig.viewport,
    deviceScaleFactor: 2,
    colorScheme: captureConfig.colorScheme,
    reducedMotion: captureConfig.reducedMotion,
    locale: "en-US",
    timezoneId: "UTC",
  });
  const page = await context.newPage();
  const browserErrors = [];
  const remoteRequests = [];

  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    const expectedAuthFailure =
      fixture.auth.status !== 200 &&
      text.startsWith("Failed to load resource:") &&
      text.includes(String(fixture.auth.status));
    if (!expectedAuthFailure) browserErrors.push(text);
  });

  await page.addInitScript((timestamp) => {
    const fixed = Date.parse(timestamp);
    Date.now = () => fixed;
  }, fixedNow);

  await page.route("**/api/control/**", async (route) => {
    const response = apiResponse(fixture, new URL(route.request().url()));
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
      return;
    }
    remoteRequests.push(url.href);
    await route.abort("blockedbyclient");
  });

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await waitForFixture(page, stateName);
    await page.waitForTimeout(100);

    const dimensions = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));

    if (dimensions.scrollWidth > dimensions.innerWidth) {
      throw new Error(
        `${stateName}/${captureConfig.name} has horizontal overflow: ${dimensions.scrollWidth}px > ${dimensions.innerWidth}px`,
      );
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

    const file = path.join(
      outputDirectory,
      `${stateName}-${captureConfig.name}.png`,
    );
    await page.screenshot({ path: file, fullPage: false });
    process.stdout.write(
      `${stateName}/${captureConfig.name}: ${file} (${dimensions.scrollWidth}px wide)\n`,
    );
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
    for (const captureConfig of captures) {
      await capture(browser, stateName, captureConfig);
    }
  }
} finally {
  await browser.close();
}
