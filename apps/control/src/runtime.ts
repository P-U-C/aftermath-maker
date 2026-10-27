import {
  AftermathGateway,
  loadAgentKeypair,
  type EndpointHealth,
  type MarketSummary,
  type PerformanceOrder,
  type PortfolioSnapshot,
} from "@puc/aftermath";
import {
  assertSafe,
  buildQuoteIntent,
  evaluateQuoteSafety,
  makerConfigSchema,
  resolveMarketConfig,
  type BuilderFeePolicy,
  type MakerConfig,
  type MakerMarket,
  type RuntimeMarketSnapshot,
  type RuntimeSnapshot,
  type Setup,
} from "@puc/core";
import type { TenantStore } from "./store.js";

export type RuntimeOptions = {
  masterKey?: string;
  liveEnabled: boolean;
  mainnetAllowed: boolean;
  builderCode: () => BuilderFeePolicy | null;
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

export type PerformanceSnapshot = {
  asOf: string;
  period: "1D";
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

export class MakerRuntime {
  private snapshotValue = initialSnapshot();
  private timer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private watchdogTripping = false;
  private generation = 0;
  private cyclePromise: Promise<void> | null = null;
  private markets: MarketSummary[] = [];
  private marketIndex = 0;
  private runPeakEquityUsd: number | null = null;

  constructor(
    private readonly store: TenantStore,
    private readonly gateway: AftermathGateway,
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
    snapshot.execution = {
      ...execution,
      gasRunwayTransactions:
        execution.averageGasMist && snapshot.balances.gasSui !== null
          ? Math.floor(
              (snapshot.balances.gasSui * 1_000_000_000) /
                execution.averageGasMist,
            )
          : null,
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
        effectiveMarketRefreshMs: config.refreshMs * config.markets.length,
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
    const stale = this.snapshotValue.markets.find((market) => {
      const observedAt = market.updatedAt
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
        updatedAt: stale.updatedAt,
        maxQuoteAgeMs: config.maxQuoteAgeMs,
      },
    });
    const activeCycle = this.cyclePromise;
    const wasRunning = this.stopScheduling("watchdog");
    if (wasRunning) {
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
    options: { attempts?: number; retryDelayMs?: number } = {},
  ): Promise<void> {
    const setup = this.store.getSetup();
    const account = setup ? this.store.getAccountSetup(setup.accountId) : null;
    const agent = this.store.getAgent();
    if (
      config.mode !== "live" ||
      !setup ||
      !account?.agentCapId ||
      !agent ||
      !this.options.masterKey
    ) {
      return;
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
          marketIds: config.markets.map((market) => market.marketId),
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
          return;
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
          return;
        }
      }

      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  async stop(): Promise<void> {
    const config = this.store.getConfig();
    const activeCycle = this.cyclePromise;
    const wasRunning = this.stopScheduling();
    let cycleSettled = !activeCycle;
    if (activeCycle) {
      cycleSettled = await Promise.race([
        activeCycle.then(() => true),
        new Promise<false>((resolve) =>
          setTimeout(() => resolve(false), 5_000),
        ),
      ]);
    }
    if (wasRunning && config) {
      await this.cancelOpenOrders(config, {
        attempts: 3,
        retryDelayMs: 2_000,
      });
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

  async flatten(maxSlippage: number): Promise<{
    digest: string | null;
    digests: string[];
    flattenedMarketIds: string[];
    transactions: Array<{
      accountId: string;
      digest: string;
      flattenedMarketIds: string[];
    }>;
  }> {
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
    if (activeCycle) await activeCycle;
    await this.cancelOpenOrders(config);
    const signer = loadAgentKeypair({
      masterKey: this.options.masterKey,
      context: agent.encryptionContext,
      encryptedSecret: agent.encryptedSecret,
    });
    const transactions: Array<{
      accountId: string;
      digest: string;
      flattenedMarketIds: string[];
    }> = [];
    for (const account of accounts) {
      const receipt = await this.gateway.flattenPositions({
        setup: account,
        config,
        signer,
        marketIds: config.markets.map((market) => market.marketId),
        maxSlippage,
      });
      if (!receipt) continue;
      transactions.push({
        accountId: account.accountId,
        digest: receipt.digest,
        flattenedMarketIds: receipt.flattenedMarketIds,
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
    this.store.logEvent({
      category: "risk",
      action: "reduce-only-flatten",
      outcome: transactions.length ? "confirmed" : "clear",
      detail: transactions.length
        ? { transactions }
        : {
            reason: "No positions in selected markets",
            accountIds: accounts.map((account) => account.accountId),
          },
    });
    await this.cycle();
    const flattenedMarketIds = [
      ...new Set(
        transactions.flatMap((transaction) => transaction.flattenedMarketIds),
      ),
    ];
    const digests = transactions.map((transaction) => transaction.digest);
    return {
      digest: digests[0] ?? null,
      digests,
      flattenedMarketIds,
      transactions,
    };
  }

  async performance(): Promise<PerformanceSnapshot> {
    const config = this.store.getConfig();
    const setup = this.store.getSetup();
    const accountSetup = setup
      ? this.store.getAccountSetup(setup.accountId)
      : null;
    const agent = this.store.getAgent();
    if (!setup || !accountSetup?.agentCapId || !agent) {
      return {
        asOf: new Date().toISOString(),
        period: "1D",
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

    const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
    const hedgeExecutions = this.store
      .listHedgeExecutions(500)
      .filter((execution) => Date.parse(execution.occurredAt) >= cutoff);
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
      period: "1D",
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
      note: "Maker attribution uses recorded order IDs. Hedge attribution uses confirmed hedge transaction digests. Builder fees are deterministic estimates from filled notional; account metrics come from Aftermath's 1D history.",
    };
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
  }): Promise<void> {
    const hedgeConfig = inputs.config.hedge;
    this.snapshotValue.hedge = {
      ...this.snapshotValue.hedge,
      enabled: hedgeConfig.enabled,
      state: hedgeConfig.enabled ? "waiting" : "off",
      accountId: hedgeConfig.accountId,
      error: null,
    };
    if (!hedgeConfig.enabled) return;

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
    const trackedOrderIds = new Set(
      this.store
        .listTrackedMakerOrders({ accountId: inputs.makerSetup.accountId })
        .filter((order) => order.marketId === inputs.selected.marketId)
        .map((order) => order.orderId),
    );
    const pendingFills = history.orders.filter(
      (order) =>
        order.maker &&
        order.marketId === inputs.selected.marketId &&
        Boolean(order.orderId) &&
        trackedOrderIds.has(order.orderId!) &&
        !this.store.isHedgeFillProcessed(
          inputs.makerSetup.accountId,
          hedgeFillKey(order),
        ),
    );
    if (!pendingFills.length) return;

    const pendingDeltaUsd = pendingFills.reduce(
      (total, fill) => total + signedFillNotional(fill),
      0,
    );
    const fillKeys = pendingFills.map(hedgeFillKey);
    if (Math.abs(pendingDeltaUsd) < hedgeConfig.thresholdUsd) {
      this.snapshotValue.hedge.state = "waiting";
      return;
    }

    if (
      Math.abs(combinedDeltaUsd) < hedgeConfig.thresholdUsd ||
      Math.sign(combinedDeltaUsd) !== Math.sign(pendingDeltaUsd)
    ) {
      this.store.markHedgeFillsProcessed({
        makerAccountId: inputs.makerSetup.accountId,
        fillKeys,
        hedgeDigest: "already-offset",
      });
      return;
    }

    const cancelReceipt = await this.gateway.cancelMakerOrders({
      setup: inputs.makerSetup,
      marketIds: [inputs.selected.marketId],
      signer: inputs.signer,
      config: inputs.marketConfig,
    });
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

    const [makerAfterCancel, hedgeAfterCancel] = await Promise.all([
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
    const makerAfterPosition = makerAfterCancel.positions[0];
    const hedgeAfterPosition = hedgeAfterCancel.positions[0];
    if (
      (makerAfterPosition?.pendingOrderCount ?? 0) > 0 ||
      (hedgeAfterPosition?.pendingOrderCount ?? 0) > 0
    ) {
      throw new Error(
        "Hedge blocked: clear every resting order on both configured accounts",
      );
    }

    const currentCombinedDeltaUsd =
      (makerAfterPosition?.inventoryUsd ?? 0) +
      (hedgeAfterPosition?.inventoryUsd ?? 0);
    this.snapshotValue.hedge.combinedDeltaUsd = currentCombinedDeltaUsd;
    if (
      Math.abs(currentCombinedDeltaUsd) < hedgeConfig.thresholdUsd ||
      Math.sign(currentCombinedDeltaUsd) !== Math.sign(pendingDeltaUsd)
    ) {
      this.store.markHedgeFillsProcessed({
        makerAccountId: inputs.makerSetup.accountId,
        fillKeys,
        hedgeDigest: cancelReceipt?.digest ?? "already-offset",
      });
      return;
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
    const projectedResidualUsd = Math.max(
      0,
      Math.abs(currentCombinedDeltaUsd) - receipt.requestedNotionalUsd,
    );
    this.store.recordHedgeExecution({
      makerAccountId: inputs.makerSetup.accountId,
      hedgeAccountId: hedgeAccount.accountId,
      marketId: inputs.selected.marketId,
      digest: receipt.digest,
      side: receipt.side,
      requestedNotionalUsd: receipt.requestedNotionalUsd,
      gasUsedMist: receipt.gasUsedMist,
      fillKeys: projectedResidualUsd < hedgeConfig.thresholdUsd ? fillKeys : [],
    });
    const occurredAt = new Date().toISOString();
    this.snapshotValue.hedge = {
      ...this.snapshotValue.hedge,
      state: "ready",
      combinedDeltaUsd:
        currentCombinedDeltaUsd -
        Math.sign(currentCombinedDeltaUsd) * receipt.requestedNotionalUsd,
      lastHedgeAt: occurredAt,
      lastDigest: receipt.digest,
      error: null,
    };
    this.store.logEvent({
      category: "hedge",
      action: "fill-driven-market-order",
      outcome: "confirmed",
      detail: {
        marketId: inputs.selected.marketId,
        makerAccountId: inputs.makerSetup.accountId,
        hedgeAccountId: hedgeAccount.accountId,
        digest: receipt.digest,
        side: receipt.side,
        requestedNotionalUsd: receipt.requestedNotionalUsd,
        pendingFillCount: pendingFills.length,
      },
    });
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
    try {
      const storedConfig = this.store.getConfig();
      if (!storedConfig) return;
      config = makerConfigSchema.parse(storedConfig);
      this.syncMarketRows(config);
      selected = config.markets[this.marketIndex % config.markets.length]!;
      const marketConfig = resolveMarketConfig(config, selected);
      const setup = this.store.getSetup();
      const account = setup
        ? this.store.getAccountSetup(setup.accountId)
        : null;
      const agent = this.store.getAgent();
      const { market, orderbook } = await this.gateway.getOrderbook(
        selected.marketId,
      );
      const bestBid = orderbook.bestBidPrice;
      const bestAsk = orderbook.bestAskPrice;
      if (bestBid === undefined || bestAsk === undefined) {
        throw new Error("Orderbook has no two-sided price");
      }

      let portfolio = emptyPortfolio();
      if (setup && account?.agentCapId && agent) {
        portfolio = await this.gateway.getAgentPortfolioSnapshot({
          setup,
          agentAddress: agent.address,
          marketIds: config.markets.map((item) => item.marketId),
        });
      }
      if (setup && account?.agentCapId && agent) {
        this.runPeakEquityUsd = Math.max(
          this.runPeakEquityUsd ?? portfolio.equityUsd,
          portfolio.equityUsd,
        );
      }
      const runDrawdownUsd = Math.max(
        0,
        (this.runPeakEquityUsd ?? portfolio.equityUsd) - portfolio.equityUsd,
      );
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
          observedAt,
        },
        inventoryUsd,
        unrealizedPnlUsd: portfolio.unrealizedPnlUsd,
      });
      const safety = evaluateQuoteSafety({
        config: marketConfig,
        quote,
        now: new Date(),
        setupComplete: Boolean(setup && account?.agentCapId && agent),
        hasAgentKey: Boolean(agent && this.options.masterKey),
        liveEnabled: this.options.liveEnabled,
        mainnetAllowed: this.options.mainnetAllowed,
        portfolioGrossExposureUsd: portfolio.grossExposureUsd,
        portfolioAvailableCollateralUsd: portfolio.availableCollateralUsd,
        agentGasSui: portfolio.gasSui,
        runDrawdownUsd,
      });
      const summary = this.markets.find(
        (item) => item.id === selected!.marketId,
      );
      const openInterestBase = Math.abs(market.marketState.openInterest);
      const maxOpenInterestBase = market.marketParams.maxOpenInterest;
      const updatedAt = observedAt.toISOString();

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
          grossExposureUsd: portfolio.grossExposureUsd,
          unrealizedPnlUsd: portfolio.unrealizedPnlUsd,
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
          equityUsd: setup ? portfolio.equityUsd : null,
          inventoryUsd,
          unrealizedPnlUsd: portfolio.unrealizedPnlUsd,
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

      const executionIsCurrent = () =>
        this.snapshotValue.running && this.generation === inputs.generation;
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
      await this.reconcileHedge({
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
      assertSafe(safety);

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

      const receipt = await this.gateway.executeQuote({
        setup,
        config: marketConfig,
        quote,
        signer,
        builderCode: this.options.builderCode(),
        shouldContinue: executionIsCurrent,
        knownMakerOrderIds,
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
      this.snapshotValue.lastSuccessfulCycleAt = new Date().toISOString();
      this.snapshotValue.markets = this.snapshotValue.markets.map((row) =>
        row.id === selected!.marketId
          ? { ...row, lastTransactionDigest: receipt.digest }
          : row,
      );
    } catch (error) {
      const errorText = message(error);
      const cancelled = inputs.generation !== this.generation;
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
          await this.cancelOpenOrders(config, {
            attempts: 3,
            retryDelayMs: 2_000,
          });
        }
      }
    } finally {
      if (config?.markets.length) {
        this.marketIndex = (this.marketIndex + 1) % config.markets.length;
      }
    }
  }

  async reconfigure(nextConfig?: MakerConfig): Promise<void> {
    const wasRunning = this.snapshotValue.running;
    await this.stop();
    if (nextConfig) this.store.setConfig(nextConfig);
    this.marketIndex = 0;
    const config = this.store.getConfig();
    if (config) {
      this.snapshotValue.mode = config.mode;
      this.syncMarketRows(config);
    }
    if (wasRunning) this.start();
  }
}
