import { describe, expect, it } from "vitest";
import {
  quoteExposureUsed,
  suggestedGrossExposureLimit,
} from "../lib/strategy-limits";

describe("strategy gross exposure suggestion", () => {
  it("adds every quote size and one maximum inventory allowance", () => {
    const markets = [
      { overrides: { quoteSizeUsd: 12 } },
      {},
      { overrides: { quoteSizeUsd: 8 } },
    ];

    expect(quoteExposureUsed(markets, 10)).toBe(30);
    expect(suggestedGrossExposureLimit(markets, 10, 50)).toBe(80);
  });
});
