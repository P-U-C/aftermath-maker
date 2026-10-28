/**
 * Walks every rendered view in light and dark and reports text that is close to
 * invisible against its own background. Catches blanket palette overrides such
 * as the access-header rule that painted menu items white on white.
 *
 * Usage: node apps/web/e2e/contrast-audit.mjs [--base-url http://127.0.0.1:8790]
 *                                             [--state <fixture>] [--min 4.5]
 */
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";

import { apiResponse } from "./fixtures/api.mjs";
import { fixedNow, fixtureStates } from "./fixtures/control.ts";

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
  process.env.MAKER_SHOTS_URL ?? "http://127.0.0.1:8790",
);
const minimumContrast = Number(option("--min", "4.5"));
const requestedState = option("--state", null);
const requestedScheme = option("--scheme", null);
const requestedViewport = option("--viewport", null);
const views = [
  "desk",
  "strategy",
  "markets",
  "performance",
  "accounts",
  "venues",
];
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

const auditInPage = (threshold) => {
  const parse = (value) => {
    const match = value.match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    const [r, g, b, a = 1] = parts;
    return { r, g, b, a };
  };
  const over = (front, back) => ({
    r: front.r * front.a + back.r * (1 - front.a),
    g: front.g * front.a + back.g * (1 - front.a),
    b: front.b * front.a + back.b * (1 - front.a),
    a: 1,
  });
  const luminance = ({ r, g, b }) => {
    const channel = (value) => {
      const scaled = value / 255;
      return scaled <= 0.03928
        ? scaled / 12.92
        : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const contrast = (front, back) => {
    const a = luminance(front) + 0.05;
    const b = luminance(back) + 0.05;
    return a > b ? a / b : b / a;
  };

  const backgroundFor = (element) => {
    let node = element;
    let backdrop = { r: 255, g: 255, b: 255, a: 1 };
    const stack = [];
    while (node) {
      const style = getComputedStyle(node);
      const colour = parse(style.backgroundColor);
      if (colour && colour.a > 0) stack.push(colour);
      if (colour && colour.a === 1) break;
      node = node.parentElement;
    }
    for (const colour of stack.reverse()) backdrop = over(colour, backdrop);
    return backdrop;
  };

  const findings = [];
  const elements = document.querySelectorAll("body *");
  for (const element of elements) {
    if (element.closest("[hidden]")) continue;
    if (element.matches("script, style, svg, svg *, img, input, textarea")) {
      continue;
    }
    if (element.hasAttribute("disabled") || element.closest("[disabled]")) {
      continue;
    }
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent.trim())
      .join(" ")
      .trim();
    if (!ownText) continue;

    const style = getComputedStyle(element);
    if (
      style.visibility === "hidden" ||
      style.display === "none" ||
      Number(style.opacity) === 0
    ) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;

    const colour = parse(style.webkitTextFillColor ?? style.color);
    if (!colour) continue;
    const background = backgroundFor(element);
    const ratio = contrast(over(colour, background), background);
    const fontSize = Number.parseFloat(style.fontSize);
    const fontWeight = Number.parseInt(style.fontWeight, 10);
    const largeText =
      fontSize >= 24 ||
      (fontSize >= 18.66 && Number.isFinite(fontWeight) && fontWeight >= 700);
    const requiredRatio = largeText ? 3 : threshold;
    if (ratio < requiredRatio || fontSize < 12) {
      const describe = (node) =>
        `${node.tagName.toLowerCase()}${
          node.className && typeof node.className === "string"
            ? `.${node.className.trim().split(/\s+/).join(".")}`
            : ""
        }`;
      findings.push({
        parent: element.parentElement ? describe(element.parentElement) : "",
        selector: `${element.tagName.toLowerCase()}${
          element.className && typeof element.className === "string"
            ? `.${element.className.trim().split(/\s+/).join(".")}`
            : ""
        }`,
        text: ownText.slice(0, 48),
        color: style.color,
        background: `rgb(${Math.round(background.r)}, ${Math.round(
          background.g,
        )}, ${Math.round(background.b)})`,
        ratio: Number(ratio.toFixed(2)),
        requiredRatio,
        fontSize: Number(fontSize.toFixed(2)),
        reason: fontSize < 12 ? "font below 12px" : "contrast below threshold",
      });
    }
  }
  return findings;
};

async function auditState(browser, stateName, colorScheme, viewport) {
  const fixture = fixtureStates[stateName];
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme,
    locale: "en-US",
    timezoneId: "UTC",
  });
  const page = await context.newPage();
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
    await route.abort("blockedbyclient");
  });

  const findings = [];
  try {
    const signedIn = fixture.auth.status === 200;
    const targets = signedIn ? views : [null];
    for (const view of targets) {
      await page.goto(`${baseUrl}${view ? `#${view}` : ""}`, {
        waitUntil: "networkidle",
      });
      if (signedIn) {
        await page.getByRole("navigation", { name: "Maker views" }).waitFor();
        await page.locator(`[data-view="${view}"]:not([hidden])`).waitFor();
      }
      await page.waitForTimeout(400);
      const found = await page.evaluate(auditInPage, minimumContrast);
      for (const entry of found) {
        findings.push({ ...entry, view: view ?? "access", colorScheme });
      }
    }
  } finally {
    await context.close();
  }
  return findings;
}

const browser = await chromium.launch({ executablePath });
const all = [];
try {
  const states = requestedState ? [requestedState] : Object.keys(fixtureStates);
  const schemes = requestedScheme ? [requestedScheme] : ["light", "dark"];
  const selectedViewports = requestedViewport
    ? viewports.filter((viewport) => viewport.name === requestedViewport)
    : viewports;
  if (!selectedViewports.length) {
    throw new Error(`Unknown viewport "${requestedViewport}"`);
  }
  if (schemes.some((scheme) => !["light", "dark"].includes(scheme))) {
    throw new Error(`Unknown scheme "${requestedScheme}"`);
  }
  for (const stateName of states) {
    for (const colorScheme of schemes) {
      for (const viewport of selectedViewports) {
        const findings = await auditState(
          browser,
          stateName,
          colorScheme,
          viewport,
        );
        for (const entry of findings) {
          all.push({ ...entry, state: stateName, viewport: viewport.name });
        }
        console.log(
          `${findings.length ? "FAIL" : "ok  "} ${stateName}/${colorScheme}/${viewport.name}${
            findings.length ? ` ${findings.length} failures` : ""
          }`,
        );
      }
    }
  }
} finally {
  await browser.close();
}

const seen = new Map();
for (const entry of all) {
  const key = `${entry.selector}|${entry.color}|${entry.background}|${entry.reason}`;
  if (!seen.has(key)) seen.set(key, { ...entry, count: 0 });
  seen.get(key).count += 1;
}
for (const entry of seen.values()) {
  console.log(
    `  ${entry.reason}; ${entry.ratio}:1 (needs ${entry.requiredRatio}:1), ${entry.fontSize}px ${entry.state}/${entry.colorScheme}/${entry.viewport}/${entry.view} ${entry.parent} > ${entry.selector} "${entry.text}" ${entry.color} on ${entry.background} (x${entry.count})`,
  );
}
if (all.length) process.exit(1);
