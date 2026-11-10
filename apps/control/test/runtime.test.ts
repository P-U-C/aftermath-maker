import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEncryptedAgent,
  QuoteBelowMinimumError,
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
  let marketDailyVolumes: Array<{ marketId: string; volumeUsd: number }> = [];
  let ownerAccounts = [
    {
      accountId: "42",
      accountCapId: "0x1234",
      collateralCoinType: "usdc",
      equityUsd: 100,
      availableCollateralUsd: 80,
      allocatedCollateralUsd: 20,
      freeMarginUsd: 70,
      positionCount: 0,
      withdrawableCollateralUsd: 75,
      openMakerOrderCount: 0,
      exposureUsd: 0,
      unrealizedPnlUsd: 0,
    },
  ];
  let orderbook: {
    bestBidPrice: number;
    bestAskPrice: number;
    bids?: Array<{ price: number; size: number }>;
    asks?: Array<{ price: number; size: number }>;
  } = {
    bestBidPrice: 9.99,
    bestAskPrice: 10.01,
    bids: [],
    asks: [],
  };
  const performanceRequests: Array<{
    timeframe?: "1D" | "1W" | "1M" | "ALL";
    sinceMs?: number;
  }> = [];
  let portfolioResolver = (inputs: {
    setup: { accountId: string };
    marketIds: string[];
  }): PortfolioSnapshot => ({
    markedAt: new Date().toISOString(),
    equityUsd: 100,
    availableCollateralUsd: 80,
    allocatedCollateralUsd: 20,
    freeMarginUsd: 70,
    withdrawableCollateralUsd: 75,
    grossExposureUsd: 0,
    unrealizedPnlUsd: 0,
    gasSui: 1,
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
      orderbook,
    }),
    getAgentPortfolioSnapshot: async (inputs: {
      setup: { accountId: string };
      marketIds: string[];
    }) => {
      const snapshot = portfolioResolver(inputs);
      return {
        ...snapshot,
        positions: snapshot.positions.map((position) => ({
          ...position,
          marginRatio:
            position.marginRatio === undefined
              ? position.hasPosition
                ? 0.5
                : null
              : position.marginRatio,
          liquidationDistanceBps:
            position.liquidationDistanceBps === undefined
              ? position.hasPosition
                ? 5_000
                : null
              : position.liquidationDistanceBps,
        })),
      };
    },
    listOwnerAccounts: async () => ownerAccounts,
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
      executionSequence.push("flatten");
      return {
        digest: `flatten-digest-${inputs.setup.accountId}`,
        endpoint: "test",
        gasUsedMist: 25,
        postedOrderIds: [],
        flattenedMarketIds: ["0x5678"],
      };
    },
    getAccountPerformanceHistory: async (inputs: {
      timeframe?: "1D" | "1W" | "1M" | "ALL";
      sinceMs?: number;
    }) => {
      performanceRequests.push(inputs);
      return performanceHistory;
    },
    getMarketsDailyVolume: async () => marketDailyVolumes,
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
    simulateQuote: async (inputs: { shouldContinue: () => boolean }) => {
      if (!inputs.shouldContinue()) throw new Error("cancelled");
      executionSequence.push("paper-dry-run");
      return { endpoint: "test", gasUsedMist: 12 };
    },
  };

  const runtimeOptions = {
    masterKey,
    liveEnabled: true,
    mainnetAllowed: true,
    builderCode: () => ({ integratorId: 7, integratorFee: 0.0001 }),
    sleep: async () => undefined,
  };
  const runtime = new MakerRuntime(store, gateway as never, runtimeOptions);

  return {
    directory,
    runtime,
    runtimeOptions,
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
    performanceRequests: () => performanceRequests,
    setPortfolioResolver: (resolver: typeof portfolioResolver) => {
      portfolioResolver = resolver;
    },
    setExecutions: (value: number) => {
      executionCount = value;
    },
    setPerformanceHistory: (value: AccountPerformanceHistory) => {
      performanceHistory = value;
    },
    setMarketDailyVolumes: (
      value: Array<{ marketId: string; volumeUsd: number }>,
    ) => {
      marketDailyVolumes = value;
    },
    setOrderbook: (value: typeof orderbook) => {
      orderbook = value;
    },
    setOwnerAccounts: (value: typeof ownerAccounts) => {
      ownerAccounts = value;
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

  it("keeps internal Observe cycles out of the transaction queue", async () => {
    for (const mode of ["observe"] as const) {
      const harness = createHarness();
      harness.tenant.setConfig(
        makerConfigSchema.parse({
          ...harness.tenant.getConfig(),
          mode,
        }),
      );
      harness.runtime.start();
      await harness.runtime.cycle();

      expect(harness.executions()).toBe(0);
      expect(harness.hedgeExecutions()).toBe(0);
      expect(harness.cancellations()).toBe(0);
      expect(harness.executionSequence).toEqual([]);
      await harness.runtime.stop();
      harness.store.close();
    }
  });

  it("records estimated Paper fills only when a later book crosses a scratch order", async () => {
    const harness = createHarness();
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        mode: "paper",
        markets: [{ marketId: "0x5678", symbol: "SUI" }],
      }),
    );

    harness.runtime.start();
    await harness.runtime.cycle();
    expect(harness.executions()).toBe(0);
    expect(harness.runtime.snapshot.paper).toMatchObject({
      estimated: true,
      openOrders: 2,
      fills: 0,
    });

    // The next sampled ask trades through the simulated bid, so this is an
    // estimate in the Paper ledger rather than an exchange fill claim.
    harness.setOrderbook({
      bestBidPrice: 9.98,
      bestAskPrice: 9.8,
      bids: [],
      asks: [],
    });
    await harness.runtime.cycle();

    expect(harness.runtime.snapshot.paper).toMatchObject({
      estimated: true,
      fills: 1,
    });
    expect(harness.runtime.snapshot.balances.inventoryUsd).toBeGreaterThan(0);
    const performance = await harness.runtime.performance();
    expect(performance.paper).toMatchObject({
      estimated: true,
      makerFills: 1,
      hedgeFills: 0,
      notionalUsd: 10,
      estimatedBuilderFeesUsd: 0.001,
    });
    expect(performance.fills[0]?.estimatedBuilderFeeUsd).toBe(0.001);
    expect(performance.fills[0]).toMatchObject({ estimated: true });
    expect(harness.executionSequence).toEqual(["paper-dry-run"]);
    await harness.runtime.stop();
    harness.store.close();
  });

  it("keeps a Live bundle running when one market fails the fair-value check", async () => {
    // Production: Live paused itself on "Safety gate failed: fair-value"
    // seconds after starting. A market condition must skip that market only.
    const harness = createHarness();
    const onBundleError = vi.fn();
    const runtime = new MakerRuntime(harness.tenant, harness.gateway as never, {
      ...harness.runtimeOptions,
      pauseOnError: true,
      onBundleError,
    });
    // Index is 10; a 10.49 / 10.51 book is about 500 bps away.
    harness.setOrderbook({
      bestBidPrice: 10.49,
      bestAskPrice: 10.51,
      bids: [],
      asks: [],
    });
    runtime.start();
    await runtime.cycle({ executeLive: true });

    expect(onBundleError).not.toHaveBeenCalled();
    expect(runtime.snapshot.running).toBe(true);
    expect(harness.executionSequence).not.toContain("quote");
    const skipped = runtime.snapshot.markets.find(
      (market) => market.id === runtime.snapshot.market.id,
    );
    expect(skipped?.skip?.code).toBe("fair-value");
    expect(
      harness.tenant
        .listEvents()
        .some(
          (event) =>
            event.category === "runtime" &&
            event.action === "cycle" &&
            event.outcome === "error",
        ),
    ).toBe(false);

    // When the book comes back, the same bundle quotes again.
    harness.setOrderbook({
      bestBidPrice: 9.99,
      bestAskPrice: 10.01,
      bids: [],
      asks: [],
    });
    await runtime.cycle({ executeLive: true });
    await runtime.cycle({ executeLive: true });
    expect(harness.executionSequence).toContain("quote");
    expect(onBundleError).not.toHaveBeenCalled();
    await runtime.stop();
    harness.store.close();
  });

  it("counts collateral the venue already allocated to resting Live quotes", async () => {
    // Production: a portfolio Live bundle paused on "collateral" soon after
    // starting. Each placed quote moves collateral into its market, so the
    // free balance drops while that allocation still backs the quotes.
    const portfolioWith =
      (available: number, allocatedPerMarket: number) =>
      (inputs: { marketIds: string[] }) => ({
        markedAt: new Date().toISOString(),
        equityUsd: available + allocatedPerMarket * inputs.marketIds.length,
        availableCollateralUsd: available,
        allocatedCollateralUsd: allocatedPerMarket * inputs.marketIds.length,
        freeMarginUsd: 0,
        withdrawableCollateralUsd: available,
        grossExposureUsd: 0,
        unrealizedPnlUsd: 0,
        gasSui: 1,
        positions: inputs.marketIds.map((marketId) => ({
          marketId,
          baseAssetAmount: 0,
          pendingOrderCount: 2,
          inventoryUsd: 0,
          unrealizedPnlUsd: 0,
          collateralUsd: allocatedPerMarket,
          freeMarginUsd: 0,
          makerOrderIds: [],
          hasPosition: false,
        })),
      });
    const runWith = async (available: number, allocatedPerMarket: number) => {
      const harness = createHarness();
      harness.tenant.setConfig(
        makerConfigSchema.parse({
          ...harness.tenant.getConfig()!,
          rotationMode: "portfolio",
          quoteSizeUsd: 10,
          maxLeverage: 1,
        }),
      );
      harness.setPortfolioResolver(
        portfolioWith(available, allocatedPerMarket) as never,
      );
      const onBundleError = vi.fn();
      const runtime = new MakerRuntime(
        harness.tenant,
        harness.gateway as never,
        { ...harness.runtimeOptions, pauseOnError: true, onBundleError },
      );
      runtime.start();
      await runtime.cycle({ executeLive: true });
      const result = {
        quoted: harness.executionSequence.includes("quote"),
        error: (onBundleError.mock.calls[0]?.[0] as string | undefined) ?? null,
      };
      await runtime.stop();
      harness.store.close();
      return result;
    };

    // Two markets at $10 a side and 1x need $40. $5 is free and $20 sits
    // allocated in each market: $45 backs the quotes.
    expect(await runWith(5, 20)).toEqual({ quoted: true, error: null });
    // With $10 in each market only $25 backs them, and the error says so.
    const short = await runWith(5, 10);
    expect(short.quoted).toBe(false);
    expect(short.error).toContain(
      "Safety gate failed: collateral. Two-sided quote collateral: $25.00 available; $40.00 conservative requirement",
    );
  });

  it("quotes around a market another Live bundle holds, without an error", async () => {
    const harness = createHarness();
    const onBundleError = vi.fn();
    const runtime = new MakerRuntime(harness.tenant, harness.gateway as never, {
      ...harness.runtimeOptions,
      pauseOnError: true,
      onBundleError,
      marketHeldBy: (marketId) => (marketId === "0x5678" ? "Core" : null),
    });
    runtime.start();
    await runtime.cycle({ executeLive: true });

    expect(onBundleError).not.toHaveBeenCalled();
    expect(runtime.snapshot.running).toBe(true);
    expect(harness.executionSequence).not.toContain("quote");
    const held = runtime.snapshot.markets.find(
      (market) => market.id === "0x5678",
    );
    expect(held?.skip).toMatchObject({ code: "market-held" });
    expect(held?.skip?.message).toContain(
      "Core quotes it live, and one Live bundle quotes a market at a time.",
    );
    await runtime.stop();
    harness.store.close();
  });

  it("runs local Paper estimates without authorizing a trading key", async () => {
    const harness = createHarness();
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        mode: "paper",
      }),
    );
    harness.tenant.clearAgentGrant("42");
    const onBundleError = vi.fn();
    const runtime = new MakerRuntime(harness.tenant, harness.gateway as never, {
      ...harness.runtimeOptions,
      pauseOnError: true,
      onBundleError,
    });

    runtime.start();
    await runtime.cycle();

    expect(runtime.snapshot.running).toBe(true);
    expect(runtime.snapshot.lastError).toBeNull();
    expect(runtime.snapshot.lastSuccessfulCycleAt).not.toBeNull();
    expect(onBundleError).not.toHaveBeenCalled();
    expect(harness.executionSequence).toEqual([]);
    expect(runtime.snapshot.quote).not.toBeNull();
    expect(runtime.snapshot.portfolio.availableCollateralUsd).toBe(80);
    harness.tenant.recordPaperQuote({
      trialId: "runtime",
      marketId: "0x5678",
      symbol: "SUI",
      bidPrice: 10,
      askPrice: 10.1,
      sizeUsd: 10,
      sides: "bid",
    });
    const [paperFill] = harness.tenant.matchPaperOrders({
      trialId: "runtime",
      marketId: "0x5678",
      bestBid: 9.9,
      bestAsk: 9.9,
      makerFeeRate: 0,
      builderFeeRate: 0.0001,
    });
    harness.tenant.recordPaperHedge({
      trialId: "runtime",
      makerFill: paperFill!,
      takerFeeRate: 0,
      builderFeeRate: 0.0001,
    });
    const performance = await runtime.performance();
    expect(performance.paper).toMatchObject({
      estimated: true,
      makerFills: 1,
      hedgeFills: 1,
      notionalUsd: 20,
      estimatedBuilderFeesUsd: 0.002,
    });
    expect(performance.fills).toHaveLength(2);
    await runtime.stop();
    harness.store.close();
  });

  it("does not substitute a different authorized account for local Paper", async () => {
    const harness = createHarness();
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        mode: "paper",
        makerAccountId: "43",
      }),
    );
    harness.setOwnerAccounts([
      {
        accountId: "43",
        accountCapId: "0x4321",
        collateralCoinType: "usdc",
        equityUsd: 150,
        availableCollateralUsd: 120,
        allocatedCollateralUsd: 30,
        freeMarginUsd: 110,
        positionCount: 0,
        withdrawableCollateralUsd: 115,
        openMakerOrderCount: 0,
        exposureUsd: 0,
        unrealizedPnlUsd: 0,
      },
    ]);
    harness.runtime.start();
    await harness.runtime.cycle();

    expect(harness.executionSequence).not.toContain("paper-dry-run");
    expect(harness.runtime.snapshot.accountId).toBe("43");
    expect(harness.runtime.snapshot.portfolio.availableCollateralUsd).toBe(120);
    await harness.runtime.stop();
    harness.store.close();
  });

  it("keeps Paper reading when its trading key has no SUI", async () => {
    const harness = createHarness();
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        mode: "paper",
        maxGasMist: 50_000_000,
      }),
    );
    harness.setPortfolioResolver((inputs) => ({
      equityUsd: 100,
      availableCollateralUsd: 80,
      allocatedCollateralUsd: 20,
      freeMarginUsd: 70,
      withdrawableCollateralUsd: 75,
      grossExposureUsd: 0,
      unrealizedPnlUsd: 0,
      gasSui: 0,
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

    const onBundleError = vi.fn();
    const runtime = new MakerRuntime(harness.tenant, harness.gateway as never, {
      ...harness.runtimeOptions,
      pauseOnError: true,
      onBundleError,
    });
    runtime.start();
    await runtime.cycle();

    expect(runtime.snapshot.running).toBe(true);
    expect(runtime.snapshot.lastError).toContain(
      "trading key for account 42 needs 0.05 SUI to simulate",
    );
    expect(runtime.snapshot.paperBlocker).toMatchObject({
      code: "gas",
      requiredGasSui: 0.05,
      accountId: "42",
    });
    expect(runtime.snapshot.lastSuccessfulCycleAt).toBeNull();
    expect(onBundleError).not.toHaveBeenCalled();
    expect(harness.executionSequence).toEqual([]);
    await runtime.stop();
    harness.store.close();
  });

  it("keeps Paper reading when a safety check blocks a dry run", async () => {
    const harness = createHarness();
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        mode: "paper",
      }),
    );
    harness.setPortfolioResolver((inputs) => ({
      equityUsd: 0,
      availableCollateralUsd: 0,
      allocatedCollateralUsd: 0,
      freeMarginUsd: 0,
      withdrawableCollateralUsd: 0,
      grossExposureUsd: 0,
      unrealizedPnlUsd: 0,
      gasSui: 1,
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

    const onBundleError = vi.fn();
    const runtime = new MakerRuntime(harness.tenant, harness.gateway as never, {
      ...harness.runtimeOptions,
      pauseOnError: true,
      onBundleError,
    });
    runtime.start();
    await runtime.cycle();

    expect(runtime.snapshot.running).toBe(true);
    expect(runtime.snapshot.lastError).toContain(
      "account 42. It has $0.00 free collateral",
    );
    expect(runtime.snapshot.lastError).toMatch(
      /quoting 2 markets at \$10\.00 a side needs \$40\.00/,
    );
    expect(runtime.snapshot.lastError).toContain(
      "quote one market at a time (needs $20.00)",
    );
    expect(runtime.snapshot.paperBlocker).toMatchObject({
      code: "collateral",
      accountId: "42",
      availableUsd: 0,
      requiredUsd: 40,
      concurrentMarkets: 2,
      quoteSizeUsd: 10,
    });
    expect(runtime.snapshot.accountReadAt).toBe(
      runtime.snapshot.paperBlocker?.observedAt,
    );
    expect(runtime.snapshot.markets[0]).toMatchObject({
      status: "healthy",
      error: null,
    });
    expect(onBundleError).not.toHaveBeenCalled();
    expect(harness.executionSequence).toEqual([]);
    await runtime.stop();
    expect(runtime.snapshot.lastError).toBeNull();
    expect(runtime.snapshot.paperBlocker).toBeNull();
    expect(runtime.snapshot.markets.every((row) => row.error === null)).toBe(
      true,
    );
    harness.store.close();
  });

  it("logs a five-market collateral block once, reminds after fifteen minutes, then clears on recovery", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
    const harness = createHarness();
    const saved = harness.tenant.getConfig()!;
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...saved,
        mode: "paper",
        rotationMode: "portfolio",
        markets: [
          ...saved.markets,
          { marketId: "0x3333", symbol: "M3" },
          { marketId: "0x4444", symbol: "M4" },
          { marketId: "0x5555", symbol: "M5" },
        ],
      }),
    );
    const baseline = await harness.gateway.getAgentPortfolioSnapshot({
      marketIds: saved.markets.map((market) => market.marketId),
    } as never);
    let available = 0;
    harness.setPortfolioResolver((inputs) => ({
      ...baseline,
      markedAt: new Date().toISOString(),
      availableCollateralUsd: available,
      gasSui: 1,
      positions: inputs.marketIds.map((marketId) => ({
        ...baseline.positions[0]!,
        marketId,
      })),
    }));
    harness.runtime.start();
    const blocked = () =>
      harness.tenant
        .listEvents(50)
        .filter(
          (event) =>
            event.category === "paper" &&
            event.action === "simulation" &&
            event.outcome === "blocked",
        );
    await harness.runtime.cycle();
    expect(harness.runtime.snapshot.paperBlocker).toMatchObject({
      accountId: "42",
      code: "collateral",
      concurrentMarkets: 5,
      quoteSizeUsd: 10,
      requiredUsd: 100,
    });
    expect(blocked()).toHaveLength(1);
    await harness.runtime.cycle();
    expect(blocked()).toHaveLength(1);
    vi.setSystemTime(new Date("2026-11-01T12:15:00Z"));
    await harness.runtime.cycle({ executeLive: true });
    expect(blocked()).toHaveLength(2);
    available = 150;
    await harness.runtime.cycle({ executeLive: true });
    expect(harness.runtime.snapshot.paperBlocker).toBeNull();
    expect(
      harness.tenant
        .listEvents()
        .filter(
          (event) =>
            event.category === "paper" &&
            event.action === "simulation" &&
            event.outcome === "cleared",
        ),
    ).toHaveLength(1);
    await harness.runtime.stop();
    harness.store.close();
  });

  it("keeps a migrated Observe bundle reading after it becomes Paper", async () => {
    const harness = createHarness();
    const legacy = makerConfigSchema.parse({
      ...harness.tenant.getConfig()!,
      mode: "observe",
    });
    harness.tenant.setConfig(legacy);
    harness.tenant.clearAgentGrant("42");
    const core = harness.tenant
      .listBundles()
      .find((bundle) => bundle.name === "Core")!;
    harness.store.close();

    const migratedStore = new Store(join(harness.directory, "maker.db"));
    const migrated = migratedStore.forTenant(harness.tenant.ownerAddress);
    expect(migrated.getStoredBundle(core.id)).toMatchObject({
      mode: "paper",
      status: "stopped",
    });
    const runtime = new MakerRuntime(
      migratedStore.forBundle(harness.tenant.ownerAddress, core.id),
      harness.gateway as never,
      { ...harness.runtimeOptions, pauseOnError: true },
    );

    runtime.start();
    await runtime.cycle();

    expect(runtime.snapshot.running).toBe(true);
    expect(runtime.snapshot.lastError).toBeNull();
    expect(runtime.snapshot.quote).not.toBeNull();
    await runtime.stop();
    migratedStore.close();
  });

  it("fails closed on an attached Inventory recycling strategy without reconciliation", async () => {
    const harness = createHarness();
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        mode: "paper",
      }),
    );
    const core = harness.tenant
      .listBundles()
      .find((bundle) => bundle.name === "Core")!;
    const strategy = harness.tenant.getStrategy(core.strategyId!)!;
    harness.tenant.updateStrategy({
      strategyId: strategy.id,
      name: "Inventory recycling",
      config: strategy.config,
      marketRule: strategy.marketRule,
      markets: strategy.markets,
      expectedVersion: strategy.version,
    });
    const runtime = new MakerRuntime(
      harness.store.forBundle(harness.tenant.ownerAddress, core.id),
      harness.gateway as never,
      harness.runtimeOptions,
    );

    runtime.start();
    await runtime.cycle({ executeLive: true });

    expect(
      runtime.snapshot.safety.find(
        (check) => check.code === "inventory-reconciliation",
      ),
    ).toMatchObject({ ok: false, scope: "bundle" });
    expect(harness.executionSequence).not.toContain("paper-dry-run");
    await runtime.stop();
    harness.store.close();
  });

  it("submits byte-identical Core quote intents and gateway payloads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T20:00:00.000Z"));
    const legacy = createHarness();
    const core = createHarness();
    const coreId = core.tenant.listBundles()[0]!.id;
    const coreRuntime = new MakerRuntime(
      core.store.forBundle(core.tenant.ownerAddress, coreId),
      core.gateway as never,
      core.runtimeOptions,
    );

    type QuoteSubmissionGateway = {
      executeQuote: (inputs: {
        setup: unknown;
        config: unknown;
        quote: unknown;
        builderCode: unknown;
        shouldContinue: () => boolean;
        knownMakerOrderIds?: bigint[];
        cancelMarketIds?: string[];
        expectedCancelOrderIds?: Record<string, bigint[]>;
      }) => Promise<{
        digest: string;
        endpoint: string;
        gasUsedMist: number;
        postedOrderIds: string[];
      }>;
    };
    const captureSubmission = async (
      runtime: MakerRuntime,
      gateway: QuoteSubmissionGateway,
    ) => {
      let captured: { intent: string; submission: string } | undefined;
      let capturedResolve!: () => void;
      const capturedPromise = new Promise<void>((resolve) => {
        capturedResolve = resolve;
      });
      gateway.executeQuote = async (inputs) => {
        captured = {
          intent: JSON.stringify({
            config: inputs.config,
            quote: inputs.quote,
          }),
          submission: JSON.stringify({
            setup: inputs.setup,
            config: inputs.config,
            quote: inputs.quote,
            builderCode: inputs.builderCode,
            knownMakerOrderIds: (inputs.knownMakerOrderIds ?? []).map(String),
            cancelMarketIds: inputs.cancelMarketIds ?? [],
            expectedCancelOrderIds: Object.fromEntries(
              Object.entries(inputs.expectedCancelOrderIds ?? {}).map(
                ([marketId, orderIds]) => [marketId, orderIds.map(String)],
              ),
            ),
          }),
        };
        capturedResolve();
        return {
          digest: "core-compatibility-digest",
          endpoint: "test",
          gasUsedMist: 20,
          postedOrderIds: ["101", "102"],
        };
      };
      runtime.start();
      await capturedPromise;
      await runtime.stop();
      return captured!;
    };

    const legacySubmission = await captureSubmission(
      legacy.runtime,
      legacy.gateway,
    );
    const coreSubmission = await captureSubmission(coreRuntime, core.gateway);
    expect(coreSubmission).toEqual(legacySubmission);
    legacy.store.close();
    core.store.close();
  });

  it("exposes only the fresh selected-market book and run risk without changing quotes", async () => {
    const harness = createHarness();
    const config = harness.tenant.getConfig()!;
    harness.tenant.setConfig({ ...config, markets: [config.markets[0]!] });
    expect(harness.runtime.snapshot.market.book).toBeNull();
    let equityUsd = 100;
    harness.setPortfolioResolver((inputs) => ({
      markedAt: new Date().toISOString(),
      equityUsd,
      availableCollateralUsd: 80,
      allocatedCollateralUsd: 20,
      freeMarginUsd: 70,
      withdrawableCollateralUsd: 75,
      grossExposureUsd: 0,
      unrealizedPnlUsd: 0,
      gasSui: 1,
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
    await harness.runtime.cycle();
    const quoteBefore = harness.runtime.snapshot.quote;
    const quoteDecision = quoteBefore
      ? { ...quoteBefore, observedAt: "ignored" }
      : null;

    harness.setOrderbook({
      bestBidPrice: 9.99,
      bestAskPrice: 10.01,
      bids: [
        { price: 0, size: 1 },
        ...Array.from({ length: 55 }, (_, index) => ({
          price: 9.99 - index * 0.01,
          size: index === 3 ? Number.NaN : index + 1,
        })),
      ],
      asks: Array.from({ length: 55 }, (_, index) => ({
        price: 10.01 + index * 0.01,
        size: index + 1,
      })),
    });
    equityUsd = 90;
    await harness.runtime.cycle();

    const snapshot = harness.runtime.snapshot;
    expect(
      snapshot.quote ? { ...snapshot.quote, observedAt: "ignored" } : null,
    ).toEqual(quoteDecision);
    expect(snapshot.market.book?.observedAt).toBe(snapshot.market.updatedAt);
    expect(snapshot.market.book?.bids.slice(0, 2)).toEqual([
      [9.99, 1],
      [9.98, 2],
    ]);
    expect(snapshot.market.book?.asks.slice(0, 2)).toEqual([
      [10.01, 1],
      [10.02, 2],
    ]);
    expect(snapshot.market.book?.bids).toHaveLength(50);
    expect(snapshot.market.book?.asks).toHaveLength(50);
    expect(snapshot.risk).toMatchObject({
      runDrawdownUsd: 10,
      runHighEquityUsd: 100,
      measuredAt: snapshot.market.updatedAt,
    });

    harness.setOrderbook({
      bestBidPrice: 9.99,
      bestAskPrice: 10.01,
    });
    await harness.runtime.cycle();
    expect(harness.runtime.snapshot.market.book).toBeNull();
    expect(
      harness.runtime.snapshot.quote
        ? { ...harness.runtime.snapshot.quote, observedAt: "ignored" }
        : null,
    ).toEqual(quoteDecision);
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
    harness.setPortfolioResolver((inputs) => ({
      equityUsd: 100,
      availableCollateralUsd: 80,
      allocatedCollateralUsd: 20,
      freeMarginUsd: 70,
      withdrawableCollateralUsd: 75,
      grossExposureUsd: 0,
      unrealizedPnlUsd: 0,
      gasSui: 0.15,
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
    harness.setMarketDailyVolumes([{ marketId: "0x5678", volumeUsd: 24_000 }]);

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
    expect(performance.volumeByMarket).toEqual([
      {
        marketId: "0x5678",
        symbol: "SUI",
        makerNotionalUsd: 120,
        makerFills: 2,
        takerNotionalUsd: 0,
        takerFills: 0,
        realizedPnlUsd: 100,
        feesUsd: 0.02,
        marketVolumeUsd: 24_000,
        marketVolumeError: null,
      },
    ]);
    expect(performance.marketVolumeLabel).toMatch(
      /^Today, since [A-Z][a-z]{2} \d{1,2} 00:00 UTC$/,
    );
    expect(performance).toMatchObject({
      period: "1D",
      historyComplete: true,
    });

    const epoch = await harness.runtime.performance({
      period: "EPOCH",
      since: "2026-10-26T00:00:00.000Z",
    });
    expect(epoch).toMatchObject({
      period: "EPOCH",
      periodStartedAt: "2026-10-26T00:00:00.000Z",
    });

    const allTime = await harness.runtime.performance({ period: "ALL" });
    expect(allTime).toMatchObject({
      period: "ALL",
      periodStartedAt: null,
    });
    expect(
      harness.performanceRequests().map(({ timeframe }) => timeframe),
    ).toEqual(["1D", "ALL", "ALL"]);
    expect(harness.performanceRequests()[1]?.sinceMs).toBe(
      Date.parse("2026-10-26T00:00:00.000Z"),
    );
    expect(harness.performanceRequests()[2]?.sinceMs).toBeUndefined();
    harness.store.close();
  });

  it("keeps two bundles' NEAR fills separated by Maker account despite a shared market", async () => {
    const harness = createHarness();
    const ownerAddress = `0x${"1".repeat(64)}`;
    const near = { marketId: "0x5678", symbol: "NEAR" };
    const coreConfig = makerConfigSchema.parse({
      ...harness.tenant.getConfig()!,
      mode: "paper",
      markets: [near],
      makerAccountId: "42",
      hedge: { enabled: false, accountId: null },
    });
    harness.tenant.setConfig(coreConfig);
    harness.tenant.confirmWalletLimits();
    const hedgeSetup = setupSchema.parse({
      ownerAddress,
      accountId: "43",
      accountCapId: "0x1243",
    });
    harness.tenant.setSetup(hedgeSetup);
    harness.tenant.confirmAgentGrant({
      accountId: "43",
      digest: "H".repeat(32),
      agentCapId: "0xhedge",
    });
    const rewards = harness.tenant.createBundle({
      name: "Rewards",
      config: makerConfigSchema.parse({ ...coreConfig, makerAccountId: "43" }),
    });
    const coreBundle = harness.tenant
      .listBundles()
      .find((bundle) => bundle.name === "Core")!;
    harness.store.forBundle(ownerAddress, coreBundle.id).trackMakerOrders({
      accountId: "42",
      marketId: near.marketId,
      quoteDigest: "core-quote",
      orderIds: ["core-order"],
    });
    harness.store.forBundle(ownerAddress, rewards.id).trackMakerOrders({
      accountId: "43",
      marketId: near.marketId,
      quoteDigest: "rewards-quote",
      orderIds: ["rewards-order"],
    });
    harness.setPerformanceHistory({
      orders: ["core-order", "rewards-order"].map((orderId, index) => ({
        timestampMs: Date.parse("2026-10-26T12:00:00Z") + index * 1000,
        txDigest: orderId,
        marketId: near.marketId,
        eventType: "FilledMakerOrder",
        side: "bid" as const,
        price: 10,
        size: 1,
        orderId,
        realizedPnlUsd: index === 0 ? 1 : 2,
        feesUsd: 0,
        maker: true,
      })),
      marginHistory: [],
    });
    const coreRuntime = new MakerRuntime(
      harness.store.forBundle(ownerAddress, coreBundle.id),
      harness.gateway as never,
      harness.runtimeOptions,
    );
    const rewardsRuntime = new MakerRuntime(
      harness.store.forBundle(ownerAddress, rewards.id),
      harness.gateway as never,
      harness.runtimeOptions,
    );
    const [coreResult, rewardsResult] = await Promise.all([
      coreRuntime.performance(),
      rewardsRuntime.performance(),
    ]);
    expect(coreResult.attributed).toMatchObject({
      fills: 1,
      realizedPnlUsd: 1,
    });
    expect(coreResult.fills.map((fill) => fill.orderId)).toEqual([
      "core-order",
    ]);
    expect(rewardsResult.attributed).toMatchObject({
      fills: 1,
      realizedPnlUsd: 2,
    });
    expect(rewardsResult.fills.map((fill) => fill.orderId)).toEqual([
      "rewards-order",
    ]);
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
    expect(harness.cancellations()).toBe(1);
    expect(harness.executionSequence.slice(0, 2)).toEqual(["cancel", "quote"]);
    expect(harness.executions()).toBe(1);
    await harness.runtime.stop();
    harness.store.close();
  });

  it("pauses quoting until a material account delta has attributable fill history", async () => {
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
      orderIds: ["delayed-fill"],
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
        gasSui: 1,
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

    expect(harness.executions()).toBe(0);
    expect(harness.hedgeExecutions()).toBe(0);
    expect(harness.runtime.snapshot.running).toBe(true);
    expect(harness.tenant.listEvents(10)).toContainEqual(
      expect.objectContaining({
        action: "fill-attribution-reconciliation",
        outcome: "waiting",
      }),
    );

    harness.setPerformanceHistory({
      orders: [
        {
          timestampMs: Date.parse("2026-10-26T12:00:00Z"),
          txDigest: "delayed-fill-digest",
          marketId: "0x5678",
          eventType: "FilledMakerOrder",
          side: "bid",
          price: 10,
          size: 3,
          orderId: "delayed-fill",
          realizedPnlUsd: 0,
          feesUsd: 0,
          maker: true,
        },
      ],
      marginHistory: [],
    });
    await harness.runtime.cycle({ executeLive: true });

    expect(harness.hedgeExecutions()).toBe(1);
    expect(harness.executions()).toBe(1);
    expect(harness.tenant.listEvents(10)).toContainEqual(
      expect.objectContaining({
        action: "fill-attribution-reconciliation",
        outcome: "confirmed",
      }),
    );

    await harness.runtime.stop();
    harness.store.close();
  });

  const hedgedHarness = (makerInventoryUsd: number) => {
    const harness = createHarness();
    harness.tenant.setSetup(
      setupSchema.parse({
        ownerAddress: `0x${"1".repeat(64)}`,
        accountId: "43",
        accountCapId: "0x1243",
      }),
    );
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
    harness.setPortfolioResolver((inputs) => {
      const maker = inputs.setup.accountId === "42";
      const inventoryUsd = maker
        ? makerInventoryUsd
        : -makerInventoryUsd * Math.min(1, harness.hedgeExecutions());
      return {
        equityUsd: 100,
        availableCollateralUsd: 80,
        allocatedCollateralUsd: 20,
        freeMarginUsd: 70,
        withdrawableCollateralUsd: 75,
        grossExposureUsd: Math.abs(inventoryUsd),
        unrealizedPnlUsd: 0,
        gasSui: 1,
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
    return harness;
  };

  it("hedges a Maker fill from before a pause once the bundle resumes", async () => {
    const harness = hedgedHarness(30);
    harness.tenant.trackMakerOrders({
      accountId: "42",
      marketId: "0x5678",
      quoteDigest: "previous-run",
      orderIds: ["filled-before-pause"],
    });
    // The order was posted an hour before this run started.
    (
      harness.store as unknown as {
        db: { prepare: (sql: string) => { run: (...args: string[]) => void } };
      }
    ).db
      .prepare(
        "UPDATE tenant_maker_orders SET posted_at = ? WHERE order_id = ?",
      )
      .run(
        new Date(Date.now() - 60 * 60_000).toISOString(),
        "filled-before-pause",
      );
    harness.setPerformanceHistory({
      orders: [
        {
          timestampMs: Date.now() - 59 * 60_000,
          txDigest: "previous-run-fill",
          marketId: "0x5678",
          eventType: "FilledMakerOrder",
          side: "bid",
          price: 10,
          size: 3,
          orderId: "filled-before-pause",
          realizedPnlUsd: 0,
          feesUsd: 0,
          maker: true,
        },
      ],
      marginHistory: [],
    });
    harness.runtime.start();
    await harness.runtime.cycle({ executeLive: true });

    expect(harness.hedgeExecutions()).toBe(1);
    expect(harness.runtime.snapshot.running).toBe(true);
    await harness.runtime.stop();
    harness.store.close();
  });

  it("skips a market whose position Maker can't match, without pausing the bundle", async () => {
    const harness = hedgedHarness(30);
    const onBundleError = vi.fn();
    const runtime = new MakerRuntime(harness.tenant, harness.gateway as never, {
      ...harness.runtimeOptions,
      pauseOnError: true,
      onBundleError,
    });
    runtime.start();
    await runtime.cycle({ executeLive: true });
    // Ten seconds on, still no Maker fill explains it.
    (
      runtime as unknown as { awaitingFillAttribution: Map<string, number> }
    ).awaitingFillAttribution.set("42:0x5678", Date.now() - 11_000);
    await runtime.cycle({ executeLive: true });

    expect(onBundleError).not.toHaveBeenCalled();
    expect(runtime.snapshot.running).toBe(true);
    expect(harness.hedgeExecutions()).toBe(0);
    expect(harness.executionSequence).not.toContain("quote");
    const skipped = runtime.snapshot.markets.find(
      (market) => market.id === "0x5678",
    );
    expect(skipped?.skip?.code).toBe("unmatched-position");
    expect(skipped?.skip?.message).toContain(
      "$30.00 of position Maker can't match to its own fills",
    );
    await runtime.stop();
    harness.store.close();
  });

  it("skips a market whose quote is below the venue minimum, without pausing", async () => {
    const harness = createHarness();
    harness.gateway.executeQuote = async () => {
      throw new QuoteBelowMinimumError(
        "Its quote rounds to $0.0251, below the venue's $1.00 minimum order.",
      );
    };
    const onBundleError = vi.fn();
    const runtime = new MakerRuntime(harness.tenant, harness.gateway as never, {
      ...harness.runtimeOptions,
      pauseOnError: true,
      onBundleError,
    });
    runtime.start();
    await runtime.cycle({ executeLive: true });

    expect(onBundleError).not.toHaveBeenCalled();
    expect(runtime.snapshot.running).toBe(true);
    const skipped = runtime.snapshot.markets.find(
      (market) => market.id === runtime.snapshot.market.id,
    );
    expect(skipped?.skip).toMatchObject({ code: "below-minimum" });
    expect(skipped?.skip?.message).toContain(
      "Its quote rounds to $0.0251, below the venue's $1.00 minimum order. Raise the quote size",
    );
    await runtime.stop();
    harness.store.close();
  });

  it("cancels quotes and keeps reconciling when attributed fills arrive before account positions", async () => {
    vi.useFakeTimers();
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
      orderIds: ["history-first-fill"],
    });
    harness.setPerformanceHistory({
      orders: [
        {
          timestampMs: Date.now(),
          txDigest: "history-first-digest",
          marketId: "0x5678",
          eventType: "FilledMakerOrder",
          side: "bid",
          price: 10,
          size: 3,
          orderId: "history-first-fill",
          realizedPnlUsd: 0,
          feesUsd: 0,
          maker: true,
        },
      ],
      marginHistory: [],
    });
    let makerInventoryUsd = 0;
    harness.setPortfolioResolver((inputs) => {
      const maker = inputs.setup.accountId === "42";
      const inventoryUsd = maker
        ? makerInventoryUsd
        : -makerInventoryUsd * Math.min(1, harness.hedgeExecutions());
      return {
        equityUsd: 100,
        availableCollateralUsd: 80,
        allocatedCollateralUsd: 20,
        freeMarginUsd: 70,
        withdrawableCollateralUsd: 75,
        grossExposureUsd: Math.abs(inventoryUsd),
        unrealizedPnlUsd: 0,
        gasSui: 1,
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

    expect(harness.executions()).toBe(0);
    expect(harness.hedgeExecutions()).toBe(0);
    const cancellationsAfterInitialReconciliation = harness.cancellations();
    expect(cancellationsAfterInitialReconciliation).toBeGreaterThan(0);
    expect(harness.tenant.listEvents(10)).toContainEqual(
      expect.objectContaining({
        action: "position-attribution-reconciliation",
        outcome: "waiting",
      }),
    );

    await vi.advanceTimersByTimeAsync(11_000);
    await harness.runtime.cycle({ executeLive: true });

    expect(harness.runtime.snapshot.running).toBe(true);
    expect(harness.runtime.snapshot.lastError).toBeNull();
    expect(harness.hedgeExecutions()).toBe(0);
    expect(harness.cancellations()).toBe(
      cancellationsAfterInitialReconciliation,
    );

    makerInventoryUsd = 30;
    await harness.runtime.cycle({ executeLive: true });

    expect(harness.hedgeExecutions()).toBe(1);
    expect(harness.executions()).toBe(1);
    expect(harness.tenant.listEvents(10)).toContainEqual(
      expect.objectContaining({
        action: "position-attribution-reconciliation",
        outcome: "confirmed",
      }),
    );

    await harness.runtime.stop();
    harness.store.close();
  });

  it("reconciles a delayed fill from a retired market before rotating again", async () => {
    vi.useFakeTimers();
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
        markets: [
          { marketId: "0x1111", symbol: "ONE" },
          { marketId: "0x2222", symbol: "TWO" },
          { marketId: "0x3333", symbol: "THREE" },
        ],
        mode: "live",
        rotationMode: "single-slot",
        refreshMs: 2_000,
        marketDwellMs: 2_000,
        maxRestingMs: 10_000,
        maxQuoteAgeMs: 40_000,
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
    let quoteAttempt = 0;
    harness.gateway.executeQuote = async (inputs) => {
      if (!inputs.shouldContinue()) throw new Error("cancelled");
      quoteAttempt += 1;
      harness.executionSequence.push("quote");
      return {
        digest: `rotation-${quoteAttempt}`,
        endpoint: "test",
        gasUsedMist: 20,
        postedOrderIds: [`order-${quoteAttempt}-a`, `order-${quoteAttempt}-b`],
      };
    };
    let makerInventoryUsd = 0;
    harness.setPortfolioResolver((inputs) => {
      const maker = inputs.setup.accountId === "42";
      return {
        equityUsd: 100,
        availableCollateralUsd: 80,
        allocatedCollateralUsd: 20,
        freeMarginUsd: 70,
        withdrawableCollateralUsd: 75,
        grossExposureUsd: Math.abs(maker ? makerInventoryUsd : 0),
        unrealizedPnlUsd: 0,
        gasSui: 1,
        positions: inputs.marketIds.map((marketId) => {
          const inventoryUsd =
            marketId === "0x1111"
              ? maker
                ? makerInventoryUsd
                : -makerInventoryUsd * Math.min(1, harness.hedgeExecutions())
              : 0;
          return {
            marketId,
            baseAssetAmount: inventoryUsd / 10,
            pendingOrderCount: 0,
            inventoryUsd,
            unrealizedPnlUsd: 0,
            collateralUsd: 20,
            freeMarginUsd: 70,
            makerOrderIds: [],
            hasPosition: inventoryUsd !== 0,
          };
        }),
      };
    });

    harness.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(quoteAttempt).toBe(2);

    makerInventoryUsd = 30;
    harness.setPerformanceHistory({
      orders: [
        {
          timestampMs: Date.now(),
          txDigest: "retired-fill-digest",
          marketId: "0x1111",
          eventType: "FilledMakerOrder",
          side: "bid",
          price: 10,
          size: 3,
          orderId: "order-1-a",
          realizedPnlUsd: 0,
          feesUsd: 0,
          maker: true,
        },
      ],
      marginHistory: [],
    });
    await vi.advanceTimersByTimeAsync(2_100);

    expect(harness.hedgeExecutions()).toBe(1);
    expect(quoteAttempt).toBe(3);
    expect(harness.executionSequence.indexOf("hedge")).toBeLessThan(
      harness.executionSequence.lastIndexOf("quote"),
    );

    await harness.runtime.stop();
    harness.store.close();
  });

  it("blocks portfolio quoting against every resting pair's simultaneous-fill exposure", async () => {
    const harness = createHarness();
    const markets = Array.from({ length: 10 }, (_, index) => ({
      marketId: `0x${(index + 1).toString(16).padStart(4, "0")}`,
      symbol: `M${index}`,
    }));
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        markets,
        mode: "live",
        rotationMode: "portfolio",
        quoteSizeUsd: 10,
        maxInventoryUsd: 100,
        maxGrossExposureUsd: 150,
      }),
    );
    harness.setPortfolioResolver((inputs) => ({
      equityUsd: 1_000,
      availableCollateralUsd: 1_000,
      allocatedCollateralUsd: 0,
      freeMarginUsd: 1_000,
      withdrawableCollateralUsd: 1_000,
      grossExposureUsd: 100,
      unrealizedPnlUsd: 0,
      gasSui: 1,
      positions: inputs.marketIds.map((marketId) => ({
        marketId,
        baseAssetAmount: 1,
        pendingOrderCount: 2,
        inventoryUsd: 10,
        unrealizedPnlUsd: 0,
        collateralUsd: 0,
        freeMarginUsd: 1_000,
        makerOrderIds: ["101", "102"],
        hasPosition: true,
      })),
    }));

    harness.runtime.start();
    await harness.runtime.cycle();

    expect(harness.executions()).toBe(1);
    expect(harness.runtime.snapshot.running).toBe(true);
    expect(harness.runtime.snapshot.quote).toMatchObject({ sides: "ask" });
    harness.store.close();
  });

  it("keeps Paper reducing filled markets without double-counting paired hedges", async () => {
    const harness = createHarness();
    const markets = Array.from({ length: 15 }, (_, index) => ({
      marketId: `0x${(index + 1).toString(16).padStart(4, "0")}`,
      symbol: `M${index}`,
    }));
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        mode: "paper",
        makerAccountId: "42",
        rotationMode: "portfolio",
        hedge: {
          enabled: true,
          accountId: "43",
          thresholdUsd: 25,
          maxOrderUsd: 100,
          maxSlippageBps: 75,
        },
        markets,
        quoteSizeUsd: 10,
        maxLeverage: 10,
        maxInventoryUsd: 100,
        maxGrossExposureUsd: 200,
        maxQuoteAgeMs: 128_000,
      }),
    );
    const hedgeSetup = setupSchema.parse({
      ownerAddress: `0x${"1".repeat(64)}`,
      accountId: "43",
      accountCapId: "0x4321",
    });
    harness.tenant.setSetup(hedgeSetup);
    harness.tenant.confirmAgentGrant({
      accountId: "43",
      digest: "H".repeat(32),
      agentCapId: "0x9877",
    });

    // Eight prior simulated bid fills contribute $160 of inventory. With the
    // seven remaining flat markets reserved at $10 each, a two-sided refresh
    // has $230 worst-case exposure. The selected filled market must still
    // place its ask-only reducing quote instead of stalling Paper.
    for (const market of markets.slice(0, 8)) {
      harness.tenant.recordPaperQuote({
        trialId: "runtime",
        marketId: market.marketId,
        symbol: market.symbol,
        bidPrice: 10,
        askPrice: 10.1,
        sizeUsd: 10,
        sides: "bid",
      });
      const [makerFill] = harness.tenant.matchPaperOrders({
        trialId: "runtime",
        marketId: market.marketId,
        bestBid: 9.99,
        bestAsk: 9.99,
      });
      harness.tenant.recordPaperHedge({
        trialId: "runtime",
        makerFill: makerFill!,
      });
    }

    harness.runtime.start();
    await harness.runtime.cycle({ executeLive: true });

    expect(harness.runtime.snapshot.paperBlocker).toMatchObject({
      code: "gross-exposure",
      requiredUsd: 230,
    });
    // The risk cap covers the Maker quote envelope: $160 of Maker inventory
    // plus seven flat $10 markets. The opposite $80 hedge leg remains visible
    // in inventory, but must not double-count against the same quote limit.
    expect(harness.runtime.snapshot.portfolio.grossExposureUsd).toBe(80);
    expect(harness.runtime.snapshot.inventory?.grossUsd).toBe(160);
    expect(harness.runtime.snapshot.quote).toMatchObject({
      sides: "ask",
      sizeUsd: 10,
    });
    expect(harness.executionSequence).toContain("paper-dry-run");
    expect(harness.runtime.snapshot.execution.lastDecision).toBe("quoted");
    const performance = await harness.runtime.performance();
    expect(performance.paper).toMatchObject({
      makerFills: 8,
      hedgeFills: 8,
    });
    await harness.runtime.stop();
    harness.store.close();
  });

  it("records one bundle exposure pause, unwinds after ten minutes, and clears without per-market rows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T00:00:00.000Z"));
    const harness = createHarness();
    const markets = Array.from({ length: 15 }, (_, index) => ({
      marketId: `0x${(index + 1).toString(16).padStart(4, "0")}`,
      symbol: `M${index}`,
    }));
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        mode: "paper",
        rotationMode: "portfolio",
        hedge: {
          enabled: false,
          accountId: null,
          thresholdUsd: 25,
          maxOrderUsd: 100,
          maxSlippageBps: 75,
        },
        markets,
        quoteSizeUsd: 10,
        maxGrossExposureUsd: 150,
        maxQuoteAgeMs: 128_000,
        unwindAfterPauseMinutes: 10,
      }),
    );
    for (const market of markets.slice(0, 4)) {
      harness.tenant.recordPaperQuote({
        trialId: "runtime",
        marketId: market.marketId,
        symbol: market.symbol,
        bidPrice: 10,
        askPrice: 10.1,
        sizeUsd: 10,
        sides: "bid",
      });
      harness.tenant.matchPaperOrders({
        trialId: "runtime",
        marketId: market.marketId,
        bestBid: 9.9,
        bestAsk: 9.9,
      });
    }
    harness.setPortfolioResolver((inputs) => ({
      equityUsd: 1_000,
      availableCollateralUsd: 1_000,
      allocatedCollateralUsd: 0,
      freeMarginUsd: 1_000,
      withdrawableCollateralUsd: 1_000,
      grossExposureUsd: 0,
      unrealizedPnlUsd: 0,
      gasSui: 1,
      positions: inputs.marketIds.map((marketId) => ({
        marketId,
        baseAssetAmount: 0,
        pendingOrderCount: 0,
        inventoryUsd: 0,
        unrealizedPnlUsd: 0,
        collateralUsd: 0,
        freeMarginUsd: 1_000,
        makerOrderIds: [],
        hasPosition: false,
      })),
    }));
    harness.runtime.start();
    await harness.runtime.cycle({ executeLive: true });
    expect(harness.runtime.snapshot.paperBlocker).toMatchObject({
      code: "gross-exposure",
      requiredUsd: 190,
    });

    for (let minute = 15; minute <= 75; minute += 15) {
      vi.setSystemTime(
        new Date(
          `2026-11-04T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`,
        ),
      );
      await harness.runtime.cycle({ executeLive: true });
    }

    const events = harness.tenant
      .listEvents(100)
      .filter(
        (event) => event.category === "paper" && event.action === "simulation",
      );
    expect(events.filter((event) => event.outcome === "blocked")).toHaveLength(
      5,
    );
    expect(events.filter((event) => event.outcome === "cleared")).toHaveLength(
      1,
    );
    expect(events.every((event) => !("marketId" in event.detail))).toBe(true);
    expect(harness.tenant.getPaperState("runtime").positions).toEqual([]);
    await harness.runtime.stop();
    harness.store.close();
  });

  it("uses the held Paper market's touch for an exposure unwind", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-08T00:00:00.000Z"));
    const harness = createHarness();
    const selected = { marketId: "0x0001", symbol: "SELECTED" };
    const held = { marketId: "0x0002", symbol: "HELD" };
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        mode: "paper",
        rotationMode: "portfolio",
        hedge: {
          enabled: false,
          accountId: null,
          thresholdUsd: 25,
          maxOrderUsd: 100,
          maxSlippageBps: 75,
        },
        markets: [selected, held],
        quoteSizeUsd: 10,
        maxInventoryUsd: 10,
        maxGrossExposureUsd: 10,
        unwindAfterPauseMinutes: 10,
      }),
    );
    harness.tenant.recordPaperQuote({
      trialId: "runtime",
      marketId: held.marketId,
      symbol: held.symbol,
      bidPrice: 10,
      askPrice: 10.1,
      sizeUsd: 10,
      sides: "bid",
    });
    harness.tenant.matchPaperOrders({
      trialId: "runtime",
      marketId: held.marketId,
      bestBid: 9.9,
      bestAsk: 9.9,
    });

    const books = new Map([
      [selected.marketId, { bestBidPrice: 1, bestAskPrice: 1.01 }],
      [held.marketId, { bestBidPrice: 9, bestAskPrice: 9.1 }],
    ]);
    harness.gateway.getOrderbook = async (marketId: string) => ({
      market: {
        metadata: { symbol: marketId === held.marketId ? "HELD" : "SELECTED" },
        indexPrice: marketId === held.marketId ? 10 : 1,
        marketState: { openInterest: 1_000 },
        marketParams: { maxOpenInterest: 10_000 },
        estimatedFundingRate: () => 0.0001,
        tickSize: () => 0.01,
      },
      orderbook: books.get(marketId)!,
    });

    harness.runtime.start();
    await harness.runtime.cycle({ executeLive: true });
    vi.setSystemTime(new Date("2026-11-08T00:10:00.000Z"));
    await harness.runtime.cycle({ executeLive: true });

    const unwind = harness.tenant
      .listPaperFills({ trialId: "runtime" })
      .find((fill) => fill.orderKey.startsWith("unwind:"));
    expect(unwind).toMatchObject({
      marketId: held.marketId,
      price: 9,
      sizeUsd: 9,
    });
    expect(harness.tenant.getPaperState("runtime").positions).toEqual([]);
    await harness.runtime.stop();
    harness.store.close();
  });

  it("clears the exposure pause below the limit even while positions remain", async () => {
    // Production: "Paper paused new exposure" never cleared because the clear
    // check looked for a key shape that no longer existed.
    const harness = createHarness();
    const markets = [
      { marketId: "0x0001", symbol: "A" },
      { marketId: "0x0002", symbol: "B" },
      { marketId: "0x0003", symbol: "C" },
    ];
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        mode: "paper",
        rotationMode: "portfolio",
        hedge: {
          enabled: false,
          accountId: null,
          thresholdUsd: 25,
          maxOrderUsd: 100,
          maxSlippageBps: 75,
        },
        markets,
        quoteSizeUsd: 10,
        maxInventoryUsd: 50,
        maxGrossExposureUsd: 60,
        unwindAfterPauseMinutes: 0,
      }),
    );
    for (const market of markets) {
      harness.tenant.recordPaperQuote({
        trialId: "runtime",
        marketId: market.marketId,
        symbol: market.symbol,
        bidPrice: 10,
        askPrice: 10.1,
        sizeUsd: 20,
        sides: "bid",
      });
      harness.tenant.matchPaperOrders({
        trialId: "runtime",
        marketId: market.marketId,
        bestBid: 9.9,
        bestAsk: 9.9,
      });
    }
    harness.runtime.start();
    // $20 long in each of 3 markets: worst case 3 x $30 = $90, over $60.
    await harness.runtime.cycle({ executeLive: true });
    expect(harness.runtime.snapshot.paperBlocker?.code).toBe("gross-exposure");

    // Close two markets: worst case $30 + $10 + $10 = $50, at the resume line
    // ($60 limit minus one $10 quote) with one position still open.
    for (const market of markets.slice(0, 2))
      harness.tenant.closePaperMarket({
        trialId: "runtime",
        marketId: market.marketId,
        bestBid: 10,
        bestAsk: 10,
        reason: "unwind",
      });
    await harness.runtime.cycle({ executeLive: true });

    expect(harness.tenant.getPaperState("runtime").positions).toHaveLength(1);
    expect(harness.runtime.snapshot.paperBlocker).toBeNull();
    expect(
      harness.tenant
        .listEvents(100)
        .filter(
          (event) =>
            event.category === "paper" &&
            event.action === "simulation" &&
            event.outcome === "cleared",
        ),
    ).toHaveLength(1);
    await harness.runtime.stop();
    harness.store.close();
  });

  it("uses the Live cancel-confirm-then-reduce path after an exposure pause", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T00:00:00.000Z"));
    const harness = createHarness();
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        markets: [{ marketId: "0x5678", symbol: "SUI" }],
        mode: "live",
        quoteSizeUsd: 10,
        maxInventoryUsd: 20,
        maxGrossExposureUsd: 20,
        unwindAfterPauseMinutes: 10,
      }),
    );
    harness.setPortfolioResolver((inputs) => ({
      equityUsd: 100,
      availableCollateralUsd: 80,
      allocatedCollateralUsd: 20,
      freeMarginUsd: 70,
      withdrawableCollateralUsd: 75,
      grossExposureUsd: 20,
      unrealizedPnlUsd: 0,
      gasSui: 1,
      positions: inputs.marketIds.map((marketId) => ({
        marketId,
        baseAssetAmount: 2,
        pendingOrderCount: 1,
        inventoryUsd: 20,
        unrealizedPnlUsd: 0,
        collateralUsd: 20,
        freeMarginUsd: 70,
        makerOrderIds: ["resting"],
        hasPosition: true,
      })),
    }));
    harness.runtime.start();
    await harness.runtime.cycle({ executeLive: true });
    vi.setSystemTime(new Date("2026-11-04T00:10:00.000Z"));
    await harness.runtime.cycle({ executeLive: true });

    expect(harness.executionSequence).toContain("flatten");
    expect(harness.executionSequence.indexOf("cancel")).toBeLessThan(
      harness.executionSequence.indexOf("flatten"),
    );
    expect(harness.flattens()).toBe(1);
    expect(
      harness.tenant
        .listEvents(20)
        .some(
          (event) =>
            event.category === "risk" &&
            event.action === "exposure-unwind" &&
            event.outcome === "confirmed",
        ),
    ).toBe(true);
    await harness.runtime.stop();
    harness.store.close();
  });

  it("does not unwind an exposure pause when the timeout is disabled", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T00:00:00.000Z"));
    const harness = createHarness();
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        mode: "paper",
        quoteSizeUsd: 10,
        maxInventoryUsd: 20,
        maxGrossExposureUsd: 20,
        unwindAfterPauseMinutes: 0,
      }),
    );
    harness.tenant.recordPaperQuote({
      trialId: "runtime",
      marketId: "0x5678",
      symbol: "SUI",
      bidPrice: 10,
      askPrice: 10.1,
      sizeUsd: 10,
      sides: "bid",
    });
    harness.tenant.matchPaperOrders({
      trialId: "runtime",
      marketId: "0x5678",
      bestBid: 9.9,
      bestAsk: 9.9,
    });
    harness.runtime.start();
    await harness.runtime.cycle({ executeLive: true });
    vi.setSystemTime(new Date("2026-11-04T01:00:00.000Z"));
    await harness.runtime.cycle({ executeLive: true });

    expect(harness.tenant.getPaperState("runtime").positions).toHaveLength(1);
    expect(
      harness.tenant
        .listEvents(20)
        .some((event) => event.action === "exposure-unwind"),
    ).toBe(false);
    await harness.runtime.stop();
    harness.store.close();
  });

  it("keeps deselected positions inside the account-wide gross exposure gate", async () => {
    const harness = createHarness();
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        markets: [{ marketId: "0x5678", symbol: "SUI" }],
        mode: "live",
        maxInventoryUsd: 50,
        maxGrossExposureUsd: 50,
      }),
    );
    harness.setPortfolioResolver((inputs) => ({
      equityUsd: 100,
      availableCollateralUsd: 80,
      allocatedCollateralUsd: 20,
      freeMarginUsd: 70,
      withdrawableCollateralUsd: 75,
      grossExposureUsd: 60,
      unrealizedPnlUsd: 0,
      gasSui: 1,
      positions: [
        ...inputs.marketIds.map((marketId) => ({
          marketId,
          baseAssetAmount: 0,
          pendingOrderCount: 0,
          inventoryUsd: 0,
          unrealizedPnlUsd: 0,
          collateralUsd: 0,
          freeMarginUsd: 70,
          makerOrderIds: [],
          hasPosition: false,
        })),
        {
          marketId: "0x9999",
          baseAssetAmount: 6,
          pendingOrderCount: 0,
          inventoryUsd: 60,
          unrealizedPnlUsd: 0,
          collateralUsd: 20,
          freeMarginUsd: 70,
          makerOrderIds: [],
          hasPosition: true,
        },
      ],
    }));

    harness.runtime.start();
    await harness.runtime.cycle();

    expect(harness.executions()).toBe(0);
    expect(harness.runtime.snapshot.running).toBe(true);
    expect(harness.runtime.snapshot.execution.lastDecision).toBe("held");
    harness.store.close();
  });

  it("fails closed when the dedicated hedge account nears margin or liquidation limits", async () => {
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
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
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
    harness.setPortfolioResolver((inputs) => {
      const unsafe = inputs.setup.accountId === "43";
      return {
        equityUsd: 100,
        availableCollateralUsd: 80,
        allocatedCollateralUsd: unsafe ? 20 : 0,
        freeMarginUsd: 70,
        withdrawableCollateralUsd: 75,
        grossExposureUsd: 0,
        unrealizedPnlUsd: 0,
        gasSui: 1,
        positions: inputs.marketIds.map((marketId) => ({
          marketId,
          baseAssetAmount: unsafe ? 1 : 0,
          pendingOrderCount: 0,
          inventoryUsd: 0,
          unrealizedPnlUsd: 0,
          collateralUsd: unsafe ? 20 : 0,
          freeMarginUsd: 70,
          marginRatio: unsafe ? 0.05 : null,
          liquidationDistanceBps: unsafe ? 500 : null,
          makerOrderIds: [],
          hasPosition: unsafe,
        })),
      };
    });

    harness.runtime.start();
    await harness.runtime.cycle();

    expect(harness.executions()).toBe(0);
    expect(harness.runtime.snapshot.lastError).toContain("hedge-margin");
    expect(harness.runtime.snapshot.lastError).toContain("hedge-liquidation");
    harness.store.close();
  });

  it("fails closed with venue copy when a real position has no reported margin ratio", async () => {
    const harness = createHarness();
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        mode: "paper",
        markets: [{ marketId: "0x5678", symbol: "SUI" }],
      }),
    );
    harness.setPortfolioResolver((inputs) => ({
      equityUsd: 100,
      availableCollateralUsd: 80,
      allocatedCollateralUsd: 20,
      freeMarginUsd: 70,
      withdrawableCollateralUsd: 75,
      grossExposureUsd: 10,
      unrealizedPnlUsd: 0,
      gasSui: 1,
      positions: inputs.marketIds.map((marketId) => ({
        marketId,
        baseAssetAmount: 1,
        pendingOrderCount: 0,
        inventoryUsd: 10,
        unrealizedPnlUsd: 0,
        collateralUsd: 20,
        freeMarginUsd: 70,
        marginRatio: null,
        liquidationDistanceBps: null,
        makerOrderIds: [],
        hasPosition: true,
      })),
    }));
    harness.runtime.start();
    await harness.runtime.cycle();
    expect(harness.runtime.snapshot.paperBlocker?.message).toBe(
      "Aftermath didn't report a margin ratio for SUI. Maker won't quote until it does.",
    );
    const runtimeText = JSON.stringify({
      snapshot: harness.runtime.snapshot,
      events: harness.tenant.listEvents(),
    });
    expect(runtimeText).not.toMatch(/NaN|undefined|Infinity/);
    harness.store.close();
  });

  it("automatically flattens both dedicated accounts before the gross limit", async () => {
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
        quoteSizeUsd: 10,
        maxInventoryUsd: 50,
        maxGrossExposureUsd: 100,
        autoRebalanceEnabled: true,
        rebalanceGrossExposureUsd: 35,
      }),
    );
    harness.tenant.trackMakerOrders({
      accountId: "42",
      marketId: "0x5678",
      quoteDigest: "quote-digest",
      orderIds: ["rebalance-fill"],
    });
    harness.setPerformanceHistory({
      orders: [
        {
          timestampMs: Date.now(),
          txDigest: "rebalance-fill-digest",
          marketId: "0x5678",
          eventType: "FilledMakerOrder",
          side: "bid",
          price: 10,
          size: 3,
          orderId: "rebalance-fill",
          realizedPnlUsd: 0,
          feesUsd: 0,
          maker: true,
        },
      ],
      marginHistory: [],
    });
    harness.setPortfolioResolver((inputs) => {
      // The first paired sweep leaves a delayed position visible, matching
      // mainnet account-index reconciliation observed during the canary.
      const flattened = harness.flattens() >= 4;
      const maker = inputs.setup.accountId === "42";
      const inventoryUsd = flattened
        ? 0
        : maker
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
        gasSui: 1,
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
    await harness.runtime.cycle({ executeLive: true });

    expect(harness.hedgeExecutions()).toBe(1);
    expect(harness.flattens()).toBe(4);
    expect(harness.flattenedAccountIds()).toEqual(["42", "43", "42", "43"]);
    expect(harness.executions()).toBe(0);
    expect(harness.runtime.snapshot.execution.lastDecision).toBe("rebalanced");
    expect(harness.tenant.listEvents(10)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "automatic-paired-rebalance",
          outcome: "retry",
        }),
        expect.objectContaining({
          action: "automatic-paired-rebalance",
          outcome: "confirmed",
        }),
      ]),
    );

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
    let stalePostCancelReads = 2;
    let stalePostHedgeReads = 1;
    harness.setPortfolioResolver((inputs) => {
      const maker = inputs.setup.accountId === "42";
      const hedgeVisible =
        !maker && harness.hedgeExecutions() > 0 && stalePostHedgeReads-- <= 0;
      const inventoryUsd = maker ? 30 : hedgeVisible ? -30 : 0;
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
        gasSui: 1,
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
    expect(harness.executionSequence.slice(0, 4)).toEqual([
      "cancel",
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
    expect(
      harness.tenant
        .listEvents()
        .find(
          (event) =>
            event.action === "post-hedge-reconciliation" &&
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
        gasSui: 1,
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
        gasSui: 1,
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
    expect(harness.executions()).toBe(1);
    expect(harness.executionSequence.slice(0, 3)).toEqual([
      "cancel",
      "cancel",
      "hedge",
    ]);
    expect(harness.runtime.snapshot.running).toBe(true);
    expect(harness.runtime.snapshot.quote).toMatchObject({ sides: "ask" });
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
        gasSui: 1,
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

  it("stops Paper by cancelling its scratch ledger without signing", async () => {
    const harness = createHarness();
    const config = harness.tenant.getConfig()!;
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...config,
        mode: "paper",
      }),
    );

    harness.runtime.start();
    await harness.runtime.cycle();
    expect(harness.runtime.snapshot.paper.openOrders).toBeGreaterThan(0);
    await harness.runtime.stop();

    expect(harness.cancellations()).toBe(0);
    expect(harness.runtime.snapshot.paper.openOrders).toBe(0);
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

  it("deduplicates concurrent flatten requests", async () => {
    const harness = createHarness();

    const [first, second] = await Promise.all([
      harness.runtime.flatten(0.01),
      harness.runtime.flatten(0.01),
    ]);

    expect(first).toEqual(second);
    expect(harness.cancellations()).toBe(1);
    expect(harness.flattens()).toBe(1);
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
    // The first quote is confirmed resting, then the market RPC hangs.
    (
      harness.runtime as unknown as {
        snapshotValue: { restingQuoteMarketIds: string[] };
      }
    ).snapshotValue.restingQuoteMarketIds = ["0x5678"];
    const readBook = harness.gateway.getOrderbook.bind(harness.gateway);
    harness.gateway.getOrderbook = async () =>
      new Promise<never>(() => undefined);
    await vi.advanceTimersByTimeAsync(13_000);

    // The quotes are cancelled, but the bundle keeps running on its own.
    expect(harness.runtime.snapshot.running).toBe(true);
    expect(harness.runtime.snapshot.watchdog.state).toBe("tripped");
    expect(harness.cancellations()).toBeGreaterThanOrEqual(1);
    expect(
      harness.tenant
        .listEvents()
        .some((event) => event.action === "watchdog-stop"),
    ).toBe(false);

    // When the market reads again, it quotes again without anyone resuming it.
    const quotesBefore = harness.executions();
    harness.gateway.getOrderbook = readBook;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(harness.runtime.snapshot.watchdog.state).toBe("armed");
    expect(harness.executions()).toBeGreaterThan(quotesBefore);
    await harness.runtime.stop();
    harness.store.close();
  });

  it("cancels only the market whose quote went unchecked, and keeps quoting", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        rotationMode: "portfolio",
        refreshMs: 2_000,
        maxQuoteAgeMs: 10_000,
      }),
    );
    const runtime = harness.runtime as unknown as {
      snapshotValue: {
        restingQuoteMarketIds: string[];
        markets: Array<{ id: string; updatedAt: string | null }>;
        lastSuccessfulCycleAt: string | null;
      };
      checkQuoteAges: (config: unknown) => Promise<void>;
    };
    harness.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    // SUI's quote rests but hasn't been re-checked for 20s; BTC is fresh.
    const now = Date.now();
    runtime.snapshotValue.restingQuoteMarketIds = ["0x5678", "0x9999"];
    runtime.snapshotValue.lastSuccessfulCycleAt = new Date(now).toISOString();
    runtime.snapshotValue.markets = runtime.snapshotValue.markets.map(
      (market) => ({
        ...market,
        updatedAt: new Date(
          market.id === "0x5678" ? now - 20_000 : now,
        ).toISOString(),
      }),
    );
    const before = harness.cancellations();
    await runtime.checkQuoteAges(harness.tenant.getConfig());

    expect(harness.cancellations()).toBe(before + 1);
    expect(harness.cancelledMarketSets().at(-1)).toEqual(["0x5678"]);
    expect(runtime.snapshotValue.restingQuoteMarketIds).toEqual(["0x9999"]);
    expect(harness.runtime.snapshot.running).toBe(true);
    expect(harness.runtime.snapshot.watchdog.state).toBe("armed");
    expect(
      harness.tenant
        .listEvents()
        .find((event) => event.action === "stale-quote-cancel")?.detail,
    ).toMatchObject({ symbols: ["SUI"], maxQuoteAgeMs: 10_000 });
    await harness.runtime.stop();
    harness.store.close();
  });

  it("does not age a single-slot quote before the transaction is confirmed", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const executeQuote = harness.gateway.executeQuote.bind(harness.gateway);
    harness.gateway.executeQuote = async (inputs) => {
      await new Promise((resolve) => setTimeout(resolve, 40_000));
      return executeQuote(inputs);
    };
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        markets: [{ marketId: "0x5678", symbol: "SUI" }],
        mode: "live",
        rotationMode: "single-slot",
        refreshMs: 2_000,
        marketDwellMs: 60_000,
        maxRestingMs: 5_000,
        maxQuoteAgeMs: 35_000,
      }),
    );

    harness.runtime.start();
    await vi.advanceTimersByTimeAsync(40_100);

    expect(harness.executions()).toBe(1);
    expect(harness.runtime.snapshot.running).toBe(true);
    expect(harness.runtime.snapshot.watchdog.state).toBe("armed");

    await harness.runtime.stop();
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
      gasSui: 1,
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

  it("cancels the prior pair before retrying a crossed market switch", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    let attempts = 0;
    harness.gateway.executeQuote = async (inputs) => {
      if (!inputs.shouldContinue()) throw new Error("cancelled");
      attempts += 1;
      if (attempts === 2) {
        throw new Error(
          "Post-only quote would cross the changed book; retrying from a fresh observation. Venue error: MoveAbort in 8th command, abort code: 47, in '0x1::clearing_house::execute_limit_order'",
        );
      }
      return {
        digest: `switch-attempt-${attempts}`,
        endpoint: "test",
        gasUsedMist: 20,
        postedOrderIds: ["101", "102"],
      };
    };
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        rotationMode: "single-slot",
        refreshMs: 2_000,
        marketDwellMs: 10_000,
        requoteThresholdBps: 5,
        maxRestingMs: 20_000,
        maxQuoteAgeMs: 50_000,
      }),
    );

    harness.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_100);

    expect(attempts).toBe(2);
    expect(harness.cancellations()).toBe(2);
    expect(harness.runtime.snapshot.running).toBe(true);
    expect(harness.runtime.snapshot.lastError).toBeNull();
    expect(harness.tenant.listEvents(10)).toContainEqual(
      expect.objectContaining({
        action: "post-only-retry",
        outcome: "retry",
        detail: expect.objectContaining({
          cancelledPriorMarketId: "0x5678",
        }),
      }),
    );

    await vi.advanceTimersByTimeAsync(2_000);
    expect(attempts).toBe(3);
    expect(harness.runtime.snapshot.execution.lastDecision).toBe("quoted");

    await harness.runtime.stop();
    harness.store.close();
  });

  it("retries an atomic post-only crossing race without stopping", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    let attempts = 0;
    harness.gateway.executeQuote = async (inputs) => {
      if (!inputs.shouldContinue()) throw new Error("cancelled");
      attempts += 1;
      if (attempts === 1) {
        throw new Error(
          "Post-only quote would cross the changed book; retrying from a fresh observation. Venue error: MoveAbort in 8th command, abort code: 47, in '0x1::clearing_house::execute_limit_order'",
        );
      }
      return {
        digest: "retry-success",
        endpoint: "test",
        gasUsedMist: 20,
        postedOrderIds: ["101", "102"],
      };
    };
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        markets: [{ marketId: "0x5678", symbol: "SUI" }],
        rotationMode: "single-slot",
        refreshMs: 2_000,
        marketDwellMs: 20_000,
        maxRestingMs: 20_000,
        maxQuoteAgeMs: 50_000,
      }),
    );

    harness.runtime.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(attempts).toBe(1);
    expect(harness.runtime.snapshot.running).toBe(true);
    expect(harness.runtime.snapshot.lastError).toBeNull();
    expect(harness.cancellations()).toBe(1);
    expect(harness.tenant.listEvents(10)).toContainEqual(
      expect.objectContaining({
        action: "post-only-retry",
        outcome: "retry",
      }),
    );

    await vi.advanceTimersByTimeAsync(2_100);
    expect(attempts).toBe(2);
    expect(harness.runtime.snapshot.running).toBe(true);
    expect(harness.runtime.snapshot.execution.lastDecision).toBe("quoted");

    await harness.runtime.stop();
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

    expect(cancellationAttempts).toBe(4);
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

    expect(harness.cancellations()).toBe(2);
    expect(harness.runtime.snapshot.running).toBe(false);
    harness.store.close();
  });

  it("atomically switches the active market after its dwell interval", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        rotationMode: "single-slot",
        refreshMs: 2_000,
        marketDwellMs: 2_000,
        maxRestingMs: 10_000,
        maxQuoteAgeMs: 40_000,
      }),
    );

    harness.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_100);

    expect(harness.executions()).toBe(2);
    expect(harness.quoteInputs()[0]?.cancelMarketIds).toBeUndefined();
    expect(harness.quoteInputs()[1]?.cancelMarketIds).toEqual(["0x5678"]);
    expect(harness.runtime.snapshot.execution.lastDecision).toBe("switched");
    expect(harness.cancellations()).toBe(1);
    await harness.runtime.stop();
    harness.store.close();
  });

  it("polls without paying for an unchanged resting quote", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        markets: [{ marketId: "0x5678", symbol: "SUI" }],
        rotationMode: "single-slot",
        refreshMs: 2_000,
        marketDwellMs: 20_000,
        requoteThresholdBps: 5,
        maxRestingMs: 10_000,
        maxQuoteAgeMs: 40_000,
      }),
    );

    harness.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_100);

    expect(harness.executions()).toBe(1);
    expect(harness.runtime.snapshot.execution.avoidedTransactions).toBe(1);
    expect(harness.runtime.snapshot.execution.lastDecision).toBe("held");

    await vi.advanceTimersByTimeAsync(8_000);
    expect(harness.executions()).toBe(2);
    expect(harness.runtime.snapshot.execution.lastDecision).toBe("quoted");

    await harness.runtime.stop();
    harness.store.close();
  });

  it("requotes before maximum age when fair value moves materially", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    let indexPrice = 10;
    harness.gateway.getOrderbook = async () => ({
      market: {
        metadata: { symbol: "SUI" },
        indexPrice,
        marketState: { openInterest: 1_000 },
        marketParams: { maxOpenInterest: 10_000 },
        estimatedFundingRate: () => 0.0001,
        tickSize: () => 0.01,
      },
      orderbook: {
        bestBidPrice: indexPrice - 0.01,
        bestAskPrice: indexPrice + 0.01,
      },
    });
    harness.tenant.setConfig(
      makerConfigSchema.parse({
        ...harness.tenant.getConfig()!,
        markets: [{ marketId: "0x5678", symbol: "SUI" }],
        rotationMode: "single-slot",
        refreshMs: 2_000,
        marketDwellMs: 20_000,
        requoteThresholdBps: 5,
        maxRestingMs: 20_000,
        maxQuoteAgeMs: 50_000,
      }),
    );

    harness.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    indexPrice = 10.1;
    await vi.advanceTimersByTimeAsync(2_100);

    expect(harness.executions()).toBe(2);
    expect(harness.runtime.snapshot.execution.avoidedTransactions).toBe(0);
    expect(harness.runtime.snapshot.execution.lastDecision).toBe("quoted");

    await harness.runtime.stop();
    harness.store.close();
  });

  it("runs three isolated Paper cycles without signing, flattening, or writing config", async () => {
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

    const result = await harness.runtime.runPaperTrial({ cadenceMs: 2_000 });

    expect(result.rounds).toHaveLength(3);
    expect(result.rounds.every((round) => round.outcome === "simulated")).toBe(
      true,
    );
    expect(harness.executions()).toBe(0);
    expect(harness.flattens()).toBe(0);
    expect(harness.cancellations()).toBe(0);
    expect(harness.executionSequence).toEqual([
      "paper-dry-run",
      "paper-dry-run",
      "paper-dry-run",
    ]);
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
    expect(harness.cancellations()).toBe(2);
    expect(harness.runtime.snapshot.running).toBe(false);
    expect(harness.runtime.snapshot.lastError).toBeNull();
    harness.store.close();
  });
});
