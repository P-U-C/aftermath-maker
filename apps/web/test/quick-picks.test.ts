import { describe, expect, it } from "vitest";

import { quickPickMarketIds } from "../lib/quick-picks";

const opportunities = [
  {
    marketId: "A",
    eligible: true,
    objectiveEligible: true,
    thinActive: false,
    farmingScore: 80,
    bothScore: 40,
    priceChange24hPct: 2,
  },
  {
    marketId: "B",
    eligible: true,
    objectiveEligible: true,
    thinActive: true,
    farmingScore: 95,
    bothScore: 88,
    priceChange24hPct: -0.1,
  },
  {
    marketId: "C",
    eligible: true,
    objectiveEligible: false,
    thinActive: true,
    farmingScore: 90,
    bothScore: 99,
    priceChange24hPct: 0.4,
  },
  {
    marketId: "D",
    eligible: false,
    objectiveEligible: true,
    thinActive: true,
    farmingScore: 100,
    bothScore: 90,
    priceChange24hPct: 0.2,
  },
  {
    marketId: "E",
    eligible: true,
    objectiveEligible: true,
    thinActive: false,
    farmingScore: 70,
    bothScore: 77,
    priceChange24hPct: null,
  },
] as const;

describe("quickPickMarketIds", () => {
  it("applies every strategy pick and the selection cap", () => {
    expect(quickPickMarketIds(opportunities, "rewards", 5)).toEqual([
      "B",
      "A",
      "E",
    ]);
    expect(quickPickMarketIds(opportunities, "balanced", 5)).toEqual([
      "B",
      "E",
      "A",
    ]);
    expect(quickPickMarketIds(opportunities, "quiet", 2)).toEqual(["B"]);
    expect(quickPickMarketIds(opportunities, "steady", 5)).toEqual(["B", "A"]);
    expect(quickPickMarketIds(opportunities, "clear", 5)).toEqual([]);
  });
});
