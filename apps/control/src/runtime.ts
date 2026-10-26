import {
  AftermathGateway,
  loadAgentKeypair,
  type EndpointHealth,
  type MarketSummary,
} from "@puc/aftermath";
import {
  assertSafe,
  buildQuoteIntent,
  evaluateQuoteSafety,
  makerConfigSchema,
  type RuntimeSnapshot,
} from "@puc/core";
import type { Store } from "./store.js";

type RuntimeOptions = {
  masterKey?: string;
  liveEnabled: boolean;
  mainnetAllowed: boolean;
  preferredEndpoint?: string;
  fallbackEndpoint?: string;
};

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
  balances: {
    equityUsd: null,
    inventoryUsd: 0,
    unrealizedPnlUsd: 0,
    gasSui: null,
  },
  quote: null,
  safety: [],
});

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class MakerRuntime {
  private gateway: AftermathGateway | null = null;
  private snapshotValue = initialSnapshot();
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;
  private cyclePromise: Promise<void> | null = null;
  private markets: MarketSummary[] = [];

  constructor(
    private readonly store: Store,
    private readonly options: RuntimeOptions,
  ) {}

  async initialize(): Promise<void> {
    try {
      this.gateway = await AftermathGateway.create({
        ...(this.options.preferredEndpoint
          ? { preferredEndpoint: this.options.preferredEndpoint }
          : {}),
        ...(this.options.fallbackEndpoint
          ? { fallbackEndpoint: this.options.fallbackEndpoint }
          : {}),
      });
      const config = this.store.getConfig();
      this.snapshotValue = {
        ...this.snapshotValue,
        mode: config?.mode ?? "observe",
        setupComplete: Boolean(
          this.store.getSetup() && this.store.getAgent()?.agentCapId,
        ),
        agentAddress: this.store.getAgent()?.address ?? null,
        accountId: this.store.getSetup()?.accountId ?? null,
      };
      this.store.logEvent({
        category: "system",
        action: "gateway.initialize",
        outcome: "success",
        detail: {
          endpoint: this.gateway.endpoint,
          health: this.gateway.endpointHealth,
        },
      });
    } catch (error) {
      this.snapshotValue.lastError = message(error);
      this.store.logEvent({
        category: "system",
        action: "gateway.initialize",
        outcome: "error",
        detail: { error: message(error) },
      });
    }
  }

  get snapshot(): RuntimeSnapshot {
    return structuredClone(this.snapshotValue);
  }

  get endpointHealth(): EndpointHealth[] {
    return this.gateway?.endpointHealth ?? [];
  }

  get activeEndpoint(): string | null {
    return this.gateway?.endpoint ?? null;
  }

  requireGateway(): AftermathGateway {
    if (!this.gateway) {
      throw new Error(
        this.snapshotValue.lastError ?? "Aftermath gateway is unavailable",
      );
    }
    return this.gateway;
  }

  async listMarkets(collateralCoinType: string): Promise<MarketSummary[]> {
    this.markets = await this.requireGateway().listMarkets(collateralCoinType);
    return this.markets;
  }

  start(): void {
    const config = this.store.getConfig();
    if (!config) throw new Error("Select and configure a market first");
    if (this.timer) return;

    this.generation += 1;
    const generation = this.generation;
    this.snapshotValue.running = true;
    this.snapshotValue.mode = config.mode;
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
      detail: { mode: config.mode, marketId: config.marketId },
    });
  }

  private stopScheduling(): void {
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
  }

  async stop(): Promise<void> {
    const activeCycle = this.cyclePromise;
    this.stopScheduling();
    if (activeCycle) await activeCycle;
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
    try {
      const gateway = this.requireGateway();
      const config = makerConfigSchema.parse(this.store.getConfig());
      const setup = this.store.getSetup();
      const agent = this.store.getAgent();
      const { market, orderbook } = await gateway.getOrderbook(config.marketId);
      const bestBid = orderbook.bestBidPrice;
      const bestAsk = orderbook.bestAskPrice;
      if (bestBid === undefined || bestAsk === undefined) {
        throw new Error("Orderbook has no two-sided price");
      }

      let equityUsd: number | null = null;
      let inventoryUsd = 0;
      let unrealizedPnlUsd = 0;
      if (setup && agent?.agentCapId) {
        const account = await gateway.getAgentAccountSnapshot({
          setup,
          agentAddress: agent.address,
          marketId: config.marketId,
        });
        equityUsd = account.equityUsd;
        inventoryUsd = account.inventoryUsd;
        unrealizedPnlUsd = account.unrealizedPnlUsd;
      }

      const observedAt = new Date();
      const quote = buildQuoteIntent({
        config,
        observation: {
          marketId: config.marketId,
          bestBid,
          bestAsk,
          observedAt,
        },
        inventoryUsd,
        unrealizedPnlUsd,
      });
      const safety = evaluateQuoteSafety({
        config,
        quote,
        now: new Date(),
        setupComplete: Boolean(setup && agent?.agentCapId),
        hasAgentKey: Boolean(agent && this.options.masterKey),
        liveEnabled: this.options.liveEnabled,
        mainnetAllowed: this.options.mainnetAllowed,
      });

      this.snapshotValue = {
        ...this.snapshotValue,
        mode: config.mode,
        cycle: this.snapshotValue.cycle + 1,
        lastCycleAt: observedAt.toISOString(),
        lastError: null,
        setupComplete: Boolean(setup && agent?.agentCapId),
        agentAddress: agent?.address ?? null,
        accountId: setup?.accountId ?? null,
        market: {
          id: config.marketId,
          symbol: market.metadata?.symbol ?? config.symbol,
          indexPrice: market.indexPrice,
          bestBid,
          bestAsk,
          updatedAt: observedAt.toISOString(),
        },
        balances: {
          ...this.snapshotValue.balances,
          equityUsd,
          inventoryUsd,
          unrealizedPnlUsd,
        },
        quote,
        safety,
      };

      if (config.mode === "observe") return;

      if (config.mode === "paper") {
        this.store.logExecution({
          mode: "paper",
          marketId: config.marketId,
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
      const receipt = await gateway.executeQuote({
        setup,
        config,
        quote,
        signer,
        shouldContinue: executionIsCurrent,
      });
      this.store.logExecution({
        mode: "live",
        marketId: config.marketId,
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
      if (!cancelled) this.snapshotValue.lastError = errorText;
      this.store.logEvent({
        category: "runtime",
        action: "cycle",
        outcome: cancelled ? "cancelled" : "error",
        detail: { error: errorText },
      });
      if (!cancelled && this.snapshotValue.mode === "live") {
        this.stopScheduling();
      }
    }
  }

  async reconfigure(): Promise<void> {
    const wasRunning = this.snapshotValue.running;
    await this.stop();
    if (wasRunning) this.start();
  }
}
