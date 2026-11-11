import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validatePaperSoakEvidence } from "./maker-dev-soak-report.mjs";

const fixtures = new URL("../docs/soak-reports/", import.meta.url);

async function readFixture(name) {
  return JSON.parse(await readFile(new URL(name, fixtures), "utf8"));
}

test("accepts a continuous maker-dev Paper soak with a forced restart and reconciled events", async () => {
  const report = validatePaperSoakEvidence(
    await readFixture("valid-paper-soak.json"),
  );
  const checkedInReport = await readFile(
    new URL("valid-paper-soak-report.md", fixtures),
    "utf8",
  );

  assert.equal(report.valid, true);
  assert.deepEqual(report.failures, []);
  assert.match(report.markdown, /Proposed duration: 72 hours/);
  assert.equal(`${report.markdown}\n`, checkedInReport);
});

test("rejects a Paper soak with a gap, missing forced restart, or unreconciled event", async (t) => {
  for (const [name, expectedCode] of [
    ["gap-paper-soak.json", "observation-gap"],
    ["missing-forced-restart.json", "missing-forced-restart"],
    ["unreconciled-event.json", "unreconciled-event"],
  ]) {
    await t.test(name, async () => {
      const report = validatePaperSoakEvidence(await readFixture(name));

      assert.equal(report.valid, false);
      assert.deepEqual(
        report.failures.map(({ code }) => code),
        [expectedCode],
      );
    });
  }
});
