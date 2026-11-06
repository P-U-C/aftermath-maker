import { makerConfigSchema } from "@puc/core";
import { describe, expect, it } from "vitest";

import { inventoryRecyclingDefault } from "../lib/inventory-recycling-default";

describe("new inventory recycling strategy", () => {
  it("does not inherit live execution, cross-account hedging, leverage, or market overrides", () => {
    const defaults = makerConfigSchema.parse({
      markets: [{ marketId: "0x1234", symbol: "MON" }],
    });
    const previous = makerConfigSchema.parse({
      ...defaults,
      mode: "live",
      makerAccountId: "613",
      strategyObjective: "volume",
      strategyProfile: "active",
      rotationMode: "single-slot",
      marketDwellMs: 300_000,
      flattenOnRotate: true,
      maxLeverage: 10,
      hedge: {
        enabled: true,
        accountId: "1706",
        thresholdUsd: 25,
        maxOrderUsd: 100,
        maxSlippageBps: 75,
      },
      markets: [
        {
          marketId: "0x1234",
          symbol: "MON",
          overrides: { quoteSizeUsd: 500, maxLeverage: 10 },
        },
      ],
    });

    const next = inventoryRecyclingDefault(defaults, previous.markets);

    expect(next.markets).toEqual([{ marketId: "0x1234", symbol: "MON" }]);
    expect(next.mode).toBe("paper");
    expect(next.makerAccountId).toBeNull();
    expect(next.hedge.enabled).toBe(false);
    expect(next.hedge.accountId).toBeNull();
    expect(next.maxLeverage).toBe(1);
    expect(next.rotationMode).toBe("portfolio");
    expect(next.strategyObjective).toBe("both");
    expect(next.strategyProfile).toBe("balanced");
    expect(next.quoteSizeUsd).toBe(defaults.quoteSizeUsd);
    expect(makerConfigSchema.safeParse(next).success).toBe(true);
    expect(previous.mode).toBe("live");
  });
});
