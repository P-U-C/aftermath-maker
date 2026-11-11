#!/usr/bin/env node
// Agent-facing dev gate.
//
// Runs the same checks as the required `maker-dev-gate` workflow, but prints
// one short line per step instead of raw tool output, so a coding agent can
// read the result without spending context on expected-error log noise. It
// also checks three things CI does not: that the Live gates are still pinned
// off, that the change stays out of human-only paths, and that the test suite
// was not weakened to make it pass.
//
//   node scripts/agent-gate.mjs                    full dev gate, no build
//   node scripts/agent-gate.mjs --scope core       one workspace's tests
//   node scripts/agent-gate.mjs --repeat 5         rerun tests to expose flakes
//   node scripts/agent-gate.mjs --full             also run the production build
//   node scripts/agent-gate.mjs --base origin/dev  compare against another ref
//
// Exit codes: 0 pass, 1 fail, 2 hold (everything passed, but a human-only
// path changed and a person has to review it). Full logs for every step are
// written to .agent-gate/ and a machine-readable summary to
// .agent-gate/result.json. This script never signs, broadcasts, or reads a key.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, ".agent-gate");

const WORKSPACES = {
  core: { dir: "packages/core" },
  aftermath: { dir: "packages/aftermath" },
  control: { dir: "apps/control" },
  web: { dir: "apps/web", env: { TZ: "UTC" } },
};

// A change under any of these needs a person, whatever the tests say.
const HUMAN_ONLY = [
  /^\.github\//,
  /^deploy\//,
  /^move\//,
  /^Dockerfile$/,
  /^docker-compose[^/]*\.yml$/,
  /^\.env\.example$/,
  /^SECURITY\.md$/,
  /^AGENTS\.md$/,
  /^audits\//,
  /^scripts\/agent-gate\.mjs$/,
  /^apps\/control\/src\/live-canary[^/]*\.ts$/,
];

// Literals that keep every non-canary lane unable to trade.
const LIVE_GATE_LITERALS = [
  ["docker-compose.dev.yml", 'LIVE_TRADING_ENABLED: "false"'],
  ["docker-compose.dev.yml", 'ALLOW_MAINNET: "false"'],
  ["docker-compose.dev.yml", 'SHADOW_PAPER_MODE: "true"'],
  [".github/workflows/pr.yml", 'LIVE_TRADING_ENABLED: "false"'],
  [".github/workflows/pr.yml", 'ALLOW_MAINNET: "false"'],
  [".github/workflows/release.yml", 'LIVE_TRADING_ENABLED: "false"'],
  [".github/workflows/release.yml", 'ALLOW_MAINNET: "false"'],
  [".env.example", "LIVE_TRADING_ENABLED=false"],
  [".env.example", "ALLOW_MAINNET=false"],
];

function parseArgs(argv) {
  const options = {
    scope: Object.keys(WORKSPACES),
    repeat: 1,
    base: "origin/dev",
    full: false,
    allowHumanOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (argv[index] === undefined) throw new Error(`${arg} needs a value`);
      return argv[index];
    };
    if (arg === "--scope") {
      const value = next();
      options.scope =
        value === "all" ? Object.keys(WORKSPACES) : value.split(",");
      for (const name of options.scope) {
        if (!WORKSPACES[name]) throw new Error(`unknown scope "${name}"`);
      }
    } else if (arg === "--repeat") {
      options.repeat = Number(next());
      if (!Number.isInteger(options.repeat) || options.repeat < 1) {
        throw new Error("--repeat needs a positive integer");
      }
    } else if (arg === "--base") {
      options.base = next();
    } else if (arg === "--full") {
      options.full = true;
    } else if (arg === "--allow-human-only") {
      options.allowHumanOnly = true;
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return options;
}

function run(command, args, { cwd = root, env = {} } = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...process.env,
      CI: "true",
      LIVE_TRADING_ENABLED: "false",
      ALLOW_MAINNET: "false",
      ...env,
    },
  });
  return {
    ok: result.status === 0,
    seconds: (Date.now() - startedAt) / 1000,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
}

const steps = [];
function record(status, name, summary = "", details = []) {
  steps.push({ status, name, summary, details });
  console.log(`${status.padEnd(5)} ${name.padEnd(24)} ${summary}`.trimEnd());
  for (const line of details) console.log(`      ${line}`);
}

function lastLines(text, count) {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith('{"level"'))
    .slice(-count);
}

// ---- guards -------------------------------------------------------------

function guardLiveGates() {
  const missing = [];
  for (const [file, literal] of LIVE_GATE_LITERALS) {
    let text = "";
    try {
      text = readFileSync(path.join(root, file), "utf8");
    } catch {
      // A missing file is reported as a missing literal.
    }
    if (!text.includes(literal)) missing.push(`${file}: ${literal}`);
  }
  if (missing.length) {
    record("FAIL", "guard:live-gates", "a Live gate literal changed", missing);
  } else {
    record("PASS", "guard:live-gates", "Live and Mainnet gates pinned off");
  }
}

function changedAgainst(base) {
  const mergeBase = git(["merge-base", "HEAD", base])?.trim();
  if (!mergeBase) return null;
  const tracked = git(["diff", "--name-only", mergeBase]) ?? "";
  const untracked = git(["ls-files", "--others", "--exclude-standard"]) ?? "";
  const files = [
    ...new Set(`${tracked}\n${untracked}`.split("\n").filter(Boolean)),
  ];
  return { mergeBase, files };
}

function guardHumanOnly(change, allow) {
  const touched = change.files.filter((file) =>
    HUMAN_ONLY.some((pattern) => pattern.test(file)),
  );
  if (!touched.length) {
    record("PASS", "guard:human-only-paths", "none touched");
  } else if (allow) {
    record("PASS", "guard:human-only-paths", "allowed by operator", touched);
  } else {
    record(
      "HOLD",
      "guard:human-only-paths",
      "needs a person to review",
      touched,
    );
  }
}

function guardTestIntegrity(change) {
  const diff =
    git([
      "diff",
      "-U0",
      change.mergeBase,
      "--",
      "*.test.ts",
      "*.test.tsx",
      "apps/web/e2e",
    ]) ?? "";
  const declaration = /\b(?:it|test)(?:\.each\s*\([^)]*\))?\s*\(/g;
  const disabled =
    /\b(?:it|test|describe)\.(?:skip|only|todo|fails)\b|\bx(?:it|describe)\s*\(/;
  let added = 0;
  let removed = 0;
  const flagged = [];
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.slice(6);
      continue;
    }
    if (line.startsWith("--- ")) continue;
    const count = (line.match(declaration) ?? []).length;
    if (line.startsWith("+")) {
      added += count;
      if (disabled.test(line))
        flagged.push(`${file}: ${line.slice(1).trim().slice(0, 100)}`);
    } else if (line.startsWith("-")) {
      removed += count;
    }
  }
  const summary = `+${added} / -${removed} test declarations`;
  if (flagged.length) {
    record("FAIL", "guard:test-integrity", "disabled test added", flagged);
  } else if (removed > added) {
    record("FAIL", "guard:test-integrity", `${summary}; net tests removed`);
  } else {
    record("PASS", "guard:test-integrity", summary);
  }
}

// ---- quality steps ------------------------------------------------------

function npmStep(name, script) {
  const result = run("npm", ["run", "--silent", script]);
  writeFileSync(path.join(outDir, `${name}.log`), result.output);
  record(
    result.ok ? "PASS" : "FAIL",
    name,
    `${result.seconds.toFixed(1)}s`,
    result.ok ? [] : lastLines(result.output, 15),
  );
  return result.ok;
}

function firstLine(message) {
  return (
    String(message)
      .split("\n")
      .find((line) => line.trim()) ?? ""
  )
    .trim()
    .slice(0, 200);
}

function testStep(scope, repeat) {
  const workspace = WORKSPACES[scope];
  const cwd = path.join(root, workspace.dir);
  // Per test: how many runs passed, how many failed, and the first failure.
  const seen = new Map();
  let seconds = 0;
  let crashed = null;
  for (let attempt = 1; attempt <= repeat; attempt += 1) {
    const reportFile = path.join(outDir, `test-${scope}-${attempt}.json`);
    rmSync(reportFile, { force: true });
    const result = run(
      "npx",
      ["vitest", "run", "--reporter=json", `--outputFile=${reportFile}`],
      { cwd, env: workspace.env },
    );
    seconds += result.seconds;
    writeFileSync(
      path.join(outDir, `test-${scope}-${attempt}.log`),
      result.output,
    );
    let report;
    try {
      report = JSON.parse(readFileSync(reportFile, "utf8"));
    } catch {
      crashed = lastLines(result.output, 15);
      break;
    }
    for (const fileResult of report.testResults ?? []) {
      const relative = path.relative(cwd, fileResult.name);
      const assertions = fileResult.assertionResults ?? [];
      if (fileResult.status === "failed" && !assertions.length) {
        crashed = [`${relative}: ${firstLine(fileResult.message)}`];
      }
      for (const assertion of assertions) {
        if (assertion.status !== "passed" && assertion.status !== "failed") {
          continue;
        }
        const key = `${relative} > ${assertion.fullName}`;
        const entry = seen.get(key) ?? { passed: 0, failed: 0, message: "" };
        entry[assertion.status] += 1;
        if (assertion.status === "failed" && !entry.message) {
          entry.message = firstLine(assertion.failureMessages?.[0]);
        }
        seen.set(key, entry);
      }
    }
    if (crashed) break;
  }

  const name = `test:${scope}`;
  if (crashed) {
    record("FAIL", name, `${seconds.toFixed(1)}s  suite did not run`, crashed);
    return false;
  }
  const failing = [...seen].filter(([, entry]) => entry.failed > 0);
  const flaky = failing.filter(([, entry]) => entry.passed > 0);
  const broken = failing.filter(([, entry]) => entry.passed === 0);
  const runs = repeat > 1 ? ` x${repeat}` : "";
  const summary = `${seconds.toFixed(1)}s  ${seen.size} tests${runs}`;
  if (!failing.length) {
    record("PASS", name, summary);
    return true;
  }
  const details = [];
  for (const [key, entry] of broken) {
    details.push(`x ${key}`, `  ${entry.message}`);
  }
  for (const [key, entry] of flaky) {
    details.push(
      `~ FLAKY ${entry.failed}/${entry.passed + entry.failed} runs: ${key}`,
      `  ${entry.message}`,
    );
  }
  record(
    "FAIL",
    name,
    `${summary}, ${broken.length} failed, ${flaky.length} flaky`,
    details.slice(0, 40),
  );
  return false;
}

// ---- main ---------------------------------------------------------------

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`agent-gate: ${error.message}`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const sha = git(["rev-parse", "--short", "HEAD"])?.trim() ?? "unknown";
console.log(
  `agent-gate sha=${sha} base=${options.base} scope=${options.scope.join(",")} repeat=${options.repeat}`,
);

guardLiveGates();
const change = changedAgainst(options.base);
if (change) {
  guardHumanOnly(change, options.allowHumanOnly);
  guardTestIntegrity(change);
} else {
  record(
    "FAIL",
    "guard:diff",
    `cannot find a merge base with ${options.base}; fetch it or pass --base`,
  );
}

npmStep("format", "format:check");
npmStep("lint", "lint");
// Type checking also emits the core and aftermath builds the tests import.
if (npmStep("typecheck", "typecheck")) {
  for (const scope of options.scope) testStep(scope, options.repeat);
} else {
  record("SKIP", "test", "typecheck failed, so tests would not be meaningful");
}
if (options.full) npmStep("build", "build");

const failed = steps.filter((step) => step.status === "FAIL");
const held = steps.filter((step) => step.status === "HOLD");
const verdict = failed.length ? "FAIL" : held.length ? "HOLD" : "PASS";
writeFileSync(
  path.join(outDir, "result.json"),
  `${JSON.stringify({ verdict, sha, options, steps }, null, 2)}\n`,
);
console.log(
  `GATE ${verdict}  ${failed.length} failed, ${held.length} held, ${steps.length} steps  logs: .agent-gate/`,
);
process.exit(failed.length ? 1 : held.length ? 2 : 0);
