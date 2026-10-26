import { describe, expect, it } from "vitest";
import {
  assertBuilderFeePolicy,
  assertNoBuilderFee,
  buildQuoteIntent,
  evaluateQuoteSafety,
  makerConfigSchema,
  MutationLock,
} from "../src/index.js";

const config = makerConfigSchema.parse({
  markets: [{ marketId: "0x1234", symbol: "SUI-PERP" }],
});

describe("quote strategy", () => {
  it("stays post-only and skews away from a long inventory", () => {
    const neutral = buildQuoteIntent({
      config,
      observation: {
        marketId: config.markets[0]!.marketId,
        bestBid: 9.99,
        bestAsk: 10.01,
        observedAt: new Date("2026-10-26T12:00:00Z"),
      },
      inventoryUsd: 0,
      unrealizedPnlUsd: 0,
    });
    const long = buildQuoteIntent({
      config,
      observation: {
        marketId: config.markets[0]!.marketId,
        bestBid: 9.99,
        bestAsk: 10.01,
        observedAt: new Date("2026-10-26T12:00:00Z"),
      },
      inventoryUsd: 40,
      unrealizedPnlUsd: 0,
    });

    expect(neutral.bidPrice).toBeLessThan(neutral.askPrice);
    expect(long.bidPrice).toBeLessThan(neutral.bidPrice);
    expect(long.askPrice).toBeLessThan(neutral.askPrice);
  });

  it("rejects crossed observations", () => {
    expect(() =>
      buildQuoteIntent({
        config,
        observation: {
          marketId: config.markets[0]!.marketId,
          bestBid: 10,
          bestAsk: 10,
          observedAt: new Date(),
        },
        inventoryUsd: 0,
        unrealizedPnlUsd: 0,
      }),
    ).toThrow("crossed");
  });
});

describe("risk gates", () => {
  it("requires both independent live switches", () => {
    const quote = buildQuoteIntent({
      config: { ...config, mode: "live" },
      observation: {
        marketId: config.markets[0]!.marketId,
        bestBid: 9.99,
        bestAsk: 10.01,
        observedAt: new Date("2026-10-26T12:00:00Z"),
      },
      inventoryUsd: 0,
      unrealizedPnlUsd: 0,
    });
    const checks = evaluateQuoteSafety({
      config: { ...config, mode: "live" },
      quote,
      now: new Date("2026-10-26T12:00:01Z"),
      setupComplete: true,
      hasAgentKey: true,
      liveEnabled: true,
      mainnetAllowed: false,
    });
    expect(checks.find((check) => check.code === "live-gate")?.ok).toBe(false);
  });

  it("stops when unrealized losses exceed the configured floor", () => {
    const quote = buildQuoteIntent({
      config,
      observation: {
        marketId: config.markets[0]!.marketId,
        bestBid: 9.99,
        bestAsk: 10.01,
        observedAt: new Date("2026-10-26T12:00:00Z"),
      },
      inventoryUsd: 0,
      unrealizedPnlUsd: -(config.maxUnrealizedLossUsd + 1),
    });
    const checks = evaluateQuoteSafety({
      config,
      quote,
      now: new Date("2026-10-26T12:00:01Z"),
      setupComplete: true,
      hasAgentKey: true,
      liveEnabled: false,
      mainnetAllowed: false,
    });

    expect(checks.find((check) => check.code === "unrealized-loss")?.ok).toBe(
      false,
    );
  });
});

describe("portfolio configuration", () => {
  it("rejects duplicate markets", () => {
    expect(() =>
      makerConfigSchema.parse({
        markets: [
          { marketId: "0x1234", symbol: "SUI" },
          { marketId: "0x1234", symbol: "SUI-SECOND" },
        ],
      }),
    ).toThrow("unique");
  });

  it("requires the gross limit to cover one market", () => {
    expect(() =>
      makerConfigSchema.parse({
        markets: [{ marketId: "0x1234", symbol: "SUI" }],
        maxInventoryUsd: 100,
        maxGrossExposureUsd: 50,
      }),
    ).toThrow("Gross exposure");
  });
});

describe("transaction policy", () => {
  it("rejects nested builder fee fields", () => {
    expect(() =>
      assertNoBuilderFee({ order: { builderCode: { integratorId: 2 } } }),
    ).toThrow("forbidden");
  });

  it("allows only the disclosed builder code and exact fee", () => {
    const request = {
      order: { builderCode: { integratorId: 7, integratorFee: 0.0001 } },
    };
    expect(() =>
      assertBuilderFeePolicy(request, {
        integratorId: 7,
        integratorFee: 0.0001,
      }),
    ).not.toThrow();
    expect(() =>
      assertBuilderFeePolicy(request, {
        integratorId: 7,
        integratorFee: 0.0002,
      }),
    ).toThrow("Unexpected builder fee");
    expect(() =>
      assertBuilderFeePolicy(
        { integratorId: 7 },
        {
          integratorId: 7,
          integratorFee: 0.0001,
        },
      ),
    ).toThrow("misplaced");
  });

  it("serializes mutations", async () => {
    const lock = new MutationLock();
    const order: number[] = [];
    await Promise.all([
      lock.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(1);
      }),
      lock.run(async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);
  });
});
