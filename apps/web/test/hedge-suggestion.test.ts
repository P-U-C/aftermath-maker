import { describe, expect, it } from "vitest";
import { hedgeSizingSuggestion } from "../lib/hedge-suggestion";

const bundle = {
  name: "Core",
  makerAccountId: "1",
  hedgeAccountId: "2",
  authorizedMaker: true,
  authorizedHedge: true,
  hedgeAvailableUsd: 100,
};
const markets = [
  { quoteSizeUsd: 10, minimumOrderUsd: 6 },
  { quoteSizeUsd: 20, minimumOrderUsd: 4 },
];

describe("hedge sizing draft suggestion", () => {
  it("uses effective quote sizes and venue minimums without raising slippage", () => {
    expect(hedgeSizingSuggestion({ markets, bundles: [bundle] })).toEqual({
      thresholdUsd: 10,
      maxOrderUsd: 20,
    });
  });
  it("blocks unknown minimum, missing account and insufficient hedge collateral", () => {
    expect(
      hedgeSizingSuggestion({
        markets: [{ quoteSizeUsd: 10, minimumOrderUsd: null }],
        bundles: [bundle],
      }),
    ).toHaveProperty("blocker");
    expect(
      hedgeSizingSuggestion({
        markets,
        bundles: [{ ...bundle, hedgeAccountId: null }],
      }),
    ).toHaveProperty("blocker");
    expect(
      hedgeSizingSuggestion({
        markets,
        bundles: [{ ...bundle, hedgeAvailableUsd: 0 }],
      }),
    ).toHaveProperty("blocker");
  });
  it("checks each attached bundle, not just Core", () => {
    expect(
      hedgeSizingSuggestion({
        markets,
        bundles: [
          bundle,
          { ...bundle, name: "Rewards", hedgeAvailableUsd: null },
        ],
      }),
    ).toHaveProperty("blocker");
  });
});
