export type Mode = "observe" | "paper" | "live";

export type SafetyCheck = {
  code: string;
  label: string;
  ok: boolean;
  detail: string;
};

export type RuntimeMarket = {
  id: string;
  symbol: string;
  status: "queued" | "healthy" | "error";
  indexPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  openInterestBase: number | null;
  openInterestUsd: number | null;
  openInterestUtilizationPct: number | null;
  volume24hUsd: number | null;
  fundingRate: number | null;
  inventoryUsd: number;
  unrealizedPnlUsd: number;
  bidPrice: number | null;
  askPrice: number | null;
  effectiveSpreadBps: number;
  effectiveQuoteSizeUsd: number;
  effectiveMaxInventoryUsd: number;
  inventoryTargetUsd: number;
  lastTransactionDigest: string | null;
  updatedAt: string | null;
  error: string | null;
};

export type Snapshot = {
  mode: Mode;
  running: boolean;
  cycle: number;
  startedAt: string | null;
  lastCycleAt: string | null;
  lastSuccessfulCycleAt: string | null;
  lastError: string | null;
  setupComplete: boolean;
  agentAddress: string | null;
  accountId: string | null;
  market: {
    id: string;
    symbol: string;
    indexPrice: number | null;
    bestBid: number | null;
    bestAsk: number | null;
    updatedAt: string | null;
    book: {
      bids: Array<[number, number]>;
      asks: Array<[number, number]>;
      observedAt: string;
    } | null;
  };
  risk: {
    runDrawdownUsd: number | null;
    runHighEquityUsd: number | null;
    measuredAt: string | null;
  };
  markets: RuntimeMarket[];
  portfolio: {
    selectedMarkets: number;
    grossExposureUsd: number;
    unrealizedPnlUsd: number;
    availableCollateralUsd: number | null;
    allocatedCollateralUsd: number | null;
    freeMarginUsd: number | null;
    withdrawableCollateralUsd: number | null;
  };
  balances: {
    equityUsd: number | null;
    inventoryUsd: number;
    unrealizedPnlUsd: number;
    gasSui: number | null;
  };
  watchdog: {
    state: "idle" | "armed" | "tripped";
    checkedAt: string | null;
    maxQuoteAgeMs: number | null;
  };
  execution: {
    confirmedLiveQuotes: number;
    averageGasMist: number | null;
    gasRunwayTransactions: number | null;
    avoidedTransactions: number;
    lastDecision: "quoted" | "switched" | "held" | "rebalanced" | null;
    lastExecutionAt: string | null;
  };
  hedge: {
    enabled: boolean;
    state: "off" | "waiting" | "ready" | "hedging" | "error";
    accountId: string | null;
    combinedDeltaUsd: number | null;
    lastHedgeAt: string | null;
    lastDigest: string | null;
    error: string | null;
  };
  quote: {
    bidPrice: number;
    askPrice: number;
    sizeUsd: number;
  } | null;
  safety: SafetyCheck[];
};

export type MakerConfig = {
  markets: Array<{
    marketId: string;
    symbol: string;
    overrides?: {
      quoteSizeUsd?: number;
      spreadBps?: number;
      maxInventoryUsd?: number;
      inventoryTargetUsd?: number;
      inventorySkewBps?: number;
      maxLeverage?: number;
    };
  }>;
  collateralCoinType: string;
  mode: Mode;
  rotationMode: "portfolio" | "single-slot";
  strategyObjective: "farming" | "profit" | "both";
  strategyProfile: "cautious" | "balanced" | "active";
  makerAccountId: string | null;
  hedge: {
    enabled: boolean;
    accountId: string | null;
    thresholdUsd: number;
    maxOrderUsd: number;
    maxSlippageBps: number;
  };
  quoteSizeUsd: number;
  spreadBps: number;
  refreshMs: number;
  marketDwellMs: number;
  requoteThresholdBps: number;
  maxRestingMs: number;
  autoRebalanceEnabled: boolean;
  rebalanceGrossExposureUsd: number;
  maxQuoteAgeMs: number;
  maxInventoryUsd: number;
  inventoryTargetUsd: number;
  maxGrossExposureUsd: number;
  maxUnrealizedLossUsd: number;
  maxRunDrawdownUsd: number;
  maxBookDivergenceBps: number;
  maxLeverage: number;
  maxGasMist: number;
  staleBookMs: number;
  inventorySkewBps: number;
};

export type SetupState = {
  setup: {
    ownerAddress: string;
    accountId: string;
    accountCapId: string;
    collateralCoinType: string;
  } | null;
  accounts: Array<{
    ownerAddress: string;
    accountId: string;
    accountCapId: string;
    collateralCoinType: string;
    addedAt: string;
    grantDigest: string | null;
    agentCapId: string | null;
  }>;
  agent: {
    address: string;
    createdAt: string;
    grantDigest: string | null;
    agentCapId: string | null;
  } | null;
};

export type Performance = {
  asOf: string;
  period: "1D" | "EPOCH" | "ALL";
  periodStartedAt: string | null;
  historyComplete: boolean;
  account: {
    realizedPnlUsd: number;
    fundingPnlUsd: number;
    makerVolumeUsd: number;
    takerVolumeUsd: number;
    makerFeesUsd: number;
    takerFeesUsd: number;
  } | null;
  attributed: {
    fills: number;
    notionalUsd: number;
    realizedPnlUsd: number;
    protocolFeesUsd: number;
    estimatedBuilderFeesUsd: number;
    netAfterKnownCostsUsd: number;
    makerVolumeCoveragePct: number | null;
  };
  hedge: {
    enabled: boolean;
    accountId: string | null;
    executions: number;
    fills: number;
    notionalUsd: number;
    realizedPnlUsd: number;
    protocolFeesUsd: number;
    estimatedBuilderFeesUsd: number;
    netAfterKnownCostsUsd: number;
  };
  combinedNetAfterKnownCostsUsd: number;
  volumeByMarket: Array<{
    marketId: string;
    symbol: string;
    makerNotionalUsd: number;
    makerFills: number;
    takerNotionalUsd: number;
    takerFills: number;
    realizedPnlUsd: number;
    feesUsd: number;
  }>;
  fills: Array<{
    occurredAt: string;
    txDigest: string;
    marketId: string;
    symbol: string;
    side: "bid" | "ask";
    price: number;
    size: number;
    notionalUsd: number;
    realizedPnlUsd: number;
    protocolFeesUsd: number;
    estimatedBuilderFeeUsd: number;
    orderId: string;
  }>;
  note: string;
};

export type RewardDashboard = {
  asOf: string;
  epoch: {
    number: number;
    startedAt: string;
    cutoffAt: string;
  };
  account: {
    trackedAccountIds: string[];
    error: string | null;
    makerRewardsSui: number;
    qScoreShare: number;
    uptime: number;
    makerVolumeUsd: number;
    makerVolumeShare: number;
    directRebatesUsd: number;
    baseMakerFeesUsd: number;
  };
  marketModel: {
    label: "heuristic";
    methodology: string;
    depthBandBps: 50;
    opportunities: Array<{
      rank: number;
      marketId: string;
      symbol: string;
      minOrderUsdValue: number;
      minimumQuoteSizeUsd: number;
      objective: "farming" | "profit" | "both";
      score: number;
      farmingScore: number;
      profitScore: number;
      bothScore: number;
      confidence: "high" | "medium" | "low";
      eligible: boolean;
      objectiveEligible: boolean;
      thinActive: boolean;
      observedSpreadBps: number | null;
      preRiskEdgeBps: number | null;
      balancedDepth50BpsUsd: number;
      volume24hUsd: number | null;
      openInterestUsd: number;
      openInterestUtilizationPct: number | null;
      volumeToDepth: number | null;
      fundingRate: number;
      priceChange24hPct: number | null;
      makerRebateBps: number;
      builderFeeBps: number;
      knownCostBps: number;
      suggestedSpreadBps: number;
      suggestedQuoteSizeUsd: number;
      reasons: string[];
      error: string | null;
    }>;
  };
};

export type AuditEvent = {
  id: number;
  occurredAt: string;
  category: string;
  action: string;
  outcome: string;
  detail: Record<string, unknown>;
};

export type AccessIdentity = {
  ownerAddress: string;
  operator: boolean;
  registryConfigured: boolean;
  registryObjectId: string | null;
};

export type OperatorStatus = {
  operatorAddress: string;
  registryObjectId: string | null;
  packageId: string | null;
  adminCapId: string | null;
  builderCode: {
    integratorId: number;
    integratorFee: number;
  } | null;
  bootstrap: boolean;
};

export type FixtureState = {
  auth:
    | { status: 200; body: AccessIdentity }
    | { status: 401 | 403; body: { error: string } };
  status: {
    snapshot: Snapshot;
    builderCode: { integratorId: number; integratorFee: number } | null;
    liveGates: {
      liveTradingEnabled: boolean;
      mainnetAllowed: boolean;
    };
  };
  config: { config: MakerConfig | null };
  setup: SetupState;
  accounts: {
    accounts: Array<{
      accountId: string;
      accountCapId: string;
      collateralCoinType: string;
      equityUsd: number;
      availableCollateralUsd: number;
      allocatedCollateralUsd: number;
      freeMarginUsd: number;
      positionCount: number;
      label: string | null;
      tags: string[];
    }>;
  };
  markets: {
    markets: Array<{
      id: string;
      symbol: string;
      displayName: string;
      indexPrice: number;
      tickSize: number;
      lotSize: number;
      minOrderUsdValue: number;
      openInterestBase: number;
      openInterestUsd: number;
      openInterestUtilizationPct: number | null;
      maxOpenInterestBase: number;
      fundingRate: number;
      makerFee: number;
      volume24hUsd: number | null;
      priceChange24hPct: number | null;
    }>;
  };
  performance: { performance: Performance };
  rewards: { rewards: RewardDashboard };
  events: { events: AuditEvent[] };
  operator: OperatorStatus;
};

export const fixedNow = "2026-10-27T17:08:32.000Z";
export const ownerAddress = `0x${"11".repeat(32)}`;
const agentAddress = `0x${"22".repeat(32)}`;
const registryObjectId = `0x${"33".repeat(32)}`;
const accountCapId = `0x${"44".repeat(32)}`;
const agentCapId = `0x${"55".repeat(32)}`;
const syntheticDigest = "11111111111111111111111111111111";
const collateralCoinType =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

const marketIds = {
  MON: `0x${"a1".repeat(32)}`,
  NEAR: `0x${"a2".repeat(32)}`,
  ETH: `0x${"a3".repeat(32)}`,
  BTC: `0x${"a4".repeat(32)}`,
  HYPE: `0x${"a5".repeat(32)}`,
} as const;

const monBook = {
  bids: fixtureBook.bids.map(
    ([price, size]) => [price!, size!] as [number, number],
  ),
  asks: fixtureBook.asks.map(
    ([price, size]) => [price!, size!] as [number, number],
  ),
};

const marketRows: FixtureState["markets"]["markets"] = [
  {
    id: marketIds.MON,
    symbol: "MON",
    displayName: "MON perpetual",
    indexPrice: 0.021441,
    tickSize: 0.000001,
    lotSize: 0.1,
    minOrderUsdValue: 1,
    openInterestBase: 1_358_420,
    openInterestUsd: 29_127.49,
    openInterestUtilizationPct: 13.58,
    maxOpenInterestBase: 10_000_000,
    fundingRate: 0.000012,
    makerFee: -0.00005,
    volume24hUsd: 86_214.72,
    priceChange24hPct: 2.17,
  },
  {
    id: marketIds.NEAR,
    symbol: "NEAR",
    displayName: "NEAR perpetual",
    indexPrice: 2.471,
    tickSize: 0.001,
    lotSize: 0.01,
    minOrderUsdValue: 1,
    openInterestBase: 8_930,
    openInterestUsd: 22_067.03,
    openInterestUtilizationPct: 8.93,
    maxOpenInterestBase: 100_000,
    fundingRate: -0.000021,
    makerFee: -0.00005,
    volume24hUsd: 61_201.18,
    priceChange24hPct: -0.84,
  },
  {
    id: marketIds.ETH,
    symbol: "ETH",
    displayName: "Ether perpetual",
    indexPrice: 3_941.2,
    tickSize: 0.1,
    lotSize: 0.001,
    minOrderUsdValue: 1,
    openInterestBase: 4_129,
    openInterestUsd: 16_273_214.8,
    openInterestUtilizationPct: 41.29,
    maxOpenInterestBase: 10_000,
    fundingRate: 0.000008,
    makerFee: -0.00005,
    volume24hUsd: 18_410_119.44,
    priceChange24hPct: 1.21,
  },
  {
    id: marketIds.BTC,
    symbol: "BTC",
    displayName: "Bitcoin perpetual",
    indexPrice: 79_621.1328,
    tickSize: 0.1,
    lotSize: 0.00001,
    minOrderUsdValue: 1,
    openInterestBase: 378,
    openInterestUsd: 30_096_788.2,
    openInterestUtilizationPct: 37.8,
    maxOpenInterestBase: 1_000,
    fundingRate: 0.000013,
    makerFee: -0.00005,
    volume24hUsd: 41_923_114.91,
    priceChange24hPct: 0.72,
  },
  {
    id: marketIds.HYPE,
    symbol: "HYPE",
    displayName: "HYPE perpetual",
    indexPrice: 39.28,
    tickSize: 0.01,
    lotSize: 0.01,
    minOrderUsdValue: 1,
    openInterestBase: 88_201,
    openInterestUsd: 3_464_535.28,
    openInterestUtilizationPct: 22.05,
    maxOpenInterestBase: 400_000,
    fundingRate: -0.000004,
    makerFee: -0.00005,
    volume24hUsd: 7_482_113.82,
    priceChange24hPct: -1.43,
  },
];

const config: MakerConfig = {
  markets: marketRows.map((market) => ({
    marketId: market.id,
    symbol: market.symbol,
    ...(market.symbol === "MON"
      ? {
          overrides: {
            quoteSizeUsd: 1.04,
            spreadBps: 42,
            maxInventoryUsd: 2.5,
            inventoryTargetUsd: 0,
            inventorySkewBps: 20,
            maxLeverage: 1,
          },
        }
      : {}),
  })),
  collateralCoinType,
  mode: "paper",
  rotationMode: "single-slot",
  strategyObjective: "both",
  strategyProfile: "balanced",
  makerAccountId: "1745",
  hedge: {
    enabled: true,
    accountId: "1746",
    thresholdUsd: 1,
    maxOrderUsd: 2,
    maxSlippageBps: 75,
  },
  quoteSizeUsd: 1.04,
  spreadBps: 42,
  refreshMs: 8_000,
  marketDwellMs: 15_000,
  requoteThresholdBps: 5,
  maxRestingMs: 15_000,
  autoRebalanceEnabled: true,
  rebalanceGrossExposureUsd: 2,
  maxQuoteAgeMs: 120_000,
  maxInventoryUsd: 2.5,
  inventoryTargetUsd: 0,
  maxGrossExposureUsd: 3,
  maxUnrealizedLossUsd: 1,
  maxRunDrawdownUsd: 1,
  maxBookDivergenceBps: 15,
  maxLeverage: 1,
  maxGasMist: 50_000_000,
  staleBookMs: 15_000,
  inventorySkewBps: 20,
};

const managedAccounts: SetupState["accounts"] = [
  {
    ownerAddress,
    accountId: "1745",
    accountCapId,
    collateralCoinType,
    addedAt: "2026-10-27T12:00:00.000Z",
    grantDigest: syntheticDigest,
    agentCapId,
  },
  {
    ownerAddress,
    accountId: "1746",
    accountCapId: `0x${"66".repeat(32)}`,
    collateralCoinType,
    addedAt: "2026-10-27T12:04:00.000Z",
    grantDigest: syntheticDigest,
    agentCapId: `0x${"77".repeat(32)}`,
  },
];

const setupReady: SetupState = {
  setup: {
    ownerAddress,
    accountId: "1745",
    accountCapId,
    collateralCoinType,
  },
  accounts: managedAccounts,
  agent: {
    address: agentAddress,
    createdAt: "2026-10-27T12:05:00.000Z",
    grantDigest: syntheticDigest,
    agentCapId,
  },
};

const accountRows: FixtureState["accounts"]["accounts"] = [
  {
    accountId: "1745",
    accountCapId,
    collateralCoinType,
    equityUsd: 7.44246,
    availableCollateralUsd: 6.40246,
    allocatedCollateralUsd: 1.04,
    freeMarginUsd: 6.40246,
    positionCount: 1,
    label: "Core maker",
    tags: ["farming", "low-risk"],
  },
  {
    accountId: "1746",
    accountCapId: `0x${"66".repeat(32)}`,
    collateralCoinType,
    equityUsd: 7.44934,
    availableCollateralUsd: 7.44934,
    allocatedCollateralUsd: 0,
    freeMarginUsd: 7.44934,
    positionCount: 0,
    label: "Neutral hedge",
    tags: ["hedge", "delta-neutral"],
  },
];

function runtimeMarkets(running: boolean): RuntimeMarket[] {
  return marketRows.map((market, index) => ({
    id: market.id,
    symbol: market.symbol,
    status: running && index === 0 ? "healthy" : "queued",
    indexPrice: market.indexPrice,
    bestBid: market.symbol === "MON" ? 0.02141 : market.indexPrice * 0.9998,
    bestAsk: market.symbol === "MON" ? 0.02147 : market.indexPrice * 1.0002,
    openInterestBase: market.openInterestBase,
    openInterestUsd: market.openInterestUsd,
    openInterestUtilizationPct: market.openInterestUtilizationPct,
    volume24hUsd: market.volume24hUsd,
    fundingRate: market.fundingRate,
    inventoryUsd: index === 0 ? 1.04 : 0,
    unrealizedPnlUsd: index === 0 ? -0.01 : 0,
    bidPrice: running && index === 0 ? 0.021393 : null,
    askPrice: running && index === 0 ? 0.021484 : null,
    effectiveSpreadBps: index === 0 ? 42 : 30,
    effectiveQuoteSizeUsd: index === 0 ? 1.04 : 1,
    effectiveMaxInventoryUsd: index === 0 ? 2.5 : 2,
    inventoryTargetUsd: 0,
    lastTransactionDigest: running && index === 0 ? syntheticDigest : null,
    updatedAt: running ? "2026-10-27T17:08:30.000Z" : null,
    error: null,
  }));
}

function snapshot(
  mode: Mode,
  running: boolean,
  setupComplete = true,
  bookAvailable = true,
): Snapshot {
  return {
    mode,
    running,
    cycle: running ? 47 : 0,
    startedAt: running ? "2026-10-27T16:51:00.000Z" : null,
    lastCycleAt: running ? "2026-10-27T17:08:30.000Z" : null,
    lastSuccessfulCycleAt: running ? "2026-10-27T17:08:30.000Z" : null,
    lastError: null,
    setupComplete,
    agentAddress: setupComplete ? agentAddress : null,
    accountId: setupComplete ? "1745" : null,
    market: {
      id: marketIds.MON,
      symbol: "MON",
      indexPrice: 0.021441,
      bestBid: 0.02141,
      bestAsk: 0.02147,
      updatedAt: "2026-10-27T17:08:30.000Z",
      book:
        setupComplete && bookAvailable
          ? {
              ...monBook,
              observedAt: "2026-10-27T17:08:30.000Z",
            }
          : null,
    },
    risk: {
      runDrawdownUsd: setupComplete ? 0.01 : null,
      runHighEquityUsd: setupComplete ? 7.45246 : null,
      measuredAt: setupComplete ? "2026-10-27T17:08:30.000Z" : null,
    },
    markets: setupComplete ? runtimeMarkets(running) : [],
    portfolio: {
      selectedMarkets: setupComplete ? marketRows.length : 0,
      grossExposureUsd: setupComplete ? 1.04 : 0,
      unrealizedPnlUsd: setupComplete ? -0.01 : 0,
      availableCollateralUsd: setupComplete ? 6.40246 : null,
      allocatedCollateralUsd: setupComplete ? 1.04 : null,
      freeMarginUsd: setupComplete ? 6.40246 : null,
      withdrawableCollateralUsd: setupComplete ? 6.40246 : null,
    },
    balances: {
      equityUsd: setupComplete ? 7.44246 : null,
      inventoryUsd: setupComplete ? 1.04 : 0,
      unrealizedPnlUsd: setupComplete ? -0.01 : 0,
      gasSui: setupComplete ? 2.985289723 : null,
    },
    watchdog: {
      state: running ? "armed" : "idle",
      checkedAt: running ? "2026-10-27T17:08:30.000Z" : null,
      maxQuoteAgeMs: setupComplete ? 120_000 : null,
    },
    execution: {
      confirmedLiveQuotes: mode === "live" ? 15 : 0,
      averageGasMist: setupComplete ? 7_115_521 : null,
      gasRunwayTransactions: setupComplete ? 244 : null,
      avoidedTransactions: running ? 12 : 0,
      lastDecision: running ? "quoted" : null,
      lastExecutionAt: running ? "2026-10-27T17:08:30.000Z" : null,
    },
    hedge: {
      enabled: setupComplete,
      state: setupComplete ? "ready" : "off",
      accountId: setupComplete ? "1746" : null,
      combinedDeltaUsd: setupComplete ? 0.0015328 : null,
      lastHedgeAt: setupComplete ? "2026-10-27T17:04:11.000Z" : null,
      lastDigest: setupComplete ? syntheticDigest : null,
      error: null,
    },
    quote:
      running && setupComplete
        ? { bidPrice: 0.021393, askPrice: 0.021484, sizeUsd: 1.04 }
        : null,
    safety: [
      {
        code: "gross-exposure",
        label: "Gross exposure",
        ok: true,
        detail: "$1.04 of $3.00",
      },
      {
        code: "drawdown",
        label: "Run drawdown",
        ok: true,
        detail: "$0.01 of $1.00",
      },
      {
        code: "gas-reserve",
        label: "Cancel gas reserve",
        ok: true,
        detail: "2.99 SUI available",
      },
    ],
  };
}

const performance: Performance = {
  asOf: fixedNow,
  period: "1D",
  periodStartedAt: "2026-10-26T17:08:32.000Z",
  historyComplete: true,
  account: {
    realizedPnlUsd: -0.0062,
    fundingPnlUsd: 0.0004,
    makerVolumeUsd: 33_054.13,
    takerVolumeUsd: 8.31,
    makerFeesUsd: -1.6527,
    takerFeesUsd: 0.0042,
  },
  attributed: {
    fills: 14,
    notionalUsd: 14.51,
    realizedPnlUsd: -0.0062,
    protocolFeesUsd: -0.00072,
    estimatedBuilderFeesUsd: 0.001451,
    netAfterKnownCostsUsd: -0.006931,
    makerVolumeCoveragePct: 100,
  },
  hedge: {
    enabled: true,
    accountId: "1746",
    executions: 7,
    fills: 7,
    notionalUsd: 7.29,
    realizedPnlUsd: -0.0041,
    protocolFeesUsd: 0.00365,
    estimatedBuilderFeesUsd: 0.000729,
    netAfterKnownCostsUsd: -0.008479,
  },
  combinedNetAfterKnownCostsUsd: -0.01541,
  volumeByMarket: [
    {
      marketId: marketIds.MON,
      symbol: "MON",
      makerNotionalUsd: 14.51,
      makerFills: 14,
      takerNotionalUsd: 4.2,
      takerFills: 4,
      realizedPnlUsd: -0.0062,
      feesUsd: -0.00072,
    },
  ],
  fills: [
    {
      occurredAt: "2026-10-27T17:08:20.000Z",
      txDigest: syntheticDigest,
      marketId: marketIds.MON,
      symbol: "MON",
      side: "bid",
      price: 0.021393,
      size: 48.6,
      notionalUsd: 1.0397,
      realizedPnlUsd: -0.0008,
      protocolFeesUsd: -0.000052,
      estimatedBuilderFeeUsd: 0.000104,
      orderId: "9001",
    },
    {
      occurredAt: "2026-10-27T16:59:00.000Z",
      txDigest: syntheticDigest,
      marketId: marketIds.NEAR,
      symbol: "NEAR",
      side: "ask",
      price: 2.474,
      size: 0.42,
      notionalUsd: 1.0391,
      realizedPnlUsd: 0.0007,
      protocolFeesUsd: -0.000052,
      estimatedBuilderFeeUsd: 0.000104,
      orderId: "9002",
    },
  ],
  note: "Net known result includes attributed fills and known fees, not total profit.",
};

function opportunity(
  market: (typeof marketRows)[number],
  rank: number,
): RewardDashboard["marketModel"]["opportunities"][number] {
  return {
    rank,
    marketId: market.id,
    symbol: market.symbol,
    minOrderUsdValue: market.minOrderUsdValue,
    minimumQuoteSizeUsd: market.symbol === "MON" ? 1.04 : 1,
    objective: "both",
    score: 92 - rank * 6,
    farmingScore: 95 - rank * 5,
    profitScore: 86 - rank * 4,
    bothScore: 90 - rank * 5,
    confidence: rank <= 2 ? "high" : "medium",
    eligible: true,
    objectiveEligible: true,
    thinActive: rank <= 2,
    observedSpreadBps: market.symbol === "MON" ? 42 : 24 + rank,
    preRiskEdgeBps: market.symbol === "MON" ? 36 : 18 + rank,
    balancedDepth50BpsUsd: 4_000 * rank,
    volume24hUsd: market.volume24hUsd,
    openInterestUsd: market.openInterestUsd,
    openInterestUtilizationPct: market.openInterestUtilizationPct,
    volumeToDepth: 1.8 + rank / 10,
    fundingRate: market.fundingRate,
    priceChange24hPct: market.priceChange24hPct,
    makerRebateBps: 0.5,
    builderFeeBps: 1,
    knownCostBps: 0.5,
    suggestedSpreadBps: market.symbol === "MON" ? 42 : 30,
    suggestedQuoteSizeUsd: market.symbol === "MON" ? 1.04 : 1,
    reasons: ["Active two-sided book", "Capacity fits the canary limits"],
    error: null,
  };
}

const rewards: RewardDashboard = {
  asOf: fixedNow,
  epoch: {
    number: 128,
    startedAt: "2026-10-27T00:00:00.000Z",
    cutoffAt: "2026-10-28T00:00:00.000Z",
  },
  account: {
    trackedAccountIds: ["1745", "1746"],
    error: null,
    makerRewardsSui: 0.0184,
    qScoreShare: 0.0017,
    uptime: 0.962,
    makerVolumeUsd: 33_054.13,
    makerVolumeShare: 0.0008,
    directRebatesUsd: 1.6527,
    baseMakerFeesUsd: -1.6527,
  },
  marketModel: {
    label: "heuristic",
    methodology:
      "Ranks observed spread, depth, activity, costs, and capacity without promising rewards.",
    depthBandBps: 50,
    opportunities: marketRows.map(opportunity),
  },
};

const events: AuditEvent[] = [
  {
    id: 3,
    occurredAt: "2026-10-27T17:08:30.000Z",
    category: "runtime",
    action: "quote-confirmed",
    outcome: "success",
    detail: { market: "MON", mode: "paper" },
  },
  {
    id: 2,
    occurredAt: "2026-10-27T17:04:11.000Z",
    category: "risk",
    action: "post-hedge-reconciliation",
    outcome: "success",
    detail: { residualDeltaUsd: 0.0015328 },
  },
  {
    id: 1,
    occurredAt: "2026-10-27T16:51:00.000Z",
    category: "runtime",
    action: "engine-started",
    outcome: "success",
    detail: { markets: 5 },
  },
  ...Array.from({ length: 9 }, (_, index) => ({
    id: index + 4,
    occurredAt: new Date(
      Date.parse("2026-10-27T16:50:00.000Z") - index * 60_000,
    ).toISOString(),
    category: "runtime",
    action: "market-cycle-completed",
    outcome: "success",
    detail: { cycle: index + 1 },
  })),
];

const identity: AccessIdentity = {
  ownerAddress,
  operator: false,
  registryConfigured: true,
  registryObjectId,
};

const base: Omit<FixtureState, "auth" | "status" | "config" | "setup"> = {
  accounts: { accounts: accountRows },
  markets: { markets: marketRows },
  performance: { performance },
  rewards: { rewards },
  events: { events },
  operator: {
    operatorAddress: `0x${"88".repeat(32)}`,
    registryObjectId,
    packageId: `0x${"99".repeat(32)}`,
    adminCapId: `0x${"aa".repeat(32)}`,
    builderCode: { integratorId: 2048, integratorFee: 0.0001 },
    bootstrap: false,
  },
};

function fixture(
  auth: FixtureState["auth"],
  stateSnapshot: Snapshot,
  stateConfig: MakerConfig | null,
  setup: SetupState,
): FixtureState {
  return {
    ...base,
    auth,
    status: {
      snapshot: stateSnapshot,
      builderCode: { integratorId: 2048, integratorFee: 0.0001 },
      liveGates: {
        liveTradingEnabled: false,
        mainnetAllowed: false,
      },
    },
    config: { config: stateConfig },
    setup,
  };
}

const signedOut = fixture(
  { status: 401, body: { error: "Authentication required" } },
  snapshot("observe", false, false),
  null,
  { setup: null, accounts: [], agent: null },
);

const notOnList = fixture(
  {
    status: 403,
    body: { error: "This wallet is not on the public access list" },
  },
  snapshot("observe", false, false),
  null,
  { setup: null, accounts: [], agent: null },
);

const onboarding = fixture(
  { status: 200, body: identity },
  snapshot("observe", false, false),
  {
    ...config,
    markets: [],
    makerAccountId: null,
    hedge: { ...config.hedge, enabled: false, accountId: null },
  },
  { setup: null, accounts: [], agent: null },
);
onboarding.accounts = { accounts: [] };

const paperRunning = fixture(
  { status: 200, body: identity },
  snapshot("paper", true),
  { ...config, mode: "paper" },
  setupReady,
);

const paperRunningNoBook = fixture(
  { status: 200, body: identity },
  snapshot("paper", true, true, false),
  { ...config, mode: "paper" },
  setupReady,
);

const liveRunning = fixture(
  { status: 200, body: identity },
  snapshot("live", true),
  { ...config, mode: "live" },
  setupReady,
);

const stopped = fixture(
  { status: 200, body: identity },
  snapshot("paper", false),
  { ...config, mode: "paper" },
  setupReady,
);

export const fixtureStates = {
  "signed-out": signedOut,
  "not-on-list": notOnList,
  onboarding,
  "paper-running": paperRunning,
  "paper-running-no-book": paperRunningNoBook,
  "live-running": liveRunning,
  stopped,
} satisfies Record<string, FixtureState>;

export type FixtureName = keyof typeof fixtureStates;
import fixtureBook from "../../../../docs/design/maker-ui-handoff-v3/mockups/fixture-book.json";
