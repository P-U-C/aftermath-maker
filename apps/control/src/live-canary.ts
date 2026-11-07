import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  AftermathGateway,
  type EncryptedSecret,
  type PortfolioSnapshot,
} from "@puc/aftermath";
import {
  assertSafe,
  buildQuoteIntent,
  evaluateQuoteSafety,
  makerConfigSchema,
  setupSchema,
  type BuilderFeePolicy,
  type MakerConfig,
  type QuoteIntent,
  type Setup,
} from "@puc/core";

/**
 * This deliberately is not a Runtime timer.  It is a manually invoked,
 * single-market Mainnet exercise for a dedicated disposable account pair.
 * The normal dev Compose lane never supplies its signer or enables Live.
 */
export type LiveCanaryPhase =
  | "new"
  | "preflighted"
  | "quoted"
  | "cancelling"
  | "hedging"
  | "flattening"
  | "complete"
  | "recovery-required";

export type LiveCanaryEvent = {
  at: string;
  action: string;
  detail?: Record<string, string | number | boolean | null>;
};

export type LiveCanaryState = {
  version: 1;
  phase: LiveCanaryPhase;
  marketId: string;
  startedAt: string;
  updatedAt: string;
  quote: QuoteIntent | null;
  quoteDigest: string | null;
  cancelDigest: string | null;
  hedgeDigest: string | null;
  flattenDigests: string[];
  events: LiveCanaryEvent[];
  error: string | null;
};

export type LiveCanaryStateStore = {
  read(): Promise<LiveCanaryState | null>;
  write(state: LiveCanaryState): Promise<void>;
};

export type LiveCanaryConfig = {
  network: "mainnet";
  makerSetup: Setup;
  hedgeSetup: Setup;
  config: MakerConfig;
  marketId: string;
  /** Hard ceiling for a single side. The production config may never exceed it. */
  maxQuoteUsd: number;
  /** How long the one post-only quote may rest before forced cancellation. */
  observationWindowMs: number;
  /** Keep observing after cancellation so index-late fills cannot be missed. */
  settlementWindowMs: number;
  pollMs: number;
  /** Independent flat reads required before the cycle can be marked complete. */
  flatConfirmReads: number;
  /** The active builder policy must match the canary agent's authorization. */
  builderCode: BuilderFeePolicy;
};

export type LiveCanarySecrets = {
  agentAddress: string;
  signer: Ed25519Keypair;
  encryptedSecret?: EncryptedSecret;
};

export type LiveCanaryResult = {
  state: LiveCanaryState;
  outcome: "dry-run" | "no-fill" | "filled-and-flat" | "recovery-required";
};

type Positions = {
  maker: PortfolioSnapshot;
  hedge: PortfolioSnapshot;
};

export type LiveCanaryDependencies = {
  gateway: AftermathGateway;
  state: LiveCanaryStateStore;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Test-only override; production calls are always bounded. */
  operationTimeoutMs?: number;
};

const CANARY_MAX_WAIT_MS = 30_000;
const CANARY_MAX_QUOTE_USD = 5;
const CANARY_OPERATION_TIMEOUT_MS = 15_000;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const nowIso = (now: () => Date) => now().toISOString();

const recorded = (state: LiveCanaryState, action: string) =>
  state.events.some((event) => event.action === action);

const positionFor = (snapshot: PortfolioSnapshot, marketId: string) =>
  snapshot.positions.find((position) => position.marketId === marketId) ?? {
    marketId,
    baseAssetAmount: 0,
    pendingOrderCount: 0,
    inventoryUsd: 0,
    unrealizedPnlUsd: 0,
    collateralUsd: 0,
    freeMarginUsd: 0,
    makerOrderIds: [],
    hasPosition: false,
  };

function initialState(marketId: string, now: () => Date): LiveCanaryState {
  const at = nowIso(now);
  return {
    version: 1,
    phase: "new",
    marketId,
    startedAt: at,
    updatedAt: at,
    quote: null,
    quoteDigest: null,
    cancelDigest: null,
    hedgeDigest: null,
    flattenDigests: [],
    events: [],
    error: null,
  };
}

function validateConfig(input: LiveCanaryConfig): LiveCanaryConfig {
  const config = makerConfigSchema.parse(input.config);
  const makerSetup = setupSchema.parse(input.makerSetup);
  const hedgeSetup = setupSchema.parse(input.hedgeSetup);
  if (input.network !== "mainnet")
    throw new Error("Canary only supports Mainnet");
  if (config.mode !== "live") throw new Error("Canary requires a Live config");
  if (
    config.markets.length !== 1 ||
    config.markets[0]?.marketId !== input.marketId
  ) {
    throw new Error("Canary requires exactly its one configured market");
  }
  if (
    !config.hedge.enabled ||
    config.makerAccountId !== makerSetup.accountId ||
    config.hedge.accountId !== hedgeSetup.accountId
  ) {
    throw new Error(
      "Canary requires its configured Maker and hedge account pair",
    );
  }
  if (makerSetup.accountId === hedgeSetup.accountId) {
    throw new Error("Canary Maker and hedge accounts must differ");
  }
  if (
    input.maxQuoteUsd <= 0 ||
    input.maxQuoteUsd > CANARY_MAX_QUOTE_USD ||
    config.quoteSizeUsd > input.maxQuoteUsd ||
    config.hedge.maxOrderUsd > input.maxQuoteUsd
  ) {
    throw new Error(
      `Canary side and hedge limits must not exceed $${CANARY_MAX_QUOTE_USD}`,
    );
  }
  if (
    input.observationWindowMs < 0 ||
    input.observationWindowMs > CANARY_MAX_WAIT_MS ||
    input.settlementWindowMs < 5_000 ||
    input.settlementWindowMs > CANARY_MAX_WAIT_MS ||
    input.pollMs <= 0 ||
    input.pollMs > 5_000 ||
    input.flatConfirmReads < 3 ||
    input.flatConfirmReads > 10
  ) {
    throw new Error("Canary wait bounds are invalid");
  }
  if (
    !Number.isInteger(input.builderCode.integratorId) ||
    input.builderCode.integratorId < 0 ||
    !Number.isFinite(input.builderCode.integratorFee) ||
    input.builderCode.integratorFee < 0
  ) {
    throw new Error("Canary requires a valid builder fee policy");
  }
  return { ...input, config, makerSetup, hedgeSetup };
}

async function bounded<T>(
  operation: string,
  timeoutMs: number,
  task: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`Canary ${operation} timed out after ${timeoutMs}ms`),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function portfolios(
  gateway: AftermathGateway,
  config: LiveCanaryConfig,
  agentAddress: string,
  operationTimeoutMs: number,
): Promise<Positions> {
  const inputs = { agentAddress, marketIds: [config.marketId] };
  const [maker, hedge] = await bounded(
    "portfolio snapshot",
    operationTimeoutMs,
    () =>
      Promise.all([
        gateway.getAgentPortfolioSnapshot({
          ...inputs,
          setup: config.makerSetup,
        }),
        gateway.getAgentPortfolioSnapshot({
          ...inputs,
          setup: config.hedgeSetup,
        }),
      ]),
  );
  return { maker, hedge };
}

function assertNoResting(positions: Positions, marketId: string): void {
  const maker = positionFor(positions.maker, marketId);
  const hedge = positionFor(positions.hedge, marketId);
  if (maker.pendingOrderCount || hedge.pendingOrderCount) {
    throw new Error(
      "Canary cancellation is not yet confirmed on both accounts",
    );
  }
}

function assertFlat(
  positions: Positions,
  marketId: string,
  toleranceUsd: number,
): void {
  assertNoResting(positions, marketId);
  const maker = positionFor(positions.maker, marketId);
  const hedge = positionFor(positions.hedge, marketId);
  if (
    Math.abs(maker.inventoryUsd) > toleranceUsd ||
    Math.abs(hedge.inventoryUsd) > toleranceUsd
  ) {
    throw new Error("Canary recovery did not prove both accounts flat");
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  maxWaitMs: number,
  pollMs: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  const attempts = Math.floor(maxWaitMs / pollMs) + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return true;
    if (attempt + 1 < attempts) await sleep(pollMs);
  }
  return false;
}

async function observeSettlement(inputs: {
  gateway: AftermathGateway;
  config: LiveCanaryConfig;
  agentAddress: string;
  sleep: (milliseconds: number) => Promise<void>;
  operationTimeoutMs: number;
}): Promise<Positions> {
  const attempts =
    Math.floor(inputs.config.settlementWindowMs / inputs.config.pollMs) + 1;
  let latest = await portfolios(
    inputs.gateway,
    inputs.config,
    inputs.agentAddress,
    inputs.operationTimeoutMs,
  );
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    await inputs.sleep(inputs.config.pollMs);
    latest = await portfolios(
      inputs.gateway,
      inputs.config,
      inputs.agentAddress,
      inputs.operationTimeoutMs,
    );
  }
  return latest;
}

async function confirmFlatReads(inputs: {
  gateway: AftermathGateway;
  config: LiveCanaryConfig;
  agentAddress: string;
  toleranceUsd: number;
  sleep: (milliseconds: number) => Promise<void>;
  operationTimeoutMs: number;
}): Promise<boolean> {
  let confirmed = 0;
  const attempts = inputs.config.flatConfirmReads * 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const observed = await portfolios(
      inputs.gateway,
      inputs.config,
      inputs.agentAddress,
      inputs.operationTimeoutMs,
    );
    try {
      assertFlat(observed, inputs.config.marketId, inputs.toleranceUsd);
      confirmed += 1;
      if (confirmed >= inputs.config.flatConfirmReads) return true;
    } catch {
      confirmed = 0;
    }
    if (attempt + 1 < attempts) await inputs.sleep(inputs.config.pollMs);
  }
  return false;
}

function withEvent(
  state: LiveCanaryState,
  now: () => Date,
  phase: LiveCanaryPhase,
  action: string,
  detail?: LiveCanaryEvent["detail"],
): LiveCanaryState {
  return {
    ...state,
    phase,
    updatedAt: nowIso(now),
    events: [
      ...state.events,
      { at: nowIso(now), action, ...(detail ? { detail } : {}) },
    ],
  };
}

/**
 * Executes at most one $5-per-side Mainnet test. Every external action is
 * checkpointed first/afterward so an interrupted process resumes by cancelling
 * and recovering rather than quoting again. `execute: false` cannot sign.
 */
export async function runLiveCanary(inputs: {
  config: LiveCanaryConfig;
  secrets: LiveCanarySecrets;
  execute: boolean;
  dependencies: LiveCanaryDependencies;
}): Promise<LiveCanaryResult> {
  const config = validateConfig(inputs.config);
  const now = inputs.dependencies.now ?? (() => new Date());
  const sleep =
    inputs.dependencies.sleep ??
    ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const operationTimeoutMs =
    inputs.dependencies.operationTimeoutMs ?? CANARY_OPERATION_TIMEOUT_MS;
  if (
    !Number.isInteger(operationTimeoutMs) ||
    operationTimeoutMs <= 0 ||
    operationTimeoutMs > CANARY_MAX_WAIT_MS
  ) {
    throw new Error("Canary operation timeout is invalid");
  }
  const { gateway, state: stateStore } = inputs.dependencies;
  let state = (await stateStore.read()) ?? initialState(config.marketId, now);
  if (state.version !== 1 || state.marketId !== config.marketId) {
    throw new Error("Canary checkpoint belongs to another market or format");
  }
  const save = async () => stateStore.write(state);
  const fail = async (error: unknown): Promise<never> => {
    state = {
      ...withEvent(state, now, "recovery-required", "recovery-required", {
        error: errorMessage(error),
      }),
      error: errorMessage(error),
    };
    await save();
    throw error;
  };

  try {
    // A signed request can be accepted by the venue immediately before this
    // process crashes. A local checkpoint without its receipt is therefore an
    // unknown outcome, never permission to retry that request.
    if (recorded(state, "hedge-requested") && !state.hedgeDigest) {
      throw new Error(
        "Canary hedge outcome is unknown; reconcile the venue before any further action",
      );
    }
    if (
      recorded(state, "flatten-requested") &&
      !recorded(state, "flatten-submitted")
    ) {
      throw new Error(
        "Canary flatten outcome is unknown; reconcile the venue before any further action",
      );
    }
    const current = await portfolios(
      gateway,
      config,
      inputs.secrets.agentAddress,
      operationTimeoutMs,
    );
    const makerPosition = positionFor(current.maker, config.marketId);
    const hedgePosition = positionFor(current.hedge, config.marketId);
    const toleranceUsd = Math.max(0.01, config.config.quoteSizeUsd * 0.02);

    if (state.phase === "complete") {
      assertFlat(current, config.marketId, toleranceUsd);
      return {
        state,
        outcome: state.hedgeDigest ? "filled-and-flat" : "no-fill",
      };
    }
    if (state.phase === "new" || state.phase === "preflighted") {
      assertNoResting(current, config.marketId);
      if (
        Math.abs(makerPosition.inventoryUsd) > toleranceUsd ||
        Math.abs(hedgePosition.inventoryUsd) > toleranceUsd
      ) {
        throw new Error("Canary refuses to start with any existing position");
      }
      const { market, orderbook } = await bounded(
        "orderbook read",
        operationTimeoutMs,
        () => gateway.getOrderbook(config.marketId),
      );
      if (
        orderbook.bestBidPrice === undefined ||
        orderbook.bestAskPrice === undefined
      ) {
        throw new Error("Canary requires a two-sided orderbook");
      }
      const quote = buildQuoteIntent({
        config: config.config,
        observation: {
          marketId: config.marketId,
          bestBid: orderbook.bestBidPrice,
          bestAsk: orderbook.bestAskPrice,
          indexPrice: market.indexPrice,
          tickSize: market.tickSize(),
          observedAt: now(),
        },
        inventoryUsd: makerPosition.inventoryUsd,
        unrealizedPnlUsd: makerPosition.unrealizedPnlUsd,
      });
      const gasSui = await bounded(
        "trading-key gas read",
        operationTimeoutMs,
        () => gateway.getTradingKeyGasSui(inputs.secrets.agentAddress),
      );
      assertSafe(
        evaluateQuoteSafety({
          config: config.config,
          quote,
          setupComplete: true,
          hasAgentKey: true,
          liveEnabled: true,
          mainnetAllowed: true,
          portfolioGrossExposureUsd: 0,
          portfolioAvailableCollateralUsd: current.maker.availableCollateralUsd,
          agentGasSui: gasSui,
          now: now(),
        }),
      );
      await bounded("quote simulation", operationTimeoutMs, () =>
        gateway.simulateQuote({
          setup: config.makerSetup,
          config: config.config,
          quote,
          agentAddress: inputs.secrets.agentAddress,
          builderCode: config.builderCode,
          shouldContinue: () => true,
        }),
      );
      state = {
        ...withEvent(state, now, "preflighted", "quote-simulated", {
          sizeUsd: quote.sizeUsd,
        }),
        quote,
      };
      await save();
      if (!inputs.execute) return { state, outcome: "dry-run" };
      state = withEvent(state, now, "quoted", "quote-submit-intent");
      await save();
      const receipt = await bounded(
        "quote submission",
        operationTimeoutMs,
        () =>
          gateway.executeQuote({
            setup: config.makerSetup,
            config: config.config,
            quote,
            signer: inputs.secrets.signer,
            builderCode: config.builderCode,
            shouldContinue: () => true,
          }),
      );
      state = {
        ...withEvent(state, now, "quoted", "quote-submitted", {
          digest: receipt.digest,
        }),
        quoteDigest: receipt.digest,
      };
      await save();
    }

    if (!inputs.execute) return { state, outcome: "dry-run" };
    if (state.phase === "quoted") {
      await sleep(config.observationWindowMs);
      state = withEvent(state, now, "cancelling", "cancel-requested");
      await save();
    }

    if (state.phase === "cancelling" || state.phase === "recovery-required") {
      const receipt = await bounded(
        "maker cancellation",
        operationTimeoutMs,
        () =>
          gateway.cancelMakerOrders({
            setup: config.makerSetup,
            config: config.config,
            marketIds: [config.marketId],
            signer: inputs.secrets.signer,
          }),
      );
      state = {
        ...withEvent(state, now, "cancelling", "cancel-submitted", {
          digest: receipt?.digest ?? null,
        }),
        cancelDigest: receipt?.digest ?? state.cancelDigest,
        error: null,
      };
      await save();
      const cancelled = await waitFor(
        async () => {
          const observed = await portfolios(
            gateway,
            config,
            inputs.secrets.agentAddress,
            operationTimeoutMs,
          );
          try {
            assertNoResting(observed, config.marketId);
            return true;
          } catch {
            return false;
          }
        },
        CANARY_MAX_WAIT_MS,
        config.pollMs,
        sleep,
      );
      if (!cancelled)
        throw new Error("Canary cancellation could not be confirmed");
    }

    // A venue may index a fill after its cancellation transaction. Keep the
    // canary in recovery mode during that visibility window rather than
    // calling it an unfilled run and freeing the account pair too early.
    const afterCancel = await observeSettlement({
      gateway,
      config,
      agentAddress: inputs.secrets.agentAddress,
      sleep,
      operationTimeoutMs,
    });
    assertNoResting(afterCancel, config.marketId);
    const makerAfterCancel = positionFor(afterCancel.maker, config.marketId);
    const hedgeAfterCancel = positionFor(afterCancel.hedge, config.marketId);
    const combinedBeforeHedge =
      makerAfterCancel.inventoryUsd + hedgeAfterCancel.inventoryUsd;
    if (
      Math.abs(makerAfterCancel.inventoryUsd) >
        config.maxQuoteUsd + toleranceUsd ||
      Math.abs(hedgeAfterCancel.inventoryUsd) >
        config.maxQuoteUsd + toleranceUsd
    ) {
      throw new Error("Canary observed position exceeds its single-fill cap");
    }
    if (Math.abs(combinedBeforeHedge) > toleranceUsd && !state.hedgeDigest) {
      state = withEvent(state, now, "hedging", "hedge-requested", {
        deltaUsd: combinedBeforeHedge,
      });
      await save();
      const receipt = await bounded(
        "hedge submission",
        operationTimeoutMs,
        () =>
          gateway.executeHedge({
            setup: config.hedgeSetup,
            config: config.config,
            signer: inputs.secrets.signer,
            marketId: config.marketId,
            deltaUsd: combinedBeforeHedge,
            maxOrderUsd: config.maxQuoteUsd,
            maxSlippage: config.config.hedge.maxSlippageBps / 10_000,
            builderCode: config.builderCode,
            shouldContinue: () => true,
          }),
      );
      state = {
        ...withEvent(state, now, "hedging", "hedge-submitted", {
          digest: receipt.digest,
        }),
        hedgeDigest: receipt.digest,
      };
      await save();
      const hedged = await waitFor(
        async () => {
          const observed = await portfolios(
            gateway,
            config,
            inputs.secrets.agentAddress,
            operationTimeoutMs,
          );
          const maker = positionFor(observed.maker, config.marketId);
          const hedge = positionFor(observed.hedge, config.marketId);
          return (
            Math.abs(maker.inventoryUsd + hedge.inventoryUsd) <= toleranceUsd
          );
        },
        CANARY_MAX_WAIT_MS,
        config.pollMs,
        sleep,
      );
      if (!hedged)
        throw new Error("Canary hedge was not visible in account positions");
    }

    state = withEvent(state, now, "flattening", "flatten-requested");
    await save();
    const flattenDigests: string[] = [];
    for (const setup of [config.makerSetup, config.hedgeSetup]) {
      const receipt = await bounded(
        "position flatten",
        operationTimeoutMs,
        () =>
          gateway.flattenPositions({
            setup,
            config: config.config,
            signer: inputs.secrets.signer,
            marketIds: [config.marketId],
            maxSlippage: config.config.hedge.maxSlippageBps / 10_000,
          }),
      );
      if (receipt)
        flattenDigests.push(...(receipt.digests ?? [receipt.digest]));
    }
    state = {
      ...withEvent(state, now, "flattening", "flatten-submitted", {
        transactions: flattenDigests.length,
      }),
      flattenDigests: [...state.flattenDigests, ...flattenDigests],
    };
    await save();
    const flat = await confirmFlatReads({
      gateway,
      config,
      agentAddress: inputs.secrets.agentAddress,
      toleranceUsd,
      sleep,
      operationTimeoutMs,
    });
    if (!flat)
      throw new Error("Canary flatten did not prove both accounts flat");
    state = {
      ...withEvent(state, now, "complete", "flat-confirmed"),
      error: null,
    };
    await save();
    return {
      state,
      outcome: state.hedgeDigest ? "filled-and-flat" : "no-fill",
    };
  } catch (error) {
    return fail(error);
  }
}
