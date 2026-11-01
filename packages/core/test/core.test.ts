import { describe, expect, it } from "vitest";
import {
  aggregatePortfolioQuoteRisk,
  assertBuilderFeePolicy,
  assertNoBuilderFee,
  buildQuoteIntent,
  evaluateQuoteSafety,
  makerConfigSchema,
  MutationLock,
  PriorityMutationQueue,
  resolveMarketConfig,
} from "../src/index.js";

const config = makerConfigSchema.parse({
  markets: [{ marketId: "0x1234", symbol: "SUI-PERP" }],
});
const safetyDefaults = {
  portfolioAvailableCollateralUsd: 1_000,
  agentGasSui: 1,
};

describe("quote strategy", () => {
  it("stays post-only and skews away from a long inventory", () => {
    const neutral = buildQuoteIntent({
      config,
      observation: {
        marketId: config.markets[0]!.marketId,
        bestBid: 9.99,
        bestAsk: 10.01,
        indexPrice: 10,
        tickSize: 0.01,
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
        tickSize: 0.01,
        observedAt: new Date("2026-10-26T12:00:00Z"),
      },
      inventoryUsd: 40,
      unrealizedPnlUsd: 0,
    });

    expect(neutral.bidPrice).toBeLessThan(neutral.askPrice);
    expect(long.bidPrice).toBeLessThan(neutral.bidPrice);
    expect(long.askPrice).toBeLessThan(neutral.askPrice);
  });

  it("reserves a valid venue tick when fair value is outside the book", () => {
    const observedAt = new Date("2026-10-26T12:00:00Z");
    const highFairValue = buildQuoteIntent({
      config: { ...config, spreadBps: 8 },
      observation: {
        marketId: config.markets[0]!.marketId,
        bestBid: 0.02135,
        bestAsk: 0.02136,
        indexPrice: 0.0214,
        tickSize: 0.000001,
        observedAt,
      },
      inventoryUsd: 0,
      unrealizedPnlUsd: 0,
    });
    const lowFairValue = buildQuoteIntent({
      config: { ...config, spreadBps: 8 },
      observation: {
        marketId: config.markets[0]!.marketId,
        bestBid: 0.02135,
        bestAsk: 0.02136,
        indexPrice: 0.0213,
        tickSize: 0.000001,
        observedAt,
      },
      inventoryUsd: 0,
      unrealizedPnlUsd: 0,
    });

    expect(highFairValue.bidPrice).toBe(0.021359);
    expect(highFairValue.bidPrice).toBeLessThan(highFairValue.bestAsk);
    expect(lowFairValue.askPrice).toBe(0.021351);
    expect(lowFairValue.askPrice).toBeGreaterThan(lowFairValue.bestBid);
    for (const price of [
      highFairValue.bidPrice,
      highFairValue.askPrice,
      lowFairValue.bidPrice,
      lowFairValue.askPrice,
    ]) {
      expect(price / 0.000001).toBeCloseTo(Math.round(price / 0.000001), 8);
    }
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
          tickSize: 0.01,
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
        tickSize: 0.01,
        observedAt: new Date("2026-10-26T12:00:00Z"),
      },
      inventoryUsd: 0,
      unrealizedPnlUsd: 0,
    });
    const checks = evaluateQuoteSafety({
      ...safetyDefaults,
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
        tickSize: 0.01,
        observedAt: new Date("2026-10-26T12:00:00Z"),
      },
      inventoryUsd: 0,
      unrealizedPnlUsd: 0,
    });
    const checks = evaluateQuoteSafety({
      ...safetyDefaults,
      config: bounded,
      quote,
      now: new Date("2026-10-26T12:00:01Z"),
      setupComplete: true,
      hasAgentKey: true,
      liveEnabled: true,
      mainnetAllowed: true,
    });

    const fairValue = checks.find((check) => check.code === "fair-value");
    expect(fairValue?.ok).toBe(false);
    expect(fairValue?.detail).toContain("limit 15.0 bps");
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
        tickSize: 0.01,
        observedAt: new Date("2026-10-26T12:00:00Z"),
      },
      inventoryUsd: 4,
      unrealizedPnlUsd: 0,
    });
    const checks = evaluateQuoteSafety({
      ...safetyDefaults,
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
        tickSize: 0.01,
        observedAt: new Date("2026-10-26T12:00:00Z"),
      },
      inventoryUsd: 1,
      unrealizedPnlUsd: 0,
    });
    const checks = evaluateQuoteSafety({
      ...safetyDefaults,
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

  it("rejects aggregate simultaneous fills across resting markets", () => {
    const bounded = makerConfigSchema.parse({
      markets: Array.from({ length: 10 }, (_, index) => ({
        marketId: `0x${index + 1}`,
        symbol: `M${index + 1}`,
      })),
      quoteSizeUsd: 10,
      maxInventoryUsd: 30,
      maxGrossExposureUsd: 150,
    });
    const quote = buildQuoteIntent({
      config: bounded,
      observation: {
        marketId: bounded.markets[0]!.marketId,
        bestBid: 9.99,
        bestAsk: 10.01,
        indexPrice: 10,
        tickSize: 0.01,
        observedAt: new Date("2026-10-26T12:00:00Z"),
      },
      inventoryUsd: 10,
      unrealizedPnlUsd: 0,
    });
    const aggregate = aggregatePortfolioQuoteRisk(
      Array.from({ length: 10 }, () => ({
        inventoryUsd: 10,
        restingQuoteSizeUsd: 10,
        maxLeverage: 1,
      })),
    );
    const checks = evaluateQuoteSafety({
      ...safetyDefaults,
      config: bounded,
      quote,
      now: new Date("2026-10-26T12:00:01Z"),
      setupComplete: true,
      hasAgentKey: true,
      liveEnabled: true,
      mainnetAllowed: true,
      portfolioGrossExposureUsd: 100,
      portfolioWorstCaseExposureUsd: aggregate.worstCaseGrossExposureUsd,
      portfolioAvailableCollateralUsd: 1_000,
      portfolioRequiredQuoteCollateralUsd: aggregate.requiredQuoteCollateralUsd,
      agentGasSui: 1,
    });

    expect(aggregate.worstCaseGrossExposureUsd).toBe(200);
    expect(checks.find((check) => check.code === "gross-exposure")?.ok).toBe(
      false,
    );
  });

  it("requires aggregate collateral and three gas ceilings for Live, one for Paper", () => {
    const bounded = makerConfigSchema.parse({
      markets: [{ marketId: "0x1234", symbol: "SUI-PERP" }],
      mode: "live",
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
        tickSize: 0.01,
        observedAt: new Date("2026-10-26T12:00:00Z"),
      },
      inventoryUsd: 0,
      unrealizedPnlUsd: 0,
    });
    const checks = evaluateQuoteSafety({
      ...safetyDefaults,
      config: bounded,
      quote,
      now: new Date("2026-10-26T12:00:01Z"),
      setupComplete: true,
      hasAgentKey: true,
      liveEnabled: true,
      mainnetAllowed: true,
      portfolioAvailableCollateralUsd: 9.99,
      agentGasSui: 0.149,
    });

    expect(checks.find((check) => check.code === "collateral")?.ok).toBe(false);
    expect(checks.find((check) => check.code === "gas")?.ok).toBe(false);
    const paper = evaluateQuoteSafety({
      ...safetyDefaults,
      config: { ...bounded, mode: "paper" },
      quote,
      now: new Date("2026-10-26T12:00:01Z"),
      agentGasSui: 0.06,
      portfolioAvailableCollateralUsd: 50,
    });
    expect(paper.find((check) => check.code === "gas")?.ok).toBe(true);
    expect(paper.find((check) => check.code === "gas")?.detail).toContain(
      "one Paper simulation",
    );
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
        tickSize: 0.01,
        observedAt: new Date("2026-10-26T12:00:00Z"),
      },
      inventoryUsd: 0,
      unrealizedPnlUsd: 0,
    });
    const checks = evaluateQuoteSafety({
      ...safetyDefaults,
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
        tickSize: 0.01,
        observedAt: new Date("2026-10-26T12:00:00Z"),
      },
      inventoryUsd: 0,
      unrealizedPnlUsd: -(config.maxUnrealizedLossUsd + 1),
    });
    const checks = evaluateQuoteSafety({
      ...safetyDefaults,
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
  it("supports an N-market universe up to the explicit server cap", () => {
    const config = makerConfigSchema.parse({
      markets: Array.from({ length: 64 }, (_, index) => ({
        marketId: `0x${(index + 1).toString(16)}`,
        symbol: `M${index + 1}`,
      })),
      rotationMode: "single-slot",
      refreshMs: 2_000,
      maxQuoteAgeMs: 90_000,
    });

    expect(config.markets).toHaveLength(64);
    expect(config.rotationMode).toBe("single-slot");
    expect(() =>
      makerConfigSchema.parse({
        ...config,
        markets: [...config.markets, { marketId: "0x100", symbol: "M65" }],
      }),
    ).toThrow();
  });

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

  it("requires the quote watchdog to cover its observation window", () => {
    expect(() =>
      makerConfigSchema.parse({
        markets: [
          { marketId: "0x1234", symbol: "SUI" },
          { marketId: "0x5678", symbol: "BTC" },
        ],
        refreshMs: 10_000,
        maxQuoteAgeMs: 15_000,
      }),
    ).toThrow("observation window");
  });

  it("requires single-slot watchdog headroom above forced refresh", () => {
    expect(() =>
      makerConfigSchema.parse({
        markets: [{ marketId: "0x1234", symbol: "SUI" }],
        rotationMode: "single-slot",
        refreshMs: 2_000,
        maxRestingMs: 60_000,
        maxQuoteAgeMs: 60_000,
      }),
    ).toThrow("observation window");
  });

  it("requires paired hedging and a pre-limit threshold for auto-rebalance", () => {
    expect(() =>
      makerConfigSchema.parse({
        markets: [{ marketId: "0x1234", symbol: "SUI" }],
        autoRebalanceEnabled: true,
        rebalanceGrossExposureUsd: 100,
        maxGrossExposureUsd: 50,
      }),
    ).toThrow("Automatic rebalancing");
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
      tickSize: 0.01,
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

  it("runs urgent cancellation work before queued normal mutations", async () => {
    const queue = new PriorityMutationQueue();
    const order: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.run(async () => {
      order.push("active");
      await blocked;
    });
    const normal = queue.run(async () => {
      order.push("normal");
    });
    const urgent = queue.run(async () => {
      order.push("cancel");
    }, "urgent");
    await Promise.resolve();
    release();
    await Promise.all([first, normal, urgent]);
    expect(order).toEqual(["active", "cancel", "normal"]);
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
