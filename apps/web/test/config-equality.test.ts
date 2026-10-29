import { describe, expect, it } from "vitest";

import { configsEqual } from "../lib/config-equality";

const config = {
  markets: [{ marketId: "0x1234", symbol: "MON" }],
  collateralCoinType:
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  mode: "paper",
  rotationMode: "portfolio",
  strategyObjective: "both",
  strategyProfile: "balanced",
  makerAccountId: "1745",
  hedge: {
    enabled: false,
    accountId: null,
    thresholdUsd: 25,
    maxOrderUsd: 100,
    maxSlippageBps: 75,
  },
  quoteSizeUsd: 10,
  spreadBps: 30,
  refreshMs: 8000,
  marketDwellMs: 60000,
  requoteThresholdBps: 5,
  maxRestingMs: 60000,
  autoRebalanceEnabled: false,
  rebalanceGrossExposureUsd: 100,
  maxQuoteAgeMs: 18000,
  maxInventoryUsd: 50,
  inventoryTargetUsd: 0,
  maxGrossExposureUsd: 150,
  maxUnrealizedLossUsd: 20,
  maxRunDrawdownUsd: 20,
  maxBookDivergenceBps: 100,
  maxLeverage: 1,
  maxGasMist: 50000000,
  staleBookMs: 15000,
  inventorySkewBps: 20,
};

describe("configsEqual", () => {
  it("compares schema-normalized strategy values rather than object key order", () => {
    const reordered = Object.fromEntries(
      Object.entries(config).reverse(),
    ) as typeof config;
    expect(configsEqual(config, reordered)).toBe(true);
  });

  it("finds a real unsaved change", () => {
    expect(configsEqual(config, { ...config, maxInventoryUsd: 49 })).toBe(
      false,
    );
  });
});
