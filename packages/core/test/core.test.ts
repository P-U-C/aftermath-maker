import { describe, expect, it } from "vitest";
import {
  assertBuilderFeePolicy,
  assertNoBuilderFee,
  buildQuoteIntent,
  evaluateQuoteSafety,
  makerConfigSchema,
  MutationLock,
  resolveMarketConfig,
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
        indexPrice: 10,
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
        indexPrice: 10,
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
          indexPrice: 10,
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
        indexPrice: 10,
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

  it("rejects a thin book that diverges from the protocol index", () => {
    const bounded = makerConfigSchema.parse({
      markets: [{ marketId: "0x1234", symbol: "SUI-PERP" }],
      maxBookDivergenceBps: 50,
    });
    const quote = buildQuoteIntent({
      config: bounded,
      observation: {
        marketId: bounded.markets[0]!.marketId,
        bestBid: 10.09,
        bestAsk: 10.11,
        indexPrice: 10,
        observedAt: new Date("2026-10-26T12:00:00Z"),
      },
      inventoryUsd: 0,
      unrealizedPnlUsd: 0,
    });
    const checks = evaluateQuoteSafety({
      config: bounded,
      quote,
      now: new Date("2026-10-26T12:00:01Z"),
      setupComplete: true,
      hasAgentKey: true,
      liveEnabled: true,
      mainnetAllowed: true,
    });

    expect(checks.find((check) => check.code === "fair-value")?.ok).toBe(false);
    expect(quote.bidPrice).toBeLessThan(10);
  });

  it("rejects a quote whose next fill would breach inventory limits", () => {
    const bounded = makerConfigSchema.parse({
      markets: [{ marketId: "0x1234", symbol: "SUI-PERP" }],
      quoteSizeUsd: 2,
      maxInventoryUsd: 5,
      maxGrossExposureUsd: 10,
    });
    const quote = buildQuoteIntent({
      config: bounded,
      observation: {
        marketId: bounded.markets[0]!.marketId,
        bestBid: 9.99,
        bestAsk: 10.01,
        indexPrice: 10,
        observedAt: new Date("2026-10-26T12:00:00Z"),
      },
      inventoryUsd: 4,
      unrealizedPnlUsd: 0,
    });
    const checks = evaluateQuoteSafety({
      config: bounded,
      quote,
      now: new Date("2026-10-26T12:00:01Z"),
      setupComplete: true,
      hasAgentKey: true,
      liveEnabled: true,
      mainnetAllowed: true,
      portfolioGrossExposureUsd: 4,
    });

    expect(checks.find((check) => check.code === "inventory")?.ok).toBe(false);
  });

  it("rejects a quote whose next fill would breach portfolio exposure", () => {
    const bounded = makerConfigSchema.parse({
      markets: [{ marketId: "0x1234", symbol: "SUI-PERP" }],
      quoteSizeUsd: 2,
      maxInventoryUsd: 10,
      maxGrossExposureUsd: 10,
    });
    const quote = buildQuoteIntent({
      config: bounded,
      observation: {
        marketId: bounded.markets[0]!.marketId,
        bestBid: 9.99,
        bestAsk: 10.01,
        indexPrice: 10,
        observedAt: new Date("2026-10-26T12:00:00Z"),
      },
      inventoryUsd: 1,
      unrealizedPnlUsd: 0,
    });
    const checks = evaluateQuoteSafety({
      config: bounded,
      quote,
      now: new Date("2026-10-26T12:00:01Z"),
      setupComplete: true,
      hasAgentKey: true,
      liveEnabled: true,
      mainnetAllowed: true,
      portfolioGrossExposureUsd: 9.5,
    });

    expect(checks.find((check) => check.code === "gross-exposure")?.ok).toBe(
      false,
    );
  });

  it("requires collateral for both sides and one full gas ceiling", () => {
    const bounded = makerConfigSchema.parse({
      markets: [{ marketId: "0x1234", symbol: "SUI-PERP" }],
      quoteSizeUsd: 10,
      maxLeverage: 2,
      maxGasMist: 50_000_000,
    });
    const quote = buildQuoteIntent({
      config: bounded,
      observation: {
        marketId: bounded.markets[0]!.marketId,
        bestBid: 9.99,
        bestAsk: 10.01,
        indexPrice: 10,
        observedAt: new Date("2026-10-26T12:00:00Z"),
      },
      inventoryUsd: 0,
      unrealizedPnlUsd: 0,
    });
    const checks = evaluateQuoteSafety({
      config: bounded,
      quote,
      now: new Date("2026-10-26T12:00:01Z"),
      setupComplete: true,
      hasAgentKey: true,
      liveEnabled: true,
      mainnetAllowed: true,
      portfolioAvailableCollateralUsd: 9.99,
      agentGasSui: 0.049,
    });

    expect(checks.find((check) => check.code === "collateral")?.ok).toBe(false);
    expect(checks.find((check) => check.code === "gas")?.ok).toBe(false);
  });

  it("stops when run equity drawdown exceeds its circuit breaker", () => {
    const bounded = makerConfigSchema.parse({
      markets: [{ marketId: "0x1234", symbol: "SUI-PERP" }],
      maxRunDrawdownUsd: 5,
    });
    const quote = buildQuoteIntent({
      config: bounded,
      observation: {
        marketId: bounded.markets[0]!.marketId,
        bestBid: 9.99,
        bestAsk: 10.01,
        indexPrice: 10,
        observedAt: new Date("2026-10-26T12:00:00Z"),
      },
      inventoryUsd: 0,
      unrealizedPnlUsd: 0,
    });
    const checks = evaluateQuoteSafety({
      config: bounded,
      quote,
      now: new Date("2026-10-26T12:00:01Z"),
      setupComplete: true,
      hasAgentKey: true,
      liveEnabled: true,
      mainnetAllowed: true,
      runDrawdownUsd: 5.01,
    });

    expect(checks.find((check) => check.code === "run-drawdown")?.ok).toBe(
      false,
    );
  });

  it("stops when unrealized losses exceed the configured floor", () => {
    const quote = buildQuoteIntent({
      config,
      observation: {
        marketId: config.markets[0]!.marketId,
        bestBid: 9.99,
        bestAsk: 10.01,
        indexPrice: 10,
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

  it("requires the quote watchdog to cover a full market rotation", () => {
    expect(() =>
      makerConfigSchema.parse({
        markets: [
          { marketId: "0x1234", symbol: "SUI" },
          { marketId: "0x5678", symbol: "BTC" },
        ],
        refreshMs: 10_000,
        maxQuoteAgeMs: 15_000,
      }),
    ).toThrow("full rotation");
  });

  it("requires distinct account roles for same-venue hedging", () => {
    expect(() =>
      makerConfigSchema.parse({
        markets: [{ marketId: "0x1234", symbol: "SUI" }],
        makerAccountId: "42",
        hedge: {
          enabled: true,
          accountId: "42",
          thresholdUsd: 25,
          maxOrderUsd: 100,
          maxSlippageBps: 75,
        },
      }),
    ).toThrow("different");
  });

  it("requires the maximum hedge order to cover its trigger", () => {
    expect(() =>
      makerConfigSchema.parse({
        markets: [{ marketId: "0x1234", symbol: "SUI" }],
        makerAccountId: "42",
        hedge: {
          enabled: true,
          accountId: "43",
          thresholdUsd: 50,
          maxOrderUsd: 25,
          maxSlippageBps: 75,
        },
      }),
    ).toThrow("cover the hedge threshold");
  });

  it("applies market policy overrides without changing global defaults", () => {
    const configured = makerConfigSchema.parse({
      markets: [
        {
          marketId: "0x1234",
          symbol: "SUI",
          overrides: {
            quoteSizeUsd: 7,
            spreadBps: 45,
            inventoryTargetUsd: 10,
          },
        },
      ],
      quoteSizeUsd: 20,
      spreadBps: 25,
      inventoryTargetUsd: 0,
    });
    const effective = resolveMarketConfig(configured, configured.markets[0]!);

    expect(effective.quoteSizeUsd).toBe(7);
    expect(effective.spreadBps).toBe(45);
    expect(effective.inventoryTargetUsd).toBe(10);
    expect(configured.quoteSizeUsd).toBe(20);
  });

  it("treats inventory at its configured target as neutral", () => {
    const targeted = makerConfigSchema.parse({
      markets: [{ marketId: "0x1234", symbol: "SUI" }],
      inventoryTargetUsd: 10,
    });
    const observation = {
      marketId: "0x1234",
      bestBid: 9.99,
      bestAsk: 10.01,
      indexPrice: 10,
      observedAt: new Date("2026-10-26T12:00:00Z"),
    };

    const atTarget = buildQuoteIntent({
      config: targeted,
      observation,
      inventoryUsd: 10,
      unrealizedPnlUsd: 0,
    });
    const neutral = buildQuoteIntent({
      config: { ...targeted, inventoryTargetUsd: 0 },
      observation,
      inventoryUsd: 0,
      unrealizedPnlUsd: 0,
    });

    expect(atTarget.bidPrice).toBe(neutral.bidPrice);
    expect(atTarget.askPrice).toBe(neutral.askPrice);
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
