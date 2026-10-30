import { describe, expect, it } from "vitest";
import {
  draftMarketsForSave,
  selectDraftMarkets,
} from "../lib/strategy-market-selection";

describe("strategy market selection", () => {
  const saved = [
    { marketId: "0xb", symbol: "B", overrides: { quoteSizeUsd: 7 } },
    { marketId: "0xa", symbol: "A", overrides: { spreadBps: 44 } },
  ];
  const catalog = [
    { id: "0xa", symbol: "A" },
    { id: "0xb", symbol: "B" },
    { id: "0xc", symbol: "C" },
  ];

  it("saves the ordered draft and overrides regardless of refreshed ranks", () => {
    const refreshed = [...catalog].reverse();
    expect(draftMarketsForSave(saved)).toEqual(saved);
    expect(draftMarketsForSave(saved)).toEqual(draftMarketsForSave(saved));
    expect(refreshed[0]?.id).toBe("0xc");
  });

  it("does not change selection until accepted; retained exceptions survive", () => {
    const proposal = ["0xc", "0xa"];
    expect(saved.map((market) => market.marketId)).toEqual(["0xb", "0xa"]);
    expect(selectDraftMarkets(proposal, saved, catalog)).toEqual([
      { marketId: "0xc", symbol: "C" },
      saved[1],
    ]);
  });
});
