import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultPacket = "docs/retest-packets/AM-EXT-2026-11-11.json";
const expectedIds = Array.from(
  { length: 25 },
  (_, index) => `AM-EXT-${String(index + 1).padStart(2, "0")}`,
);

function fail(message) {
  throw new Error(`RETEST PACKET CHECK FAIL: ${message}`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function packetPathFromArgs(args) {
  if (args.length === 0) return defaultPacket;
  if (args.length === 2 && args[0] === "--packet") return args[1];
  fail(
    "usage: node scripts/check-external-retest-packet.mjs [--packet <path>]",
  );
}

function readPacket(relativePath) {
  const absolutePath = resolve(repositoryRoot, relativePath);

  try {
    return JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    fail(`cannot read packet ${relativePath}: ${error.message}`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim())
    fail(`${label} must be a non-empty string`);
  return value;
}

function verifyNamedTest(entry) {
  if (!entry.test || typeof entry.test !== "object") {
    fail(`${entry.id} must name a regression test`);
  }

  const file = requireString(entry.test.file, `${entry.id}.test.file`);
  const name = requireString(entry.test.name, `${entry.id}.test.name`);
  const absolutePath = resolve(repositoryRoot, file);
  if (!absolutePath.startsWith(`${repositoryRoot}/`)) {
    fail(`${entry.id} test file escapes the repository: ${file}`);
  }

  let source;
  try {
    source = readFileSync(absolutePath, "utf8");
  } catch (error) {
    fail(
      `${entry.id} named test file is unavailable (${file}): ${error.message}`,
    );
  }

  const quotedVitest = new RegExp(`\\bit\\(\\s*["']${escapeRegex(name)}["']`);
  const moveTest = new RegExp(`\\bfun\\s+${escapeRegex(name)}\\s*\\(`);
  if (!quotedVitest.test(source) && !moveTest.test(source)) {
    fail(`${entry.id} named test is absent from ${file}: ${name}`);
  }
}

const packet = readPacket(packetPathFromArgs(process.argv.slice(2)));
if (packet.externalRetestPerformed !== false) {
  fail("packet must not claim an external retest was performed");
}
if (!Array.isArray(packet.entries)) fail("entries must be an array");
if (packet.entries.length !== expectedIds.length) {
  fail(
    `expected ${expectedIds.length} entries, found ${packet.entries.length}`,
  );
}

const seen = new Set();
for (const [index, entry] of packet.entries.entries()) {
  if (!entry || typeof entry !== "object")
    fail(`entry ${index + 1} is not an object`);
  const expectedId = expectedIds[index];
  if (entry.id !== expectedId || seen.has(entry.id)) {
    fail(`entry ${index + 1} must be unique and ordered as ${expectedId}`);
  }
  seen.add(entry.id);
  requireString(entry.finding, `${entry.id}.finding`);
  if (entry.remediation !== "fixed" && entry.remediation !== "mitigated") {
    fail(`${entry.id}.remediation must be fixed or mitigated`);
  }

  if (entry.coverage === "mapped") {
    verifyNamedTest(entry);
    continue;
  }
  fail(`${entry.id}.coverage must be mapped with a named regression test`);
}

process.stdout.write("RETEST PACKET CHECK PASS\n");
process.stdout.write(
  `Mapped named regression tests: ${expectedIds.length}/${expectedIds.length}\n`,
);
process.stdout.write(
  "External retest: not performed; this packet is an internal mapping only.\n",
);
