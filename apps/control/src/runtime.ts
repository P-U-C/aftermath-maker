import {
  AftermathGateway,
  isPostOnlyWouldMatch,
  loadAgentKeypair,
  type EndpointHealth,
  type MarketSummary,
  type MarketDailyVolume,
  type PerformanceOrder,
  type PortfolioSnapshot,
} from "@puc/aftermath";
import {
  aggregatePortfolioQuoteRisk,
  requiredMakerCollateralUsd,
  requiredHedgeCollateralUsd,
  lowestEffectiveHedgeLeverage,
  assertSafe,
  buildQuoteIntent,
  evaluateQuoteSafety,
  makerConfigSchema,
  marketRiskThresholds,
  rewardEpochDailyStatsWindow,
  reduceOnlyQuoteIntent,
  resolveMarketConfig,
  type BuilderFeePolicy,
  type MakerConfig,
  type MakerMarket,
  type QuoteIntent,
  type RuntimeMarketSnapshot,
  type RuntimeSnapshot,
  type SafetyCheck,
  type Setup,
} from "@puc/core";
import type { TenantStore } from "./store.js";
import {
  VENUE_READ_TIMEOUT_MS,
  VenueReadTimeoutError,
  withTimeout,
} from "./venue-read.js";
import { confirmedRestingMarketIds } from "./resting-quotes.js";
import {
  buildStrategyTrialPlan,
  STRATEGY_TRIAL_OBJECTIVES,
  type StrategyTrialMode,
} from "./trial.js";

export type RuntimeOptions = {
  masterKey?: string;
  liveEnabled: boolean;
  mainnetAllowed: boolean;
  builderCode: () => BuilderFeePolicy | null;
  sleep?: (milliseconds: number) => Promise<void>;
  pauseOnError?: boolean;
  onBundleError?: (error: string) => Promise<void> | void;
  admitBundleProposal?: (proposal: {
    worstCaseGrossExposureDeltaUsd: number;
    worstCaseInventoryDeltaUsd: number;
    worstCaseUnrealizedLossDeltaUsd: number;
    worstCaseRunDrawdownDeltaUsd: number;
  }) =>
    | Promise<{ accepted: boolean; reason: string | null }>
    | {
        accepted: boolean;
        reason: string | null;
      };
};

export type MakerFill = {
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
  estimated: boolean;
  role: "Maker fill" | "Hedge" | "Close" | "Unwind";
  bundleName?: string;
};

export type FlattenResult = {
  digest: string | null;
  digests: string[];
  flattenedMarketIds: string[];
  transactions: Array<{
    accountId: string;
    digest: string;
    digests?: string[];
    flattenedMarketIds: string[];
    residualMarketIds?: string[];
  }>;
  residualMarketIds?: string[];
};

export type StrategyTrialRoundResult = {
  objective: MakerConfig["strategyObjective"];
  profile: MakerConfig["strategyProfile"];
  score: number;
  quoteSizeUsd: number;
  spreadBps: number;
  outcome: "simulated" | "confirmed";
  digest: string | null;
  startedAt: string;
  completedAt: string;
};

export type StrategyTrialResult = {
  mode: StrategyTrialMode;
  marketId: string;
  symbol: string;
  cadenceMs: number;
  startedAt: string;
  completedAt: string;
  rounds: StrategyTrialRoundResult[];
  recovery: FlattenResult | null;
  restoredConfig: MakerConfig;
};

export type PerformancePeriod = "1D" | "EPOCH" | "ALL";

export type PerformanceSnapshot = {
  asOf: string;
  period: PerformancePeriod;
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
  paper: {
    estimated: boolean;
    makerFills: number;
    hedgeFills: number;
    notionalUsd: number;
  };
  volumeByMarket: Array<{
    marketId: string;
    symbol: string;
    makerNotionalUsd: number;
    makerFills: number;
    takerNotionalUsd: number;
    takerFills: number;
    realizedPnlUsd: number;
    feesUsd: number;
    marketVolumeUsd: number | null;
    marketVolumeError: string | null;
  }>;
  marketVolumeLabel: string | null;
  fills: MakerFill[];
  note: string;
};

const emptyRuntimeMarket = (
  market: MakerMarket,
  config: MakerConfig,
): RuntimeMarketSnapshot => {
  const effective = resolveMarketConfig(config, market);
  return {
    id: market.marketId,
    symbol: market.symbol,
    status: "queued",
    indexPrice: null,
    bestBid: null,
    bestAsk: null,
    openInterestBase: null,
    openInterestUsd: null,
    openInterestUtilizationPct: null,
    volume24hUsd: null,
    fundingRate: null,
    inventoryUsd: 0,
    unrealizedPnlUsd: 0,
    bidPrice: null,
    askPrice: null,
    effectiveSpreadBps: effective.spreadBps,
    effectiveQuoteSizeUsd: effective.quoteSizeUsd,
    effectiveMaxInventoryUsd: effective.maxInventoryUsd,
    inventoryTargetUsd: effective.inventoryTargetUsd,
    lastTransactionDigest: null,
    updatedAt: null,
    error: null,
    skip: null,
  };
};

const snapshotBookLevels = (
  levels: ReadonlyArray<{ price: unknown; size: unknown }>,
): Array<[price: number, size: number]> =>
  levels
    .flatMap((level) =>
      typeof level.price === "number" &&
      Number.isFinite(level.price) &&
      level.price > 0 &&
      typeof level.size === "number" &&
      Number.isFinite(level.size) &&
      level.size > 0
        ? ([[level.price, level.size]] as Array<[number, number]>)
        : [],
    )
    .slice(0, 50);

const initialSnapshot = (): RuntimeSnapshot => ({
  mode: "paper",
  running: false,
  cycle: 0,
  startedAt: null,
  lastCycleAt: null,
  lastSuccessfulCycleAt: null,
  lastError: null,
  accountReadAt: null,
  paperBlocker: null,
  setupComplete: false,
  agentAddress: null,
  accountId: null,
  market: {
    id: "",
    symbol: "Not selected",
    indexPrice: null,
    bestBid: null,
    bestAsk: null,
    updatedAt: null,
    book: null,
  },
  risk: {
    runDrawdownUsd: null,
    runHighEquityUsd: null,
    measuredAt: null,
  },
  markets: [],
  restingQuoteMarketIds: [],
  restingQuoteVerifiedAt: null,
  portfolio: {
    selectedMarkets: 0,
    grossExposureUsd: 0,
    unrealizedPnlUsd: 0,
    availableCollateralUsd: null,
    allocatedCollateralUsd: null,
    freeMarginUsd: null,
    withdrawableCollateralUsd: null,
  },
  balances: {
    equityUsd: null,
    inventoryUsd: 0,
    unrealizedPnlUsd: 0,
    gasSui: null,
  },
  watchdog: {
    state: "idle",
    checkedAt: null,
    maxQuoteAgeMs: null,
  },
  execution: {
    confirmedLiveQuotes: 0,
    averageGasMist: null,
    gasRunwayTransactions: null,
    avoidedTransactions: 0,
    lastDecision: null,
    lastExecutionAt: null,
  },
  paper: {
    estimated: false,
    openOrders: 0,
    fills: 0,
    hedges: 0,
    makerInventoryUsd: 0,
    hedgeInventoryUsd: 0,
    grossExposureUsd: 0,
  },
  hedge: {
    enabled: false,
    state: "off",
    accountId: null,
    combinedDeltaUsd: null,
    lastHedgeAt: null,
    lastDigest: null,
    error: null,
  },
  quote: null,
  safety: [],
});

const emptyPortfolio = (): PortfolioSnapshot => ({
  markedAt: new Date(0).toISOString(),
  equityUsd: 0,
  availableCollateralUsd: 0,
  allocatedCollateralUsd: 0,
  freeMarginUsd: 0,
  withdrawableCollateralUsd: 0,
  grossExposureUsd: 0,
  unrealizedPnlUsd: 0,
  gasSui: 0,
  positions: [],
});

const paperSnapshot = (paper: {
  openOrders: number;
  fills: number;
  hedges: number;
  positions: Array<{ role: "maker" | "hedge"; inventoryUsd: number }>;
}) => {
  const makerInventoryUsd = paper.positions
    .filter((position) => position.role === "maker")
    .reduce((total, position) => total + position.inventoryUsd, 0);
  const hedgeInventoryUsd = paper.positions
    .filter((position) => position.role === "hedge")
    .reduce((total, position) => total + position.inventoryUsd, 0);
  return {
    estimated: true,
    openOrders: paper.openOrders,
    fills: paper.fills,
    hedges: paper.hedges,
    makerInventoryUsd,
    hedgeInventoryUsd,
    grossExposureUsd: paper.positions.reduce(
      (total, position) => total + Math.abs(position.inventoryUsd),
      0,
    ),
  };
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const formatSui = (value: number) =>
  value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");

function paperSimulationBlocker(inputs: {
  setup: Setup | null;
  account: { agentCapId: string | null } | null;
  agent: { address: string } | null;
  safety: SafetyCheck[];
  symbol: string;
  observedAt?: string;
  requiredGasSui: number;
  hedgeCollateral?: {
    accountId: string;
    availableUsd: number;
    requiredUsd: number;
    maxOrderUsd: number;
    leverage: number;
    observedAt: string;
  };
  collateral?: {
    availableUsd: number;
    requiredUsd: number;
    concurrentMarkets: number;
    quoteSizeUsd: number;
    leverage: number;
    observedAt: string;
  };
}): NonNullable<RuntimeSnapshot["paperBlocker"]> | null {
  const accountLabel = inputs.setup
    ? `account ${inputs.setup.accountId}`
    : "this account";
  if (!inputs.setup || !inputs.account?.agentCapId || !inputs.agent) {
    return {
      code: "trading-key",
      message: `Paper needs a trading key for ${accountLabel}. Set it up in Venues; Maker will keep reading the market.`,
    };
  }

  const failed = inputs.safety.filter((check) => !check.ok);
  if (!failed.length) return null;
  const first = failed[0]!;
  if (
    first.code === "maker-margin" &&
    first.detail.startsWith("Aftermath didn't report")
  ) {
    return { code: first.code, message: first.detail };
  }
  if (first.code === "gas") {
    return {
      code: "gas",
      accountId: inputs.setup?.accountId,
      agentAddress: inputs.agent.address,
      requiredGasSui: inputs.requiredGasSui,
      ...(inputs.observedAt ? { observedAt: inputs.observedAt } : {}),
      message: `Paper is waiting on gas. The trading key for ${accountLabel} needs ${formatSui(inputs.requiredGasSui)} SUI to simulate.`,
    };
  }
  if (first.code === "hedge-collateral" && inputs.hedgeCollateral) {
    const hedge = inputs.hedgeCollateral;
    return {
      code: "hedge-collateral",
      accountId: hedge.accountId,
      availableUsd: hedge.availableUsd,
      requiredUsd: hedge.requiredUsd,
      maxOrderUsd: hedge.maxOrderUsd,
      leverage: hedge.leverage,
      observedAt: hedge.observedAt,
      message: `Hedge account ${hedge.accountId} needs $${hedge.requiredUsd.toFixed(2)} free collateral to place one hedge of up to $${hedge.maxOrderUsd.toFixed(2)} at ${hedge.leverage}x. It has $${hedge.availableUsd.toFixed(2)}.`,
    };
  }
  if (first.code === "collateral") {
    return {
      code: "collateral",
      accountId: inputs.setup?.accountId,
      ...(inputs.collateral ?? {}),
      message: inputs.collateral
        ? `Paper is waiting on ${accountLabel}. It has $${inputs.collateral.availableUsd.toFixed(2)} free collateral, and quoting ${inputs.collateral.concurrentMarkets} ${inputs.collateral.concurrentMarkets === 1 ? "market" : "markets"} at $${inputs.collateral.quoteSizeUsd.toFixed(2)} a side needs $${inputs.collateral.requiredUsd.toFixed(2)}. Deposit at least $${Math.max(0, inputs.collateral.requiredUsd - inputs.collateral.availableUsd).toFixed(2)}${inputs.collateral.concurrentMarkets > 1 ? `, or quote one market at a time (needs $${((inputs.collateral.quoteSizeUsd * 2) / Math.max(1, inputs.collateral.leverage)).toFixed(2)})` : ""}.`
        : `Paper is waiting on ${accountLabel}. Add collateral or review quote size in Strategy.`,
    };
  }
  if (first.code === "fair-value") {
    return {
      code: "fair-value",
      message: `Paper skipped ${inputs.symbol}: ${first.detail}. The book is outside the strategy's fair-value limit, so Maker will keep reading the market.`,
    };
  }
  if (first.code === "freshness") {
    return {
      code: "freshness",
      message: `Paper skipped ${inputs.symbol}: ${first.detail}. Maker is waiting for a fresh book.`,
    };
  }
  return {
    code: first.code,
    message: `Paper skipped ${inputs.symbol}: ${first.label} needs attention (${first.detail}). Fix it in Strategy or Accounts; Maker will keep reading the market.`,
  };
}

const hedgeFillKey = (order: PerformanceOrder) =>
  [
    order.txDigest,
    order.orderId ?? "no-order-id",
    order.timestampMs,
    order.marketId,
    order.side,
    order.price,
    order.size,
  ].join(":");

const signedFillNotional = (order: PerformanceOrder) =>
  Math.abs(order.price * order.size) * (order.side === "bid" ? 1 : -1);

const finitePercent = (value: number | null | undefined): string | null =>
  typeof value === "number" && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : null;

function accountRiskChecks(
  label: string,
  portfolio: PortfolioSnapshot | null,
  symbols: ReadonlyMap<string, string>,
  thresholdForMarket: (marketId: string) => {
    minMarginRatio: number;
    minLiquidationDistanceBps: number;
  },
): SafetyCheck[] {
  const positions = portfolio?.positions.filter(
    (position) => position.hasPosition && !position.simulated,
  );
  const simulated = portfolio?.positions.some(
    (position) => position.hasPosition && position.simulated,
  );
  const missingMargin = positions?.find(
    (position) => !Number.isFinite(position.marginRatio),
  );
  const missingLiquidation = positions?.find(
    (position) => !Number.isFinite(position.liquidationDistanceBps),
  );
  const marginRatios =
    positions?.flatMap((position) =>
      Number.isFinite(position.marginRatio)
        ? [
            {
              actual: position.marginRatio!,
              threshold: thresholdForMarket(position.marketId).minMarginRatio,
            },
          ]
        : [],
    ) ?? [];
  const liquidationDistances =
    positions?.flatMap((position) =>
      Number.isFinite(position.liquidationDistanceBps)
        ? [
            {
              actual: position.liquidationDistanceBps!,
              threshold: thresholdForMarket(position.marketId)
                .minLiquidationDistanceBps,
            },
          ]
        : [],
    ) ?? [];
  const name = (marketId: string) => symbols.get(marketId) ?? marketId;
  return [
    {
      code: `${label.toLowerCase()}-margin`,
      label: `${label} margin`,
      ok:
        portfolio !== null &&
        !missingMargin &&
        marginRatios.every(
          ({ actual, threshold }) =>
            Number.isFinite(actual) && actual >= threshold,
        ),
      detail:
        portfolio === null
          ? `${label} account risk is unavailable`
          : missingMargin
            ? `Aftermath didn't report a margin ratio for ${name(missingMargin.marketId)}. Maker won't quote until it does.`
            : positions?.length === 0
              ? simulated
                ? "Simulated positions only; inventory and exposure limits apply"
                : "No open positions"
              : `Minimum ${label.toLowerCase()} margin ratio ${finitePercent(Math.min(...marginRatios.map(({ actual }) => actual))) ?? "unavailable"}; required threshold is market-specific`,
      scope: "bundle",
    },
    {
      code: `${label.toLowerCase()}-liquidation`,
      label: `${label} liquidation distance`,
      ok:
        portfolio !== null &&
        !missingLiquidation &&
        liquidationDistances.every(
          ({ actual, threshold }) =>
            Number.isFinite(actual) && actual >= threshold,
        ),
      detail:
        portfolio === null
          ? `${label} account risk is unavailable`
          : missingLiquidation
            ? `Aftermath didn't report a liquidation distance for ${name(missingLiquidation.marketId)}. Maker won't quote until it does.`
            : positions?.length === 0
              ? simulated
                ? "Simulated positions only; inventory and exposure limits apply"
                : "No open positions"
              : `Nearest liquidation ${finitePercent(Math.min(...liquidationDistances.map(({ actual }) => actual)) / 10_000) ?? "unavailable"} away; required threshold is market-specific`,
      scope: "bundle",
    },
  ];
}

export class MakerRuntime {
  private snapshotValue = initialSnapshot();
  private timer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private watchdogTripping = false;
  private generation = 0;
  /** Invalidates late Paper reads without ending the running bundle generation. */
  private cycleToken = 0;
  private cyclePromise: Promise<void> | null = null;
  private flattenPromise: Promise<FlattenResult> | null = null;
  private markets: MarketSummary[] = [];
  private marketIndex = 0;
  private runPeakEquityUsd: number | null = null;
  private activeQuoteMarketId: string | null = null;
  private activeQuote: {
    marketId: string;
    quote: QuoteIntent;
    placedAt: number;
  } | null = null;
  private marketSelectedAt: number | null = null;
  private awaitingFillAttribution = new Map<string, number>();
  private awaitingPositionAttribution = new Map<string, number>();
  private autoRebalancedOrderIds = new Set<string>();
  private singleSlotSwept = false;
  private strategyTrialActive = false;
  private paperTrialId: string | null = null;
  private paperSimulationBlockerKey: string | null = null;
  private paperSimulationBlockerLastLoggedAt = 0;
  private paperExposurePausedAt: number | null = null;
  private paperMarketSkips = new Map<string, { code: string; since: number }>();
  private paperAllSkippedSince: number | null = null;
  private paperAllSkippedWarningLogged = false;
  private paperVolumeFees: {
    utcDate: string;
    usd: number;
    warned: boolean;
  } | null = null;
  /** SUI in USD at the latest cycle, so gas is priced when it is spent. */
  private suiUsd: number | null = null;

  constructor(
    private readonly store: TenantStore,
    private gateway: AftermathGateway,
    private readonly options: RuntimeOptions,
  ) {
    const config = this.store.getConfig();
    const setup = this.store.getSetup();
    const activeAccount = setup
      ? this.store.getAccountSetup(setup.accountId)
      : null;
    this.snapshotValue = {
      ...this.snapshotValue,
      mode: config?.mode ?? "paper",
      markets: config
        ? config.markets.map((market) => emptyRuntimeMarket(market, config))
        : [],
      portfolio: {
        ...this.snapshotValue.portfolio,
        selectedMarkets: config?.markets.length ?? 0,
      },
      setupComplete: Boolean(
        activeAccount?.agentCapId && this.store.getAgent(),
      ),
      agentAddress: this.store.getAgent()?.address ?? null,
      accountId: setup?.accountId ?? null,
      hedge: {
        ...this.snapshotValue.hedge,
        enabled: config?.hedge.enabled ?? false,
        state: config?.hedge.enabled ? "waiting" : "off",
        accountId: config?.hedge.accountId ?? null,
      },
    };
    this.store.logEvent({
      category: "system",
      action: "runtime.initialize",
      outcome: "success",
      detail: { endpoint: this.gateway.endpoint },
    });
  }

  get snapshot(): RuntimeSnapshot {
    const snapshot = structuredClone(this.snapshotValue);
    const execution = this.store.getExecutionStats();
    const config = this.store.getConfig();
    const executableGasMist =
      snapshot.balances.gasSui === null
        ? null
        : Math.max(
            0,
            snapshot.balances.gasSui * 1_000_000_000 -
              (config?.maxGasMist ?? 0) * 2,
          );
    snapshot.execution = {
      ...execution,
      gasRunwayTransactions:
        execution.averageGasMist && executableGasMist !== null
          ? Math.floor(executableGasMist / execution.averageGasMist)
          : null,
      avoidedTransactions: this.snapshotValue.execution.avoidedTransactions,
      lastDecision: this.snapshotValue.execution.lastDecision,
    };
    const paper = this.store.getPaperState("runtime");
    snapshot.paper =
      snapshot.mode === "paper"
        ? paperSnapshot(paper)
        : {
            estimated: false,
            openOrders: 0,
            fills: 0,
            hedges: 0,
            makerInventoryUsd: 0,
            hedgeInventoryUsd: 0,
            grossExposureUsd: 0,
          };
    return snapshot;
  }

  get endpointHealth(): EndpointHealth[] {
    return this.gateway.endpointHealth;
  }

  get activeEndpoint(): string {
    return this.gateway.endpoint;
  }

  requireGateway(): AftermathGateway {
    return this.gateway;
  }

  replaceGateway(gateway: AftermathGateway): boolean {
    if (
      this.snapshotValue.running ||
      this.cyclePromise ||
      this.flattenPromise
    ) {
      return false;
    }
    const previousEndpoint = this.gateway.endpoint;
    this.gateway = gateway;
    this.store.logEvent({
      category: "system",
      action: "gateway.replace",
      outcome: "success",
      detail: {
        previousEndpoint,
        endpoint: gateway.endpoint,
      },
    });
    return true;
  }

  private clearActiveQuoteState(): void {
    this.activeQuoteMarketId = null;
    this.activeQuote = null;
    // A cancellation or handoff invalidates prior venue-order observations.
    this.snapshotValue.restingQuoteMarketIds = [];
    this.snapshotValue.restingQuoteVerifiedAt = null;
  }

  private venueRead<T>(task: Promise<T>, label: string): Promise<T> {
    return withTimeout(task, VENUE_READ_TIMEOUT_MS, `${label} timed out`);
  }

  async listMarkets(collateralCoinType: string): Promise<MarketSummary[]> {
    this.markets = await this.venueRead(
      this.gateway.listMarkets(collateralCoinType),
      "Market list read",
    );
    const config = this.store.getConfig();
    if (config) this.syncMarketRows(config);
    return this.markets;
  }

  async rewardDashboard(
    collateralCoinType: string,
    objective: MakerConfig["strategyObjective"],
  ) {
    return this.venueRead(
      this.gateway.getRewardDashboard({
        accountIds: this.store
          .listAccountSetups()
          .map((account) => account.accountId),
        collateralCoinType,
        builderFeeBps:
          (this.options.builderCode()?.integratorFee ?? 0) * 10_000,
        objective,
      }),
      "Reward read",
    );
  }

  private syncMarketRows(config: MakerConfig): void {
    const previous = new Map(
      this.snapshotValue.markets.map((market) => [market.id, market]),
    );
    this.snapshotValue.markets = config.markets.map((market) => {
      const current = previous.get(market.marketId);
      const summary = this.markets.find(
        (candidate) => candidate.id === market.marketId,
      );
      const effective = resolveMarketConfig(config, market);
      return {
        ...(current ?? emptyRuntimeMarket(market, config)),
        symbol: market.symbol,
        effectiveSpreadBps: effective.spreadBps,
        effectiveQuoteSizeUsd: effective.quoteSizeUsd,
        effectiveMaxInventoryUsd: effective.maxInventoryUsd,
        inventoryTargetUsd: effective.inventoryTargetUsd,
        ...(summary
          ? {
              indexPrice: summary.indexPrice,
              openInterestBase: summary.openInterestBase,
              openInterestUsd: summary.openInterestUsd,
              openInterestUtilizationPct: summary.openInterestUtilizationPct,
              volume24hUsd: summary.volume24hUsd,
              fundingRate: summary.fundingRate,
            }
          : {}),
      };
    });
    this.snapshotValue.portfolio.selectedMarkets = config.markets.length;
  }

  start(): void {
    if (this.strategyTrialActive) {
      throw new Error("A strategy trial is already running");
    }
    const config = this.store.getConfig();
    if (!config?.markets.length) {
      throw new Error("Select and configure at least one market first");
    }
    if (this.timer) return;

    this.generation += 1;
    const generation = this.generation;
    const startedAt = new Date().toISOString();
    this.snapshotValue.running = true;
    this.snapshotValue.mode = config.mode;
    this.snapshotValue.startedAt = startedAt;
    this.snapshotValue.lastError = null;
    this.snapshotValue.paperBlocker = null;
    this.snapshotValue.accountReadAt = null;
    this.paperSimulationBlockerKey = null;
    this.paperSimulationBlockerLastLoggedAt = 0;
    this.paperExposurePausedAt = null;
    this.paperMarketSkips.clear();
    this.paperAllSkippedSince = null;
    this.paperAllSkippedWarningLogged = false;
    this.runPeakEquityUsd = null;
    this.clearActiveQuoteState();
    this.marketSelectedAt = null;
    this.awaitingFillAttribution.clear();
    this.awaitingPositionAttribution.clear();
    this.autoRebalancedOrderIds.clear();
    this.snapshotValue.execution.avoidedTransactions = 0;
    this.snapshotValue.execution.lastDecision = null;
    this.singleSlotSwept = config.mode !== "live";
    this.snapshotValue.markets = config.markets.map((market) =>
      emptyRuntimeMarket(market, config),
    );
    this.snapshotValue.watchdog = {
      state: config.mode === "live" ? "armed" : "idle",
      checkedAt: startedAt,
      maxQuoteAgeMs: config.mode === "live" ? config.maxQuoteAgeMs : null,
    };
    this.syncMarketRows(config);
    void this.cycle({ executeLive: true, generation });
    this.timer = setInterval(
      () => void this.cycle({ executeLive: true, generation }),
      config.refreshMs,
    );
    this.timer.unref();
    if (config.mode === "live") {
      const watchdogIntervalMs = Math.max(
        1_000,
        Math.min(5_000, Math.floor(config.maxQuoteAgeMs / 4)),
      );
      this.watchdogTimer = setInterval(
        () => void this.checkQuoteAges(config),
        watchdogIntervalMs,
      );
      this.watchdogTimer.unref();
    }
    this.store.logEvent({
      category: "runtime",
      action: "start",
      outcome: "success",
      detail: {
        mode: config.mode,
        marketIds: config.markets.map((market) => market.marketId),
        pollIntervalMs: config.refreshMs,
        marketDwellMs:
          config.rotationMode === "single-slot"
            ? config.marketDwellMs
            : config.refreshMs,
        effectiveMarketRefreshMs:
          (config.rotationMode === "single-slot"
            ? config.marketDwellMs
            : config.refreshMs) * config.markets.length,
        requoteThresholdBps: config.requoteThresholdBps,
        maxRestingMs: config.maxRestingMs,
        maxQuoteAgeMs: config.maxQuoteAgeMs,
      },
    });
  }

  private async checkQuoteAges(config: MakerConfig): Promise<void> {
    if (
      !this.snapshotValue.running ||
      this.snapshotValue.mode !== "live" ||
      this.watchdogTripping
    ) {
      return;
    }
    const now = Date.now();
    this.snapshotValue.watchdog.checkedAt = new Date(now).toISOString();
    const startedAt = Date.parse(this.snapshotValue.startedAt ?? "");
    const activeQuote =
      config.rotationMode === "single-slot" ? this.activeQuote : null;
    if (config.rotationMode === "single-slot" && !activeQuote) return;
    const watchedMarkets = activeQuote
      ? this.snapshotValue.markets.filter(
          (market) => market.id === activeQuote.marketId,
        )
      : this.snapshotValue.markets;
    const stale = watchedMarkets.find((market) => {
      const observedAt = activeQuote
        ? activeQuote.placedAt
        : market.updatedAt
          ? Date.parse(market.updatedAt)
          : startedAt;
      return (
        Number.isFinite(observedAt) && now - observedAt > config.maxQuoteAgeMs
      );
    });
    if (!stale) return;

    this.watchdogTripping = true;
    this.snapshotValue.watchdog.state = "tripped";
    this.snapshotValue.lastError = `Stale-quote watchdog tripped on ${stale.symbol}`;
    this.store.logEvent({
      category: "risk",
      action: "stale-quote-watchdog",
      outcome: "tripped",
      detail: {
        marketId: stale.id,
        ageSource: activeQuote ? "quote-placement" : "market-observation",
        observedAt: activeQuote
          ? new Date(activeQuote.placedAt).toISOString()
          : stale.updatedAt,
        maxQuoteAgeMs: config.maxQuoteAgeMs,
      },
    });
    const activeCycle = this.cyclePromise;
    this.stopScheduling("watchdog");
    if (config) {
      await this.cancelOpenOrders(config, {
        attempts: 3,
        retryDelayMs: 2_000,
      });
    }

    // Do not let a stalled RPC prevent immediate cancellation. If a transaction
    // was already broadcast, cancel again after its result becomes known.
    if (activeCycle) {
      void activeCycle
        .finally(async () => {
          if (this.snapshotValue.watchdog.state === "tripped") {
            await this.cancelOpenOrders(config, {
              attempts: 3,
              retryDelayMs: 2_000,
            });
          }
        })
        .catch(() => undefined);
    }
    this.watchdogTripping = false;
  }

  private stopScheduling(
    reason: "operator" | "watchdog" = "operator",
  ): boolean {
    const wasRunning = this.snapshotValue.running || Boolean(this.timer);
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.timer = null;
    this.watchdogTimer = null;
    this.snapshotValue.running = false;
    if (this.snapshotValue.paperBlocker) {
      this.snapshotValue.lastError = null;
      this.snapshotValue.paperBlocker = null;
      this.paperSimulationBlockerKey = null;
      this.paperSimulationBlockerLastLoggedAt = 0;
      this.paperExposurePausedAt = null;
      this.snapshotValue.markets = this.snapshotValue.markets.map((row) => ({
        ...row,
        error: null,
      }));
    }
    if (reason === "operator") {
      this.snapshotValue.watchdog = {
        state: "idle",
        checkedAt: new Date().toISOString(),
        maxQuoteAgeMs: null,
      };
    }
    if (wasRunning) {
      this.store.logEvent({
        category: "runtime",
        action: reason === "watchdog" ? "watchdog-stop" : "stop",
        outcome: "success",
      });
    }
    return wasRunning;
  }

  private async cancelOpenOrders(
    config: MakerConfig,
    options: {
      attempts?: number;
      retryDelayMs?: number;
      marketIds?: string[];
    } = {},
  ): Promise<boolean> {
    this.snapshotValue.restingQuoteMarketIds = [];
    this.snapshotValue.restingQuoteVerifiedAt = null;
    const setup = this.store.getSetup();
    const account = setup ? this.store.getAccountSetup(setup.accountId) : null;
    const agent = this.store.getAgent();
    if (!setup || !account?.agentCapId || !agent || !this.options.masterKey) {
      this.snapshotValue.lastError =
        "Quote cancellation requires a confirmed agent signer";
      return false;
    }

    const signer = loadAgentKeypair({
      masterKey: this.options.masterKey,
      context: agent.encryptionContext,
      encryptedSecret: agent.encryptedSecret,
    });
    const attempts = Math.max(1, options.attempts ?? 1);
    const retryDelayMs = Math.max(0, options.retryDelayMs ?? 0);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const receipt = await this.gateway.cancelMakerOrders({
          setup,
          marketIds:
            options.marketIds ??
            config.markets.map((market) => market.marketId),
          signer,
          config,
        });
        if (receipt) this.logCancelGas(receipt, options.marketIds ?? null);
        if (receipt || attempt === attempts) {
          this.store.logEvent({
            category: "runtime",
            action: "cancel-maker-orders",
            outcome: receipt ? "confirmed" : "clear",
            detail: { attempt, attempts, ...(receipt ?? {}) },
          });
          return true;
        }
      } catch (error) {
        const errorText = message(error);
        this.store.logEvent({
          category: "runtime",
          action: "cancel-maker-orders-attempt",
          outcome: "error",
          detail: { attempt, attempts, error: errorText },
        });
        if (attempt === attempts) {
          this.snapshotValue.lastError = `Quote cancellation failed after ${attempts} attempts: ${errorText}`;
          return false;
        }
      }

      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
    return false;
  }

  async stop(): Promise<void> {
    // An isolated Paper test has no live orders and may run beside a real
    // bundle. Stop must only cancel its scratch ledger, never inspect or
    // cancel the saved bundle's exchange-backed orders.
    if (this.paperTrialId) {
      const trialId = this.paperTrialId;
      this.stopScheduling();
      this.store.cancelPaperOrders(trialId);
      return;
    }
    const config = this.store.getConfig();
    const activeCycle = this.cyclePromise;
    this.stopScheduling();
    let cycleSettled = !activeCycle;
    if (activeCycle) {
      cycleSettled = await Promise.race([
        activeCycle.then(() => true),
        new Promise<false>((resolve) =>
          setTimeout(() => resolve(false), 5_000),
        ),
      ]);
    }
    if (config?.mode === "live") {
      const cancelled = await this.cancelOpenOrders(config, {
        attempts: 3,
        retryDelayMs: 2_000,
      });
      if (cancelled) this.clearActiveQuoteState();
    } else if (config?.mode === "paper") {
      this.store.cancelPaperOrders("runtime");
      this.clearActiveQuoteState();
    }
    if (!cycleSettled && activeCycle && config?.mode === "live") {
      void activeCycle
        .finally(() =>
          this.cancelOpenOrders(config, {
            attempts: 3,
            retryDelayMs: 2_000,
          }),
        )
        .catch(() => undefined);
    }
  }

  async flatten(
    maxSlippage: number,
    options: { refreshSnapshot?: boolean } = {},
  ): Promise<FlattenResult> {
    if (this.flattenPromise) return this.flattenPromise;
    const task = this.flattenOnce(maxSlippage, options);
    this.flattenPromise = task;
    try {
      return await task;
    } finally {
      if (this.flattenPromise === task) this.flattenPromise = null;
    }
  }

  private async flattenOnce(
    maxSlippage: number,
    options: { refreshSnapshot?: boolean },
  ): Promise<FlattenResult> {
    const config = makerConfigSchema.parse(this.store.getConfig());
    if (
      config.mode !== "live" ||
      !this.options.liveEnabled ||
      !this.options.mainnetAllowed
    ) {
      throw new Error("Flattening requires live mode and both mainnet gates");
    }
    const setup = this.store.getSetup();
    const makerAccount = setup
      ? this.store.getAccountSetup(setup.accountId)
      : null;
    const agent = this.store.getAgent();
    if (
      !setup ||
      !makerAccount?.agentCapId ||
      !agent ||
      !this.options.masterKey
    ) {
      throw new Error("A confirmed agent signer is required");
    }

    const accounts = [makerAccount];
    if (config.hedge.enabled && config.hedge.accountId) {
      const hedgeAccount = this.store.getAccountSetup(config.hedge.accountId);
      if (!hedgeAccount?.agentCapId) {
        throw new Error("The configured hedge account is not authorized");
      }
      if (hedgeAccount.accountId !== makerAccount.accountId) {
        accounts.push(hedgeAccount);
      }
    }

    const activeCycle = this.cyclePromise;
    this.stopScheduling();
    if (activeCycle) {
      try {
        await withTimeout(
          activeCycle,
          10_000,
          "Flatten continued after waiting 10 seconds for the active cycle",
        );
      } catch (error) {
        this.store.logEvent({
          category: "risk",
          action: "flatten-cycle-wait",
          outcome: "timeout",
          detail: { error: message(error) },
        });
      }
    }
    const cancelled = await this.cancelOpenOrders(config, {
      attempts: 3,
      retryDelayMs: 750,
    });
    if (!cancelled) {
      throw new Error(
        "Flatten blocked because Maker quote cancellation could not be confirmed",
      );
    }
    this.clearActiveQuoteState();
    const signer = loadAgentKeypair({
      masterKey: this.options.masterKey,
      context: agent.encryptionContext,
      encryptedSecret: agent.encryptedSecret,
    });
    const transactions: FlattenResult["transactions"] = [];
    for (const account of accounts) {
      const receipt = await this.gateway.flattenPositions({
        setup: account,
        config,
        signer,
        marketIds: config.markets.map((market) => market.marketId),
        maxSlippage,
      });
      if (!receipt) continue;
      const receiptDigests = receipt.digests ?? [receipt.digest];
      const residualMarketIds = receipt.residualMarketIds ?? [];
      transactions.push({
        accountId: account.accountId,
        digest: receipt.digest,
        ...(receiptDigests.length > 1 ? { digests: receiptDigests } : {}),
        flattenedMarketIds: receipt.flattenedMarketIds,
        ...(residualMarketIds.length ? { residualMarketIds } : {}),
      });
      this.store.logExecution({
        mode: "live",
        marketId: `portfolio:${account.accountId}`,
        digest: receipt.digest,
        endpoint: receipt.endpoint,
        bidPrice: 0,
        askPrice: 0,
        sizeUsd: 0,
        outcome: residualMarketIds.length ? "flattened-partial" : "flattened",
        gasUsedMist: receipt.gasUsedMist,
        suiUsd: this.suiUsd,
      });
    }
    const residualMarketIds = [
      ...new Set(
        transactions.flatMap(
          (transaction) => transaction.residualMarketIds ?? [],
        ),
      ),
    ];
    this.store.logEvent({
      category: "risk",
      action: "reduce-only-flatten",
      outcome: residualMarketIds.length
        ? "partial"
        : transactions.length
          ? "confirmed"
          : "clear",
      detail: transactions.length
        ? { transactions, residualMarketIds }
        : {
            reason: "No open positions",
            accountIds: accounts.map((account) => account.accountId),
          },
    });
    if (options.refreshSnapshot !== false) await this.cycle();
    const flattenedMarketIds = [
      ...new Set(
        transactions.flatMap((transaction) => transaction.flattenedMarketIds),
      ),
    ];
    const digests = transactions.flatMap(
      (transaction) => transaction.digests ?? [transaction.digest],
    );
    return {
      digest: digests[0] ?? null,
      digests,
      flattenedMarketIds,
      transactions,
      ...(residualMarketIds.length ? { residualMarketIds } : {}),
    };
  }

  async performance(
    inputs: { period?: PerformancePeriod; since?: string } = {},
  ): Promise<PerformanceSnapshot> {
    const period = inputs.period ?? "1D";
    const requestedSince =
      period === "1D"
        ? Date.now() - 24 * 60 * 60 * 1_000
        : period === "EPOCH"
          ? Date.parse(inputs.since ?? "")
          : undefined;
    if (period === "EPOCH" && !Number.isFinite(requestedSince)) {
      throw new Error("Epoch performance requires a valid start time");
    }
    const sinceMs =
      requestedSince === undefined ? undefined : Number(requestedSince);
    const periodStartedAt =
      sinceMs === undefined ? null : new Date(sinceMs).toISOString();
    const timeframe = period === "1D" ? ("1D" as const) : ("ALL" as const);
    const config = this.store.getConfig();
    const setup = this.store.getSetup();
    const accountSetup = setup
      ? this.store.getAccountSetup(setup.accountId)
      : null;
    const agent = this.store.getAgent();
    if (!setup || !accountSetup?.agentCapId || !agent) {
      return {
        asOf: new Date().toISOString(),
        period,
        periodStartedAt,
        historyComplete: true,
        account: null,
        attributed: {
          fills: 0,
          notionalUsd: 0,
          realizedPnlUsd: 0,
          protocolFeesUsd: 0,
          estimatedBuilderFeesUsd: 0,
          netAfterKnownCostsUsd: 0,
          makerVolumeCoveragePct: null,
        },
        hedge: {
          enabled: config?.hedge.enabled ?? false,
          accountId: config?.hedge.accountId ?? null,
          executions: 0,
          fills: 0,
          notionalUsd: 0,
          realizedPnlUsd: 0,
          protocolFeesUsd: 0,
          estimatedBuilderFeesUsd: 0,
          netAfterKnownCostsUsd: 0,
        },
        combinedNetAfterKnownCostsUsd: 0,
        paper: {
          estimated: false,
          makerFills: 0,
          hedgeFills: 0,
          notionalUsd: 0,
        },
        volumeByMarket: [],
        marketVolumeLabel: null,
        fills: [],
        note: "Authorize an agent to begin account and fill reconciliation.",
      };
    }

    const history = await this.venueRead(
      this.gateway.getAccountPerformanceHistory({
        setup,
        agentAddress: agent.address,
        limit: 200,
        timeframe,
        ...(sinceMs === undefined ? {} : { sinceMs }),
      }),
      "Account fill history read",
    );
    const trackedIds = new Set(
      this.store
        .listTrackedMakerOrders({ accountId: setup.accountId })
        .map((order) => order.orderId),
    );
    const symbols = new Map(
      config?.markets.map((market) => [market.marketId, market.symbol]) ?? [],
    );
    const volumeByMarket = new Map<
      string,
      PerformanceSnapshot["volumeByMarket"][number]
    >();
    for (const order of history.orders) {
      const current = volumeByMarket.get(order.marketId) ?? {
        marketId: order.marketId,
        symbol: symbols.get(order.marketId) ?? order.marketId.slice(0, 10),
        makerNotionalUsd: 0,
        makerFills: 0,
        takerNotionalUsd: 0,
        takerFills: 0,
        realizedPnlUsd: 0,
        feesUsd: 0,
        marketVolumeUsd: null,
        marketVolumeError: null,
      };
      const notionalUsd = Math.abs(order.size * order.price);
      if (order.maker) {
        current.makerNotionalUsd += notionalUsd;
        current.makerFills += 1;
      } else {
        current.takerNotionalUsd += notionalUsd;
        current.takerFills += 1;
      }
      current.realizedPnlUsd += order.realizedPnlUsd;
      current.feesUsd += order.feesUsd;
      volumeByMarket.set(order.marketId, current);
    }
    const builderFeeRate = this.options.builderCode()?.integratorFee ?? 0;
    const confirmedFills = history.orders
      .filter(
        (order) =>
          order.maker && order.orderId && trackedIds.has(order.orderId),
      )
      .map<MakerFill>((order) => {
        const notionalUsd = Math.abs(order.size * order.price);
        return {
          occurredAt: new Date(order.timestampMs).toISOString(),
          txDigest: order.txDigest,
          marketId: order.marketId,
          symbol: symbols.get(order.marketId) ?? order.marketId.slice(0, 10),
          side: order.side,
          price: order.price,
          size: order.size,
          notionalUsd,
          realizedPnlUsd: order.realizedPnlUsd,
          protocolFeesUsd: order.feesUsd,
          estimatedBuilderFeeUsd: notionalUsd * builderFeeRate,
          orderId: order.orderId!,
          estimated: false,
          role: "Maker fill",
        };
      })
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));

    const paperRows =
      config?.mode === "paper"
        ? this.store
            .listPaperFills({ trialId: "runtime", limit: 2_000 })
            .filter(
              (fill) =>
                sinceMs === undefined || Date.parse(fill.occurredAt) >= sinceMs,
            )
        : [];
    const paperMakerFills = paperRows.map<MakerFill>((fill) => ({
      occurredAt: fill.occurredAt,
      txDigest: `paper:${fill.orderKey}`,
      marketId: fill.marketId,
      symbol: fill.symbol,
      side: fill.side,
      price: fill.price,
      size: fill.sizeUsd / fill.price,
      notionalUsd: fill.sizeUsd,
      realizedPnlUsd: 0,
      protocolFeesUsd: 0,
      estimatedBuilderFeeUsd: 0,
      orderId: fill.orderKey,
      estimated: true,
      role: fill.orderKey.startsWith("unwind:")
        ? "Unwind"
        : fill.orderKey.startsWith("close:")
          ? "Close"
          : fill.role === "hedge"
            ? "Hedge"
            : "Maker fill",
    }));
    const fills = [...confirmedFills, ...paperMakerFills].sort((left, right) =>
      right.occurredAt.localeCompare(left.occurredAt),
    );

    const sum = (selector: (fill: MakerFill) => number) =>
      confirmedFills.reduce((total, fill) => total + selector(fill), 0);
    const notionalUsd = sum((fill) => fill.notionalUsd);
    const realizedPnlUsd = sum((fill) => fill.realizedPnlUsd);
    const protocolFeesUsd = sum((fill) => fill.protocolFeesUsd);
    const estimatedBuilderFeesUsd = sum((fill) => fill.estimatedBuilderFeeUsd);

    const marginHistory = [...history.marginHistory].sort(
      (left, right) => Number(left.timestamp) - Number(right.timestamp),
    );
    const first = marginHistory[0];
    const last = marginHistory.at(-1);
    const change = (key: keyof NonNullable<typeof first>) =>
      first &&
      last &&
      typeof first[key] === "number" &&
      typeof last[key] === "number"
        ? Number(last[key]) - Number(first[key])
        : 0;
    const account =
      first && last
        ? {
            realizedPnlUsd: change("realizedPnlUsd"),
            fundingPnlUsd: change("realizedFundingsUsd"),
            makerVolumeUsd: change("makerVolumeUsd"),
            takerVolumeUsd: change("takerVolumeUsd"),
            makerFeesUsd: change("makerFeesUsd"),
            takerFeesUsd: change("takerFeesUsd"),
          }
        : null;

    const hedgeExecutions = this.store
      .listHedgeExecutions(period === "ALL" ? 10_000 : 2_000)
      .filter(
        (execution) =>
          sinceMs === undefined || Date.parse(execution.occurredAt) >= sinceMs,
      );
    const hedge = {
      enabled: config?.hedge.enabled ?? false,
      accountId: config?.hedge.accountId ?? null,
      executions: hedgeExecutions.length,
      fills: 0,
      notionalUsd: 0,
      realizedPnlUsd: 0,
      protocolFeesUsd: 0,
      estimatedBuilderFeesUsd: 0,
      netAfterKnownCostsUsd: 0,
    };
    const hedgeSetup = config?.hedge.accountId
      ? this.store.getAccountSetup(config.hedge.accountId)
      : null;
    if (hedgeSetup?.agentCapId && hedgeExecutions.length) {
      const hedgeHistory = await this.venueRead(
        this.gateway.getAccountPerformanceHistory({
          setup: hedgeSetup,
          agentAddress: agent.address,
          limit: 200,
          timeframe,
          ...(sinceMs === undefined ? {} : { sinceMs }),
        }),
        "Hedge fill history read",
      );
      const executionDigests = new Set(
        hedgeExecutions.map((execution) => execution.digest),
      );
      const hedgeFills = hedgeHistory.orders.filter((order) =>
        executionDigests.has(order.txDigest),
      );
      hedge.fills = hedgeFills.length;
      hedge.notionalUsd = hedgeFills.reduce(
        (total, fill) => total + Math.abs(fill.price * fill.size),
        0,
      );
      hedge.realizedPnlUsd = hedgeFills.reduce(
        (total, fill) => total + fill.realizedPnlUsd,
        0,
      );
      hedge.protocolFeesUsd = hedgeFills.reduce(
        (total, fill) => total + fill.feesUsd,
        0,
      );
      hedge.estimatedBuilderFeesUsd = hedge.notionalUsd * builderFeeRate;
      hedge.netAfterKnownCostsUsd =
        hedge.realizedPnlUsd -
        hedge.protocolFeesUsd -
        hedge.estimatedBuilderFeesUsd;
    }
    const makerNetAfterKnownCostsUsd =
      realizedPnlUsd - protocolFeesUsd - estimatedBuilderFeesUsd;
    const now = new Date();
    const marketIds = [...volumeByMarket.keys()];
    let marketVolumeLabel: string | null = null;
    let marketVolumes = new Map<string, number>();
    let marketVolumeError: string | null = null;
    if (marketIds.length && period !== "ALL") {
      const window =
        period === "EPOCH"
          ? rewardEpochDailyStatsWindow(now)
          : {
              fromTimestamp: Date.UTC(
                now.getUTCFullYear(),
                now.getUTCMonth(),
                now.getUTCDate(),
              ),
              toTimestamp: now.getTime(),
              label: `Today, since ${new Intl.DateTimeFormat("en-US", {
                month: "short",
                day: "numeric",
                timeZone: "UTC",
              }).format(now)} 00:00 UTC`,
            };
      marketVolumeLabel = window.label;
      try {
        const dailyVolumes: MarketDailyVolume[] = await this.venueRead(
          this.gateway.getMarketsDailyVolume({
            fromTimestamp: window.fromTimestamp,
            toTimestamp: window.toTimestamp,
            marketIds,
          }),
          "Market daily volume read",
        );
        marketVolumes = new Map(
          dailyVolumes.map((entry) => [entry.marketId, entry.volumeUsd]),
        );
      } catch (error) {
        marketVolumeError = message(error);
      }
    }

    return {
      asOf: now.toISOString(),
      period,
      periodStartedAt,
      historyComplete: history.historyComplete ?? true,
      account,
      attributed: {
        fills: fills.length,
        notionalUsd,
        realizedPnlUsd,
        protocolFeesUsd,
        estimatedBuilderFeesUsd,
        netAfterKnownCostsUsd: makerNetAfterKnownCostsUsd,
        makerVolumeCoveragePct:
          account && account.makerVolumeUsd > 0
            ? Math.min(100, (notionalUsd / account.makerVolumeUsd) * 100)
            : null,
      },
      hedge,
      combinedNetAfterKnownCostsUsd:
        makerNetAfterKnownCostsUsd + hedge.netAfterKnownCostsUsd,
      paper: {
        estimated: paperRows.length > 0,
        makerFills: paperMakerFills.length,
        hedgeFills: paperRows.filter((fill) => fill.role === "hedge").length,
        notionalUsd: paperRows.reduce((total, fill) => total + fill.sizeUsd, 0),
      },
      volumeByMarket: [...volumeByMarket.values()]
        .map((row) => ({
          ...row,
          marketVolumeUsd: marketVolumes.get(row.marketId) ?? null,
          marketVolumeError,
        }))
        .sort((left, right) => left.symbol.localeCompare(right.symbol)),
      marketVolumeLabel,
      fills,
      note: `Maker attribution uses recorded order IDs. Hedge attribution uses confirmed hedge transaction digests. Builder fees are deterministic estimates from filled notional; account metrics come from Aftermath's ${period === "1D" ? "24-hour" : period === "EPOCH" ? "current-epoch" : "all-time"} history.${paperRows.length ? " Paper fills are book-crossing estimates, not exchange executions." : ""}`,
    };
  }

  private async pendingHedgeFills(inputs: {
    makerSetup: Setup;
    agentAddress: string;
  }): Promise<PerformanceOrder[]> {
    const startedAt = Date.parse(this.snapshotValue.startedAt ?? "");
    if (!Number.isFinite(startedAt)) return [];
    const trackedOrderIds = new Set(
      this.store
        .listTrackedMakerOrders({ accountId: inputs.makerSetup.accountId })
        .filter((order) => Date.parse(order.postedAt) >= startedAt - 1_000)
        .map((order) => order.orderId),
    );
    if (!trackedOrderIds.size) return [];
    const history = await this.venueRead(
      this.gateway.getAccountPerformanceHistory({
        setup: inputs.makerSetup,
        agentAddress: inputs.agentAddress,
        limit: 200,
      }),
      "Maker fill history read",
    );
    return history.orders.filter(
      (order) =>
        order.maker &&
        Boolean(order.orderId) &&
        trackedOrderIds.has(order.orderId!) &&
        !this.autoRebalancedOrderIds.has(order.orderId!) &&
        !this.store.isHedgeFillProcessed(
          inputs.makerSetup.accountId,
          hedgeFillKey(order),
        ),
    );
  }

  private async pendingHedgeMarketIds(inputs: {
    makerSetup: Setup;
    agentAddress: string;
  }): Promise<string[]> {
    return [
      ...new Set(
        (await this.pendingHedgeFills(inputs)).map((order) => order.marketId),
      ),
    ];
  }

  private async autoRebalanceIfNeeded(inputs: {
    config: MakerConfig;
    makerSetup: Setup;
    agentAddress: string;
    signer: ReturnType<typeof loadAgentKeypair>;
    makerPortfolio: PortfolioSnapshot;
    hedgePortfolio: PortfolioSnapshot | null;
  }): Promise<boolean> {
    if (!inputs.config.autoRebalanceEnabled) return false;
    const nextQuoteUsd = Math.max(
      ...inputs.config.markets.map(
        (market) => resolveMarketConfig(inputs.config, market).quoteSizeUsd,
      ),
    );
    const combinedGrossExposureUsd =
      inputs.makerPortfolio.grossExposureUsd +
      (inputs.hedgePortfolio?.grossExposureUsd ?? 0);
    if (
      combinedGrossExposureUsd <= 0 ||
      combinedGrossExposureUsd + nextQuoteUsd <
        inputs.config.rebalanceGrossExposureUsd
    ) {
      return false;
    }
    const hedgeAccountId = inputs.config.hedge.accountId;
    const hedgeAccount = hedgeAccountId
      ? this.store.getAccountSetup(hedgeAccountId)
      : null;
    if (!inputs.config.hedge.enabled || !hedgeAccount?.agentCapId) {
      throw new Error(
        "Automatic rebalancing requires an authorized hedge account",
      );
    }
    const cancelled = await this.cancelOpenOrders(inputs.config, {
      attempts: 3,
      retryDelayMs: 750,
    });
    if (!cancelled) {
      throw new Error(
        "Automatic rebalancing could not confirm Maker order cancellation",
      );
    }
    this.clearActiveQuoteState();
    const accounts = [inputs.makerSetup, hedgeAccount];
    const marketIds = inputs.config.markets.map((market) => market.marketId);
    const transactions: FlattenResult["transactions"] = [];
    let flatReads = 0;
    let verifiedFlat = false;
    let lastPortfolios: PortfolioSnapshot[] = [];

    // Account indexing can expose positions in stages after confirmed fills. Retry
    // the reduce-only sweep rather than treating the first indexed view as final.
    for (let pass = 1; pass <= 3; pass += 1) {
      for (const account of accounts) {
        const receipt = await this.gateway.flattenPositions({
          setup: account,
          config: inputs.config,
          signer: inputs.signer,
          marketIds,
          maxSlippage: inputs.config.hedge.maxSlippageBps / 10_000,
        });
        if (!receipt) continue;
        transactions.push({
          accountId: account.accountId,
          digest: receipt.digest,
          ...((receipt.digests?.length ?? 0) > 1
            ? { digests: receipt.digests }
            : {}),
          flattenedMarketIds: receipt.flattenedMarketIds,
          ...(receipt.residualMarketIds?.length
            ? { residualMarketIds: receipt.residualMarketIds }
            : {}),
        });
        this.store.logExecution({
          mode: "live",
          marketId: `portfolio:${account.accountId}`,
          digest: receipt.digest,
          endpoint: receipt.endpoint,
          bidPrice: 0,
          askPrice: 0,
          sizeUsd: 0,
          outcome: "flattened",
          gasUsedMist: receipt.gasUsedMist,
          suiUsd: this.suiUsd,
        });
      }

      flatReads = 0;
      for (let attempt = 1; attempt <= 12; attempt += 1) {
        lastPortfolios = await Promise.all(
          accounts.map((setup) =>
            this.venueRead(
              this.gateway.getAgentPortfolioSnapshot({
                setup,
                agentAddress: inputs.agentAddress,
                marketIds,
              }),
              "Rebalance account read",
            ),
          ),
        );
        const flat = lastPortfolios.every((portfolio) =>
          portfolio.positions.every(
            (position) =>
              Math.abs(position.inventoryUsd) < 0.01 &&
              position.pendingOrderCount === 0,
          ),
        );
        flatReads = flat ? flatReads + 1 : 0;
        if (flatReads >= 3) {
          verifiedFlat = true;
          break;
        }
        if (attempt < 12) {
          await (this.options.sleep
            ? this.options.sleep(750)
            : new Promise((resolve) => setTimeout(resolve, 750)));
        }
      }
      if (verifiedFlat) break;
      if (pass < 3) {
        this.store.logEvent({
          category: "risk",
          action: "automatic-paired-rebalance",
          outcome: "retry",
          detail: {
            completedPass: pass,
            residualAccounts: lastPortfolios.map((portfolio, index) => ({
              accountId: accounts[index]?.accountId,
              positions: portfolio.positions
                .filter(
                  (position) =>
                    Math.abs(position.inventoryUsd) >= 0.01 ||
                    position.pendingOrderCount > 0,
                )
                .map((position) => ({
                  marketId: position.marketId,
                  inventoryUsd: position.inventoryUsd,
                  pendingOrderCount: position.pendingOrderCount,
                })),
            })),
          },
        });
      }
    }
    if (!verifiedFlat) {
      throw new Error(
        "Automatic rebalancing could not verify three consecutive flat account reads after three reduce-only passes",
      );
    }

    const pendingFills = await this.pendingHedgeFills({
      makerSetup: inputs.makerSetup,
      agentAddress: inputs.agentAddress,
    });
    const runStartedAt = Date.parse(this.snapshotValue.startedAt ?? "");
    for (const order of this.store
      .listTrackedMakerOrders({ accountId: inputs.makerSetup.accountId })
      .filter((order) => Date.parse(order.postedAt) >= runStartedAt - 1_000)) {
      this.autoRebalancedOrderIds.add(order.orderId);
    }
    if (pendingFills.length) {
      this.store.markHedgeFillsProcessed({
        makerAccountId: inputs.makerSetup.accountId,
        fillKeys: pendingFills.map(hedgeFillKey),
        hedgeDigest: `auto-rebalance:${transactions.map((item) => item.digest).join(",")}`,
      });
    }
    this.store.logEvent({
      category: "risk",
      action: "automatic-paired-rebalance",
      outcome: "confirmed",
      detail: {
        triggerGrossExposureUsd: combinedGrossExposureUsd,
        thresholdUsd: inputs.config.rebalanceGrossExposureUsd,
        transactions,
        flatReads,
      },
    });
    this.snapshotValue.execution.lastDecision = "rebalanced";
    this.snapshotValue.hedge.state = "ready";
    this.snapshotValue.hedge.combinedDeltaUsd = 0;
    return true;
  }

  private async reconcileHedge(inputs: {
    config: MakerConfig;
    marketConfig: MakerConfig;
    selected: MakerMarket;
    makerSetup: Setup;
    agentAddress: string;
    signer: ReturnType<typeof loadAgentKeypair>;
    makerPortfolio: PortfolioSnapshot;
    executionIsCurrent: () => boolean;
  }): Promise<boolean> {
    const hedgeConfig = inputs.config.hedge;
    this.snapshotValue.hedge = {
      ...this.snapshotValue.hedge,
      enabled: hedgeConfig.enabled,
      state: hedgeConfig.enabled ? "waiting" : "off",
      accountId: hedgeConfig.accountId,
      error: null,
    };
    if (!hedgeConfig.enabled) return true;

    const makerAccount = this.store.getAccountSetup(
      inputs.makerSetup.accountId,
    );
    const hedgeAccount = hedgeConfig.accountId
      ? this.store.getAccountSetup(hedgeConfig.accountId)
      : null;
    if (!makerAccount?.agentCapId || !hedgeAccount?.agentCapId) {
      throw new Error("Both Maker and hedge accounts must be authorized");
    }
    if (makerAccount.accountId === hedgeAccount.accountId) {
      throw new Error("Maker and hedge accounts must be different");
    }

    const hedgePortfolio = await this.venueRead(
      this.gateway.getAgentPortfolioSnapshot({
        setup: hedgeAccount,
        agentAddress: inputs.agentAddress,
        marketIds: [inputs.selected.marketId],
      }),
      "Hedge account read",
    );
    const makerPosition = inputs.makerPortfolio.positions.find(
      (position) => position.marketId === inputs.selected.marketId,
    );
    const hedgePosition = hedgePortfolio.positions.find(
      (position) => position.marketId === inputs.selected.marketId,
    );
    const combinedDeltaUsd =
      (makerPosition?.inventoryUsd ?? 0) + (hedgePosition?.inventoryUsd ?? 0);
    this.snapshotValue.hedge = {
      ...this.snapshotValue.hedge,
      state: "ready",
      combinedDeltaUsd,
    };

    const history = await this.venueRead(
      this.gateway.getAccountPerformanceHistory({
        setup: inputs.makerSetup,
        agentAddress: inputs.agentAddress,
        limit: 200,
      }),
      "Maker fill history read",
    );
    const runStartedAt = Date.parse(this.snapshotValue.startedAt ?? "");
    const trackedOrderIds = new Set(
      this.store
        .listTrackedMakerOrders({ accountId: inputs.makerSetup.accountId })
        .filter(
          (order) =>
            order.marketId === inputs.selected.marketId &&
            Date.parse(order.postedAt) >= runStartedAt - 1_000,
        )
        .map((order) => order.orderId),
    );
    const pendingFills = history.orders.filter(
      (order) =>
        order.maker &&
        order.marketId === inputs.selected.marketId &&
        Boolean(order.orderId) &&
        trackedOrderIds.has(order.orderId!) &&
        !this.autoRebalancedOrderIds.has(order.orderId!) &&
        !this.store.isHedgeFillProcessed(
          inputs.makerSetup.accountId,
          hedgeFillKey(order),
        ),
    );
    const pendingDeltaUsd = pendingFills.reduce(
      (total, fill) => total + signedFillNotional(fill),
      0,
    );
    const attributionKey = `${inputs.makerSetup.accountId}:${inputs.selected.marketId}`;
    if (
      Math.abs(combinedDeltaUsd) >= hedgeConfig.thresholdUsd &&
      Math.abs(pendingDeltaUsd) < hedgeConfig.thresholdUsd
    ) {
      const now = Date.now();
      const waitingSince = this.awaitingFillAttribution.get(attributionKey);
      if (waitingSince === undefined) {
        this.awaitingFillAttribution.set(attributionKey, now);
        this.store.logEvent({
          category: "hedge",
          action: "fill-attribution-reconciliation",
          outcome: "waiting",
          detail: {
            marketId: inputs.selected.marketId,
            combinedDeltaUsd,
            attributedDeltaUsd: pendingDeltaUsd,
          },
        });
      } else if (now - waitingSince >= 10_000) {
        throw new Error(
          `Hedge blocked: $${Math.abs(combinedDeltaUsd).toFixed(4)} of account delta has no attributable Maker fill history`,
        );
      }
      this.snapshotValue.hedge.state = "waiting";
      return false;
    }
    const waitingSince = this.awaitingFillAttribution.get(attributionKey);
    if (waitingSince !== undefined) {
      this.awaitingFillAttribution.delete(attributionKey);
      if (pendingFills.length) {
        this.store.logEvent({
          category: "hedge",
          action: "fill-attribution-reconciliation",
          outcome: "confirmed",
          detail: {
            marketId: inputs.selected.marketId,
            waitedMs: Date.now() - waitingSince,
            pendingFillCount: pendingFills.length,
          },
        });
      }
    }
    if (!pendingFills.length) return true;

    const fillKeys = pendingFills.map(hedgeFillKey);
    const completionToleranceUsd = Math.min(
      hedgeConfig.thresholdUsd,
      Math.max(0.01, Math.min(0.05, Math.abs(pendingDeltaUsd) * 0.02)),
    );
    if (Math.abs(pendingDeltaUsd) < hedgeConfig.thresholdUsd) {
      this.snapshotValue.hedge.state = "waiting";
      return true;
    }

    if (Math.abs(combinedDeltaUsd) < completionToleranceUsd) {
      const now = Date.now();
      const positionWaitingSince =
        this.awaitingPositionAttribution.get(attributionKey);
      if (positionWaitingSince === undefined) {
        this.awaitingPositionAttribution.set(attributionKey, now);
        this.store.logEvent({
          category: "hedge",
          action: "position-attribution-reconciliation",
          outcome: "waiting",
          detail: {
            marketId: inputs.selected.marketId,
            combinedDeltaUsd,
            attributedDeltaUsd: pendingDeltaUsd,
          },
        });
      } else if (now - positionWaitingSince >= 10_000) {
        throw new Error(
          `Hedge blocked: $${Math.abs(pendingDeltaUsd).toFixed(4)} of attributed fills is not visible in account positions`,
        );
      }
      this.snapshotValue.hedge.state = "waiting";
      return false;
    }
    const positionWaitingSince =
      this.awaitingPositionAttribution.get(attributionKey);
    if (positionWaitingSince !== undefined) {
      this.awaitingPositionAttribution.delete(attributionKey);
      this.store.logEvent({
        category: "hedge",
        action: "position-attribution-reconciliation",
        outcome: "confirmed",
        detail: {
          marketId: inputs.selected.marketId,
          waitedMs: Date.now() - positionWaitingSince,
          combinedDeltaUsd,
        },
      });
    }

    if (Math.sign(combinedDeltaUsd) !== Math.sign(pendingDeltaUsd)) {
      throw new Error(
        "Hedge account over-offsets the attributed Maker fills; flatten both accounts before restarting",
      );
    }

    const cancelReceipt = await this.gateway.cancelMakerOrders({
      setup: inputs.makerSetup,
      marketIds: [inputs.selected.marketId],
      signer: inputs.signer,
      config: inputs.marketConfig,
    });
    if (cancelReceipt)
      this.logCancelGas(cancelReceipt, [inputs.selected.marketId]);
    if (this.activeQuoteMarketId === inputs.selected.marketId) {
      this.clearActiveQuoteState();
    }
    this.store.logEvent({
      category: "hedge",
      action: "cancel-maker-quotes",
      outcome: cancelReceipt ? "confirmed" : "clear",
      detail: {
        marketId: inputs.selected.marketId,
        ...(cancelReceipt ? { digest: cancelReceipt.digest } : {}),
      },
    });
    if (!inputs.executionIsCurrent()) {
      throw new Error("Hedge execution cancelled after quote cancellation");
    }

    let postCancelPortfolios: [PortfolioSnapshot, PortfolioSnapshot] | null =
      null;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const portfolios = await Promise.all([
        this.venueRead(
          this.gateway.getAgentPortfolioSnapshot({
            setup: inputs.makerSetup,
            agentAddress: inputs.agentAddress,
            marketIds: [inputs.selected.marketId],
          }),
          "Maker account read",
        ),
        this.venueRead(
          this.gateway.getAgentPortfolioSnapshot({
            setup: hedgeAccount,
            agentAddress: inputs.agentAddress,
            marketIds: [inputs.selected.marketId],
          }),
          "Hedge account read",
        ),
      ]);
      const makerPending = portfolios[0].positions[0]?.pendingOrderCount ?? 0;
      const hedgePending = portfolios[1].positions[0]?.pendingOrderCount ?? 0;
      if (makerPending === 0 && hedgePending === 0) {
        postCancelPortfolios = portfolios;
        if (attempt > 1) {
          this.store.logEvent({
            category: "hedge",
            action: "post-cancel-reconciliation",
            outcome: "confirmed",
            detail: { attempt, makerPending, hedgePending },
          });
        }
        break;
      }
      if (attempt === 1) {
        this.store.logEvent({
          category: "hedge",
          action: "post-cancel-reconciliation",
          outcome: "waiting",
          detail: { attempt, makerPending, hedgePending },
        });
      }
      if (attempt === 10) break;
      if (!inputs.executionIsCurrent()) {
        throw new Error(
          "Hedge execution cancelled while confirming order removal",
        );
      }
      await (this.options.sleep
        ? this.options.sleep(750)
        : new Promise((resolve) => setTimeout(resolve, 750)));
    }
    if (!postCancelPortfolios) {
      throw new Error(
        "Hedge blocked: clear every resting order on both configured accounts",
      );
    }

    const [makerAfterCancel, hedgeAfterCancel] = postCancelPortfolios;
    const makerAfterPosition = makerAfterCancel.positions[0];
    const hedgeAfterPosition = hedgeAfterCancel.positions[0];
    const currentCombinedDeltaUsd =
      (makerAfterPosition?.inventoryUsd ?? 0) +
      (hedgeAfterPosition?.inventoryUsd ?? 0);
    this.snapshotValue.hedge.combinedDeltaUsd = currentCombinedDeltaUsd;
    if (Math.abs(currentCombinedDeltaUsd) < completionToleranceUsd) {
      this.store.markHedgeFillsProcessed({
        makerAccountId: inputs.makerSetup.accountId,
        fillKeys,
        hedgeDigest: cancelReceipt?.digest ?? "already-offset",
      });
      return true;
    }
    if (Math.sign(currentCombinedDeltaUsd) !== Math.sign(pendingDeltaUsd)) {
      throw new Error(
        "Hedge account over-offsets the attributed Maker fills; flatten both accounts before restarting",
      );
    }

    const attributedDeltaUsd =
      Math.sign(currentCombinedDeltaUsd) *
      Math.min(Math.abs(currentCombinedDeltaUsd), Math.abs(pendingDeltaUsd));
    this.snapshotValue.hedge.state = "hedging";
    const receipt = await this.gateway.executeHedge({
      setup: hedgeAccount,
      config: inputs.marketConfig,
      signer: inputs.signer,
      marketId: inputs.selected.marketId,
      deltaUsd: attributedDeltaUsd,
      maxOrderUsd: hedgeConfig.maxOrderUsd,
      maxSlippage: hedgeConfig.maxSlippageBps / 10_000,
      builderCode: this.options.builderCode(),
      shouldContinue: inputs.executionIsCurrent,
    });
    let actualCombinedDeltaUsd = currentCombinedDeltaUsd;
    let hedgeStateObserved = false;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const [makerAfterHedge, hedgeAfterHedge] = await Promise.all([
        this.venueRead(
          this.gateway.getAgentPortfolioSnapshot({
            setup: inputs.makerSetup,
            agentAddress: inputs.agentAddress,
            marketIds: [inputs.selected.marketId],
          }),
          "Maker account read",
        ),
        this.venueRead(
          this.gateway.getAgentPortfolioSnapshot({
            setup: hedgeAccount,
            agentAddress: inputs.agentAddress,
            marketIds: [inputs.selected.marketId],
          }),
          "Hedge account read",
        ),
      ]);
      actualCombinedDeltaUsd =
        (makerAfterHedge.positions[0]?.inventoryUsd ?? 0) +
        (hedgeAfterHedge.positions[0]?.inventoryUsd ?? 0);
      const progressUsd =
        Math.abs(currentCombinedDeltaUsd) - Math.abs(actualCombinedDeltaUsd);
      hedgeStateObserved =
        Math.abs(actualCombinedDeltaUsd) < completionToleranceUsd ||
        progressUsd > 0.001 ||
        Math.sign(actualCombinedDeltaUsd) !==
          Math.sign(currentCombinedDeltaUsd);
      if (hedgeStateObserved) {
        if (attempt > 1) {
          this.store.logEvent({
            category: "hedge",
            action: "post-hedge-reconciliation",
            outcome: "confirmed",
            detail: { attempt, actualCombinedDeltaUsd },
          });
        }
        break;
      }
      if (attempt === 1) {
        this.store.logEvent({
          category: "hedge",
          action: "post-hedge-reconciliation",
          outcome: "waiting",
          detail: { attempt, actualCombinedDeltaUsd },
        });
      }
      if (attempt === 10) break;
      if (!inputs.executionIsCurrent()) {
        throw new Error(
          "Hedge reconciliation cancelled while confirming execution",
        );
      }
      await (this.options.sleep
        ? this.options.sleep(750)
        : new Promise((resolve) => setTimeout(resolve, 750)));
    }
    const resolved = Math.abs(actualCombinedDeltaUsd) < completionToleranceUsd;
    const progressUsd =
      Math.abs(currentCombinedDeltaUsd) - Math.abs(actualCombinedDeltaUsd);
    this.store.recordHedgeExecution({
      makerAccountId: inputs.makerSetup.accountId,
      hedgeAccountId: hedgeAccount.accountId,
      marketId: inputs.selected.marketId,
      digest: receipt.digest,
      side: receipt.side,
      requestedNotionalUsd: receipt.requestedNotionalUsd,
      gasUsedMist: receipt.gasUsedMist,
      suiUsd: this.suiUsd,
      fillKeys: resolved ? fillKeys : [],
    });
    const occurredAt = new Date().toISOString();
    this.snapshotValue.hedge = {
      ...this.snapshotValue.hedge,
      state: resolved ? "ready" : "hedging",
      combinedDeltaUsd: actualCombinedDeltaUsd,
      lastHedgeAt: occurredAt,
      lastDigest: receipt.digest,
      error: null,
    };
    this.store.logEvent({
      category: "hedge",
      action: "fill-driven-market-order",
      outcome: resolved ? "confirmed" : "partial",
      detail: {
        marketId: inputs.selected.marketId,
        makerAccountId: inputs.makerSetup.accountId,
        hedgeAccountId: hedgeAccount.accountId,
        digest: receipt.digest,
        side: receipt.side,
        requestedNotionalUsd: receipt.requestedNotionalUsd,
        actualCombinedDeltaUsd,
        completionToleranceUsd,
        pendingFillCount: pendingFills.length,
      },
    });
    if (!resolved && progressUsd <= 0.001) {
      throw new Error(
        `Hedge transaction did not reduce combined delta: $${Math.abs(actualCombinedDeltaUsd).toFixed(4)} remains`,
      );
    }
    return resolved;
  }

  async cycle(
    inputs: {
      executeLive?: boolean;
      generation?: number;
      configOverride?: MakerConfig;
      paperTrialId?: string;
    } = {},
  ): Promise<void> {
    if (this.cyclePromise) return this.cyclePromise;

    const generation = inputs.generation ?? this.generation;
    const config = inputs.configOverride ?? this.store.getConfig();
    const token = ++this.cycleToken;
    const task = this.runCycle({
      executeLive: inputs.executeLive ?? false,
      generation,
      cycleToken: token,
      ...(inputs.configOverride
        ? { configOverride: inputs.configOverride }
        : {}),
      ...(inputs.paperTrialId ? { paperTrialId: inputs.paperTrialId } : {}),
    });
    const runningPaper =
      config?.mode === "paper" &&
      this.snapshotValue.running &&
      (inputs.executeLive ?? false);
    const guarded = runningPaper
      ? withTimeout(
          task,
          Math.max(3 * config.refreshMs, 60_000),
          "Paper cycle passed its deadline",
        ).catch((error) => {
          if (
            error instanceof VenueReadTimeoutError &&
            token === this.cycleToken &&
            generation === this.generation &&
            this.snapshotValue.running
          ) {
            this.cycleToken += 1;
            this.snapshotValue.lastError = error.message;
            this.store.logEvent({
              category: "runtime",
              action: "cycle",
              outcome: "timeout",
              detail: {
                error: error.message,
                accountReadAt: this.snapshotValue.accountReadAt,
              },
            });
            return;
          }
          throw error;
        })
      : task;
    this.cyclePromise = guarded;
    try {
      await guarded;
    } finally {
      if (this.cyclePromise === guarded) this.cyclePromise = null;
    }
  }

  private recordPaperSimulationBlocker(inputs: {
    blocker: NonNullable<RuntimeSnapshot["paperBlocker"]>;
    selected: MakerMarket;
    updatedAt: string;
    trialId: string;
  }): void {
    const { blocker, selected, updatedAt, trialId } = inputs;
    this.snapshotValue.lastError = blocker.message;
    this.snapshotValue.paperBlocker = blocker;
    this.snapshotValue.execution.lastDecision = "held";
    // A bundle blocker must not overwrite an independent market skip. Both
    // states are useful: the card can offer the bundle-level fix while the
    // affected market row explains why that market itself is waiting.
    // Gross exposure is one bundle state. Its projected amount can change as
    // positions move, but that is not a new pause.
    const key = `${trialId}:${blocker.code}`;
    const now = Date.now();
    if (
      this.paperSimulationBlockerKey !== key ||
      now - this.paperSimulationBlockerLastLoggedAt >= 15 * 60_000
    ) {
      this.store.logEvent({
        category: "paper",
        action: "simulation",
        outcome: "blocked",
        detail: {
          ...blocker,
          ...(blocker.code === "gross-exposure"
            ? {}
            : { marketId: selected.marketId }),
          accountId: this.snapshotValue.accountId,
          agentAddress: this.snapshotValue.agentAddress,
        },
      });
      this.paperSimulationBlockerKey = key;
      this.paperSimulationBlockerLastLoggedAt = now;
      if (
        blocker.code === "gross-exposure" &&
        this.paperExposurePausedAt === null
      )
        this.paperExposurePausedAt = now;
    }
  }

  private clearPaperSimulationBlocker(): void {
    if (!this.snapshotValue.paperBlocker && !this.paperSimulationBlockerKey)
      return;
    if (
      this.snapshotValue.paperBlocker &&
      this.snapshotValue.lastError === this.snapshotValue.paperBlocker.message
    )
      this.snapshotValue.lastError = null;
    this.snapshotValue.paperBlocker = null;
    this.paperSimulationBlockerKey = null;
    this.paperSimulationBlockerLastLoggedAt = 0;
    this.paperExposurePausedAt = null;
    this.store.logEvent({
      category: "paper",
      action: "simulation",
      outcome: "cleared",
      detail: { accountId: this.snapshotValue.accountId },
    });
  }

  private recordPaperMarketSkip(inputs: {
    selected: MakerMarket;
    failed: SafetyCheck;
    config: MakerConfig;
  }): void {
    const { selected, failed, config } = inputs;
    const key = `${selected.marketId}:${failed.code}`;
    const maxFairValue = Math.min(
      config.maxBookDivergenceBps,
      config.spreadBps / 2,
    );
    const limitName =
      config.maxBookDivergenceBps < config.spreadBps / 2
        ? "the book / index divergence setting"
        : `half its ${config.spreadBps.toFixed(0)} bps spread`;
    const bundleName = this.store.bundleId
      ? (this.store.getStoredBundle(this.store.bundleId)?.name ?? "Maker")
      : "Core";
    const message =
      failed.code === "fair-value"
        ? `${bundleName}: ${selected.symbol} paused. Its book is ${failed.detail.split(";")[0]} from the index price, and ${bundleName} quotes only within ${maxFairValue.toFixed(1)} bps (${limitName}). Quoting resumes when the book comes back, or widen the spread in Strategy.`
        : `${bundleName}: ${selected.symbol} paused. ${failed.detail}. Quoting resumes when this market is safe again.`;
    const previous = this.paperMarketSkips.get(selected.marketId);
    this.snapshotValue.markets = this.snapshotValue.markets.map((row) =>
      row.id === selected.marketId
        ? {
            ...row,
            error: message,
            skip: {
              code: failed.code,
              message,
              since: new Date(previous?.since ?? Date.now()).toISOString(),
            },
          }
        : row,
    );
    if (previous?.code === failed.code) {
      this.maybeWarnAllPaperMarketsSkipped(config, bundleName);
      return;
    }
    if (previous) this.logPaperMarketResumed(selected, bundleName);
    this.paperMarketSkips.set(selected.marketId, {
      code: failed.code,
      since: Date.now(),
    });
    this.store.logEvent({
      category: "paper",
      action: "market-skip",
      outcome: "paused",
      detail: {
        marketId: selected.marketId,
        symbol: selected.symbol,
        code: failed.code,
        message,
      },
    });
    this.maybeWarnAllPaperMarketsSkipped(config, bundleName);
  }

  private clearPaperMarketSkip(selected: MakerMarket): void {
    if (!this.paperMarketSkips.delete(selected.marketId)) return;
    const bundleName = this.store.bundleId
      ? (this.store.getStoredBundle(this.store.bundleId)?.name ?? "Maker")
      : "Core";
    this.snapshotValue.markets = this.snapshotValue.markets.map((row) =>
      row.id === selected.marketId ? { ...row, error: null, skip: null } : row,
    );
    this.logPaperMarketResumed(selected, bundleName);
    if (this.paperMarketSkips.size === 0) this.paperAllSkippedSince = null;
  }

  private logPaperMarketResumed(
    selected: MakerMarket,
    bundleName: string,
  ): void {
    this.store.logEvent({
      category: "paper",
      action: "market-skip",
      outcome: "resumed",
      detail: {
        marketId: selected.marketId,
        symbol: selected.symbol,
        message: `${bundleName}: ${selected.symbol} is quoting again.`,
      },
    });
  }

  private maybeWarnAllPaperMarketsSkipped(
    config: MakerConfig,
    bundleName: string,
  ): void {
    if (this.paperMarketSkips.size !== config.markets.length) {
      this.paperAllSkippedSince = null;
      return;
    }
    const now = Date.now();
    this.paperAllSkippedSince ??= now;
    if (
      this.paperAllSkippedWarningLogged ||
      now - this.paperAllSkippedSince < 15 * 60_000
    )
      return;
    const counts = new Map<string, number>();
    for (const skip of this.paperMarketSkips.values()) {
      counts.set(skip.code, (counts.get(skip.code) ?? 0) + 1);
    }
    const labels: Record<string, string> = {
      "fair-value": "markets outside the fair-value limit",
      freshness: "with stale books",
      spread: "with crossed quotes",
      notional: "outside the notional limit",
      inventory: "at the inventory limit",
    };
    const reasons = [...counts.entries()]
      .map(
        ([code, count]) => `${count} ${labels[code] ?? `blocked by ${code}`}`,
      )
      .join(", ");
    const message = `${bundleName}: Paper hasn't quoted for 15 min: ${reasons}.`;
    this.store.logEvent({
      category: "paper",
      action: "market-skip",
      outcome: "all-paused",
      detail: { message },
    });
    this.paperAllSkippedWarningLogged = true;
  }

  /** A cancel spends gas like any other transaction, so it is counted. */
  private logCancelGas(
    receipt: { digest: string; endpoint: string; gasUsedMist: number },
    marketIds: string[] | null,
  ): void {
    this.store.logExecution({
      mode: "live",
      marketId: marketIds?.length === 1 ? marketIds[0]! : "*",
      digest: receipt.digest,
      endpoint: receipt.endpoint,
      bidPrice: 0,
      askPrice: 0,
      sizeUsd: 0,
      outcome: "cancelled",
      gasUsedMist: receipt.gasUsedMist,
      suiUsd: this.suiUsd,
    });
  }

  /** A failed read leaves gas unpriced for this cycle; it never blocks it. */
  private async refreshSuiUsd(): Promise<void> {
    const read = (this.gateway as Partial<Pick<AftermathGateway, "getSuiUsd">>)
      .getSuiUsd;
    if (typeof read !== "function") return;
    try {
      this.suiUsd = await withTimeout(
        read.call(this.gateway),
        2_000,
        "SUI price read timed out",
      );
    } catch {
      this.suiUsd = null;
    }
  }

  private async runCycle(inputs: {
    executeLive: boolean;
    generation: number;
    cycleToken: number;
    configOverride?: MakerConfig;
    paperTrialId?: string;
  }): Promise<void> {
    let selected: MakerMarket | null = null;
    let config: MakerConfig | null = null;
    let hedgeReconciliationCompleted = false;
    let switchFromMarketId: string | null = null;
    let volumeRotateFromMarketId: string | null = null;
    let usesDwellScheduler = false;
    const paperTrialId = inputs.paperTrialId ?? "runtime";
    try {
      const storedConfig = inputs.configOverride ?? this.store.getConfig();
      if (!storedConfig) return;
      config = makerConfigSchema.parse(storedConfig);
      await this.refreshSuiUsd();
      this.syncMarketRows(config);
      usesDwellScheduler =
        inputs.executeLive &&
        this.snapshotValue.running &&
        config.rotationMode === "single-slot";
      if (usesDwellScheduler) {
        const now = Date.now();
        if (this.marketSelectedAt === null) {
          this.marketSelectedAt = now;
        } else if (now - this.marketSelectedAt >= config.marketDwellMs) {
          const prior =
            config.markets[this.marketIndex % config.markets.length];
          this.marketIndex = (this.marketIndex + 1) % config.markets.length;
          this.marketSelectedAt = now;
          if (
            config.mode === "paper" &&
            config.strategyObjective === "volume" &&
            config.flattenOnRotate
          ) {
            volumeRotateFromMarketId = prior?.marketId ?? null;
          }
        }
      }
      selected = config.markets[this.marketIndex % config.markets.length]!;
      const marketConfig = resolveMarketConfig(config, selected);
      const setup = this.store.getSetup();
      const account = setup
        ? this.store.getAccountSetup(setup.accountId)
        : null;
      const agent = this.store.getAgent();
      const executionIsCurrent = () =>
        this.snapshotValue.running &&
        this.generation === inputs.generation &&
        (config?.mode !== "paper" || this.cycleToken === inputs.cycleToken);
      const liveExecution = config.mode === "live" && inputs.executeLive;

      if (liveExecution) {
        if (!this.singleSlotSwept) {
          const swept = await this.cancelOpenOrders(config, {
            attempts: 3,
            retryDelayMs: 750,
          });
          if (!swept) {
            throw new Error(
              "Single-slot rotation could not confirm its startup order sweep",
            );
          }
          this.singleSlotSwept = true;
          this.clearActiveQuoteState();
        }
        if (
          config.rotationMode === "single-slot" &&
          this.activeQuoteMarketId &&
          this.activeQuoteMarketId !== selected.marketId
        ) {
          switchFromMarketId = this.activeQuoteMarketId;
        }
      }

      const { market, orderbook } = await withTimeout(
        this.gateway.getOrderbook(selected.marketId),
        VENUE_READ_TIMEOUT_MS,
        "Venue orderbook read timed out",
      );
      if (inputs.executeLive && !executionIsCurrent()) return;
      const bestBid = orderbook.bestBidPrice;
      const bestAsk = orderbook.bestAskPrice;
      if (bestBid === undefined || bestAsk === undefined) {
        throw new Error("Orderbook has no two-sided price");
      }

      if (config.mode === "paper") {
        if (volumeRotateFromMarketId) {
          // Volume is deliberately sequential: cancel first, then close the
          // prior maker and hedge inventories at touch before opening the next
          // market.  These are simulator records only; no live order path is
          // reachable from this branch.
          this.store.cancelPaperOrders(paperTrialId, volumeRotateFromMarketId);
          const priorBook = await withTimeout(
            this.gateway.getOrderbook(volumeRotateFromMarketId),
            VENUE_READ_TIMEOUT_MS,
            "Volume close orderbook read timed out",
          );
          const priorBid = priorBook.orderbook.bestBidPrice;
          const priorAsk = priorBook.orderbook.bestAskPrice;
          if (priorBid === undefined || priorAsk === undefined) {
            throw new Error("Volume close orderbook has no two-sided price");
          }
          const closes = this.store.closePaperMarket({
            trialId: paperTrialId,
            marketId: volumeRotateFromMarketId,
            bestBid: priorBid,
            bestAsk: priorAsk,
            reason: "close",
          });
          if (closes.length) {
            const utcDate = new Date().toISOString().slice(0, 10);
            if (this.paperVolumeFees?.utcDate !== utcDate) {
              this.paperVolumeFees = { utcDate, usd: 0, warned: false };
            }
            const priorFee =
              this.markets.find((item) => item.id === volumeRotateFromMarketId)
                ?.makerFee ?? 0;
            this.paperVolumeFees!.usd +=
              closes.reduce((total, fill) => total + fill.sizeUsd, 0) *
              priorFee;
            const state = this.store.getPaperState(paperTrialId);
            if (
              state.positions.some(
                (position) => position.marketId === volumeRotateFromMarketId,
              )
            ) {
              throw new Error("Volume close did not leave both accounts flat");
            }
            this.store.logEvent({
              category: "paper",
              action: "volume-close",
              outcome: "estimated",
              detail: {
                trialId: paperTrialId,
                marketId: volumeRotateFromMarketId,
                closes: closes.length,
                volumeUsd: closes.reduce(
                  (total, fill) => total + fill.sizeUsd,
                  0,
                ),
              },
            });
          }
        }
        const estimatedFills = this.store.matchPaperOrders({
          trialId: paperTrialId,
          marketId: selected.marketId,
          bestBid,
          bestAsk,
        });
        if (estimatedFills.length && config.hedge.enabled) {
          for (const fill of estimatedFills) {
            this.store.recordPaperHedge({
              trialId: paperTrialId,
              makerFill: fill,
            });
          }
        }
        if (estimatedFills.length) {
          if (config.strategyObjective === "volume") {
            const utcDate = new Date().toISOString().slice(0, 10);
            if (this.paperVolumeFees?.utcDate !== utcDate) {
              this.paperVolumeFees = { utcDate, usd: 0, warned: false };
            }
            // The Paper estimate has no account-history fee rows.  Apply the
            // venue maker rate to the maker fill and its immediate hedge; the
            // two reduce-only closes are added when the dwell interval ends.
            this.paperVolumeFees!.usd +=
              estimatedFills.reduce((total, fill) => total + fill.sizeUsd, 0) *
              (this.markets.find((item) => item.id === selected!.marketId)
                ?.makerFee ?? 0) *
              2;
          }
          this.store.logEvent({
            category: "paper",
            action: "estimated-fill",
            outcome: "estimated",
            detail: {
              trialId: paperTrialId,
              marketId: selected.marketId,
              fills: estimatedFills.length,
              hedges: config.hedge.enabled ? estimatedFills.length : 0,
              estimatedFills: estimatedFills.map((fill) => ({
                symbol: fill.symbol,
                side: fill.side,
                price: fill.price,
                sizeUsd: fill.sizeUsd,
              })),
            },
          });
        }
      }
      const paperState =
        config.mode === "paper" ? this.store.getPaperState(paperTrialId) : null;

      let portfolio = emptyPortfolio();
      let hedgeRiskPortfolio: PortfolioSnapshot | null = config.hedge.enabled
        ? null
        : emptyPortfolio();
      if (setup && account?.agentCapId && agent) {
        portfolio = await withTimeout(
          this.gateway.getAgentPortfolioSnapshot({
            setup,
            agentAddress: agent.address,
            marketIds: config.markets.map((item) => item.marketId),
          }),
          VENUE_READ_TIMEOUT_MS,
          "Maker account read timed out",
        );
        if (inputs.executeLive && !executionIsCurrent()) return;
        this.snapshotValue.accountReadAt = portfolio.markedAt;
        if (config.hedge.enabled && config.hedge.accountId) {
          const hedgeAccount = this.store.getAccountSetup(
            config.hedge.accountId,
          );
          if (hedgeAccount?.agentCapId) {
            hedgeRiskPortfolio = await withTimeout(
              this.gateway.getAgentPortfolioSnapshot({
                setup: hedgeAccount,
                agentAddress: agent.address,
                marketIds: config.markets.map((item) => item.marketId),
              }),
              VENUE_READ_TIMEOUT_MS,
              "Hedge account read timed out",
            );
            if (inputs.executeLive && !executionIsCurrent()) return;
          }
        }
      }
      if (paperState) {
        const virtualPortfolio = (
          role: "maker" | "hedge",
          base: PortfolioSnapshot,
        ) => {
          const positions = config!.markets.map((configuredMarket) => {
            const existing = base.positions.find(
              (position) => position.marketId === configuredMarket.marketId,
            );
            const estimated = paperState.positions.find(
              (position) =>
                position.role === role &&
                position.marketId === configuredMarket.marketId,
            );
            // A synthetic Paper fill replaces venue inventory only for the
            // same market. Otherwise retain a real venue position (and its
            // margin/liquidation fields) exactly as reported.
            if (!estimated && existing) return existing;
            return {
              ...(existing ?? {
                marketId: configuredMarket.marketId,
                baseAssetAmount: 0,
                pendingOrderCount: 0,
                inventoryUsd: 0,
                unrealizedPnlUsd: 0,
                collateralUsd: 0,
                freeMarginUsd: 0,
                makerOrderIds: [],
                hasPosition: false,
              }),
              inventoryUsd: estimated?.inventoryUsd ?? 0,
              unrealizedPnlUsd: 0,
              pendingOrderCount: 0,
              makerOrderIds: [],
              hasPosition: Boolean(estimated),
              simulated: Boolean(estimated),
            };
          });
          return {
            ...base,
            positions,
            grossExposureUsd: positions.reduce(
              (total, position) => total + Math.abs(position.inventoryUsd),
              0,
            ),
            unrealizedPnlUsd: 0,
          };
        };
        portfolio = virtualPortfolio("maker", portfolio);
        hedgeRiskPortfolio = config.hedge.enabled
          ? virtualPortfolio("hedge", hedgeRiskPortfolio ?? emptyPortfolio())
          : emptyPortfolio();
      }
      const combinedEquityUsd =
        portfolio.equityUsd + (hedgeRiskPortfolio?.equityUsd ?? 0);
      const combinedGrossExposureUsd =
        portfolio.grossExposureUsd +
        (hedgeRiskPortfolio?.grossExposureUsd ?? 0);
      const combinedUnrealizedPnlUsd =
        portfolio.unrealizedPnlUsd +
        (hedgeRiskPortfolio?.unrealizedPnlUsd ?? 0);
      const bundleInventoryPositions = [
        ...portfolio.positions.map((position) => ({
          marketId: position.marketId,
          symbol:
            config!.markets.find(
              (market) => market.marketId === position.marketId,
            )?.symbol ?? position.marketId.slice(0, 10),
          account: "Maker" as const,
          inventoryUsd: position.inventoryUsd,
        })),
        ...(hedgeRiskPortfolio?.positions ?? []).map((position) => ({
          marketId: position.marketId,
          symbol:
            config!.markets.find(
              (market) => market.marketId === position.marketId,
            )?.symbol ?? position.marketId.slice(0, 10),
          account: "Hedge" as const,
          inventoryUsd: position.inventoryUsd,
        })),
      ].filter((position) => Math.abs(position.inventoryUsd) > 0.000001);
      if (setup && account?.agentCapId && agent) {
        this.runPeakEquityUsd = Math.max(
          this.runPeakEquityUsd ?? combinedEquityUsd,
          combinedEquityUsd,
        );
      }
      const runDrawdownUsd = Math.max(
        0,
        (this.runPeakEquityUsd ?? combinedEquityUsd) - combinedEquityUsd,
      );

      if (
        liveExecution &&
        config.hedge.enabled &&
        setup &&
        account?.agentCapId &&
        agent &&
        this.options.masterKey
      ) {
        const pendingMarketIds = await this.pendingHedgeMarketIds({
          makerSetup: setup,
          agentAddress: agent.address,
        });
        if (pendingMarketIds.length) {
          const signer = loadAgentKeypair({
            masterKey: this.options.masterKey,
            context: agent.encryptionContext,
            encryptedSecret: agent.encryptedSecret,
          });
          for (const marketId of pendingMarketIds) {
            const pendingMarket = config.markets.find(
              (candidate) => candidate.marketId === marketId,
            );
            if (!pendingMarket) continue;
            const hedgeReady = await this.reconcileHedge({
              config,
              marketConfig: resolveMarketConfig(config, pendingMarket),
              selected: pendingMarket,
              makerSetup: setup,
              agentAddress: agent.address,
              signer,
              makerPortfolio: portfolio,
              executionIsCurrent,
            });
            hedgeReconciliationCompleted = true;
            if (!hedgeReady) {
              this.snapshotValue.lastSuccessfulCycleAt =
                new Date().toISOString();
              return;
            }
          }
        }
      }

      if (
        liveExecution &&
        config.autoRebalanceEnabled &&
        setup &&
        account?.agentCapId &&
        agent &&
        this.options.masterKey
      ) {
        const signer = loadAgentKeypair({
          masterKey: this.options.masterKey,
          context: agent.encryptionContext,
          encryptedSecret: agent.encryptedSecret,
        });
        const rebalanced = await this.autoRebalanceIfNeeded({
          config,
          makerSetup: setup,
          agentAddress: agent.address,
          signer,
          makerPortfolio: portfolio,
          hedgePortfolio: hedgeRiskPortfolio,
        });
        if (rebalanced) {
          this.snapshotValue.lastSuccessfulCycleAt = new Date().toISOString();
          return;
        }
      }

      if (switchFromMarketId) {
        const priorMarket = config.markets.find(
          (candidate) => candidate.marketId === switchFromMarketId,
        );
        if (!priorMarket || !setup || !agent || !this.options.masterKey) {
          throw new Error("Single-slot rotation lost its active-market state");
        }
        const signer = loadAgentKeypair({
          masterKey: this.options.masterKey,
          context: agent.encryptionContext,
          encryptedSecret: agent.encryptedSecret,
        });
        if (config.strategyObjective === "volume" && config.flattenOnRotate) {
          // Never submit a taker close against an owner's resting Maker
          // order.  Confirm the cancel first, then reuse the paired
          // reduce-only flattener with this one market as its scope.
          const cancelled = await this.cancelOpenOrders(config, {
            attempts: 3,
            retryDelayMs: 750,
            marketIds: [switchFromMarketId],
          });
          if (!cancelled) {
            throw new Error(
              "Volume rotation could not confirm Maker cancellation",
            );
          }
          this.clearActiveQuoteState();
          await this.autoRebalanceIfNeeded({
            config: {
              ...config,
              markets: [priorMarket],
              autoRebalanceEnabled: true,
              rebalanceGrossExposureUsd: 0,
            },
            makerSetup: setup,
            agentAddress: agent.address,
            signer,
            makerPortfolio: portfolio,
            hedgePortfolio: hedgeRiskPortfolio,
          });
          switchFromMarketId = null;
        }
        const hedgeReady = await this.reconcileHedge({
          config,
          marketConfig: resolveMarketConfig(config, priorMarket),
          selected: priorMarket,
          makerSetup: setup,
          agentAddress: agent.address,
          signer,
          makerPortfolio: portfolio,
          executionIsCurrent,
        });
        hedgeReconciliationCompleted = true;
        if (this.activeQuoteMarketId === null) switchFromMarketId = null;
        if (!hedgeReady) {
          this.snapshotValue.lastSuccessfulCycleAt = new Date().toISOString();
          return;
        }
      }

      const position = portfolio.positions.find(
        (item) => item.marketId === selected!.marketId,
      );
      const inventoryUsd = position?.inventoryUsd ?? 0;
      const marketPnlUsd = position?.unrealizedPnlUsd ?? 0;
      const observedAt = new Date();
      const updatedAt = observedAt.toISOString();
      const book =
        Array.isArray(orderbook.bids) && Array.isArray(orderbook.asks)
          ? {
              bids: snapshotBookLevels(orderbook.bids),
              asks: snapshotBookLevels(orderbook.asks),
              observedAt: updatedAt,
            }
          : null;
      const twoSidedQuote = buildQuoteIntent({
        config: marketConfig,
        observation: {
          marketId: selected.marketId,
          bestBid,
          bestAsk,
          indexPrice: market.indexPrice,
          tickSize: market.tickSize(),
          observedAt,
        },
        inventoryUsd,
        unrealizedPnlUsd: combinedUnrealizedPnlUsd,
      });
      let quote = twoSidedQuote;
      let reducingOnly = false;
      let holdNewExposure = false;
      const activeConfig = config;
      const portfolioRiskFor = (intent: QuoteIntent) =>
        aggregatePortfolioQuoteRisk(
          activeConfig.markets.map((configuredMarket) => {
            const configuredPosition = portfolio.positions.find(
              (item) => item.marketId === configuredMarket.marketId,
            );
            const effective = resolveMarketConfig(
              activeConfig,
              configuredMarket,
            );
            return {
              inventoryUsd: configuredPosition?.inventoryUsd ?? 0,
              restingQuoteSizeUsd:
                configuredMarket.marketId === selected!.marketId ||
                activeConfig.rotationMode === "portfolio"
                  ? configuredMarket.marketId === selected!.marketId
                    ? intent.sizeUsd
                    : effective.quoteSizeUsd
                  : configuredPosition?.makerOrderIds.length
                    ? effective.quoteSizeUsd
                    : 0,
              maxLeverage: effective.maxLeverage,
              ...(configuredMarket.marketId === selected!.marketId
                ? { restingQuoteSides: intent.sides }
                : {}),
            };
          }),
        );
      const configuredMarketIds = new Set(
        activeConfig.markets.map((market) => market.marketId),
      );
      const unselectedGrossExposureUsd = portfolio.positions
        .filter((item) => !configuredMarketIds.has(item.marketId))
        .reduce((sum, item) => sum + Math.abs(item.inventoryUsd), 0);
      // Exposure is a bundle state, never a property of the market selected
      // this rotation.  Model every configured market as two-sided here.
      const bundleQuoteRisk = aggregatePortfolioQuoteRisk(
        activeConfig.markets.map((configuredMarket) => {
          const configuredPosition = portfolio.positions.find(
            (item) => item.marketId === configuredMarket.marketId,
          );
          const effective = resolveMarketConfig(activeConfig, configuredMarket);
          return {
            inventoryUsd: configuredPosition?.inventoryUsd ?? 0,
            restingQuoteSizeUsd: effective.quoteSizeUsd,
            restingQuoteSides: "both" as const,
            maxLeverage: effective.maxLeverage,
          };
        }),
      );
      const largestBundleQuoteUsd = Math.max(
        0,
        ...activeConfig.markets.map(
          (configuredMarket) =>
            resolveMarketConfig(activeConfig, configuredMarket).quoteSizeUsd,
        ),
      );
      const bundleWorstCaseGrossExposureUsd =
        bundleQuoteRisk.worstCaseGrossExposureUsd +
        unselectedGrossExposureUsd +
        (hedgeRiskPortfolio?.grossExposureUsd ?? 0);
      const exposureWasPaused =
        this.snapshotValue.paperBlocker?.code === "gross-exposure" ||
        this.paperSimulationBlockerKey === `${paperTrialId}:gross-exposure`;
      const bundleHasInventory =
        portfolio.positions.some(
          (position) => Math.abs(position.inventoryUsd) > 0.000001,
        ) ||
        (paperState?.positions.some(
          (position) => Math.abs(position.inventoryUsd) > 0.000001,
        ) ??
          false) ||
        (hedgeRiskPortfolio?.positions.some(
          (position) => Math.abs(position.inventoryUsd) > 0.000001,
        ) ??
          false);
      const exposurePaused = exposureWasPaused
        ? bundleHasInventory &&
          bundleWorstCaseGrossExposureUsd >
            activeConfig.maxGrossExposureUsd - largestBundleQuoteUsd
        : bundleWorstCaseGrossExposureUsd > activeConfig.maxGrossExposureUsd;
      const hedgeCollateralRequirement =
        requiredHedgeCollateralUsd(activeConfig);
      const hedgeSharesMakerAccount =
        activeConfig.hedge.enabled &&
        activeConfig.hedge.accountId === activeConfig.makerAccountId;
      const safetyFor = (intent: QuoteIntent) =>
        evaluateQuoteSafety({
          config: marketConfig,
          quote: intent,
          now: new Date(),
          setupComplete: Boolean(setup && account?.agentCapId && agent),
          // Paper needs the authorized agent address to build and dry-run the
          // transaction, not its private signing material.
          hasAgentKey: Boolean(
            agent && (activeConfig.mode === "paper" || this.options.masterKey),
          ),
          liveEnabled: this.options.liveEnabled,
          mainnetAllowed: this.options.mainnetAllowed,
          portfolioGrossExposureUsd: combinedGrossExposureUsd,
          portfolioWorstCaseExposureUsd: bundleWorstCaseGrossExposureUsd,
          portfolioAvailableCollateralUsd: portfolio.availableCollateralUsd,
          portfolioRequiredQuoteCollateralUsd:
            activeConfig.mode === "paper"
              ? Math.max(
                  portfolioRiskFor(intent).requiredQuoteCollateralUsd,
                  requiredMakerCollateralUsd(activeConfig),
                ) + (hedgeSharesMakerAccount ? hedgeCollateralRequirement : 0)
              : portfolioRiskFor(intent).requiredQuoteCollateralUsd,
          agentGasSui: portfolio.gasSui,
          runDrawdownUsd,
        });
      let safety = safetyFor(quote);
      const originalGrossCheck = exposurePaused
        ? {
            code: "gross-exposure" as const,
            label: "Gross exposure",
            ok: false,
            scope: "bundle" as const,
            detail: `$${bundleWorstCaseGrossExposureUsd.toFixed(2)} after one fill; limit $${activeConfig.maxGrossExposureUsd.toFixed(2)}`,
          }
        : undefined;
      if (originalGrossCheck) safety = [...safety, originalGrossCheck];
      const reduceOnlyRequired = safety.some(
        (check) =>
          !check.ok &&
          (check.code === "inventory" || check.code === "gross-exposure"),
      );
      if (reduceOnlyRequired) {
        const reduceOnly = reduceOnlyQuoteIntent({
          quote,
          inventoryUsd,
          targetUsd: marketConfig.inventoryTargetUsd,
        });
        if (reduceOnly) {
          quote = reduceOnly;
          reducingOnly = true;
          safety = safetyFor(quote).map((check) =>
            check.code === "inventory" || check.code === "gross-exposure"
              ? { ...check, ok: true, detail: `${check.detail}; reducing only` }
              : check,
          );
        } else {
          // A flat market cannot reduce bundle risk. Do not post a new quote
          // while another market is bringing the bundle back below its cap.
          holdNewExposure = true;
        }
      }
      const portfolioQuoteRisk = portfolioRiskFor(quote);
      const marketSymbols = new Map(
        config.markets.map((configuredMarket) => [
          configuredMarket.marketId,
          configuredMarket.symbol,
        ]),
      );
      const thresholdForMarket = (marketId: string) => {
        const configuredMarket = activeConfig.markets.find(
          (candidate) => candidate.marketId === marketId,
        );
        const summary = this.markets.find((item) => item.id === marketId);
        const effective = configuredMarket
          ? resolveMarketConfig(activeConfig, configuredMarket)
          : activeConfig;
        return marketRiskThresholds({
          effectiveLeverage: effective.maxLeverage,
          maintenanceMarginRatio: summary?.maintenanceMarginRatio ?? 0,
        });
      };
      safety.push(
        ...accountRiskChecks(
          "Maker",
          portfolio,
          marketSymbols,
          thresholdForMarket,
        ),
      );
      if (config.hedge.enabled) {
        if (config.mode === "paper" && !hedgeSharesMakerAccount) {
          safety.push({
            code: "hedge-collateral",
            label: "Hedge collateral",
            ok:
              hedgeRiskPortfolio !== null &&
              hedgeRiskPortfolio.availableCollateralUsd >=
                hedgeCollateralRequirement,
            scope: "bundle",
            detail: `Hedge account requires $${hedgeCollateralRequirement.toFixed(2)} free`,
          });
        }
        safety.push(
          ...accountRiskChecks(
            "Hedge",
            hedgeRiskPortfolio,
            marketSymbols,
            thresholdForMarket,
          ),
        );
      }
      const summary = this.markets.find(
        (item) => item.id === selected!.marketId,
      );
      const openInterestBase = Math.abs(market.marketState.openInterest);
      const maxOpenInterestBase = market.marketParams.maxOpenInterest;

      if (inputs.executeLive && !executionIsCurrent()) return;

      this.snapshotValue = {
        ...this.snapshotValue,
        mode: config.mode,
        cycle: this.snapshotValue.cycle + 1,
        lastCycleAt: updatedAt,
        lastError:
          config.mode === "paper"
            ? (this.snapshotValue.paperBlocker?.message ?? null)
            : null,
        setupComplete: Boolean(setup && account?.agentCapId && agent),
        agentAddress: agent?.address ?? null,
        accountId: setup?.accountId ?? null,
        market: {
          id: selected.marketId,
          symbol: market.metadata?.symbol ?? selected.symbol,
          indexPrice: market.indexPrice,
          bestBid,
          bestAsk,
          updatedAt,
          book,
        },
        risk: {
          runDrawdownUsd:
            setup && account?.agentCapId && agent ? runDrawdownUsd : null,
          runHighEquityUsd:
            setup && account?.agentCapId && agent
              ? this.runPeakEquityUsd
              : null,
          measuredAt: setup && account?.agentCapId && agent ? updatedAt : null,
        },
        restingQuoteMarketIds:
          config.mode === "live" && setup
            ? confirmedRestingMarketIds(
                portfolio.positions,
                this.store.listTrackedMakerOrders({
                  accountId: setup.accountId,
                }),
              )
            : [],
        restingQuoteVerifiedAt:
          config.mode === "live" && setup ? portfolio.markedAt : null,
        markets: this.snapshotValue.markets.map((row) => {
          const rowPosition = portfolio.positions.find(
            (item) => item.marketId === row.id,
          );
          if (row.id !== selected!.marketId) {
            return {
              ...row,
              inventoryUsd: rowPosition?.inventoryUsd ?? row.inventoryUsd,
              unrealizedPnlUsd:
                rowPosition?.unrealizedPnlUsd ?? row.unrealizedPnlUsd,
            };
          }
          return {
            ...row,
            symbol: market.metadata?.symbol ?? selected!.symbol,
            status: "healthy",
            indexPrice: market.indexPrice,
            bestBid,
            bestAsk,
            reason: "close",
            openInterestBase,
            openInterestUsd: openInterestBase * market.indexPrice,
            openInterestUtilizationPct:
              maxOpenInterestBase > 0
                ? (openInterestBase / maxOpenInterestBase) * 100
                : null,
            volume24hUsd: summary?.volume24hUsd ?? row.volume24hUsd,
            fundingRate: market.estimatedFundingRate(),
            inventoryUsd,
            unrealizedPnlUsd: marketPnlUsd,
            bidPrice: quote.bidPrice,
            askPrice: quote.askPrice,
            updatedAt,
            error: reducingOnly
              ? `Reducing: quoting the ${quote.sides} to bring inventory from $${inventoryUsd.toFixed(2)} back to $${marketConfig.inventoryTargetUsd.toFixed(2)}.`
              : holdNewExposure
                ? "Paused new exposure until bundle inventory is reduced."
                : null,
          };
        }),
        portfolio: {
          selectedMarkets: config.markets.length,
          grossExposureUsd: combinedGrossExposureUsd,
          unrealizedPnlUsd: combinedUnrealizedPnlUsd,
          availableCollateralUsd: setup
            ? portfolio.availableCollateralUsd
            : null,
          allocatedCollateralUsd: setup
            ? portfolio.allocatedCollateralUsd
            : null,
          freeMarginUsd: setup ? portfolio.freeMarginUsd : null,
          withdrawableCollateralUsd: setup
            ? portfolio.withdrawableCollateralUsd
            : null,
        },
        balances: {
          ...this.snapshotValue.balances,
          equityUsd: setup ? combinedEquityUsd : null,
          inventoryUsd,
          unrealizedPnlUsd: combinedUnrealizedPnlUsd,
          gasSui: setup ? portfolio.gasSui : null,
        },
        inventory: {
          netUsd: bundleInventoryPositions.reduce(
            (total, position) => total + position.inventoryUsd,
            0,
          ),
          grossUsd: bundleInventoryPositions.reduce(
            (total, position) => total + Math.abs(position.inventoryUsd),
            0,
          ),
          positions: bundleInventoryPositions,
        },
        fillSequence:
          (paperState?.fills ?? 0) +
          this.store.getExecutionStats().confirmedLiveQuotes,
        hedge: {
          ...this.snapshotValue.hedge,
          enabled: config.hedge.enabled,
          state: config.hedge.enabled
            ? this.snapshotValue.hedge.state === "off"
              ? "waiting"
              : this.snapshotValue.hedge.state
            : "off",
          accountId: config.hedge.accountId,
          error: config.hedge.enabled ? this.snapshotValue.hedge.error : null,
        },
        paper: paperState
          ? paperSnapshot(paperState)
          : {
              estimated: false,
              openOrders: 0,
              fills: 0,
              hedges: 0,
              makerInventoryUsd: 0,
              hedgeInventoryUsd: 0,
              grossExposureUsd: 0,
            },
        quote,
        safety,
      };

      if (config.mode === "observe") {
        this.snapshotValue.lastSuccessfulCycleAt = updatedAt;
        return;
      }

      const failedMarketSafety = safety.filter(
        (check) => !check.ok && check.scope === "market",
      );
      // One bundle-wide state with hysteresis (exposurePaused above), never the
      // market that happens to be selected this cycle.
      const bundleName = this.store.bundleId
        ? (this.store.getStoredBundle(this.store.bundleId)?.name ?? "Maker")
        : "Core";
      const exposureBlocker = exposurePaused
        ? {
            code: "gross-exposure",
            requiredUsd: bundleWorstCaseGrossExposureUsd,
            message: `${bundleName}: Paper paused new exposure. One more fill could take gross exposure to $${bundleWorstCaseGrossExposureUsd.toFixed(2)}, over the $${activeConfig.maxGrossExposureUsd.toFixed(2)} limit. Maker quotes only the sides that reduce inventory until it's back under. Raise the limit in Strategy, or quote fewer markets.`,
          }
        : null;
      if (exposurePaused) this.paperExposurePausedAt ??= Date.now();
      else this.paperExposurePausedAt = null;
      if (
        config.mode === "paper" &&
        inputs.executeLive &&
        !exposureBlocker &&
        this.snapshotValue.paperBlocker?.code === "gross-exposure"
      ) {
        this.clearPaperSimulationBlocker();
      }
      if (config.mode === "paper" && inputs.executeLive && exposureBlocker) {
        this.recordPaperSimulationBlocker({
          blocker: exposureBlocker,
          selected,
          updatedAt,
          trialId: paperTrialId,
        });
        const pausedForMs =
          Date.now() - (this.paperExposurePausedAt ?? Date.now());
        if (
          config.unwindAfterPauseMinutes > 0 &&
          pausedForMs >= config.unwindAfterPauseMinutes * 60_000 &&
          paperState?.positions.length
        ) {
          const largest = [...paperState.positions].sort(
            (left, right) =>
              Math.abs(right.inventoryUsd) - Math.abs(left.inventoryUsd),
          )[0]!;
          const closed = this.store.closePaperMarket({
            trialId: paperTrialId,
            marketId: largest.marketId,
            bestBid,
            bestAsk,
            reason: "unwind",
          });
          if (closed.length) {
            this.store.logEvent({
              category: "paper",
              action: "exposure-unwind",
              outcome: "estimated",
              detail: {
                trialId: paperTrialId,
                marketId: largest.marketId,
                symbol: largest.symbol,
                sizeUsd: Math.abs(largest.inventoryUsd),
              },
            });
            this.snapshotValue.execution.lastDecision = "rebalanced";
          }
        }
      }
      if (holdNewExposure) {
        if (config.mode === "paper" && inputs.executeLive && exposureBlocker) {
          this.recordPaperSimulationBlocker({
            blocker: exposureBlocker,
            selected,
            updatedAt,
            trialId: paperTrialId,
          });
        }
        this.snapshotValue.execution.lastDecision = "held";
        this.snapshotValue.lastSuccessfulCycleAt = updatedAt;
        return;
      }
      if (
        config.mode === "paper" &&
        config.strategyObjective === "volume" &&
        this.paperVolumeFees?.utcDate !== new Date().toISOString().slice(0, 10)
      ) {
        this.paperVolumeFees = {
          utcDate: new Date().toISOString().slice(0, 10),
          usd: 0,
          warned: false,
        };
      }
      if (
        config.mode === "paper" &&
        config.strategyObjective === "volume" &&
        this.paperVolumeFees?.usd !== undefined &&
        this.paperVolumeFees.usd >= config.dailyFeeBudgetUsd
      ) {
        if (!this.paperVolumeFees.warned) {
          this.store.logEvent({
            category: "paper",
            action: "volume-fee-budget",
            outcome: "warning",
            detail: {
              trialId: paperTrialId,
              estimatedFeesUsd: this.paperVolumeFees.usd,
              dailyFeeBudgetUsd: config.dailyFeeBudgetUsd,
              resumesAt: "00:00 UTC",
            },
          });
          this.paperVolumeFees.warned = true;
        }
        this.snapshotValue.markets = this.snapshotValue.markets.map((row) =>
          row.id === selected!.marketId
            ? {
                ...row,
                error:
                  "Volume paused: daily fee budget reached; resumes at 00:00 UTC.",
              }
            : row,
        );
        this.snapshotValue.execution.lastDecision = "held";
        this.snapshotValue.lastSuccessfulCycleAt = updatedAt;
        return;
      }
      const admission = await this.options.admitBundleProposal?.({
        worstCaseGrossExposureDeltaUsd:
          quote.sizeUsd * marketConfig.maxLeverage,
        worstCaseInventoryDeltaUsd: quote.sizeUsd,
        worstCaseUnrealizedLossDeltaUsd: quote.sizeUsd,
        worstCaseRunDrawdownDeltaUsd: quote.sizeUsd,
      });
      if (inputs.executeLive && !executionIsCurrent()) return;
      if (admission && !admission.accepted) {
        this.store.logEvent({
          category: "risk",
          action: "wallet-limit",
          outcome: "rejected",
          detail: { reason: admission.reason, marketId: selected.marketId },
        });
        this.snapshotValue.lastSuccessfulCycleAt = updatedAt;
        return;
      }

      if (config.mode === "paper") {
        if (!inputs.executeLive) {
          this.snapshotValue.lastSuccessfulCycleAt = updatedAt;
          return;
        }
        if (!executionIsCurrent()) return;

        if (exposureBlocker) {
          this.recordPaperSimulationBlocker({
            blocker: exposureBlocker,
            selected,
            updatedAt,
            trialId: paperTrialId,
          });
        }

        // Paper continues to read the market when it cannot dry-run a quote.
        // A missing key, gas, or safety condition is useful setup feedback, not
        // an execution failure that should pause a bundle and hide the next book.
        const blocker = paperSimulationBlocker({
          setup,
          account,
          agent,
          safety: safety.filter((check) => check.scope === "bundle"),
          symbol: market.metadata?.symbol ?? selected.symbol,
          requiredGasSui: config.maxGasMist / 1_000_000_000,
          observedAt: portfolio.markedAt,
          ...(config.hedge.enabled && config.hedge.accountId
            ? {
                hedgeCollateral: {
                  accountId: config.hedge.accountId,
                  availableUsd: hedgeRiskPortfolio?.availableCollateralUsd ?? 0,
                  requiredUsd: hedgeCollateralRequirement,
                  maxOrderUsd: config.hedge.maxOrderUsd,
                  leverage: lowestEffectiveHedgeLeverage(config),
                  observedAt:
                    hedgeRiskPortfolio?.markedAt ?? portfolio.markedAt,
                },
              }
            : {}),
          collateral: {
            availableUsd: portfolio.availableCollateralUsd,
            requiredUsd: Math.max(
              portfolioQuoteRisk.requiredQuoteCollateralUsd,
              requiredMakerCollateralUsd(config),
            ),
            concurrentMarkets:
              config.rotationMode === "single-slot" ? 1 : config.markets.length,
            quoteSizeUsd: quote.sizeUsd,
            leverage: marketConfig.maxLeverage,
            observedAt: portfolio.markedAt,
          },
        });
        if (blocker) {
          // Bundle readiness is evaluated before a market-local safety skip.
          // A fair-value pause must never hide a missing collateral, key, or
          // gas fix from the Paper card.
          if (failedMarketSafety.length) {
            this.recordPaperMarketSkip({
              selected,
              failed: failedMarketSafety[0]!,
              config,
            });
          }
          this.recordPaperSimulationBlocker({
            blocker,
            selected,
            updatedAt,
            trialId: paperTrialId,
          });
          return;
        }

        if (failedMarketSafety.length) {
          this.recordPaperMarketSkip({
            selected,
            failed: failedMarketSafety[0]!,
            config,
          });
          this.snapshotValue.execution.lastDecision = "held";
          this.snapshotValue.lastSuccessfulCycleAt = updatedAt;
          return;
        }
        this.clearPaperMarketSkip(selected);

        let receipt: { endpoint: string; gasUsedMist: number };
        try {
          receipt = await withTimeout(
            this.gateway.simulateQuote({
              setup: setup!,
              config: marketConfig,
              quote,
              agentAddress: agent!.address,
              builderCode: this.options.builderCode(),
              shouldContinue: executionIsCurrent,
            }),
            VENUE_READ_TIMEOUT_MS,
            "Paper simulation read timed out",
          );
        } catch (error) {
          if (!executionIsCurrent()) return;
          const errorText = message(error);
          const gasRelated = /(?:gas|sui balance|insufficient funds)/i.test(
            errorText,
          );
          this.recordPaperSimulationBlocker({
            blocker: {
              code: gasRelated ? "gas" : "dry-run",
              ...(gasRelated
                ? {
                    accountId: setup!.accountId,
                    agentAddress: agent!.address,
                    requiredGasSui: config.maxGasMist / 1_000_000_000,
                  }
                : {}),
              observedAt: portfolio.markedAt,
              message: gasRelated
                ? `Paper is waiting on gas. The trading key for account ${setup!.accountId} needs ${formatSui(config.maxGasMist / 1_000_000_000)} SUI to simulate.`
                : `Paper couldn't dry-run ${market.metadata?.symbol ?? selected.symbol}. Check the trading key and market conditions, then try again; Maker will keep reading the market.`,
            },
            selected,
            updatedAt,
            trialId: paperTrialId,
          });
          return;
        }
        if (!executionIsCurrent()) return;
        this.store.recordPaperQuote({
          trialId: paperTrialId,
          marketId: selected.marketId,
          symbol: market.metadata?.symbol ?? selected.symbol,
          bidPrice: quote.bidPrice,
          askPrice: quote.askPrice,
          sizeUsd: quote.sizeUsd,
          sides: quote.sides,
        });
        this.paperAllSkippedSince = null;
        this.paperAllSkippedWarningLogged = false;
        this.store.logExecution({
          mode: "paper",
          marketId: selected.marketId,
          endpoint: receipt.endpoint,
          bidPrice: quote.bidPrice,
          askPrice: quote.askPrice,
          sizeUsd: quote.sizeUsd,
          outcome: "dry-run",
          gasUsedMist: receipt.gasUsedMist,
          suiUsd: this.suiUsd,
        });
        if (!exposureBlocker) this.clearPaperSimulationBlocker();
        this.snapshotValue.execution.lastDecision = "quoted";
        this.snapshotValue.lastSuccessfulCycleAt = updatedAt;
        return;
      }

      if (!inputs.executeLive) {
        this.snapshotValue.lastSuccessfulCycleAt = updatedAt;
        return;
      }

      if (!executionIsCurrent()) return;

      if (!this.options.liveEnabled || !this.options.mainnetAllowed) {
        assertSafe(safety);
      }
      if (!setup || !agent || !this.options.masterKey) {
        throw new Error("Live signer state is incomplete");
      }
      const signer = loadAgentKeypair({
        masterKey: this.options.masterKey,
        context: agent.encryptionContext,
        encryptedSecret: agent.encryptedSecret,
      });
      // Live follows the same deliberately slow recovery path as Paper: once
      // the pause has persisted, cancel our resting Maker quotes first, then
      // reduce the largest position in one market.  This branch is reachable
      // only after the existing Live gates and signer checks above.
      if (
        exposurePaused &&
        config.unwindAfterPauseMinutes > 0 &&
        Date.now() - (this.paperExposurePausedAt ?? Date.now()) >=
          config.unwindAfterPauseMinutes * 60_000
      ) {
        const largest = [
          ...portfolio.positions,
          ...(hedgeRiskPortfolio?.positions ?? []),
        ]
          .filter((position) => Math.abs(position.inventoryUsd) > 0.000001)
          .sort(
            (left, right) =>
              Math.abs(right.inventoryUsd) - Math.abs(left.inventoryUsd),
          )[0];
        if (largest) {
          const cancelled = await this.cancelOpenOrders(config, {
            attempts: 3,
            retryDelayMs: 750,
            marketIds: [largest.marketId],
          });
          if (!cancelled)
            throw new Error(
              "Exposure unwind could not confirm Maker order cancellation",
            );
          this.clearActiveQuoteState();
          const accounts = [setup];
          const hedgeSetup =
            config.hedge.enabled && config.hedge.accountId
              ? this.store.getAccountSetup(config.hedge.accountId)
              : null;
          if (
            hedgeSetup?.agentCapId &&
            hedgeSetup.accountId !== setup.accountId
          )
            accounts.push(hedgeSetup);
          for (const unwindSetup of accounts) {
            const receipt = await this.gateway.flattenPositions({
              setup: unwindSetup,
              config,
              signer,
              marketIds: [largest.marketId],
              maxSlippage: config.hedge.maxSlippageBps / 10_000,
            });
            if (!receipt) continue;
            this.store.logExecution({
              mode: "live",
              marketId: largest.marketId,
              digest: receipt.digest,
              endpoint: receipt.endpoint,
              bidPrice: 0,
              askPrice: 0,
              sizeUsd: Math.abs(largest.inventoryUsd),
              outcome: "exposure-unwind",
              gasUsedMist: receipt.gasUsedMist,
              suiUsd: this.suiUsd,
            });
          }
          this.store.logEvent({
            category: "risk",
            action: "exposure-unwind",
            outcome: "confirmed",
            detail: {
              marketId: largest.marketId,
              sizeUsd: Math.abs(largest.inventoryUsd),
            },
          });
          this.snapshotValue.execution.lastDecision = "rebalanced";
          this.snapshotValue.lastSuccessfulCycleAt = updatedAt;
          return;
        }
      }
      const hedgeReadyForQuotes = await this.reconcileHedge({
        config,
        marketConfig,
        selected,
        makerSetup: setup,
        agentAddress: agent.address,
        signer,
        makerPortfolio: portfolio,
        executionIsCurrent,
      });
      hedgeReconciliationCompleted = true;
      if (!executionIsCurrent()) return;
      if (!hedgeReadyForQuotes) {
        this.snapshotValue.lastSuccessfulCycleAt = new Date().toISOString();
        return;
      }
      // A market condition (book away from fair value, stale or crossed book,
      // size or inventory for this one market) is routine, exactly as in
      // Paper: pull our quotes from this market and keep the bundle running.
      // Only bundle-wide failures stop it.
      const liveMarketFailures = safety.filter(
        (check) => !check.ok && check.scope === "market",
      );
      const liveBundleFailures = safety.filter(
        (check) => !check.ok && check.scope !== "market",
      );
      if (liveMarketFailures.length && !liveBundleFailures.length) {
        const resting = portfolio.positions.find(
          (position) => position.marketId === selected!.marketId,
        );
        if (resting?.makerOrderIds.length) {
          const cancelled = await this.cancelOpenOrders(config, {
            attempts: 3,
            retryDelayMs: 750,
            marketIds: [selected.marketId],
          });
          if (!cancelled)
            throw new Error(
              `Could not confirm cancellation of ${selected.symbol} quotes after a ${liveMarketFailures[0]!.code} skip`,
            );
        }
        if (this.activeQuote?.marketId === selected.marketId)
          this.clearActiveQuoteState();
        this.recordPaperMarketSkip({
          selected,
          failed: liveMarketFailures[0]!,
          config,
        });
        this.snapshotValue.execution.lastDecision = "held";
        this.snapshotValue.lastSuccessfulCycleAt = updatedAt;
        return;
      }
      if (!liveMarketFailures.length) this.clearPaperMarketSkip(selected);
      assertSafe(safety);

      const activeQuote = this.activeQuote;
      const sameActiveMarket =
        config.rotationMode === "single-slot" &&
        activeQuote?.marketId === selected.marketId &&
        this.activeQuoteMarketId === selected.marketId;
      if (sameActiveMarket) {
        const bidMoveBps =
          (Math.abs(quote.bidPrice - activeQuote.quote.bidPrice) /
            activeQuote.quote.bidPrice) *
          10_000;
        const askMoveBps =
          (Math.abs(quote.askPrice - activeQuote.quote.askPrice) /
            activeQuote.quote.askPrice) *
          10_000;
        const sizeChanged =
          Math.abs(quote.sizeUsd - activeQuote.quote.sizeUsd) > 0.000_001;
        const restingAgeMs = Date.now() - activeQuote.placedAt;
        if (
          !sizeChanged &&
          Math.max(bidMoveBps, askMoveBps) < config.requoteThresholdBps &&
          restingAgeMs < config.maxRestingMs
        ) {
          this.snapshotValue.quote = activeQuote.quote;
          this.snapshotValue.markets = this.snapshotValue.markets.map((row) =>
            row.id === selected!.marketId
              ? {
                  ...row,
                  bidPrice: activeQuote.quote.bidPrice,
                  askPrice: activeQuote.quote.askPrice,
                }
              : row,
          );
          this.snapshotValue.execution.avoidedTransactions += 1;
          this.snapshotValue.execution.lastDecision = "held";
          this.snapshotValue.lastSuccessfulCycleAt = updatedAt;
          return;
        }
      }

      const trackedMakerOrders = this.store
        .listTrackedMakerOrders({ accountId: setup.accountId })
        .filter((order) => order.marketId === selected!.marketId);
      const latestQuoteDigest = trackedMakerOrders[0]?.quoteDigest;
      const knownMakerOrderIds = latestQuoteDigest
        ? trackedMakerOrders
            .filter((order) => order.quoteDigest === latestQuoteDigest)
            .flatMap((order) =>
              /^\d+$/.test(order.orderId) ? [BigInt(order.orderId)] : [],
            )
        : [];
      const switchOrders = switchFromMarketId
        ? this.store
            .listTrackedMakerOrders({ accountId: setup.accountId })
            .filter((order) => order.marketId === switchFromMarketId)
        : [];
      const switchQuoteDigest = switchOrders[0]?.quoteDigest;
      const expectedCancelOrderIds = switchQuoteDigest
        ? switchOrders
            .filter((order) => order.quoteDigest === switchQuoteDigest)
            .flatMap((order) =>
              /^\d+$/.test(order.orderId) ? [BigInt(order.orderId)] : [],
            )
        : [];

      // Atomic cancel-and-place can invalidate all previously observed resting IDs.
      // Require a fresh account read on a later cycle before reporting them.
      this.snapshotValue.restingQuoteMarketIds = [];
      this.snapshotValue.restingQuoteVerifiedAt = null;
      const receipt = await this.gateway.executeQuote({
        setup,
        config: marketConfig,
        quote,
        signer,
        builderCode: this.options.builderCode(),
        shouldContinue: executionIsCurrent,
        knownMakerOrderIds,
        ...(switchFromMarketId
          ? {
              cancelMarketIds: [switchFromMarketId],
              expectedCancelOrderIds: {
                [switchFromMarketId]: expectedCancelOrderIds,
              },
            }
          : {}),
      });
      this.store.logExecution({
        mode: "live",
        marketId: selected.marketId,
        digest: receipt.digest,
        endpoint: receipt.endpoint,
        bidPrice: quote.bidPrice,
        askPrice: quote.askPrice,
        sizeUsd: quote.sizeUsd,
        outcome: "confirmed",
        gasUsedMist: receipt.gasUsedMist,
        suiUsd: this.suiUsd,
      });
      this.store.trackMakerOrders({
        accountId: setup.accountId,
        marketId: selected.marketId,
        quoteDigest: receipt.digest,
        orderIds: receipt.postedOrderIds ?? [],
      });
      if (config.rotationMode === "single-slot") {
        this.activeQuoteMarketId = selected.marketId;
        this.activeQuote = {
          marketId: selected.marketId,
          quote,
          placedAt: Date.now(),
        };
      }
      this.snapshotValue.execution.lastDecision = switchFromMarketId
        ? "switched"
        : "quoted";
      this.snapshotValue.lastSuccessfulCycleAt = new Date().toISOString();
      this.snapshotValue.markets = this.snapshotValue.markets.map((row) =>
        row.id === selected!.marketId
          ? { ...row, lastTransactionDigest: receipt.digest }
          : row,
      );
    } catch (error) {
      const errorText = message(error);
      const cancelled =
        inputs.generation !== this.generation ||
        (config?.mode === "paper" && inputs.cycleToken !== this.cycleToken);
      if (
        !cancelled &&
        error instanceof VenueReadTimeoutError &&
        config?.mode === "paper"
      ) {
        this.snapshotValue.lastError = errorText;
        this.store.logEvent({
          category: "runtime",
          action: "cycle",
          outcome: "timeout",
          detail: {
            error: errorText,
            accountReadAt: this.snapshotValue.accountReadAt,
          },
        });
        return;
      }
      const retryablePostOnlyRace =
        !cancelled &&
        config?.mode === "live" &&
        isPostOnlyWouldMatch(errorText);
      if (retryablePostOnlyRace && config) {
        const retainedQuote = this.activeQuote;
        const cancelledPriorMarket = switchFromMarketId
          ? await this.cancelOpenOrders(config, {
              attempts: 3,
              retryDelayMs: 750,
              marketIds: [switchFromMarketId],
            })
          : true;
        if (cancelledPriorMarket) {
          if (switchFromMarketId) {
            this.clearActiveQuoteState();
            this.marketSelectedAt = Date.now();
            this.snapshotValue.quote = null;
          } else if (
            retainedQuote &&
            retainedQuote.marketId === selected?.marketId
          ) {
            this.snapshotValue.quote = retainedQuote.quote;
          } else {
            this.snapshotValue.quote = null;
          }
          this.snapshotValue.lastError = null;
          if (selected) {
            this.snapshotValue.markets = this.snapshotValue.markets.map(
              (row) =>
                row.id === selected!.marketId
                  ? { ...row, status: "healthy", error: null }
                  : row,
            );
          }
          this.store.logEvent({
            category: "runtime",
            action: "post-only-retry",
            outcome: "retry",
            detail: {
              error: errorText,
              ...(selected ? { marketId: selected.marketId } : {}),
              ...(switchFromMarketId
                ? { cancelledPriorMarketId: switchFromMarketId }
                : {}),
            },
          });
          return;
        }
      }
      if (!cancelled) {
        this.snapshotValue.lastError = errorText;
        if (config?.mode === "paper") {
          const paper = this.store.getPaperState(paperTrialId);
          const makerInventory = selected
            ? (paper.positions.find(
                (position) =>
                  position.role === "maker" &&
                  position.marketId === selected!.marketId,
              )?.inventoryUsd ?? 0)
            : 0;
          const grossExposureUsd = paper.positions.reduce(
            (total, position) => total + Math.abs(position.inventoryUsd),
            0,
          );
          this.snapshotValue.paper = paperSnapshot(paper);
          this.snapshotValue.balances = {
            ...this.snapshotValue.balances,
            inventoryUsd: makerInventory,
          };
          this.snapshotValue.portfolio = {
            ...this.snapshotValue.portfolio,
            grossExposureUsd,
          };
          if (selected) {
            this.snapshotValue.markets = this.snapshotValue.markets.map(
              (row) =>
                row.id === selected!.marketId
                  ? { ...row, inventoryUsd: makerInventory }
                  : row,
            );
          }
        }
        if (config?.hedge.enabled && !hedgeReconciliationCompleted) {
          this.snapshotValue.hedge = {
            ...this.snapshotValue.hedge,
            state: "error",
            error: errorText,
          };
        }
        if (selected) {
          this.snapshotValue.markets = this.snapshotValue.markets.map((row) =>
            row.id === selected!.marketId
              ? { ...row, status: "error", error: errorText }
              : row,
          );
        }
      }
      this.store.logEvent({
        category: "runtime",
        action: "cycle",
        outcome: cancelled ? "cancelled" : "error",
        detail: {
          error: errorText,
          ...(selected ? { marketId: selected.marketId } : {}),
        },
      });
      if (
        !cancelled &&
        (this.snapshotValue.mode === "live" || this.options.pauseOnError)
      ) {
        this.stopScheduling();
        if (config?.mode === "live") {
          const cancelledOrders = await this.cancelOpenOrders(config, {
            attempts: 3,
            retryDelayMs: 2_000,
          });
          if (cancelledOrders) this.clearActiveQuoteState();
        } else if (config?.mode === "paper") {
          this.store.cancelPaperOrders(paperTrialId);
          this.clearActiveQuoteState();
        }
        if (this.options.pauseOnError) {
          await this.options.onBundleError?.(errorText);
        }
      }
    } finally {
      if (
        config?.markets.length &&
        !usesDwellScheduler &&
        (config.mode !== "paper" || inputs.cycleToken === this.cycleToken)
      ) {
        this.marketIndex = (this.marketIndex + 1) % config.markets.length;
      }
    }
  }

  async runPaperTrial(inputs: {
    cadenceMs: number;
  }): Promise<StrategyTrialResult> {
    if (
      this.strategyTrialActive ||
      this.snapshotValue.running ||
      this.cyclePromise
    ) {
      throw new Error("A Paper test run is already in progress");
    }

    const originalConfig = makerConfigSchema.parse(this.store.getConfig());
    const setup = this.store.getSetup();
    const makerAccount = setup
      ? this.store.getAccountSetup(setup.accountId)
      : null;
    const agent = this.store.getAgent();
    if (!setup || !makerAccount?.agentCapId || !agent) {
      throw new Error("A confirmed Maker account and agent are required");
    }
    if (
      originalConfig.hedge.enabled &&
      (!originalConfig.hedge.accountId ||
        !this.store.getAccountSetup(originalConfig.hedge.accountId)?.agentCapId)
    ) {
      throw new Error("The configured hedge account is not authorized");
    }

    const marketIds = originalConfig.markets.map((market) => market.marketId);
    const [farming, profit, both, makerPortfolio] = await Promise.all([
      this.rewardDashboard(setup.collateralCoinType, "farming"),
      this.rewardDashboard(setup.collateralCoinType, "profit"),
      this.rewardDashboard(setup.collateralCoinType, "both"),
      this.venueRead(
        this.gateway.getAgentPortfolioSnapshot({
          setup,
          agentAddress: agent.address,
          marketIds,
        }),
        "Paper trial account read",
      ),
    ]);
    const plan = buildStrategyTrialPlan({
      originalConfig,
      dashboards: { farming, profit, both },
      availableCollateralUsd: makerPortfolio.availableCollateralUsd,
      mode: "paper",
      cadenceMs: inputs.cadenceMs,
    });

    const startedAt = new Date().toISOString();
    const trialId = `trial-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const rounds: StrategyTrialRoundResult[] = [];
    this.strategyTrialActive = true;
    this.paperTrialId = trialId;
    this.generation += 1;
    const trialGeneration = this.generation;
    this.snapshotValue.running = true;
    this.snapshotValue.mode = "paper";
    this.snapshotValue.startedAt = startedAt;
    this.snapshotValue.lastError = null;
    this.runPeakEquityUsd = null;
    this.clearActiveQuoteState();
    this.marketSelectedAt = null;
    this.singleSlotSwept = true;
    this.store.logEvent({
      category: "paper",
      action: "trial.start",
      outcome: "success",
      detail: {
        trialId,
        marketId: plan.marketId,
        objectives: STRATEGY_TRIAL_OBJECTIVES,
        cadenceMs: plan.cadenceMs,
      },
    });

    try {
      for (const round of plan.rounds) {
        if (
          this.generation !== trialGeneration ||
          !this.snapshotValue.running
        ) {
          throw new Error("Paper test run was stopped by the operator");
        }
        this.marketIndex = 0;
        this.snapshotValue.markets = round.config.markets.map((market) =>
          emptyRuntimeMarket(market, round.config),
        );
        this.syncMarketRows(round.config);
        this.snapshotValue.watchdog = {
          state: "idle",
          checkedAt: null,
          maxQuoteAgeMs: null,
        };

        const roundStartedAt = new Date().toISOString();
        await withTimeout(
          this.cycle({
            executeLive: true,
            generation: trialGeneration,
            configOverride: round.config,
            paperTrialId: trialId,
          }),
          30_000,
          "Paper test-run cycle timed out",
        );
        if (this.snapshotValue.lastError) {
          throw new Error(this.snapshotValue.lastError);
        }
        rounds.push({
          objective: round.objective,
          profile: round.profile,
          score: round.score,
          quoteSizeUsd: round.quoteSizeUsd,
          spreadBps: round.spreadBps,
          outcome: "simulated",
          digest: null,
          startedAt: roundStartedAt,
          completedAt: new Date().toISOString(),
        });
        // Each policy gets its own scratch resting orders. This is a ledger
        // operation only; no signer, queue cancellation, or live state changes.
        this.store.cancelPaperOrders(trialId);
        await (this.options.sleep
          ? this.options.sleep(plan.cadenceMs)
          : new Promise((resolve) => setTimeout(resolve, plan.cadenceMs)));
      }

      this.stopScheduling();
      this.store.cancelPaperOrders(trialId);
      this.snapshotValue.mode = originalConfig.mode;
      this.syncMarketRows(originalConfig);
      const completedAt = new Date().toISOString();
      this.store.logEvent({
        category: "paper",
        action: "trial.complete",
        outcome: "success",
        detail: { trialId, marketId: plan.marketId, rounds: rounds.length },
      });
      return {
        mode: "paper",
        marketId: plan.marketId,
        symbol: plan.symbol,
        cadenceMs: plan.cadenceMs,
        startedAt,
        completedAt,
        rounds,
        recovery: null,
        restoredConfig: originalConfig,
      };
    } catch (error) {
      this.stopScheduling();
      this.store.cancelPaperOrders(trialId);
      const errorText = message(error);
      this.store.logEvent({
        category: "paper",
        action: "trial",
        outcome: "error",
        detail: { trialId, error: errorText, rounds: rounds.length },
      });
      throw error;
    } finally {
      this.paperTrialId = null;
      this.strategyTrialActive = false;
    }
  }

  async reconfigure(nextConfig?: MakerConfig): Promise<void> {
    if (this.strategyTrialActive) {
      throw new Error("Strategy configuration is locked during a trial");
    }
    const wasRunning = this.snapshotValue.running;
    await this.stop();
    if (nextConfig) this.store.setConfig(nextConfig);
    this.marketIndex = 0;
    this.clearActiveQuoteState();
    this.marketSelectedAt = null;
    this.singleSlotSwept = false;
    const config = this.store.getConfig();
    if (config) {
      this.snapshotValue.mode = config.mode;
      this.syncMarketRows(config);
    }
    if (wasRunning) this.start();
  }
}
