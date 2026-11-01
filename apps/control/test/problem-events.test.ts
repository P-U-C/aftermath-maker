import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROBLEM_OUTCOMES } from "../src/audit-event-kinds.js";
import { Store } from "../src/store.js";

describe("server-side problem filtering", () => {
  it("finds a blocked event even when thirty newer info events precede it", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `maker-problems-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const store = new Store(join(directory, "maker.db"));
    const owner = store.forTenant(`0x${"1".repeat(64)}`);
    const other = store.forTenant(`0x${"2".repeat(64)}`);
    owner.logEvent({
      category: "paper",
      action: "simulation",
      outcome: "blocked",
      detail: { code: "collateral" },
    });
    other.logEvent({
      category: "paper",
      action: "simulation",
      outcome: "blocked",
    });
    for (let i = 0; i < 30; i++)
      owner.logEvent({
        category: "runtime",
        action: "cycle",
        outcome: "success",
      });
    expect(owner.listEvents(12)).toHaveLength(12);
    expect(owner.listEvents(50, undefined, true)).toMatchObject([
      { category: "paper", outcome: "blocked", detail: { code: "collateral" } },
    ]);
    expect(other.listEvents(50, undefined, true)).toHaveLength(1);
    expect(PROBLEM_OUTCOMES).toEqual([
      "blocked",
      "error",
      "rejected",
      "partial",
      "timeout",
      "tripped",
      "retry",
    ]);
    store.close();
  });
});
