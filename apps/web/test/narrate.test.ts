import { describe, expect, it } from "vitest";

import { narrate } from "../lib/narrate";

describe("desk narration", () => {
  it("describes two-sided quoting from real snapshot values", () => {
    expect(
      narrate({
        name: "Core",
        running: true,
        mode: "live",
        market: {
          symbol: "MON",
          bid: 0.021393,
          ask: 0.021484,
          tickSize: 0.000001,
        },
      }),
    ).toBe(
      "Core is quoting MON, buying at 0.021393 and selling at 0.021484, 42 bps apart.",
    );
  });

  it("drops unavailable clauses rather than guessing", () => {
    expect(
      narrate({
        name: "Core",
        running: true,
        mode: "live",
        market: { symbol: "MON", bid: null, ask: null },
        inventoryUsd: null,
        rotation: { secondsLeft: null, nextSymbol: null },
      }),
    ).toBe("Core is waiting for a complete market snapshot.");
  });

  it("adds inventory, hedge, rotation, and limit clauses only when present", () => {
    expect(
      narrate({
        name: "Core",
        running: true,
        mode: "live",
        market: { symbol: "MON", bid: 10, ask: 10.1, tickSize: 0.01 },
        inventoryUsd: 2.08,
        maxInventoryUsd: 2.5,
        lastFillAgeSeconds: 12,
        hedge: { fired: true, side: "sold", notionalUsd: 1.04 },
        rotation: { secondsLeft: 3, nextSymbol: "NEAR" },
      }),
    ).toContain("It holds $2.08 of MON from a fill 12 s ago");
    expect(
      narrate({
        name: "Core",
        running: true,
        mode: "live",
        market: { symbol: "MON", bid: 10, ask: 10.1, tickSize: 0.01 },
        inventoryUsd: 2.08,
        maxInventoryUsd: 2.5,
        hedge: { fired: true, side: "sold", notionalUsd: 1.04 },
        rotation: { secondsLeft: 3, nextSymbol: "NEAR" },
      }),
    ).toContain("MON has 3 s left. NEAR is next.");
  });

  it("names inventory honestly after the desk stops", () => {
    expect(
      narrate({
        running: false,
        mode: "live",
        market: { symbol: "MON" },
        inventoryUsd: 1.04,
      }),
    ).toBe("Stopped. Orders are cancelled; you still hold $1.04 of MON.");
  });

  it("only says the stopped desk holds nothing when it is flat", () => {
    expect(narrate({ running: false, mode: "live", inventoryUsd: 0 })).toBe(
      "Stopped. Orders are cancelled; you hold nothing.",
    );
    expect(narrate({ name: "Core", running: true, mode: "paper" })).toBe(
      "Core is paper trading. Nothing it shows is a real order.",
    );
  });
});
