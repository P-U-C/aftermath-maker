import {
  AftermathGateway,
  isPostOnlyWouldMatch,
  loadAgentKeypair,
  type EndpointHealth,
  type MarketSummary,
  type PerformanceOrder,
  type PortfolioSnapshot,
} from "@puc/aftermath";
import {
  aggregatePortfolioQuoteRisk,
  assertSafe,
  buildQuoteIntent,
  evaluateQuoteSafety,
  makerConfigSchema,
  resolveMarketConfig,
  type BuilderFeePolicy,
  type MakerConfig,
  type MakerMarket,
  type QuoteIntent,
  type RuntimeMarketSnapshot,
  type RuntimeSnapshot,
  type Setup,
} from "@puc/core";
import type { TenantStore } from "./store.js";
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
  };
};

const initialSnapshot = (): RuntimeSnapshot => ({
  mode: "observe",
  running: false,
  cycle: 0,
  startedAt: null,
  lastCycleAt: null,
  lastSuccessfulCycleAt: null,
  lastError: null,
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
  },
  markets: [],
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

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

async function withTimeout<T>(
  task: Promise<T>,
  milliseconds: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(timeoutMessage)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

const MIN_ACCOUNT_MARGIN_RATIO = 0.12;
const MIN_LIQUIDATION_DISTANCE_BPS = 1_000;

function accountRiskChecks(label: string, portfolio: PortfolioSnapshot | null) {
  const positions = portfolio?.positions.filter(
    (position) => position.hasPosition,
  );
  const marginRatios =
    positions?.map((position) => position.marginRatio ?? Number.NaN) ?? [];
  const liquidationDistances =
    positions?.map(
      (position) => position.liquidationDistanceBps ?? Number.NaN,
    ) ?? [];
  return [
    {
      code: `${label.toLowerCase()}-margin`,
      label: `${label} margin`,
      ok:
        portfolio !== null &&
        marginRatios.every(
          (ratio) =>
            Number.isFinite(ratio) && ratio >= MIN_ACCOUNT_MARGIN_RATIO,
        ),
      detail:
        portfolio === null
          ? `${label} account risk is unavailable`
          : positions?.length === 0
            ? "No open positions"
            : `Minimum ${label.toLowerCase()} margin ratio ${(
                Math.min(...marginRatios) * 100
              ).toFixed(1)}%; 12.0% required`,
    },
    {
      code: `${label.toLowerCase()}-liquidation`,
      label: `${label} liquidation distance`,
      ok:
        portfolio !== null &&
        liquidationDistances.every(
          (distance) =>
            Number.isFinite(distance) &&
            distance >= MIN_LIQUIDATION_DISTANCE_BPS,
        ),
      detail:
        portfolio === null
          ? `${label} account risk is unavailable`
          : positions?.length === 0
            ? "No open positions"
            : `Nearest liquidation ${(
                Math.min(...liquidationDistances) / 100
              ).toFixed(1)}% away; 10.0% required`,
    },
  ];
}

export class MakerRuntime {
  private snapshotValue = initialSnapshot();
  private timer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private watchdogTripping = false;
  private generation = 0;
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
      mode: config?.mode ?? "observe",
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
  }

  async listMarkets(collateralCoinType: string): Promise<MarketSummary[]> {
    this.markets = await this.gateway.listMarkets(collateralCoinType);
    const config = this.store.getConfig();
    if (config) this.syncMarketRows(config);
    return this.markets;
  }

  async rewardDashboard(
    collateralCoinType: string,
    objective: MakerConfig["strategyObjective"],
  ) {
    return this.gateway.getRewardDashboard({
      accountIds: this.store
        .listAccountSetups()
        .map((account) => account.accountId),
      collateralCoinType,
      builderFeeBps: (this.options.builderCode()?.integratorFee ?? 0) * 10_000,
      objective,
    });
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
    if (config) {
      const cancelled = await this.cancelOpenOrders(config, {
        attempts: 3,
        retryDelayMs: 2_000,
      });
      if (cancelled) this.clearActiveQuoteState();
    }
    if (!cycleSettled && activeCycle && config) {
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
        fills: [],
        note: "Authorize an agent to begin account and fill reconciliation.",
      };
    }

    const history = await this.gateway.getAccountPerformanceHistory({
      setup,
      agentAddress: agent.address,
      limit: 200,
      timeframe,
      ...(sinceMs === undefined ? {} : { sinceMs }),
    });
    const trackedIds = new Set(
      this.store
        .listTrackedMakerOrders({ accountId: setup.accountId })
        .map((order) => order.orderId),
    );
    const symbols = new Map(
      config?.markets.map((market) => [market.marketId, market.symbol]) ?? [],
    );
    const builderFeeRate = this.options.builderCode()?.integratorFee ?? 0;
    const fills = history.orders
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
        };
      })
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));

    const sum = (selector: (fill: MakerFill) => number) =>
      fills.reduce((total, fill) => total + selector(fill), 0);
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
      const hedgeHistory = await this.gateway.getAccountPerformanceHistory({
        setup: hedgeSetup,
        agentAddress: agent.address,
        limit: 200,
        timeframe,
        ...(sinceMs === undefined ? {} : { sinceMs }),
      });
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

    return {
      asOf: new Date().toISOString(),
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
      fills,
      note: `Maker attribution uses recorded order IDs. Hedge attribution uses confirmed hedge transaction digests. Builder fees are deterministic estimates from filled notional; account metrics come from Aftermath's ${period === "1D" ? "24-hour" : period === "EPOCH" ? "current-epoch" : "all-time"} history.`,
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
    const history = await this.gateway.getAccountPerformanceHistory({
      setup: inputs.makerSetup,
      agentAddress: inputs.agentAddress,
      limit: 200,
    });
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
        });
      }

      flatReads = 0;
      for (let attempt = 1; attempt <= 12; attempt += 1) {
        lastPortfolios = await Promise.all(
          accounts.map((setup) =>
            this.gateway.getAgentPortfolioSnapshot({
              setup,
              agentAddress: inputs.agentAddress,
              marketIds,
            }),
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

    const hedgePortfolio = await this.gateway.getAgentPortfolioSnapshot({
      setup: hedgeAccount,
      agentAddress: inputs.agentAddress,
      marketIds: [inputs.selected.marketId],
    });
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

    const history = await this.gateway.getAccountPerformanceHistory({
      setup: inputs.makerSetup,
      agentAddress: inputs.agentAddress,
      limit: 200,
    });
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
        this.gateway.getAgentPortfolioSnapshot({
          setup: inputs.makerSetup,
          agentAddress: inputs.agentAddress,
          marketIds: [inputs.selected.marketId],
        }),
        this.gateway.getAgentPortfolioSnapshot({
          setup: hedgeAccount,
          agentAddress: inputs.agentAddress,
          marketIds: [inputs.selected.marketId],
        }),
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
        this.gateway.getAgentPortfolioSnapshot({
          setup: inputs.makerSetup,
          agentAddress: inputs.agentAddress,
          marketIds: [inputs.selected.marketId],
        }),
        this.gateway.getAgentPortfolioSnapshot({
          setup: hedgeAccount,
          agentAddress: inputs.agentAddress,
          marketIds: [inputs.selected.marketId],
        }),
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
    inputs: { executeLive?: boolean; generation?: number } = {},
  ): Promise<void> {
    if (this.cyclePromise) return this.cyclePromise;

    const generation = inputs.generation ?? this.generation;
    const task = this.runCycle({
      executeLive: inputs.executeLive ?? false,
      generation,
    });
    this.cyclePromise = task;
    try {
      await task;
    } finally {
      if (this.cyclePromise === task) this.cyclePromise = null;
    }
  }

  private async runCycle(inputs: {
    executeLive: boolean;
    generation: number;
  }): Promise<void> {
    let selected: MakerMarket | null = null;
    let config: MakerConfig | null = null;
    let hedgeReconciliationCompleted = false;
    let switchFromMarketId: string | null = null;
    let usesDwellScheduler = false;
    try {
      const storedConfig = this.store.getConfig();
      if (!storedConfig) return;
      config = makerConfigSchema.parse(storedConfig);
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
          this.marketIndex = (this.marketIndex + 1) % config.markets.length;
          this.marketSelectedAt = now;
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
        this.snapshotValue.running && this.generation === inputs.generation;

      if (config.mode === "live" && inputs.executeLive) {
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

      const { market, orderbook } = await this.gateway.getOrderbook(
        selected.marketId,
      );
      const bestBid = orderbook.bestBidPrice;
      const bestAsk = orderbook.bestAskPrice;
      if (bestBid === undefined || bestAsk === undefined) {
        throw new Error("Orderbook has no two-sided price");
      }

      let portfolio = emptyPortfolio();
      let hedgeRiskPortfolio: PortfolioSnapshot | null = config.hedge.enabled
        ? null
        : emptyPortfolio();
      if (setup && account?.agentCapId && agent) {
        portfolio = await this.gateway.getAgentPortfolioSnapshot({
          setup,
          agentAddress: agent.address,
          marketIds: config.markets.map((item) => item.marketId),
        });
        if (config.hedge.enabled && config.hedge.accountId) {
          const hedgeAccount = this.store.getAccountSetup(
            config.hedge.accountId,
          );
          if (hedgeAccount?.agentCapId) {
            hedgeRiskPortfolio = await this.gateway.getAgentPortfolioSnapshot({
              setup: hedgeAccount,
              agentAddress: agent.address,
              marketIds: config.markets.map((item) => item.marketId),
            });
          }
        }
      }
      const combinedEquityUsd =
        portfolio.equityUsd + (hedgeRiskPortfolio?.equityUsd ?? 0);
      const combinedGrossExposureUsd =
        portfolio.grossExposureUsd +
        (hedgeRiskPortfolio?.grossExposureUsd ?? 0);
      const combinedUnrealizedPnlUsd =
        portfolio.unrealizedPnlUsd +
        (hedgeRiskPortfolio?.unrealizedPnlUsd ?? 0);
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
        inputs.executeLive &&
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
        inputs.executeLive &&
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
      const quote = buildQuoteIntent({
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
      const activeConfig = config;
      const portfolioQuoteRisk = aggregatePortfolioQuoteRisk(
        activeConfig.markets.map((configuredMarket) => {
          const configuredPosition = portfolio.positions.find(
            (item) => item.marketId === configuredMarket.marketId,
          );
          const effective = resolveMarketConfig(activeConfig, configuredMarket);
          return {
            inventoryUsd: configuredPosition?.inventoryUsd ?? 0,
            restingQuoteSizeUsd:
              configuredMarket.marketId === selected!.marketId ||
              activeConfig.rotationMode === "portfolio"
                ? configuredMarket.marketId === selected!.marketId
                  ? quote.sizeUsd
                  : effective.quoteSizeUsd
                : configuredPosition?.makerOrderIds.length
                  ? effective.quoteSizeUsd
                  : 0,
            maxLeverage: effective.maxLeverage,
          };
        }),
      );
      const configuredMarketIds = new Set(
        activeConfig.markets.map((market) => market.marketId),
      );
      const unselectedGrossExposureUsd = portfolio.positions
        .filter((item) => !configuredMarketIds.has(item.marketId))
        .reduce((sum, item) => sum + Math.abs(item.inventoryUsd), 0);
      const safety = evaluateQuoteSafety({
        config: marketConfig,
        quote,
        now: new Date(),
        setupComplete: Boolean(setup && account?.agentCapId && agent),
        hasAgentKey: Boolean(agent && this.options.masterKey),
        liveEnabled: this.options.liveEnabled,
        mainnetAllowed: this.options.mainnetAllowed,
        portfolioGrossExposureUsd: combinedGrossExposureUsd,
        portfolioWorstCaseExposureUsd:
          portfolioQuoteRisk.worstCaseGrossExposureUsd +
          unselectedGrossExposureUsd +
          (hedgeRiskPortfolio?.grossExposureUsd ?? 0),
        portfolioAvailableCollateralUsd: portfolio.availableCollateralUsd,
        portfolioRequiredQuoteCollateralUsd:
          portfolioQuoteRisk.requiredQuoteCollateralUsd,
        agentGasSui: portfolio.gasSui,
        runDrawdownUsd,
      });
      safety.push(...accountRiskChecks("Maker", portfolio));
      if (config.hedge.enabled) {
        safety.push(...accountRiskChecks("Hedge", hedgeRiskPortfolio));
      }
      const summary = this.markets.find(
        (item) => item.id === selected!.marketId,
      );
      const openInterestBase = Math.abs(market.marketState.openInterest);
      const maxOpenInterestBase = market.marketParams.maxOpenInterest;
      const updatedAt = observedAt.toISOString();

      if (inputs.executeLive && !executionIsCurrent()) return;

      this.snapshotValue = {
        ...this.snapshotValue,
        mode: config.mode,
        cycle: this.snapshotValue.cycle + 1,
        lastCycleAt: updatedAt,
        lastError: null,
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
        },
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
            error: null,
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
        quote,
        safety,
      };

      if (config.mode === "observe") {
        this.snapshotValue.lastSuccessfulCycleAt = updatedAt;
        return;
      }

      if (config.mode === "paper") {
        this.store.logExecution({
          mode: "paper",
          marketId: selected.marketId,
          bidPrice: quote.bidPrice,
          askPrice: quote.askPrice,
          sizeUsd: quote.sizeUsd,
          outcome: "simulated",
        });
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
      const cancelled = inputs.generation !== this.generation;
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
      if (!cancelled && this.snapshotValue.mode === "live") {
        this.stopScheduling();
        if (config) {
          const cancelledOrders = await this.cancelOpenOrders(config, {
            attempts: 3,
            retryDelayMs: 2_000,
          });
          if (cancelledOrders) this.clearActiveQuoteState();
        }
      }
    } finally {
      if (config?.markets.length && !usesDwellScheduler) {
        this.marketIndex = (this.marketIndex + 1) % config.markets.length;
      }
    }
  }

  async runStrategyTrial(inputs: {
    mode: StrategyTrialMode;
    cadenceMs: number;
    maxSlippageBps: number;
  }): Promise<StrategyTrialResult> {
    if (
      this.strategyTrialActive ||
      this.snapshotValue.running ||
      this.cyclePromise
    ) {
      throw new Error("Stop the engine before starting a strategy trial");
    }
    if (
      inputs.mode === "live" &&
      (!this.options.liveEnabled || !this.options.mainnetAllowed)
    ) {
      throw new Error("A live strategy trial requires both mainnet gates");
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
      this.gateway.getAgentPortfolioSnapshot({
        setup,
        agentAddress: agent.address,
        marketIds,
      }),
    ]);
    const plan = buildStrategyTrialPlan({
      originalConfig,
      dashboards: { farming, profit, both },
      availableCollateralUsd: makerPortfolio.availableCollateralUsd,
      mode: inputs.mode,
      cadenceMs: inputs.cadenceMs,
    });

    const hedgeSetup = originalConfig.hedge.accountId
      ? this.store.getAccountSetup(originalConfig.hedge.accountId)
      : null;
    const hedgePortfolio = hedgeSetup
      ? await this.gateway.getAgentPortfolioSnapshot({
          setup: hedgeSetup,
          agentAddress: agent.address,
          marketIds,
        })
      : null;
    const hasExposure = (portfolio: PortfolioSnapshot) =>
      portfolio.positions.some(
        (position) =>
          Math.abs(position.inventoryUsd) > 0.01 ||
          position.pendingOrderCount > 0,
      );
    if (
      hasExposure(makerPortfolio) ||
      (hedgePortfolio && hasExposure(hedgePortfolio))
    ) {
      throw new Error(
        "The three-cycle trial requires both configured accounts to start flat with no resting orders",
      );
    }

    const recoverySlippageBps = Math.min(
      inputs.maxSlippageBps,
      originalConfig.hedge.maxSlippageBps,
    );
    const startedAt = new Date().toISOString();
    const rounds: StrategyTrialRoundResult[] = [];
    let recovery: FlattenResult | null = null;
    let recoveryCompleted = inputs.mode === "paper";
    let activeConfig: MakerConfig | null = null;
    this.strategyTrialActive = true;
    this.generation += 1;
    const trialGeneration = this.generation;
    this.snapshotValue.running = true;
    this.snapshotValue.startedAt = startedAt;
    this.snapshotValue.lastError = null;
    this.runPeakEquityUsd = null;
    this.clearActiveQuoteState();
    this.marketSelectedAt = null;
    this.awaitingFillAttribution.clear();
    this.awaitingPositionAttribution.clear();
    this.autoRebalancedOrderIds.clear();
    this.singleSlotSwept = true;
    this.store.logEvent({
      category: "runtime",
      action: "strategy-trial-start",
      outcome: "success",
      detail: {
        mode: inputs.mode,
        marketId: plan.marketId,
        objectives: STRATEGY_TRIAL_OBJECTIVES,
        cadenceMs: plan.cadenceMs,
      },
    });

    try {
      for (const [index, round] of plan.rounds.entries()) {
        if (
          this.generation !== trialGeneration ||
          !this.snapshotValue.running
        ) {
          throw new Error("Strategy trial was stopped by the operator");
        }
        if (index > 0 && activeConfig?.mode === "live") {
          const cancelled = await this.cancelOpenOrders(activeConfig, {
            attempts: 3,
            retryDelayMs: 750,
          });
          if (!cancelled) {
            throw new Error(
              "Strategy trial could not confirm cancellation before changing policy",
            );
          }
          this.clearActiveQuoteState();
        }

        activeConfig = round.config;
        this.store.setConfig(round.config);
        this.marketIndex = 0;
        this.snapshotValue.mode = round.config.mode;
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
        const cycle = this.cycle({
          executeLive: inputs.mode === "live",
          generation: trialGeneration,
        });
        await withTimeout(cycle, 30_000, "Strategy trial cycle timed out");
        if (this.snapshotValue.lastError) {
          throw new Error(this.snapshotValue.lastError);
        }
        const digest =
          this.snapshotValue.markets.find(
            (market) => market.id === plan.marketId,
          )?.lastTransactionDigest ?? null;
        if (inputs.mode === "live" && !digest) {
          throw new Error(
            "Live strategy trial did not confirm a quote transaction",
          );
        }
        rounds.push({
          objective: round.objective,
          profile: round.profile,
          score: round.score,
          quoteSizeUsd: round.quoteSizeUsd,
          spreadBps: round.spreadBps,
          outcome: inputs.mode === "live" ? "confirmed" : "simulated",
          digest,
          startedAt: roundStartedAt,
          completedAt: new Date().toISOString(),
        });
        await (this.options.sleep
          ? this.options.sleep(plan.cadenceMs)
          : new Promise((resolve) => setTimeout(resolve, plan.cadenceMs)));
      }

      if (inputs.mode === "live") {
        recovery = await this.flatten(recoverySlippageBps / 10_000, {
          refreshSnapshot: false,
        });
        recoveryCompleted = true;
      } else {
        this.stopScheduling();
      }

      this.store.setConfig(originalConfig);
      this.marketIndex = 0;
      this.clearActiveQuoteState();
      this.marketSelectedAt = null;
      this.singleSlotSwept = false;
      this.snapshotValue.mode = originalConfig.mode;
      this.syncMarketRows(originalConfig);
      const completedAt = new Date().toISOString();
      this.store.logEvent({
        category: "runtime",
        action: "strategy-trial-complete",
        outcome: "success",
        detail: {
          mode: inputs.mode,
          marketId: plan.marketId,
          rounds: rounds.length,
          recoveryTransactions: recovery?.transactions.length ?? 0,
        },
      });
      return {
        mode: inputs.mode,
        marketId: plan.marketId,
        symbol: plan.symbol,
        cadenceMs: plan.cadenceMs,
        startedAt,
        completedAt,
        rounds,
        recovery,
        restoredConfig: originalConfig,
      };
    } catch (error) {
      this.stopScheduling();
      let recoveryError: string | null = null;
      if (inputs.mode === "live" && activeConfig) {
        try {
          recovery = await this.flatten(recoverySlippageBps / 10_000, {
            refreshSnapshot: false,
          });
          recoveryCompleted = true;
        } catch (flattenError) {
          recoveryError = message(flattenError);
        }
      }
      if (recoveryCompleted) {
        this.store.setConfig(originalConfig);
        this.marketIndex = 0;
        this.clearActiveQuoteState();
        this.marketSelectedAt = null;
        this.singleSlotSwept = false;
        this.snapshotValue.mode = originalConfig.mode;
        this.syncMarketRows(originalConfig);
      }
      const errorText = message(error);
      this.store.logEvent({
        category: "runtime",
        action: "strategy-trial",
        outcome: "error",
        detail: {
          error: errorText,
          rounds: rounds.length,
          recoveryCompleted,
          ...(recoveryError ? { recoveryError } : {}),
        },
      });
      throw new Error(
        recoveryError
          ? `${errorText}; automatic recovery also failed: ${recoveryError}`
          : errorText,
      );
    } finally {
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
