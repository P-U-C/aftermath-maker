import { describe, expect, it } from "vitest";
import { mergeStrategyReads } from "../lib/strategy-snapshots";

describe("strategy list reconciliation", () => {
  it("does not revert an acknowledged rename or drop a new strategy on a stale poll", () => {
    const current = [
      { id: "a", version: 3, name: "Applied B" },
      { id: "new", version: 1, name: "New" },
    ];
    expect(
      mergeStrategyReads(current, [{ id: "a", version: 2, name: "Applied A" }]),
    ).toEqual(current);
    expect(
      mergeStrategyReads(current, [
        { id: "a", version: 4, name: "External C" },
      ]),
    ).toMatchObject([{ version: 4, name: "External C" }, { id: "new" }]);
  });
});
