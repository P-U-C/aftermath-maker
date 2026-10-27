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
const showFlattenSheet = process.argv.includes("--flatten-sheet");
const showLiveSheet = process.argv.includes("--live-sheet");
const verifyConfigSave = process.argv.includes("--verify-config-save");
const outputDirectory = path.resolve(
  projectRoot,
  option("--output", defaultOutput),
);

const makerViews = ["desk", "strategy", "markets", "performance", "venues"];

function selectedViews() {
  const requested = option("--view", null);
  if (!requested) return [null];
  if (requested === "all") return makerViews;
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
  if (stateName === "signed-out") {
    await page
      .getByRole("heading", {
        name: "Both sides of the market, from your own wallet.",
      })
      .waitFor();
    return;
  }
  if (stateName === "not-on-list") {
    await page
      .getByRole("heading", { name: "You're not on the list yet." })
      .waitFor();
    return;
  }

  await page.getByRole("navigation", { name: "Maker views" }).waitFor();
  if (stateName === "onboarding") {
    await page
      .getByRole("heading", { name: "Authorize once. Run unattended." })
      .waitFor();
  }
}

async function capture(browser, stateName, captureConfig, view) {
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
  let capturedConfigBody = null;
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
    if (!expectedAuthFailure) browserErrors.push(text);
  });

  await page.addInitScript((timestamp) => {
    const fixed = Date.parse(timestamp);
    Date.now = () => fixed;
  }, fixedNow);

  await page.route("**/api/control/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
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
      return;
    }
    remoteRequests.push(url.href);
    await route.abort("blockedbyclient");
  });

  try {
    await page.goto(`${baseUrl}${view ? `#${view}` : ""}`, {
      waitUntil: "networkidle",
    });
    await waitForFixture(page, stateName);
    if (fixture.auth.status === 200) {
      const tabStops = await page
        .getByRole("navigation", { name: "Maker views" })
        .getByRole("link")
        .evaluateAll((links) => links.map((link) => link.tabIndex));
      if (
        tabStops.length !== makerViews.length ||
        tabStops.some((tab) => tab < 0)
      ) {
        throw new Error(
          `${stateName}/${captureConfig.name} has unreachable view tabs`,
        );
      }
      if (captureConfig.name === "desktop-light" && view === null) {
        for (const targetView of makerViews) {
          await page
            .getByRole("link", { name: targetView, exact: false })
            .click();
          await page
            .locator(`[data-view="${targetView}"]:not([hidden])`)
            .first()
            .waitFor();
          if (new URL(page.url()).hash !== `#${targetView}`) {
            throw new Error(
              `${stateName}/${captureConfig.name} did not navigate to ${targetView}`,
            );
          }
        }
        const resetView = stateName === "onboarding" ? "venues" : "desk";
        await page.getByRole("link", { name: resetView, exact: false }).click();
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
      showLiveSheet &&
      stateName === "stopped" &&
      (view === null || view === "strategy")
    ) {
      if (view === null) {
        await page.getByRole("link", { name: "Strategy" }).click();
      }
      await page.getByRole("button", { name: "Review live setup" }).click();
      await page.getByRole("dialog", { name: "Use Live mode?" }).waitFor();
      if (
        await page.getByRole("button", { name: "Use Live mode" }).isEnabled()
      ) {
        throw new Error(
          "Live mode was selectable while deployment gates were off",
        );
      }
    }
    if (
      verifyConfigSave &&
      stateName === "stopped" &&
      captureConfig.name === "desktop-light" &&
      view === "strategy"
    ) {
      const nextSpread = fixture.config.config.spreadBps + 1;
      await page
        .getByRole("spinbutton", { name: "Spread in basis points" })
        .fill(String(nextSpread));
      await page.getByRole("button", { name: "Save strategy" }).click();
      await page.getByText("Unsaved changes").waitFor({ state: "hidden" });
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
      const expectedBody = JSON.stringify({
        ...fixture.config.config,
        spreadBps: nextSpread,
      });
      if (capturedConfigBody !== expectedBody) {
        throw new Error(
          `Strategy save body changed. Expected ${expectedBody}, received ${capturedConfigBody}`,
        );
      }
      process.stdout.write(
        `${stateName}/${view}/${captureConfig.name}: config request body is byte-identical\n`,
      );
    }
    await page.waitForTimeout(100);

    const dimensions = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    const contrastFailures = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const rgb = (token) => {
        const value = style.getPropertyValue(token).trim();
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

    if (dimensions.scrollWidth > dimensions.innerWidth) {
      throw new Error(
        `${stateName}/${captureConfig.name} has horizontal overflow: ${dimensions.scrollWidth}px > ${dimensions.innerWidth}px`,
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

    const file = path.join(
      outputDirectory,
      `${stateName}${view ? `-${view}` : ""}${showFlattenSheet ? "-flatten" : ""}${showLiveSheet ? "-live" : ""}-${captureConfig.name}.png`,
    );
    await page.screenshot({ path: file, fullPage: false });
    process.stdout.write(
      `${stateName}${view ? `/${view}` : ""}/${captureConfig.name}: ${file} (${dimensions.scrollWidth}px wide)\n`,
    );

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

    if (exerciseStop) {
      await page.getByRole("button", { name: "Refresh market" }).click();
      await page.waitForTimeout(50);
      const stop = page.getByRole("button", { name: "Stop", exact: true });
      if (!(await stop.isEnabled())) {
        throw new Error("Stop became disabled while a refresh was in flight");
      }
      await stop.click();
      await page
        .getByText(
          "Stop failed: Stop is already reconciling orders. Try Stop again.",
        )
        .waitFor();
      if (!(await stop.isEnabled())) {
        throw new Error("Stop became disabled after a server error");
      }
      process.stdout.write(
        `${stateName}${view ? `/${view}` : ""}/${captureConfig.name}: Stop stayed enabled during busy and after error\n`,
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
    for (const view of selectedViews()) {
      for (const captureConfig of selectedCaptures()) {
        await capture(browser, stateName, captureConfig, view);
      }
    }
  }
} finally {
  await browser.close();
}
