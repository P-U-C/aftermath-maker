import { describe, expect, it } from "vitest";
import {
  summarizeStrategyResult,
  type StrategyResultFill,
} from "../src/index.js";

const fill = (
  overrides: Partial<StrategyResultFill> &
    Pick<StrategyResultFill, "side" | "price">,
): StrategyResultFill => ({
  occurredAt: "2026-11-04T10:00:00.000Z",
  marketId: "0xnear",
  account: "maker",
  sizeUsd: 10,
  feesUsd: 0,
  ...overrides,
});

describe("strategy result", () => {
  it("realizes a round trip at average cost and subtracts fees", () => {
    const result = summarizeStrategyResult({
      fills: [
        fill({ side: "bid", price: 2, feesUsd: 0.01 }),
        fill({
          side: "ask",
          price: 2.2,
          sizeUsd: 11,
          feesUsd: 0.01,
          occurredAt: "2026-11-04T11:00:00.000Z",
        }),
      ],
      marks: new Map(),
      requiredCollateralUsd: 100,
    });
    // Bought 5 at 2, sold 5 at 2.2: +1.00 before fees.
    expect(result.realizedPnlUsd).toBeCloseTo(1, 9);
    expect(result.unrealizedPnlUsd).toBeCloseTo(0, 9);
    expect(result.netUsd).toBeCloseTo(0.98, 9);
    expect(result.returnPct).toBeCloseTo(0.98, 9);
    expect(result.volumeUsd).toBe(21);
    expect(result.since).toBe("2026-11-04T10:00:00.000Z");
  });

  it("marks an open position at the current price", () => {
    const result = summarizeStrategyResult({
      fills: [fill({ side: "ask", price: 2 })],
      marks: new Map([["0xnear", 1.8]]),
      requiredCollateralUsd: 50,
    });
    // Short 5 from 2, mark 1.8: +1.00 unrealized.
    expect(result.unrealizedPnlUsd).toBeCloseTo(1, 9);
    expect(result.netUsd).toBeCloseTo(1, 9);
  });

  it("keeps a hedge account separate from the maker account", () => {
    const result = summarizeStrategyResult({
      fills: [
        fill({ side: "bid", price: 2 }),
        fill({ side: "ask", price: 2, account: "hedge" }),
      ],
      marks: new Map([["0xnear", 2.5]]),
      requiredCollateralUsd: 50,
    });
    // Long 5 and short 5 on different accounts: +2.50 and -2.50, nothing realized.
    expect(result.realizedPnlUsd).toBe(0);
    expect(result.unrealizedPnlUsd).toBeCloseTo(0, 9);
  });

  it("handles a fill that flips the position", () => {
    const result = summarizeStrategyResult({
      fills: [
        fill({ side: "bid", price: 2, sizeUsd: 10 }),
        fill({
          side: "ask",
          price: 2.5,
          sizeUsd: 25,
          occurredAt: "2026-11-04T12:00:00.000Z",
        }),
      ],
      marks: new Map([["0xnear", 2.5]]),
      requiredCollateralUsd: 0,
    });
    // Closed 5 for +2.50, then short 5 at 2.5 marked at 2.5.
    expect(result.realizedPnlUsd).toBeCloseTo(2.5, 9);
    expect(result.unrealizedPnlUsd).toBeCloseTo(0, 9);
    expect(result.returnPct).toBeNull();
  });

  it("uses the venue's realized PnL for Live and adds live unrealized", () => {
    const result = summarizeStrategyResult({
      fills: [
        fill({ side: "bid", price: 2, realizedPnlUsd: 0, feesUsd: 0.02 }),
        fill({ side: "ask", price: 2.1, realizedPnlUsd: 0.25, feesUsd: 0.02 }),
      ],
      marks: new Map(),
      requiredCollateralUsd: 100,
      reportedRealized: true,
      unrealizedPnlUsd: -0.1,
    });
    expect(result.realizedPnlUsd).toBeCloseTo(0.25, 9);
    expect(result.netUsd).toBeCloseTo(0.25 - 0.1 - 0.04, 9);
  });

  it("reports nothing for a strategy with no fills", () => {
    const result = summarizeStrategyResult({
      fills: [],
      marks: new Map(),
      requiredCollateralUsd: 100,
    });
    expect(result).toMatchObject({
      fills: 0,
      netUsd: 0,
      returnPct: null,
      since: null,
    });
  });
});
