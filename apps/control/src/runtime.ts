import {
  AftermathGateway,
  loadAgentKeypair,
  type EndpointHealth,
  type MarketSummary,
  type PortfolioSnapshot,
} from "@puc/aftermath";
import {
  assertSafe,
  buildQuoteIntent,
  evaluateQuoteSafety,
  makerConfigSchema,
  type BuilderFeePolicy,
  type MakerConfig,
  type MakerMarket,
  type RuntimeMarketSnapshot,
  type RuntimeSnapshot,
} from "@puc/core";
import type { TenantStore } from "./store.js";

export type RuntimeOptions = {
  masterKey?: string;
  liveEnabled: boolean;
  mainnetAllowed: boolean;
  builderCode: () => BuilderFeePolicy | null;
};

const emptyRuntimeMarket = (market: MakerMarket): RuntimeMarketSnapshot => ({
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
  updatedAt: null,
  error: null,
});

const initialSnapshot = (): RuntimeSnapshot => ({
  mode: "observe",
  running: false,
  cycle: 0,
  lastCycleAt: null,
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
  },
  balances: {
    equityUsd: null,
    inventoryUsd: 0,
    unrealizedPnlUsd: 0,
    gasSui: null,
  },
  quote: null,
  safety: [],
});

const emptyPortfolio = (): PortfolioSnapshot => ({
  equityUsd: 0,
  grossExposureUsd: 0,
  unrealizedPnlUsd: 0,
  positions: [],
});

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class MakerRuntime {
  private snapshotValue = initialSnapshot();
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;
  private cyclePromise: Promise<void> | null = null;
  private markets: MarketSummary[] = [];
  private marketIndex = 0;

  constructor(
    private readonly store: TenantStore,
    private readonly gateway: AftermathGateway,
    private readonly options: RuntimeOptions,
  ) {
    const config = this.store.getConfig();
    this.snapshotValue = {
      ...this.snapshotValue,
      mode: config?.mode ?? "observe",
      markets: config?.markets.map(emptyRuntimeMarket) ?? [],
      portfolio: {
        ...this.snapshotValue.portfolio,
        selectedMarkets: config?.markets.length ?? 0,
      },
      setupComplete: Boolean(
        this.store.getSetup() && this.store.getAgent()?.agentCapId,
      ),
      agentAddress: this.store.getAgent()?.address ?? null,
      accountId: this.store.getSetup()?.accountId ?? null,
    };
    this.store.logEvent({
      category: "system",
      action: "runtime.initialize",
      outcome: "success",
      detail: { endpoint: this.gateway.endpoint },
    });
  }

  get snapshot(): RuntimeSnapshot {
    return structuredClone(this.snapshotValue);
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

  private syncMarketRows(config: MakerConfig): void {
    const previous = new Map(
      this.snapshotValue.markets.map((market) => [market.id, market]),
    );
    this.snapshotValue.markets = config.markets.map((market) => {
      const current = previous.get(market.marketId);
      const summary = this.markets.find(
        (candidate) => candidate.id === market.marketId,
      );
      return {
        ...(current ?? emptyRuntimeMarket(market)),
        symbol: market.symbol,
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
    this.snapshotValue.running = true;
    this.snapshotValue.mode = config.mode;
    this.syncMarketRows(config);
    void this.cycle({ executeLive: true, generation });
    this.timer = setInterval(
      () => void this.cycle({ executeLive: true, generation }),
      config.refreshMs,
    );
    this.timer.unref();
    this.store.logEvent({
      category: "runtime",
      action: "start",
      outcome: "success",
      detail: {
        mode: config.mode,
        marketIds: config.markets.map((market) => market.marketId),
        effectiveMarketRefreshMs: config.refreshMs * config.markets.length,
      },
    });
  }

  private stopScheduling(): boolean {
    const wasRunning = this.snapshotValue.running || Boolean(this.timer);
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.snapshotValue.running = false;
    if (wasRunning) {
      this.store.logEvent({
        category: "runtime",
        action: "stop",
        outcome: "success",
      });
    }
    return wasRunning;
  }

  private async cancelOpenOrders(config: MakerConfig): Promise<void> {
    const setup = this.store.getSetup();
    const agent = this.store.getAgent();
    if (
      config.mode !== "live" ||
      !setup ||
      !agent?.agentCapId ||
      !this.options.masterKey
    ) {
      return;
    }

    const signer = loadAgentKeypair({
      masterKey: this.options.masterKey,
      context: `account:${setup.accountId}`,
      encryptedSecret: agent.encryptedSecret,
    });
    try {
      const receipt = await this.gateway.cancelMakerOrders({
        setup,
        marketIds: config.markets.map((market) => market.marketId),
        signer,
        config,
      });
      this.store.logEvent({
        category: "runtime",
        action: "cancel-maker-orders",
        outcome: receipt ? "confirmed" : "clear",
        detail: receipt ?? {},
      });
    } catch (error) {
      const errorText = message(error);
      this.snapshotValue.lastError = `Quote cancellation failed: ${errorText}`;
      this.store.logEvent({
        category: "runtime",
        action: "cancel-maker-orders",
        outcome: "error",
        detail: { error: errorText },
      });
    }
  }

  async stop(): Promise<void> {
    const config = this.store.getConfig();
    const activeCycle = this.cyclePromise;
    const wasRunning = this.stopScheduling();
    if (activeCycle) await activeCycle;
    if (wasRunning && config) await this.cancelOpenOrders(config);
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
    try {
      config = makerConfigSchema.parse(this.store.getConfig());
      this.syncMarketRows(config);
      selected = config.markets[this.marketIndex % config.markets.length]!;
      const setup = this.store.getSetup();
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
      if (setup && agent?.agentCapId) {
        portfolio = await this.gateway.getAgentPortfolioSnapshot({
          setup,
          agentAddress: agent.address,
          marketIds: config.markets.map((item) => item.marketId),
        });
      }
      const position = portfolio.positions.find(
        (item) => item.marketId === selected!.marketId,
      );
      const inventoryUsd = position?.inventoryUsd ?? 0;
      const marketPnlUsd = position?.unrealizedPnlUsd ?? 0;
      const observedAt = new Date();
      const quote = buildQuoteIntent({
        config,
        observation: {
          marketId: selected.marketId,
          bestBid,
          bestAsk,
          observedAt,
        },
        inventoryUsd,
        unrealizedPnlUsd: portfolio.unrealizedPnlUsd,
      });
      const safety = evaluateQuoteSafety({
        config,
        quote,
        now: new Date(),
        setupComplete: Boolean(setup && agent?.agentCapId),
        hasAgentKey: Boolean(agent && this.options.masterKey),
        liveEnabled: this.options.liveEnabled,
        mainnetAllowed: this.options.mainnetAllowed,
        portfolioGrossExposureUsd: portfolio.grossExposureUsd,
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
        setupComplete: Boolean(setup && agent?.agentCapId),
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
        },
        balances: {
          ...this.snapshotValue.balances,
          equityUsd: setup ? portfolio.equityUsd : null,
          inventoryUsd,
          unrealizedPnlUsd: portfolio.unrealizedPnlUsd,
        },
        quote,
        safety,
      };

      if (config.mode === "observe") return;

      if (config.mode === "paper") {
        this.store.logExecution({
          mode: "paper",
          marketId: selected.marketId,
          bidPrice: quote.bidPrice,
          askPrice: quote.askPrice,
          sizeUsd: quote.sizeUsd,
          outcome: "simulated",
        });
        return;
      }

      if (!inputs.executeLive) return;

      const executionIsCurrent = () =>
        this.snapshotValue.running && this.generation === inputs.generation;
      if (!executionIsCurrent()) return;

      assertSafe(safety);
      if (!setup || !agent || !this.options.masterKey) {
        throw new Error("Live signer state is incomplete");
      }
      const signer = loadAgentKeypair({
        masterKey: this.options.masterKey,
        context: `account:${setup.accountId}`,
        encryptedSecret: agent.encryptedSecret,
      });
      const receipt = await this.gateway.executeQuote({
        setup,
        config,
        quote,
        signer,
        builderCode: this.options.builderCode(),
        shouldContinue: executionIsCurrent,
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
      });
    } catch (error) {
      const errorText = message(error);
      const cancelled = inputs.generation !== this.generation;
      if (!cancelled) {
        this.snapshotValue.lastError = errorText;
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
        if (config) await this.cancelOpenOrders(config);
      }
    } finally {
      if (config?.markets.length) {
        this.marketIndex = (this.marketIndex + 1) % config.markets.length;
      }
    }
  }

  async reconfigure(): Promise<void> {
    const wasRunning = this.snapshotValue.running;
    await this.stop();
    this.marketIndex = 0;
    const config = this.store.getConfig();
    if (config) {
      this.snapshotValue.mode = config.mode;
      this.syncMarketRows(config);
    }
    if (wasRunning) this.start();
  }
}
