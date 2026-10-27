import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEncryptedAgent,
  type AccountPerformanceHistory,
  type PortfolioSnapshot,
} from "@puc/aftermath";
import { makerConfigSchema, setupSchema } from "@puc/core";
import { MakerRuntime } from "../src/runtime.js";
import { Store } from "../src/store.js";

function createHarness() {
  const directory = join(
    process.env.TMPDIR ?? "/tmp",
    `aftermath-maker-${randomBytes(8).toString("hex")}`,
  );
  mkdirSync(directory, { recursive: true });
  const databaseStore = new Store(join(directory, "maker.db"));
  const masterKey = randomBytes(32).toString("base64");
  const setup = setupSchema.parse({
    ownerAddress: `0x${"1".repeat(64)}`,
    accountId: "42",
    accountCapId: "0x1234",
  });
  const store = databaseStore.forTenant(setup.ownerAddress);
  const config = makerConfigSchema.parse({
    markets: [
      { marketId: "0x5678", symbol: "SUI" },
      { marketId: "0x9999", symbol: "BTC" },
    ],
    mode: "live",
  });
  const agent = createEncryptedAgent({
    masterKey,
    context: "account:42",
  });

  store.setSetup(setup);
  store.setConfig(config);
  store.createAgent({
    ...agent,
    encryptionContext: "account:42",
  });
  store.confirmAgentGrant({
    accountId: "42",
    digest: "A".repeat(32),
    agentCapId: "0x9876",
  });

  let executionCount = 0;
  let cancellationCount = 0;
  const cancelledMarketSets: string[][] = [];
  let flattenCount = 0;
  let hedgeExecutionCount = 0;
  const executionSequence: string[] = [];
  let performanceHistory: AccountPerformanceHistory = {
    orders: [],
    marginHistory: [],
  };
  let portfolioResolver = (inputs: {
    setup: { accountId: string };
    marketIds: string[];
  }): PortfolioSnapshot => ({
    equityUsd: 100,
    availableCollateralUsd: 80,
    allocatedCollateralUsd: 20,
    freeMarginUsd: 70,
    withdrawableCollateralUsd: 75,
    grossExposureUsd: 0,
    unrealizedPnlUsd: 0,
    gasSui: 0.1,
    positions: inputs.marketIds.map((marketId) => ({
      marketId,
      baseAssetAmount: 0,
      pendingOrderCount: 0,
      inventoryUsd: 0,
      unrealizedPnlUsd: 0,
      collateralUsd: 0,
      freeMarginUsd: 0,
      makerOrderIds: [],
      hasPosition: false,
    })),
  });
  const gateway = {
    endpoint: "test",
    endpointHealth: [],
    getOrderbook: async (marketId: string) => ({
      market: {
        metadata: { symbol: marketId === "0x5678" ? "SUI" : "BTC" },
        indexPrice: 10,
        marketState: { openInterest: 1_000 },
        marketParams: { maxOpenInterest: 10_000 },
        estimatedFundingRate: () => 0.0001,
      },
      orderbook: {
        bestBidPrice: 9.99,
        bestAskPrice: 10.01,
      },
    }),
    getAgentPortfolioSnapshot: async (inputs: {
      setup: { accountId: string };
      marketIds: string[];
    }) => portfolioResolver(inputs),
    cancelMakerOrders: async (inputs: { marketIds: string[] }) => {
      cancellationCount += 1;
      cancelledMarketSets.push([...inputs.marketIds]);
      executionSequence.push("cancel");
      return {
        digest: "cancel-digest",
        endpoint: "test",
        gasUsedMist: 10,
        postedOrderIds: [],
      };
    },
    flattenPositions: async () => {
      flattenCount += 1;
      return {
        digest: "flatten-digest",
        endpoint: "test",
        gasUsedMist: 25,
        postedOrderIds: [],
        flattenedMarketIds: ["0x5678"],
      };
    },
    getAccountPerformanceHistory: async () => performanceHistory,
    executeHedge: async (inputs: {
      deltaUsd: number;
      maxOrderUsd: number;
      shouldContinue: () => boolean;
    }) => {
      if (!inputs.shouldContinue()) throw new Error("cancelled");
      hedgeExecutionCount += 1;
      executionSequence.push("hedge");
      return {
        digest: `hedge-digest-${hedgeExecutionCount}`,
        endpoint: "test",
        gasUsedMist: 15,
        postedOrderIds: [],
        side: inputs.deltaUsd > 0 ? ("ask" as const) : ("bid" as const),
        requestedNotionalUsd: Math.min(
          Math.abs(inputs.deltaUsd),
          inputs.maxOrderUsd,
        ),
      };
    },
    executeQuote: async (inputs: { shouldContinue: () => boolean }) => {
      if (!inputs.shouldContinue()) throw new Error("cancelled");
      executionCount += 1;
      executionSequence.push("quote");
      return {
        digest: "digest",
        endpoint: "test",
        gasUsedMist: 20,
        postedOrderIds: ["101", "102"],
      };
    },
  };

  const runtime = new MakerRuntime(store, gateway as never, {
    masterKey,
    liveEnabled: true,
    mainnetAllowed: true,
    builderCode: () => ({ integratorId: 7, integratorFee: 0.0001 }),
  });

  return {
    runtime,
    store: databaseStore,
    tenant: store,
    gateway,
    executions: () => executionCount,
    cancellations: () => cancellationCount,
    cancelledMarketSets: () => cancelledMarketSets,
    flattens: () => flattenCount,
    hedgeExecutions: () => hedgeExecutionCount,
    executionSequence,
    setPortfolioResolver: (resolver: typeof portfolioResolver) => {
      portfolioResolver = resolver;
    },
    setExecutions: (value: number) => {
      executionCount = value;
    },
    setPerformanceHistory: (value: AccountPerformanceHistory) => {
      performanceHistory = value;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runtime execution boundaries", () => {
  it("keeps a manual live-mode refresh read-only", async () => {
    const harness = createHarness();

    await harness.runtime.cycle();

    expect(harness.runtime.snapshot.quote).not.toBeNull();
    expect(harness.executions()).toBe(0);
    harness.store.close();
  });

  it("rotates through the configured markets", async () => {
    const harness = createHarness();

    await harness.runtime.cycle();
    expect(harness.runtime.snapshot.market.id).toBe("0x5678");
    await harness.runtime.cycle();
    expect(harness.runtime.snapshot.market.id).toBe("0x9999");
    expect(harness.runtime.snapshot.markets).toHaveLength(2);
    harness.store.close();
  });

  it("cancels the old market set before saving a replacement configuration", async () => {
    const harness = createHarness();
    harness.runtime.start();
    await harness.runtime.cycle();

    const replacement = makerConfigSchema.parse({
      markets: [{ marketId: "0xabcd", symbol: "NEW" }],
      mode: "live",
    });
    await harness.runtime.reconfigure(replacement);

    expect(harness.cancelledMarketSets()[0]).toEqual(["0x5678", "0x9999"]);
    expect(harness.tenant.getConfig()?.markets).toEqual(replacement.markets);
    await harness.runtime.stop();
    harness.store.close();
  });

  it("uses the selected market policy without mutating global defaults", async () => {
    const harness = createHarness();
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        markets: [
          {
            marketId: "0x5678",
            symbol: "SUI",
            overrides: { quoteSizeUsd: 7, spreadBps: 45 },
          },
          { marketId: "0x9999", symbol: "BTC" },
        ],
        mode: "live",
        quoteSizeUsd: 20,
        spreadBps: 25,
      }),
    );

    await harness.runtime.cycle();

    expect(harness.runtime.snapshot.quote?.sizeUsd).toBe(7);
    expect(harness.runtime.snapshot.markets[0]).toMatchObject({
      effectiveQuoteSizeUsd: 7,
      effectiveSpreadBps: 45,
    });
    expect(harness.tenant.getConfig()?.quoteSizeUsd).toBe(20);
    harness.store.close();
  });

  it("attributes only fills whose Maker order IDs were recorded", async () => {
    const harness = createHarness();
    harness.tenant.trackMakerOrders({
      accountId: "42",
      marketId: "0x5678",
      quoteDigest: "quote-digest",
      orderIds: ["tracked"],
    });
    harness.setPerformanceHistory({
      orders: [
        {
          timestampMs: Date.parse("2026-10-26T12:00:00Z"),
          txDigest: "fill-digest",
          marketId: "0x5678",
          eventType: "FilledMakerOrder",
          side: "bid",
          price: 10,
          size: 2,
          orderId: "tracked",
          realizedPnlUsd: 1,
          feesUsd: 0.02,
          maker: true,
        },
        {
          timestampMs: Date.parse("2026-10-26T12:01:00Z"),
          txDigest: "other-digest",
          marketId: "0x5678",
          eventType: "FilledMakerOrder",
          side: "ask",
          price: 10,
          size: 10,
          orderId: "another-client",
          realizedPnlUsd: 99,
          feesUsd: 0,
          maker: true,
        },
      ],
      marginHistory: [],
    });

    const performance = await harness.runtime.performance();

    expect(performance.attributed).toMatchObject({
      fills: 1,
      notionalUsd: 20,
      realizedPnlUsd: 1,
      protocolFeesUsd: 0.02,
      estimatedBuilderFeesUsd: 0.002,
      netAfterKnownCostsUsd: 0.978,
    });
    expect(performance.fills[0]?.orderId).toBe("tracked");
    harness.store.close();
  });

  it("does not hedge an untracked account fill", async () => {
    const harness = createHarness();
    const hedgeSetup = setupSchema.parse({
      ownerAddress: `0x${"1".repeat(64)}`,
      accountId: "43",
      accountCapId: "0x1243",
    });
    harness.tenant.setSetup(hedgeSetup);
    harness.tenant.confirmAgentGrant({
      accountId: "43",
      digest: "H".repeat(32),
      agentCapId: "0xhedge",
    });
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        markets: [{ marketId: "0x5678", symbol: "SUI" }],
        mode: "live",
        makerAccountId: "42",
        hedge: {
          enabled: true,
          accountId: "43",
          thresholdUsd: 25,
          maxOrderUsd: 100,
          maxSlippageBps: 75,
        },
      }),
    );
    harness.setPerformanceHistory({
      orders: [
        {
          timestampMs: Date.parse("2026-10-26T12:00:00Z"),
          txDigest: "other-client-fill",
          marketId: "0x5678",
          eventType: "FilledMakerOrder",
          side: "bid",
          price: 10,
          size: 3,
          orderId: "not-recorded-by-maker",
          realizedPnlUsd: 0,
          feesUsd: 0,
          maker: true,
        },
      ],
      marginHistory: [],
    });

    harness.runtime.start();
    await harness.runtime.cycle();

    expect(harness.hedgeExecutions()).toBe(0);
    expect(harness.cancellations()).toBe(0);
    expect(harness.executions()).toBe(1);
    await harness.runtime.stop();
    harness.store.close();
  });

  it("hedges only after an attributed Maker fill and cancels quotes first", async () => {
    const harness = createHarness();
    const hedgeSetup = setupSchema.parse({
      ownerAddress: `0x${"1".repeat(64)}`,
      accountId: "43",
      accountCapId: "0x1243",
    });
    harness.tenant.setSetup(hedgeSetup);
    harness.tenant.confirmAgentGrant({
      accountId: "43",
      digest: "H".repeat(32),
      agentCapId: "0xhedge",
    });
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        markets: [{ marketId: "0x5678", symbol: "SUI" }],
        mode: "live",
        makerAccountId: "42",
        hedge: {
          enabled: true,
          accountId: "43",
          thresholdUsd: 25,
          maxOrderUsd: 100,
          maxSlippageBps: 75,
        },
      }),
    );
    harness.tenant.trackMakerOrders({
      accountId: "42",
      marketId: "0x5678",
      quoteDigest: "quote-digest",
      orderIds: ["tracked-fill"],
    });
    harness.setPerformanceHistory({
      orders: [
        {
          timestampMs: Date.parse("2026-10-26T12:00:00Z"),
          txDigest: "fill-digest",
          marketId: "0x5678",
          eventType: "FilledMakerOrder",
          side: "bid",
          price: 10,
          size: 3,
          orderId: "tracked-fill",
          realizedPnlUsd: 0,
          feesUsd: 0,
          maker: true,
        },
      ],
      marginHistory: [],
    });
    harness.setPortfolioResolver((inputs) => {
      const maker = inputs.setup.accountId === "42";
      const inventoryUsd = maker ? 30 : 0;
      return {
        equityUsd: 100,
        availableCollateralUsd: 80,
        allocatedCollateralUsd: 20,
        freeMarginUsd: 70,
        withdrawableCollateralUsd: 75,
        grossExposureUsd: Math.abs(inventoryUsd),
        unrealizedPnlUsd: 0,
        gasSui: 0.1,
        positions: inputs.marketIds.map((marketId) => ({
          marketId,
          baseAssetAmount: maker ? 3 : 0,
          pendingOrderCount: maker && harness.cancellations() === 0 ? 2 : 0,
          inventoryUsd,
          unrealizedPnlUsd: 0,
          collateralUsd: 20,
          freeMarginUsd: 70,
          makerOrderIds: [],
          hasPosition: maker,
        })),
      };
    });

    harness.runtime.start();
    await harness.runtime.cycle();

    expect(harness.hedgeExecutions()).toBe(1);
    expect(harness.executionSequence.slice(0, 3)).toEqual([
      "cancel",
      "hedge",
      "quote",
    ]);
    expect(harness.runtime.snapshot.hedge).toMatchObject({
      enabled: true,
      state: "ready",
      accountId: "43",
      lastDigest: "hedge-digest-1",
    });
    expect(harness.tenant.listHedgeExecutions(1)[0]).toMatchObject({
      makerAccountId: "42",
      hedgeAccountId: "43",
      requestedNotionalUsd: 30,
    });
    await harness.runtime.stop();
    harness.store.close();
  });

  it("fails closed when either hedge account has an unrelated resting order", async () => {
    const harness = createHarness();
    const hedgeSetup = setupSchema.parse({
      ownerAddress: `0x${"1".repeat(64)}`,
      accountId: "43",
      accountCapId: "0x1243",
    });
    harness.tenant.setSetup(hedgeSetup);
    harness.tenant.confirmAgentGrant({
      accountId: "43",
      digest: "H".repeat(32),
      agentCapId: "0xhedge",
    });
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        markets: [{ marketId: "0x5678", symbol: "SUI" }],
        mode: "live",
        makerAccountId: "42",
        hedge: {
          enabled: true,
          accountId: "43",
          thresholdUsd: 25,
          maxOrderUsd: 100,
          maxSlippageBps: 75,
        },
      }),
    );
    harness.tenant.trackMakerOrders({
      accountId: "42",
      marketId: "0x5678",
      quoteDigest: "quote-digest",
      orderIds: ["tracked-fill"],
    });
    harness.setPerformanceHistory({
      orders: [
        {
          timestampMs: Date.parse("2026-10-26T12:00:00Z"),
          txDigest: "fill-digest",
          marketId: "0x5678",
          eventType: "FilledMakerOrder",
          side: "bid",
          price: 10,
          size: 3,
          orderId: "tracked-fill",
          realizedPnlUsd: 0,
          feesUsd: 0,
          maker: true,
        },
      ],
      marginHistory: [],
    });
    harness.setPortfolioResolver((inputs) => {
      const maker = inputs.setup.accountId === "42";
      return {
        equityUsd: 100,
        availableCollateralUsd: 80,
        allocatedCollateralUsd: 20,
        freeMarginUsd: 70,
        withdrawableCollateralUsd: 75,
        grossExposureUsd: maker ? 30 : 0,
        unrealizedPnlUsd: 0,
        gasSui: 0.1,
        positions: inputs.marketIds.map((marketId) => ({
          marketId,
          baseAssetAmount: maker ? 3 : 0,
          pendingOrderCount: maker ? 0 : 1,
          inventoryUsd: maker ? 30 : 0,
          unrealizedPnlUsd: 0,
          collateralUsd: 20,
          freeMarginUsd: 70,
          makerOrderIds: [],
          hasPosition: maker,
        })),
      };
    });

    harness.runtime.start();
    await harness.runtime.cycle();

    expect(harness.hedgeExecutions()).toBe(0);
    expect(harness.executions()).toBe(0);
    expect(harness.runtime.snapshot.running).toBe(false);
    expect(harness.runtime.snapshot.lastError).toContain(
      "clear every resting order",
    );
    expect(harness.runtime.snapshot.hedge.state).toBe("error");
    harness.store.close();
  });

  it("cancels once before a separate reduce-only flatten", async () => {
    const harness = createHarness();

    const result = await harness.runtime.flatten(0.01);

    expect(harness.cancellations()).toBe(1);
    expect(harness.flattens()).toBe(1);
    expect(result).toEqual({
      digest: "flatten-digest",
      flattenedMarketIds: ["0x5678"],
    });
    expect(harness.runtime.snapshot.running).toBe(false);
    harness.store.close();
  });

  it("cancels stale quotes even while the market RPC is stalled", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        markets: [{ marketId: "0x5678", symbol: "SUI" }],
        mode: "live",
        refreshMs: 2_000,
        maxQuoteAgeMs: 10_000,
      }),
    );

    harness.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    harness.gateway.getOrderbook = async () =>
      new Promise<never>(() => undefined);
    await vi.advanceTimersByTimeAsync(13_000);

    expect(harness.runtime.snapshot.running).toBe(false);
    expect(harness.runtime.snapshot.watchdog.state).toBe("tripped");
    expect(harness.cancellations()).toBeGreaterThanOrEqual(1);
    harness.store.close();
  });

  it("stops live quoting after equity breaches the run drawdown limit", async () => {
    const harness = createHarness();
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        markets: [{ marketId: "0x5678", symbol: "SUI" }],
        mode: "live",
        maxRunDrawdownUsd: 5,
      }),
    );

    harness.runtime.start();
    await harness.runtime.cycle();
    harness.setPortfolioResolver((inputs) => ({
      equityUsd: 94,
      availableCollateralUsd: 80,
      allocatedCollateralUsd: 20,
      freeMarginUsd: 70,
      withdrawableCollateralUsd: 75,
      grossExposureUsd: 0,
      unrealizedPnlUsd: 0,
      gasSui: 0.1,
      positions: inputs.marketIds.map((marketId) => ({
        marketId,
        baseAssetAmount: 0,
        pendingOrderCount: 0,
        inventoryUsd: 0,
        unrealizedPnlUsd: 0,
        collateralUsd: 0,
        freeMarginUsd: 0,
        makerOrderIds: [],
        hasPosition: false,
      })),
    }));
    await harness.runtime.cycle({ executeLive: true });

    expect(harness.runtime.snapshot.running).toBe(false);
    expect(harness.runtime.snapshot.lastError).toContain("run-drawdown");
    expect(harness.cancellations()).toBeGreaterThanOrEqual(1);
    harness.store.close();
  });

  it("rechecks cancellation after a possibly broadcast quote fails", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    let cancellationAttempts = 0;
    harness.gateway.executeQuote = async () => {
      throw new Error("RPC timed out after submission");
    };
    harness.gateway.cancelMakerOrders = async () => {
      cancellationAttempts += 1;
      return cancellationAttempts < 3
        ? null
        : {
            digest: "recovery-cancel-digest",
            endpoint: "test",
            gasUsedMist: 10,
            postedOrderIds: [],
          };
    };

    harness.runtime.start();
    await vi.advanceTimersByTimeAsync(4_100);

    expect(cancellationAttempts).toBe(3);
    expect(harness.runtime.snapshot.running).toBe(false);
    expect(harness.tenant.listEvents(10)).toContainEqual(
      expect.objectContaining({
        action: "cancel-maker-orders",
        outcome: "confirmed",
        detail: expect.objectContaining({ attempt: 3, attempts: 3 }),
      }),
    );
    harness.store.close();
  });

  it("does not let a stalled cycle block an operator stop", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.gateway.getOrderbook = async () =>
      new Promise<never>(() => undefined);

    harness.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopping = harness.runtime.stop();
    await vi.advanceTimersByTimeAsync(5_100);
    await stopping;

    expect(harness.cancellations()).toBe(1);
    expect(harness.runtime.snapshot.running).toBe(false);
    harness.store.close();
  });

  it("invalidates an in-flight cycle before signing when stopped", async () => {
    const harness = createHarness();
    let entered!: () => void;
    let release!: () => void;
    const atExecution = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const continueExecution = new Promise<void>((resolve) => {
      release = resolve;
    });

    harness.gateway.executeQuote = async (inputs: {
      shouldContinue: () => boolean;
    }) => {
      entered();
      await continueExecution;
      if (!inputs.shouldContinue()) throw new Error("cancelled");
      harness.setExecutions(harness.executions() + 1);
      return {
        digest: "digest",
        endpoint: "test",
        gasUsedMist: 20,
        postedOrderIds: ["101", "102"],
      };
    };

    harness.runtime.start();
    await atExecution;
    const stopping = harness.runtime.stop();
    release();
    await stopping;

    expect(harness.executions()).toBe(0);
    expect(harness.cancellations()).toBe(1);
    expect(harness.runtime.snapshot.running).toBe(false);
    expect(harness.runtime.snapshot.lastError).toBeNull();
    harness.store.close();
  });
});
