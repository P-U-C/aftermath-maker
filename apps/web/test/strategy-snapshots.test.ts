import { describe, expect, it } from "vitest";
import { mergeStrategyReads } from "../lib/strategy-snapshots";

describe("strategy list reconciliation", () => {
  it("does not revert an acknowledged rename and removes a server-deleted strategy", () => {
    const current = [
      { id: "a", version: 3, name: "Applied B" },
      { id: "new", version: 1, name: "New" },
    ];
    expect(
      mergeStrategyReads(current, [{ id: "a", version: 2, name: "Applied A" }]),
    ).toEqual([{ id: "a", version: 3, name: "Applied B" }]);
    expect(
      mergeStrategyReads(current, [
        { id: "a", version: 4, name: "External C" },
      ]),
    ).toMatchObject([{ version: 4, name: "External C" }]);
  });

  it("keeps a locally-created strategy only until the server returns it", () => {
    const pending = new Set(["new"]);
    const current = [{ id: "new", version: 1, name: "New" }];
    expect(mergeStrategyReads(current, [], pending)).toEqual(current);
    expect(
      mergeStrategyReads(
        current,
        [{ id: "new", version: 1, name: "New" }],
        pending,
      ),
    ).toEqual(current);
  });
});
