import { describe, expect, it } from "vitest";
import { withMarketPolicyOverride } from "../lib/strategy-market-policy";
import { makerMarketOverridesSchema } from "@puc/core";

describe("per-market strategy PATCH body", () => {
  it("changes a spread override by exactly that field and preserves market order", () => {
    const strategy = {
      name: "Core maker",
      config: { quoteSizeUsd: 1.04 },
      marketRule: { kind: "preferred-list", marketIds: ["MON", "NEAR"] },
      markets: [
        { marketId: "MON", symbol: "MON" },
        { marketId: "NEAR", symbol: "NEAR", overrides: { quoteSizeUsd: 2 } },
      ],
      expectedVersion: 4,
    };
    const next = {
      ...strategy,
      markets: withMarketPolicyOverride(
        strategy.markets,
        "MON",
        makerMarketOverridesSchema.parse({ spreadBps: 30 }),
      ),
    };
    expect(next).toEqual({
      ...strategy,
      markets: [
        { marketId: "MON", symbol: "MON", overrides: { spreadBps: 30 } },
        strategy.markets[1],
      ],
    });
    expect(strategy.markets[0]).toEqual({ marketId: "MON", symbol: "MON" });
  });

  it("removes an empty override object and leaves other markets untouched", () => {
    const before = [
      { marketId: "MON", symbol: "MON", overrides: { spreadBps: 42 } },
      { marketId: "NEAR", symbol: "NEAR", overrides: { quoteSizeUsd: 2 } },
    ];
    expect(withMarketPolicyOverride(before, "MON", {})).toEqual([
      { marketId: "MON", symbol: "MON" },
      before[1],
    ]);
    expect(() => withMarketPolicyOverride(before, "BTC", {})).toThrow(
      "not part",
    );
  });
});
