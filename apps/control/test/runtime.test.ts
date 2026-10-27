import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEncryptedAgent,
  type AccountPerformanceHistory,
  type PortfolioSnapshot,
  type RewardDashboard,
} from "@puc/aftermath";
import {
  makerConfigSchema,
  setupSchema,
  type StrategyObjective,
} from "@puc/core";
import { MakerRuntime } from "../src/runtime.js";
import { Store } from "../src/store.js";

function rewardDashboard(objective: StrategyObjective): RewardDashboard {
  return {
    asOf: "2026-10-27T12:00:00.000Z",
    epoch: {
      number: 4,
      startedAt: "2026-10-26T00:00:00.000Z",
      cutoffAt: "2026-11-02T00:00:00.000Z",
    },
    account: {
      trackedAccountIds: ["42", "43"],
      error: null,
      makerRewardsSui: 0,
      qScoreShare: 0,
      uptime: 0,
      makerVolumeUsd: 0,
      makerVolumeShare: 0,
      directRebatesUsd: 0,
      baseMakerFeesUsd: 0,
      accounts: [],
    },
    marketModel: {
      label: "heuristic",
      methodology: "test",
      depthBandBps: 50,
      opportunities: [
        {
          rank: 1,
          marketId: "0x5678",
          symbol: "SUI",
          minOrderUsdValue: 1,
          minimumQuoteSizeUsd: 1.04,
          objective,
          score:
            objective === "farming" ? 82 : objective === "profit" ? 64 : 71,
          farmingScore: 82,
          profitScore: 64,
          bothScore: 71,
          confidence: "high",
          eligible: true,
          objectiveEligible: true,
          thinActive: true,
          sessionOpen: true,
          observedSpreadBps: 12,
          preRiskEdgeBps: 5,
          balancedDepth50BpsUsd: 600,
          volume24hUsd: 100_000,
          openInterestUsd: 2_000,
          openInterestUtilizationPct: 10,
          volumeToDepth: 166,
          fundingRate: 0,
          priceChange24hPct: 1,
          makerRebateBps: 0.5,
          builderFeeBps: 1,
          knownCostBps: 0.5,
          suggestedSpreadBps:
            objective === "farming" ? 10 : objective === "profit" ? 16 : 12,
          suggestedQuoteSizeUsd: 20,
          reasons: ["test"],
          error: null,
        },
      ],
    },
  };
}

function createHarness(options: { configured?: boolean } = {}) {
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
  if (options.configured !== false) store.setConfig(config);
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
  const flattenedAccountIds: string[] = [];
  let hedgeExecutionCount = 0;
  const executionSequence: string[] = [];
  const quoteInputs: Array<{ cancelMarketIds?: string[] }> = [];
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
        tickSize: () => 0.01,
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
    flattenPositions: async (inputs: { setup: { accountId: string } }) => {
      flattenCount += 1;
      flattenedAccountIds.push(inputs.setup.accountId);
      return {
        digest: `flatten-digest-${inputs.setup.accountId}`,
        endpoint: "test",
        gasUsedMist: 25,
        postedOrderIds: [],
        flattenedMarketIds: ["0x5678"],
      };
    },
    getAccountPerformanceHistory: async () => performanceHistory,
    getRewardDashboard: async (inputs: { objective: StrategyObjective }) =>
      rewardDashboard(inputs.objective),
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
    executeQuote: async (inputs: {
      shouldContinue: () => boolean;
      cancelMarketIds?: string[];
    }) => {
      if (!inputs.shouldContinue()) throw new Error("cancelled");
      quoteInputs.push({ cancelMarketIds: inputs.cancelMarketIds });
      executionCount += 1;
      executionSequence.push("quote");
      return {
        digest: `digest-${executionCount}`,
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
    sleep: async () => undefined,
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
    flattenedAccountIds: () => flattenedAccountIds,
    hedgeExecutions: () => hedgeExecutionCount,
    executionSequence,
    quoteInputs: () => quoteInputs,
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
  it("treats a cycle before strategy setup as an idle no-op", async () => {
    const harness = createHarness({ configured: false });

    await harness.runtime.cycle();

    expect(harness.runtime.snapshot.cycle).toBe(0);
    expect(harness.runtime.snapshot.lastError).toBeNull();
    expect(
      harness.tenant.listEvents().filter((event) => event.action === "cycle"),
    ).toHaveLength(0);
    harness.store.close();
  });

  it("keeps a manual live-mode refresh read-only", async () => {
    const harness = createHarness();

    await harness.runtime.cycle();

    expect(harness.runtime.snapshot.quote).not.toBeNull();
    expect(harness.executions()).toBe(0);
    harness.store.close();
  });

  it("reserves worst-case transaction gas from the displayed runway", async () => {
    const harness = createHarness();
    const saved = harness.tenant.getConfig();
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...saved,
        mode: "paper",
        maxGasMist: 50_000_000,
      }),
    );
    await harness.runtime.cycle();
    harness.tenant.logExecution({
      mode: "live",
      marketId: "0x5678",
      digest: "gas-sample",
      endpoint: "test",
      bidPrice: 9.99,
      askPrice: 10.01,
      sizeUsd: 1,
      outcome: "confirmed",
      gasUsedMist: 10_000_000,
    });

    expect(harness.runtime.snapshot.execution.gasRunwayTransactions).toBe(5);
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
    let stalePostCancelReads = 1;
    harness.setPortfolioResolver((inputs) => {
      const maker = inputs.setup.accountId === "42";
      const inventoryUsd = maker
        ? 30
        : -30 * Math.min(1, harness.hedgeExecutions());
      const pendingOrderCount = maker
        ? harness.cancellations() === 0
          ? 2
          : harness.hedgeExecutions() === 0 && stalePostCancelReads-- > 0
            ? 1
            : 0
        : 0;
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
          baseAssetAmount: inventoryUsd / 10,
          pendingOrderCount,
          inventoryUsd,
          unrealizedPnlUsd: 0,
          collateralUsd: 20,
          freeMarginUsd: 70,
          makerOrderIds: [],
          hasPosition: inventoryUsd !== 0,
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
    expect(
      harness.tenant
        .listEvents()
        .find(
          (event) =>
            event.action === "post-cancel-reconciliation" &&
            event.outcome === "confirmed",
        ),
    ).toMatchObject({ detail: expect.objectContaining({ attempt: 2 }) });
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

  it("keeps hedging below the trigger until the actual delta reaches completion tolerance", async () => {
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
          thresholdUsd: 5,
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
      const inventoryUsd = maker ? 30 : harness.hedgeExecutions() > 0 ? -26 : 0;
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
          baseAssetAmount: inventoryUsd / 10,
          pendingOrderCount: 0,
          inventoryUsd,
          unrealizedPnlUsd: 0,
          collateralUsd: 20,
          freeMarginUsd: 70,
          makerOrderIds: [],
          hasPosition: inventoryUsd !== 0,
        })),
      };
    });

    harness.runtime.start();
    await harness.runtime.cycle();

    expect(harness.hedgeExecutions()).toBe(1);
    expect(harness.executions()).toBe(0);
    expect(harness.runtime.snapshot.running).toBe(true);
    expect(harness.runtime.snapshot.hedge).toMatchObject({
      state: "hedging",
      combinedDeltaUsd: 4,
      lastDigest: "hedge-digest-1",
    });

    await harness.runtime.cycle({ executeLive: true });
    expect(harness.hedgeExecutions()).toBe(2);
    expect(harness.executions()).toBe(0);
    expect(harness.runtime.snapshot.running).toBe(false);
    expect(harness.runtime.snapshot.lastError).toContain(
      "did not reduce combined delta",
    );
    expect(harness.runtime.snapshot.hedge).toMatchObject({
      state: "error",
      combinedDeltaUsd: 4,
      lastDigest: "hedge-digest-2",
    });
    await harness.runtime.stop();
    harness.store.close();
  });

  it("hedges an attributed fill before quote-entry safety halts the engine", async () => {
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
        maxInventoryUsd: 30,
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
      const inventoryUsd = maker
        ? 30
        : -30 * Math.min(1, harness.hedgeExecutions());
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
          baseAssetAmount: inventoryUsd / 10,
          pendingOrderCount: 0,
          inventoryUsd,
          unrealizedPnlUsd: 0,
          collateralUsd: 20,
          freeMarginUsd: 70,
          makerOrderIds: [],
          hasPosition: inventoryUsd !== 0,
        })),
      };
    });

    harness.runtime.start();
    await harness.runtime.cycle();

    expect(harness.hedgeExecutions()).toBe(1);
    expect(harness.executions()).toBe(0);
    expect(harness.executionSequence.slice(0, 2)).toEqual(["cancel", "hedge"]);
    expect(harness.runtime.snapshot.running).toBe(false);
    expect(harness.runtime.snapshot.lastError).toContain("inventory");
    expect(harness.runtime.snapshot.hedge).toMatchObject({
      state: "ready",
      lastDigest: "hedge-digest-1",
      error: null,
    });
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
      digest: "flatten-digest-42",
      digests: ["flatten-digest-42"],
      flattenedMarketIds: ["0x5678"],
      transactions: [
        {
          accountId: "42",
          digest: "flatten-digest-42",
          flattenedMarketIds: ["0x5678"],
        },
      ],
    });
    expect(harness.runtime.snapshot.running).toBe(false);
    harness.store.close();
  });

  it("refuses to flatten when quote cancellation cannot be confirmed", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.gateway.cancelMakerOrders = async () => {
      throw new Error("RPC unavailable");
    };

    const flattening = expect(harness.runtime.flatten(0.01)).rejects.toThrow(
      "quote cancellation could not be confirmed",
    );
    await vi.advanceTimersByTimeAsync(2_000);

    await flattening;
    expect(harness.flattens()).toBe(0);
    harness.store.close();
  });

  it("flattens both sides of a configured Maker and hedge pair", async () => {
    const harness = createHarness();
    harness.tenant.setSetup(
      setupSchema.parse({
        ownerAddress: `0x${"1".repeat(64)}`,
        accountId: "43",
        accountCapId: "0x4321",
      }),
    );
    harness.tenant.confirmAgentGrant({
      accountId: "43",
      digest: "B".repeat(32),
      agentCapId: "0x8765",
    });
    const current = harness.tenant.getConfig()!;
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...current,
        makerAccountId: "42",
        hedge: {
          enabled: true,
          accountId: "43",
          thresholdUsd: 1,
          maxOrderUsd: 5,
          maxSlippageBps: 75,
        },
      }),
    );

    const result = await harness.runtime.flatten(0.01);

    expect(harness.cancellations()).toBe(1);
    expect(harness.flattens()).toBe(2);
    expect(harness.flattenedAccountIds()).toEqual(["42", "43"]);
    expect(result.digests).toEqual(["flatten-digest-42", "flatten-digest-43"]);
    expect(
      result.transactions.map((transaction) => transaction.accountId),
    ).toEqual(["42", "43"]);
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

  it("atomically switches the active market in single-slot rotation", async () => {
    const harness = createHarness();
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        rotationMode: "single-slot",
        refreshMs: 2_000,
        maxQuoteAgeMs: 10_000,
      }),
    );

    harness.runtime.start();
    await harness.runtime.cycle({ executeLive: true });
    await harness.runtime.cycle({ executeLive: true });

    expect(harness.executions()).toBe(2);
    expect(harness.quoteInputs()[0]?.cancelMarketIds).toBeUndefined();
    expect(harness.quoteInputs()[1]?.cancelMarketIds).toEqual(["0x5678"]);
    expect(harness.cancellations()).toBe(1);
    await harness.runtime.stop();
    harness.store.close();
  });

  it("runs three live objective rounds and restores the saved strategy after flattening", async () => {
    const harness = createHarness();
    const original = makerConfigSchema.parse({
      ...harness.tenant.getConfig()!,
      markets: [{ marketId: "0x5678", symbol: "SUI" }],
      mode: "paper",
      rotationMode: "single-slot",
      quoteSizeUsd: 1.04,
      maxInventoryUsd: 1.1,
      maxGrossExposureUsd: 3,
    });
    harness.tenant.setConfig(original);

    const result = await harness.runtime.runStrategyTrial({
      mode: "live",
      cadenceMs: 2_000,
      maxSlippageBps: 100,
    });

    expect(result.rounds.map((round) => round.objective)).toEqual([
      "farming",
      "profit",
      "both",
    ]);
    expect(result.rounds.map((round) => round.profile)).toEqual([
      "active",
      "cautious",
      "balanced",
    ]);
    expect(result.rounds.map((round) => round.digest)).toEqual([
      "digest-1",
      "digest-2",
      "digest-3",
    ]);
    expect(harness.executions()).toBe(3);
    expect(harness.flattens()).toBe(1);
    expect(harness.cancellations()).toBe(3);
    expect(harness.tenant.getConfig()).toEqual(original);
    expect(harness.runtime.snapshot.running).toBe(false);
    harness.store.close();
  });

  it("simulates all three objective rounds without signing or flattening", async () => {
    const harness = createHarness();
    const original = makerConfigSchema.parse({
      ...harness.tenant.getConfig()!,
      markets: [{ marketId: "0x5678", symbol: "SUI" }],
      mode: "paper",
      quoteSizeUsd: 1.04,
      maxInventoryUsd: 1.1,
      maxGrossExposureUsd: 3,
    });
    harness.tenant.setConfig(original);

    const result = await harness.runtime.runStrategyTrial({
      mode: "paper",
      cadenceMs: 2_000,
      maxSlippageBps: 100,
    });

    expect(result.rounds).toHaveLength(3);
    expect(result.rounds.every((round) => round.outcome === "simulated")).toBe(
      true,
    );
    expect(harness.executions()).toBe(0);
    expect(harness.flattens()).toBe(0);
    expect(harness.tenant.getConfig()).toEqual(original);
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
