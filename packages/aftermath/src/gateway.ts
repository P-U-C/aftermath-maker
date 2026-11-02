import {
  Aftermath,
  PerpetualsOrderSide,
  PerpetualsOrderType,
  type PerpetualsAccountCap,
  type PerpetualsAccountMarginHistoryData,
  type PerpetualsAccountMarginHistoryTimeframeKey,
  type PerpetualsAccountOrderHistoryData,
  type PerpetualsMarket,
  type SdkPerpetualsCancelAndPlaceOrdersInputs,
} from "aftermath-ts-sdk";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import {
  assertOwnerSimulationEffects,
  assertOwnerTransactionIntent,
  serializeOwnerTransactionIntent,
  type OwnerTransactionIntent,
  type PreparedOwnerTransaction,
} from "./owner-transaction-intent.js";
import {
  assertAgentSimulationEffects,
  assertAgentTransactionIntent,
  type AgentTransactionIntent,
} from "./transaction-intent.js";
import {
  assertBuilderFeePolicy,
  assertNoBuilderFee,
  PriorityMutationQueue,
  rankRewardMarkets,
  rewardEpochWindow,
  type BuilderFeePolicy,
  type MakerConfig,
  type QuoteIntent,
  type RewardMarketEvidence,
  type RewardMarketOpportunity,
  type Setup,
  type StrategyObjective,
} from "@puc/core";

export type MarketSummary = {
  id: string;
  symbol: string;
  displayName: string;
  indexPrice: number;
  collateralPrice: number;
  collateralCoinType: string;
  tickSize: number;
  lotSize: number;
  minOrderUsdValue: number;
  openInterestBase: number;
  openInterestUsd: number;
  openInterestUtilizationPct: number | null;
  maxOpenInterestBase: number;
  fundingRate: number;
  makerFee: number;
  category: string | null;
  sessionOpen: boolean | null;
  sessionNextTransitionAt: number | null;
  volume24hUsd: number | null;
  priceChange24hPct: number | null;
};

export type RewardAccountSnapshot = {
  accountId: string;
  maker: {
    qScore: number;
    qScoreShare: number;
    uptime: number;
    rewardsSui: number;
    volumeUsd: number;
    volumeShare: number;
    volumeRebateUsd: number;
    feeRebateUsd: number;
    feesPaidUsd: number;
  };
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
    accounts: RewardAccountSnapshot[];
  };
  marketModel: {
    label: "heuristic";
    methodology: string;
    depthBandBps: 50;
    opportunities: RewardMarketOpportunity[];
  };
};

export type PositionSnapshot = {
  marketId: string;
  baseAssetAmount: number;
  pendingOrderCount: number;
  inventoryUsd: number;
  unrealizedPnlUsd: number;
  collateralUsd: number;
  freeMarginUsd: number;
  marginRatio?: number | null;
  liquidationPrice?: number | null;
  markPrice?: number | null;
  liquidationDistanceBps?: number | null;
  makerOrderIds: bigint[];
  hasPosition: boolean;
};

export type PortfolioSnapshot = {
  markedAt: string;
  equityUsd: number;
  availableCollateralUsd: number;
  allocatedCollateralUsd: number;
  freeMarginUsd: number;
  withdrawableCollateralUsd: number;
  grossExposureUsd: number;
  unrealizedPnlUsd: number;
  gasSui: number;
  positions: PositionSnapshot[];
};

export type OwnerAccountSummary = {
  accountId: string;
  accountCapId: string;
  collateralCoinType: string;
  equityUsd: number;
  availableCollateralUsd: number;
  allocatedCollateralUsd: number;
  freeMarginUsd: number;
  positionCount: number;
  withdrawableCollateralUsd: number;
  openMakerOrderCount: number;
  /** Current venue-marked notional of this account's open positions. */
  exposureUsd?: number;
  unrealizedPnlUsd?: number;
};

export type PerformanceOrder = {
  timestampMs: number;
  txDigest: string;
  marketId: string;
  eventType: string;
  side: "bid" | "ask";
  price: number;
  size: number;
  orderId: string | null;
  realizedPnlUsd: number;
  feesUsd: number;
  maker: boolean;
};

export type AccountPerformanceHistory = {
  orders: PerformanceOrder[];
  marginHistory: PerpetualsAccountMarginHistoryData[];
  historyComplete?: boolean;
};

export type AccountSnapshot = PositionSnapshot & {
  equityUsd: number;
  openOrderIds: bigint[];
};

export type EndpointHealth = {
  url: string;
  preferred: boolean;
  ok: boolean;
  chainIdentifier: string | null;
  latencyMs: number;
  error: string | null;
};

export type ExecutionReceipt = {
  digest: string;
  endpoint: string;
  gasUsedMist: number;
  postedOrderIds: string[];
};

/** A fully-built, chain-simulated quote that was never signed or broadcast. */
export type PaperQuoteReceipt = {
  endpoint: string;
  gasUsedMist: number;
};

export type FlattenReceipt = ExecutionReceipt & {
  flattenedMarketIds: string[];
  digests?: string[];
  residualMarketIds?: string[];
};

export type HedgeReceipt = ExecutionReceipt & {
  side: "bid" | "ask";
  requestedNotionalUsd: number;
};

const PUBLIC_MAINNET_GRPC = "https://fullnode.mainnet.sui.io:443";
const AFTERMATH_API = "https://aftermath.finance/api";
const AFTERMATH_MAINNET_REGISTRY =
  "0xda0bd7a60182efd662b70e0de99218bbd2b6c4bbe9de23c0bb5a87ec52b37c37";
const AFTERMATH_MAINNET_PACKAGE =
  "0x3ec740df8428aa9c93aaef7f8cc1542ac3194fd014826b51bfe245346d64efc7";
const REWARD_MARKET_CACHE_MS = 60_000;

export const totalSuiBalance = (balance: { balance: string }) =>
  Number(BigInt(balance.balance)) / 1_000_000_000;

export function markPositionInventoryUsd(
  baseAssetAmount: number,
  indexPrice: number,
): number {
  if (
    !Number.isFinite(baseAssetAmount) ||
    !Number.isFinite(indexPrice) ||
    indexPrice <= 0
  ) {
    throw new Error(
      "Position cannot be valued without a positive current index",
    );
  }
  return baseAssetAmount * indexPrice;
}

type GasCoin = {
  objectId: string;
  version: string;
  digest: string;
  balance: string;
};

export function selectGasPaymentCoins(
  coins: GasCoin[],
  budgetMist: bigint,
): Array<{ objectId: string; version: string; digest: string }> {
  const eligible = [...coins].sort((left, right) => {
    const a = BigInt(left.balance);
    const b = BigInt(right.balance);
    return a === b ? 0 : a > b ? -1 : 1;
  });
  const selected: GasCoin[] = [];
  let balance = 0n;
  for (const coin of eligible) {
    selected.push(coin);
    balance += BigInt(coin.balance);
    if (balance >= budgetMist) break;
  }
  if (balance < budgetMist) {
    throw new Error(
      `Agent has ${balance} MIST across gas coins; ${budgetMist} MIST is required`,
    );
  }
  return selected.map(({ objectId, version, digest }) => ({
    objectId,
    version,
    digest,
  }));
}

type RewardOrderbook = {
  marketId: string;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  bestBidPrice: number | null;
  bestAskPrice: number | null;
  midPrice: number | null;
};

function parseRewardOrderbooks(value: unknown): RewardOrderbook[] {
  if (!value || typeof value !== "object") {
    throw new Error("Aftermath returned an invalid orderbook response");
  }
  const orderbooks = (value as { orderbooks?: unknown }).orderbooks;
  if (!Array.isArray(orderbooks)) {
    throw new Error("Aftermath orderbook response omitted orderbooks");
  }

  return orderbooks.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as {
      marketId?: unknown;
      orderbook?: {
        bids?: unknown;
        asks?: unknown;
        bestBidPrice?: unknown;
        bestAskPrice?: unknown;
        midPrice?: unknown;
      };
    };
    if (
      typeof record.marketId !== "string" ||
      !Array.isArray(record.orderbook?.bids) ||
      !Array.isArray(record.orderbook?.asks)
    ) {
      return [];
    }
    const levels = (items: unknown[]): Array<{ price: number; size: number }> =>
      items.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const level = item as { price?: unknown; size?: unknown };
        return typeof level.price === "number" &&
          Number.isFinite(level.price) &&
          typeof level.size === "number" &&
          Number.isFinite(level.size)
          ? [{ price: level.price, size: level.size }]
          : [];
      });
    const numericOrNull = (item: unknown) =>
      typeof item === "number" && Number.isFinite(item) ? item : null;
    return [
      {
        marketId: record.marketId,
        bids: levels(record.orderbook.bids),
        asks: levels(record.orderbook.asks),
        bestBidPrice: numericOrNull(record.orderbook.bestBidPrice),
        bestAskPrice: numericOrNull(record.orderbook.bestAskPrice),
        midPrice: numericOrNull(record.orderbook.midPrice),
      },
    ];
  });
}

const MAKER_CLIENT_ORDER_PREFIX = 0x5055430000000000n;
const MAKER_CLIENT_ORDER_MASK = 0xffffff0000000000n;
const MAKER_CLIENT_ORDER_NONCE_MASK = 0x0000007fffffffffn;

export const MAKER_BID_CLIENT_ORDER_ID = 0x5055434d4b520001n;
export const MAKER_ASK_CLIENT_ORDER_ID = 0x5055434d4b520002n;

export function isMakerClientOrderId(
  clientOrderId: bigint | undefined,
): boolean {
  return (
    clientOrderId !== undefined &&
    (clientOrderId & MAKER_CLIENT_ORDER_MASK) === MAKER_CLIENT_ORDER_PREFIX
  );
}

export function nextMakerClientOrderIds(nowMs = Date.now()): {
  bid: bigint;
  ask: bigint;
} {
  const nonce =
    (BigInt(Math.max(0, Math.trunc(nowMs))) & MAKER_CLIENT_ORDER_NONCE_MASK) <<
    1n;
  return {
    bid: MAKER_CLIENT_ORDER_PREFIX | nonce,
    ask: MAKER_CLIENT_ORDER_PREFIX | nonce | 1n,
  };
}

export function buildQuoteReplacementRequest(inputs: {
  marketId: string;
  bidPrice: bigint;
  askPrice: bigint;
  size: bigint;
  leverage: number;
  hasPosition: boolean;
  activeMakerOrderIds?: bigint[];
  activeMakerClientOrderIds?: bigint[];
  clientOrderIds?: { bid: bigint; ask: bigint };
  builderCode?: BuilderFeePolicy;
}): SdkPerpetualsCancelAndPlaceOrdersInputs {
  const clientOrderIds = inputs.clientOrderIds ?? {
    bid: MAKER_BID_CLIENT_ORDER_ID,
    ask: MAKER_ASK_CLIENT_ORDER_ID,
  };
  return {
    marketId: inputs.marketId,
    orderIdsToCancel: inputs.activeMakerOrderIds ?? [],
    clientOrderIdsToCancel: inputs.activeMakerClientOrderIds ?? [
      MAKER_BID_CLIENT_ORDER_ID,
      MAKER_ASK_CLIENT_ORDER_ID,
    ],
    ordersToPlace: [
      {
        side: PerpetualsOrderSide.Bid,
        price: inputs.bidPrice,
        size: inputs.size,
        clientOrderId: clientOrderIds.bid,
      },
      {
        side: PerpetualsOrderSide.Ask,
        price: inputs.askPrice,
        size: inputs.size,
        clientOrderId: clientOrderIds.ask,
      },
    ],
    orderType: PerpetualsOrderType.PostOnly,
    reduceOnly: false,
    leverage: inputs.leverage,
    hasPosition: inputs.hasPosition,
    ...(inputs.builderCode ? { builderCode: inputs.builderCode } : {}),
    shouldAbortOnMissingId: false,
  };
}

export function assertRoundedQuoteOrderValue(inputs: {
  symbol: string;
  sizeBase: number;
  bidPrice: number;
  askPrice: number;
  minOrderUsdValue: number;
}): void {
  const roundedNotionalUsd =
    inputs.sizeBase * Math.min(inputs.bidPrice, inputs.askPrice);
  if (roundedNotionalUsd + 1e-9 >= inputs.minOrderUsdValue) return;

  throw new Error(
    `${inputs.symbol} quote rounds to $${roundedNotionalUsd.toFixed(4)}, below the venue's $${inputs.minOrderUsdValue.toFixed(2)} minimum. Restage the market to apply a lot-size buffer.`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isPostOnlyWouldMatch(message: string): boolean {
  return (
    message.includes("abort code: 47") &&
    message.includes("::clearing_house::execute_limit_order")
  );
}

export function explainTransactionFailure(message: string): string {
  if (
    message.includes("abort code: 46") &&
    message.includes("::clearing_house::execute_limit_order")
  ) {
    return `Market order could not execute within the configured slippage cap. Increase the hedge or flatten slippage only after reviewing this market's depth. Venue error: ${message}`;
  }
  if (isPostOnlyWouldMatch(message)) {
    return `Post-only quote would cross the changed book; retrying from a fresh observation. Venue error: ${message}`;
  }
  return message;
}

function timestampMs(value: number | bigint): number {
  const numeric = Number(value);
  return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
}

type TimestampedHistoryOrder = {
  timestamp: number | bigint;
};

export type AccountFillHistoryPage<T extends TimestampedHistoryOrder> = {
  orders: T[];
  nextBeforeTimestampCursor: number | undefined;
};

type AccountFillHistoryCacheEntry<T extends TimestampedHistoryOrder> = {
  orders: T[];
  nextBeforeTimestampCursor: number | undefined;
  sourceComplete: boolean;
};

/**
 * Keeps the immutable tail of each account's fill history in memory. Every
 * request still reads the newest page, so fresh fills are never hidden.
 */
export class AccountFillHistoryCache<T extends TimestampedHistoryOrder> {
  private readonly entries = new Map<string, AccountFillHistoryCacheEntry<T>>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly maxOrders = 10_000,
    private readonly maxAccounts = 16,
  ) {}

  async get(inputs: {
    accountKey: string;
    pageSize: number;
    sinceMs?: number;
    orderKey: (order: T) => string;
    fetchPage: (inputs: {
      beforeTimestampCursor?: number;
      limit: number;
    }) => Promise<AccountFillHistoryPage<T>>;
  }): Promise<{ orders: T[]; historyComplete: boolean }> {
    const pending = this.pending.get(inputs.accountKey);
    if (pending) {
      await pending;
      return this.get(inputs);
    }

    let release: (() => void) | undefined;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending.set(inputs.accountKey, lock);

    try {
      return await this.read(inputs);
    } finally {
      release?.();
      if (this.pending.get(inputs.accountKey) === lock) {
        this.pending.delete(inputs.accountKey);
      }
    }
  }

  private async read(inputs: {
    accountKey: string;
    pageSize: number;
    sinceMs?: number;
    orderKey: (order: T) => string;
    fetchPage: (inputs: {
      beforeTimestampCursor?: number;
      limit: number;
    }) => Promise<AccountFillHistoryPage<T>>;
  }): Promise<{ orders: T[]; historyComplete: boolean }> {
    const firstPage = await inputs.fetchPage({ limit: inputs.pageSize });
    const cached = this.entries.get(inputs.accountKey);
    const merged = cached
      ? this.mergeOrders(cached.orders, firstPage.orders, inputs.orderKey)
      : firstPage.orders;
    const overlapsCache =
      cached !== undefined &&
      firstPage.orders.some((order) =>
        cached.orders.some(
          (cachedOrder) =>
            inputs.orderKey(cachedOrder) === inputs.orderKey(order),
        ),
      );
    const mustRebuild =
      !cached ||
      merged.length > this.maxOrders ||
      (cached.orders.length > 0 &&
        firstPage.orders.length > 0 &&
        !overlapsCache);

    let entry: AccountFillHistoryCacheEntry<T>;
    if (mustRebuild) {
      entry = {
        orders: this.mergeOrders([], firstPage.orders, inputs.orderKey),
        nextBeforeTimestampCursor: firstPage.nextBeforeTimestampCursor,
        sourceComplete: firstPage.nextBeforeTimestampCursor === undefined,
      };
    } else {
      entry = cached;
      entry.orders = merged;
      if (firstPage.nextBeforeTimestampCursor === undefined) {
        entry.nextBeforeTimestampCursor = undefined;
        entry.sourceComplete = true;
      }
    }

    const seenCursors = new Set<number>();
    while (!this.coversWindow(entry, inputs.sinceMs)) {
      const cursor = entry.nextBeforeTimestampCursor;
      if (cursor === undefined || seenCursors.has(cursor)) break;
      seenCursors.add(cursor);

      const remaining = this.maxOrders - entry.orders.length;
      if (remaining <= 0) break;
      const page = await inputs.fetchPage({
        beforeTimestampCursor: cursor,
        limit: Math.min(inputs.pageSize, remaining),
      });
      entry.orders = this.mergeOrders(
        entry.orders,
        page.orders,
        inputs.orderKey,
      );
      entry.nextBeforeTimestampCursor = page.nextBeforeTimestampCursor;
      entry.sourceComplete = page.nextBeforeTimestampCursor === undefined;
    }

    this.touch(inputs.accountKey, entry);
    return {
      orders: entry.orders.filter(
        (order) =>
          inputs.sinceMs === undefined ||
          timestampMs(order.timestamp) >= inputs.sinceMs,
      ),
      historyComplete: this.coversWindow(entry, inputs.sinceMs),
    };
  }

  private coversWindow(
    entry: AccountFillHistoryCacheEntry<T>,
    sinceMs: number | undefined,
  ): boolean {
    if (entry.sourceComplete) return true;
    if (entry.orders.length >= this.maxOrders) return false;
    return (
      sinceMs !== undefined &&
      entry.orders.some((order) => timestampMs(order.timestamp) < sinceMs)
    );
  }

  private mergeOrders(
    cached: T[],
    fresh: T[],
    orderKey: (order: T) => string,
  ): T[] {
    const orders = new Map<string, T>();
    for (const order of cached) orders.set(orderKey(order), order);
    for (const order of fresh) orders.set(orderKey(order), order);
    return [...orders.values()].sort(
      (left, right) =>
        timestampMs(right.timestamp) - timestampMs(left.timestamp),
    );
  }

  private touch(accountKey: string, entry: AccountFillHistoryCacheEntry<T>) {
    this.entries.delete(accountKey);
    this.entries.set(accountKey, entry);
    while (this.entries.size > this.maxAccounts) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export function decodeIntegratorId(bytes: Uint8Array): number {
  if (bytes.byteLength !== 4) {
    throw new Error("Integrator ID must be a four-byte u32");
  }
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(0, true);
}

export function assertIntegratorRegistrationIntent(
  tx: { getData(): unknown },
  ownerAddress: string,
): void {
  const data = tx.getData() as {
    sender?: string | null;
    inputs?: Array<{
      Object?: {
        SharedObject?: { objectId?: string; mutable?: boolean };
      };
    }>;
    commands?: Array<{
      MoveCall?: {
        package?: string;
        module?: string;
        function?: string;
        typeArguments?: string[];
        arguments?: Array<{ Input?: number }>;
      };
    }>;
  };
  const input = data.inputs?.[0]?.Object?.SharedObject;
  const call = data.commands?.[0]?.MoveCall;
  if (
    data.sender?.toLowerCase() !== ownerAddress.toLowerCase() ||
    data.inputs?.length !== 1 ||
    input?.objectId?.toLowerCase() !== AFTERMATH_MAINNET_REGISTRY ||
    input.mutable !== true ||
    data.commands?.length !== 1 ||
    call?.package?.toLowerCase() !== AFTERMATH_MAINNET_PACKAGE ||
    call.module !== "registry" ||
    call.function !== "register_integrator" ||
    call.typeArguments?.length !== 0 ||
    call.arguments?.length !== 1 ||
    call.arguments[0]?.Input !== 0
  ) {
    throw new Error(
      "Integrator registration transaction does not match the pinned Aftermath registry intent",
    );
  }
}

function successfulTransaction(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") {
    throw new Error("Sui returned an invalid execution result");
  }
  const record = result as Record<string, unknown>;
  if (record.$kind === "FailedTransaction") {
    const failed = record.FailedTransaction as
      { status?: { error?: { message?: string } } } | undefined;
    throw new Error(
      failed?.status?.error?.message ?? "Sui transaction execution failed",
    );
  }
  const tx = record.Transaction as Record<string, unknown> | undefined;
  if (!tx || typeof tx.digest !== "string") {
    throw new Error("Sui result did not include a digest");
  }
  return tx;
}

function transactionDigest(result: unknown): string {
  return successfulTransaction(result).digest as string;
}

export function executionGasUsedMist(result: unknown): number {
  const tx = successfulTransaction(result);
  return gasUsedMistFromEffects(tx.effects);
}

function gasUsedMistFromEffects(effects: unknown): number {
  const typedEffects = effects as
    | {
        gasUsed?: {
          computationCost?: string;
          storageCost?: string;
          storageRebate?: string;
          nonRefundableStorageFee?: string;
        };
      }
    | undefined;
  const gas = typedEffects?.gasUsed;
  if (!gas) return 0;
  const used =
    BigInt(gas.computationCost ?? "0") +
    BigInt(gas.storageCost ?? "0") -
    BigInt(gas.storageRebate ?? "0");
  return Number(used > 0n ? used : 0n);
}

function simulationGasUsedMist(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const transaction = (result as { Transaction?: { effects?: unknown } })
    .Transaction;
  return gasUsedMistFromEffects(transaction?.effects);
}

export function postedOrderIds(result: unknown): string[] {
  const tx = successfulTransaction(result);
  const events = Array.isArray(tx.events) ? tx.events : [];
  return events.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const event = value as {
      eventType?: unknown;
      json?: Record<string, unknown> | null;
    };
    if (
      typeof event.eventType !== "string" ||
      !event.eventType.includes("::PostedOrder")
    ) {
      return [];
    }
    const id = event.json?.order_id ?? event.json?.orderId;
    return typeof id === "string" || typeof id === "number" ? [String(id)] : [];
  });
}

export class AftermathGateway {
  private rewardMarketCache:
    | {
        collateralCoinType: string;
        expiresAt: number;
        evidence: RewardMarketEvidence[];
      }
    | undefined;
  private rewardMarketPromise:
    | {
        collateralCoinType: string;
        value: Promise<RewardMarketEvidence[]>;
      }
    | undefined;
  private ownerTrustPromise:
    | Promise<{ protocolPackageId: string; registryObjectId: string }>
    | undefined;
  private readonly accountFillHistory =
    new AccountFillHistoryCache<PerpetualsAccountOrderHistoryData>();
  private readonly mutationQueues = new Map<string, PriorityMutationQueue>();

  private mutationQueue(address: string): PriorityMutationQueue {
    const key = address.toLowerCase();
    const current = this.mutationQueues.get(key);
    if (current) return current;
    const queue = new PriorityMutationQueue();
    this.mutationQueues.set(key, queue);
    return queue;
  }

  private constructor(
    private readonly sdk: Aftermath,
    private readonly client: SuiGrpcClient,
    public readonly endpoint: string,
    public readonly endpointHealth: EndpointHealth[],
  ) {}

  static async create(
    inputs: {
      preferredEndpoint?: string;
      fallbackEndpoint?: string;
    } = {},
  ): Promise<AftermathGateway> {
    const candidates = [
      inputs.preferredEndpoint,
      inputs.fallbackEndpoint ?? PUBLIC_MAINNET_GRPC,
    ].filter((value, index, all): value is string =>
      Boolean(value && all.indexOf(value) === index),
    );

    const health: EndpointHealth[] = [];
    let active:
      | { url: string; client: SuiGrpcClient; chainIdentifier: string }
      | undefined;

    for (const [index, url] of candidates.entries()) {
      const started = Date.now();
      const client = new SuiGrpcClient({
        network: "mainnet",
        baseUrl: url,
      });
      try {
        const response = await client.getChainIdentifier();
        health.push({
          url,
          preferred: index === 0 && Boolean(inputs.preferredEndpoint),
          ok: true,
          chainIdentifier: response.chainIdentifier,
          latencyMs: Date.now() - started,
          error: null,
        });
        active ??= {
          url,
          client,
          chainIdentifier: response.chainIdentifier,
        };
      } catch (error) {
        health.push({
          url,
          preferred: index === 0 && Boolean(inputs.preferredEndpoint),
          ok: false,
          chainIdentifier: null,
          latencyMs: Date.now() - started,
          error: errorMessage(error),
        });
      }
    }

    if (!active) {
      throw new Error(
        `No healthy Sui endpoint: ${health.map((item) => item.error).join("; ")}`,
      );
    }

    const sdk = await Aftermath.create({
      network: "MAINNET",
      fullnodeUrl: active.url,
    });
    return new AftermathGateway(sdk, active.client, active.url, health);
  }

  async listMarkets(collateralCoinType: string): Promise<MarketSummary[]> {
    const perps = this.sdk.Perpetuals();
    const { markets: rawMarkets } = await perps.getAllMarkets({
      collateralCoinType,
    });
    const marketIds = rawMarkets.map((market) => market.marketId);
    const [{ markets }, statsResult] = await Promise.all([
      perps.getMarkets({ marketIds }),
      perps
        .getMarkets24hrStats({ marketIds })
        .catch(() => ({ marketsStats: [] })),
    ]);

    const statsByMarketId = new Map(
      marketIds.map((marketId, index) => [
        marketId.toLowerCase(),
        statsResult.marketsStats[index],
      ]),
    );
    return markets.map((market) => {
      const openInterestBase = Math.abs(market.marketState.openInterest);
      const maxOpenInterestBase = market.marketParams.maxOpenInterest;
      const stats = statsByMarketId.get(market.marketId.toLowerCase());
      const metadata = market.metadata as
        | (NonNullable<typeof market.metadata> & {
            session?: {
              isOpen?: boolean;
              nextTransitionAt?: number;
            };
          })
        | null;
      return {
        id: market.marketId,
        symbol: market.metadata?.symbol ?? market.marketId.slice(0, 10),
        displayName:
          market.metadata?.displayName ??
          market.metadata?.symbol ??
          "Unnamed market",
        indexPrice: market.indexPrice,
        collateralPrice: market.collateralPrice,
        collateralCoinType: market.collateralCoinType,
        tickSize: market.tickSize(),
        lotSize: market.lotSize(),
        minOrderUsdValue: market.marketParams.minOrderUsdValue,
        openInterestBase,
        openInterestUsd: openInterestBase * market.indexPrice,
        openInterestUtilizationPct:
          maxOpenInterestBase > 0
            ? (openInterestBase / maxOpenInterestBase) * 100
            : null,
        maxOpenInterestBase,
        fundingRate: market.estimatedFundingRate(),
        makerFee: market.marketParams.makerFee,
        category: metadata?.category ?? null,
        sessionOpen:
          typeof metadata?.session?.isOpen === "boolean"
            ? metadata.session.isOpen
            : null,
        sessionNextTransitionAt:
          typeof metadata?.session?.nextTransitionAt === "number"
            ? metadata.session.nextTransitionAt
            : null,
        volume24hUsd: stats?.volumeUsd ?? null,
        priceChange24hPct: stats?.priceChangePercentage ?? null,
      };
    });
  }

  private async fetchRewardMarketEvidence(
    collateralCoinType: string,
  ): Promise<RewardMarketEvidence[]> {
    const markets = await this.listMarkets(collateralCoinType);
    const batches = Array.from(
      { length: Math.ceil(markets.length / 10) },
      (_value, index) => markets.slice(index * 10, index * 10 + 10),
    );
    const batchResults = await Promise.all(
      batches.map(async (batch) => {
        try {
          const response = await fetch(
            `${AFTERMATH_API}/perpetuals/markets/orderbooks`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                marketIds: batch.map((market) => market.id),
              }),
              signal: AbortSignal.timeout(15_000),
            },
          );
          if (!response.ok) {
            const detail = (await response.text()).slice(0, 160);
            throw new Error(
              `Aftermath orderbook request failed with HTTP ${response.status}: ${detail}`,
            );
          }
          return {
            orderbooks: parseRewardOrderbooks(await response.json()),
            errors: new Map<string, string>(),
          };
        } catch (error) {
          return {
            orderbooks: [] as RewardOrderbook[],
            errors: new Map(
              batch.map((market) => [market.id, errorMessage(error)]),
            ),
          };
        }
      }),
    );
    const orderbooks = batchResults.flatMap((result) => result.orderbooks);
    const orderbookErrors = new Map(
      batchResults.flatMap((result) => [...result.errors]),
    );

    const booksByMarket = new Map(
      orderbooks.map((orderbook) => [
        orderbook.marketId.toLowerCase(),
        orderbook,
      ]),
    );
    return markets.map((market) => {
      const orderbook = booksByMarket.get(market.id.toLowerCase());
      const bestBid = orderbook?.bestBidPrice ?? null;
      const bestAsk = orderbook?.bestAskPrice ?? null;
      const midpoint =
        orderbook?.midPrice ??
        (bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null);
      const bidFloor = midpoint === null ? null : midpoint * (1 - 0.005);
      const askCeiling = midpoint === null ? null : midpoint * (1 + 0.005);
      const bidDepth50BpsUsd =
        midpoint === null || bidFloor === null
          ? 0
          : (orderbook?.bids ?? [])
              .filter((level) => level.price >= bidFloor)
              .reduce((total, level) => total + level.price * level.size, 0);
      const askDepth50BpsUsd =
        midpoint === null || askCeiling === null
          ? 0
          : (orderbook?.asks ?? [])
              .filter((level) => level.price <= askCeiling)
              .reduce((total, level) => total + level.price * level.size, 0);

      return {
        marketId: market.id,
        symbol: market.symbol,
        indexPrice: market.indexPrice,
        minOrderUsdValue: market.minOrderUsdValue,
        lotSize: market.lotSize,
        volume24hUsd: market.volume24hUsd,
        openInterestUsd: market.openInterestUsd,
        openInterestUtilizationPct: market.openInterestUtilizationPct,
        fundingRate: market.fundingRate,
        priceChange24hPct: market.priceChange24hPct,
        makerFee: market.makerFee,
        sessionOpen: market.sessionOpen,
        bestBid,
        bestAsk,
        bidDepth50BpsUsd,
        askDepth50BpsUsd,
        error:
          orderbookErrors.get(market.id) ??
          (orderbook ? null : "No two-sided orderbook snapshot returned"),
      };
    });
  }

  private async getRewardMarketEvidence(
    collateralCoinType: string,
  ): Promise<RewardMarketEvidence[]> {
    if (
      this.rewardMarketCache &&
      this.rewardMarketCache.collateralCoinType === collateralCoinType &&
      this.rewardMarketCache.expiresAt > Date.now()
    ) {
      return this.rewardMarketCache.evidence;
    }
    if (this.rewardMarketPromise?.collateralCoinType === collateralCoinType) {
      return this.rewardMarketPromise.value;
    }

    const request = this.fetchRewardMarketEvidence(collateralCoinType);
    this.rewardMarketPromise = { collateralCoinType, value: request };
    try {
      const evidence = await request;
      this.rewardMarketCache = {
        collateralCoinType,
        expiresAt: Date.now() + REWARD_MARKET_CACHE_MS,
        evidence,
      };
      return evidence;
    } finally {
      if (this.rewardMarketPromise?.value === request) {
        this.rewardMarketPromise = undefined;
      }
    }
  }

  async getRewardDashboard(inputs: {
    accountIds: string[];
    collateralCoinType: string;
    builderFeeBps: number;
    objective: StrategyObjective;
  }): Promise<RewardDashboard> {
    const uniqueAccountIds = [...new Set(inputs.accountIds)];
    const [evidence, distributionResult] = await Promise.all([
      this.getRewardMarketEvidence(inputs.collateralCoinType),
      uniqueAccountIds.length
        ? this.sdk
            .Rewards()
            .getDistribution({
              accountIds: uniqueAccountIds.map((accountId) =>
                BigInt(accountId),
              ),
              totalMakerRewards: 0,
              totalTakerRewards: 0,
              calculationVariables: {
                qScoreCoefficient: 1,
                uptimeCoefficient: 1,
                mmVolumeCoefficient: 1,
                takerVolumeCoefficient: 1,
                takerOiCoefficient: 1,
              },
            })
            .then((value) => ({ value, error: null as string | null }))
            .catch((error) => ({
              value: null,
              error: errorMessage(error),
            }))
        : Promise.resolve({
            value: null,
            error: null as string | null,
          }),
    ]);

    const accountRows: RewardAccountSnapshot[] = (
      distributionResult.value?.rewards ?? []
    ).map((reward) => ({
      accountId: reward.accountId.toString(),
      maker: {
        qScore: reward.maker.qScore,
        qScoreShare: reward.maker.qScoreFinalShare,
        uptime: Number(reward.maker.uptime),
        rewardsSui: reward.maker.rewards,
        volumeUsd: reward.maker.volume,
        volumeShare: reward.maker.volumeShare,
        volumeRebateUsd: reward.maker.volumeRebate,
        feeRebateUsd: reward.maker.feeRebate,
        feesPaidUsd: reward.maker.feesPaid,
      },
    }));
    const sum = (select: (row: RewardAccountSnapshot) => number) =>
      accountRows.reduce((total, row) => total + select(row), 0);
    const epoch = rewardEpochWindow();

    return {
      asOf: new Date().toISOString(),
      epoch: {
        number: epoch.epoch,
        startedAt: epoch.startedAt,
        cutoffAt: epoch.cutoffAt,
      },
      account: {
        trackedAccountIds: uniqueAccountIds,
        error: distributionResult.error,
        makerRewardsSui: sum((row) => row.maker.rewardsSui),
        qScoreShare: sum((row) => row.maker.qScoreShare),
        uptime: sum((row) => row.maker.uptime),
        makerVolumeUsd: sum((row) => row.maker.volumeUsd),
        makerVolumeShare: sum((row) => row.maker.volumeShare),
        directRebatesUsd: sum(
          (row) => row.maker.volumeRebateUsd + row.maker.feeRebateUsd,
        ),
        baseMakerFeesUsd: sum((row) => row.maker.feesPaidUsd),
        accounts: accountRows,
      },
      marketModel: {
        label: "heuristic",
        methodology:
          "Farming ranks reported turnover and reward signals per dollar near the book. Profit ranks half-spread after known fill costs, then discounts weak depth, movement, and funding risk. Both uses their harmonic mean and requires positive pre-risk edge. These are transparent allocation heuristics, not Aftermath reward or profit forecasts.",
        depthBandBps: 50,
        opportunities: rankRewardMarkets({
          markets: evidence,
          builderFeeBps: inputs.builderFeeBps,
          objective: inputs.objective,
        }),
      },
    };
  }

  private async ownerTransactionTrust(): Promise<{
    protocolPackageId: string;
    registryObjectId: string;
  }> {
    this.ownerTrustPromise ??= this.client
      .getObject({
        objectId: AFTERMATH_MAINNET_REGISTRY,
        include: { content: true },
      })
      .then((result) => {
        const expectedType = `${AFTERMATH_MAINNET_PACKAGE}::registry::Registry`;
        if (result.object?.type !== expectedType) {
          throw new Error(
            "Pinned Aftermath registry does not match the expected mainnet package",
          );
        }
        return {
          protocolPackageId: AFTERMATH_MAINNET_PACKAGE,
          registryObjectId: AFTERMATH_MAINNET_REGISTRY,
        };
      });
    return this.ownerTrustPromise;
  }

  async getMarket(marketId: string): Promise<PerpetualsMarket> {
    const { market } = await this.sdk.Perpetuals().getMarket({ marketId });
    if (!market) throw new Error(`Market ${marketId} was not found`);
    if (market.marketId.toLowerCase() !== marketId.toLowerCase()) {
      throw new Error("Aftermath returned a different market than requested");
    }
    if (
      market.marketData.packageId.toLowerCase() !==
      AFTERMATH_MAINNET_PACKAGE.toLowerCase()
    ) {
      throw new Error("Market is not owned by the pinned Aftermath package");
    }
    return market;
  }

  async getOrderbook(marketId: string) {
    const market = await this.getMarket(marketId);
    const { orderbook } = await market.getOrderbook();
    return { market, orderbook };
  }

  async getOwnedAccountCaps(inputs: {
    walletAddress: string;
    collateralCoinType?: string;
  }): Promise<PerpetualsAccountCap[]> {
    const result = await this.sdk.Perpetuals().getOwnedAccountCaps({
      walletAddress: inputs.walletAddress,
      ...(inputs.collateralCoinType
        ? { collateralCoinTypes: [inputs.collateralCoinType] }
        : {}),
    });
    return result.accountCaps;
  }

  /** Read-only owner-funded trading-key gas balance; no signing path. */
  async getTradingKeyGasSui(agentAddress: string): Promise<number> {
    const result = await this.client.getBalance({ owner: agentAddress });
    return totalSuiBalance(result.balance);
  }

  async listOwnerAccounts(inputs: {
    walletAddress: string;
    collateralCoinType?: string;
  }): Promise<OwnerAccountSummary[]> {
    const caps = await this.getOwnedAccountCaps(inputs);
    const adminCaps = caps.filter((cap) => !cap.isAgent);
    return Promise.all(
      adminCaps.map(async (cap) => {
        const { account } = await this.sdk.Perpetuals().getAccount({
          accountCap: cap,
        });
        const allocatedCollateralUsd = account.account.positions.reduce(
          (sum, position) => sum + position.collateralUsd,
          0,
        );
        const freeMarginUsd = account.account.positions.reduce(
          (sum, position) => sum + position.freeMarginUsd,
          0,
        );
        const openPositions = account.account.positions.filter(
          (position) => position.baseAssetAmount !== 0,
        );
        const marks = openPositions.length
          ? (
              await this.sdk.Perpetuals().getMarkets({
                marketIds: openPositions.map((position) => position.marketId),
              })
            ).markets
          : [];
        const priceByMarket = new Map(
          marks.map((market) => [
            market.marketId.toLowerCase(),
            market.indexPrice,
          ]),
        );
        const marked = openPositions.every((position) => {
          const price = priceByMarket.get(position.marketId.toLowerCase());
          return price !== undefined && Number.isFinite(price) && price > 0;
        });
        return {
          accountId: cap.accountId.toString(),
          accountCapId: cap.objectId,
          collateralCoinType: cap.collateralCoinType,
          equityUsd: account.account.totalEquityUsd,
          availableCollateralUsd: account.account.availableCollateralUsd,
          allocatedCollateralUsd,
          freeMarginUsd,
          positionCount: openPositions.length,
          withdrawableCollateralUsd: account.account.availableCollateralUsd,
          openMakerOrderCount: account.account.positions.reduce(
            (total, position) =>
              total +
              (position.pendingOrders ?? []).filter((order) =>
                isMakerClientOrderId(order.clientOrderId),
              ).length,
            0,
          ),
          ...(marked
            ? {
                exposureUsd: openPositions.reduce(
                  (total, position) =>
                    total +
                    Math.abs(
                      markPositionInventoryUsd(
                        position.baseAssetAmount,
                        priceByMarket.get(position.marketId.toLowerCase())!,
                      ),
                    ),
                  0,
                ),
                unrealizedPnlUsd: openPositions.reduce(
                  (total, position) =>
                    total +
                    (position.unrealizedPnlUsd ?? 0) +
                    (position.unrealizedFundingsUsd ?? 0),
                  0,
                ),
              }
            : {}),
        };
      }),
    );
  }

  async buildCreateAccountTransaction(inputs: {
    ownerAddress: string;
    collateralCoinType: string;
  }): Promise<PreparedOwnerTransaction> {
    const { tx } = await this.sdk.Perpetuals().getCreateAccountTx({
      walletAddress: inputs.ownerAddress,
      collateralCoinType: inputs.collateralCoinType,
    });
    const trust = await this.ownerTransactionTrust();
    return this.prepareOwnerTransaction(tx, inputs.ownerAddress, {
      kind: "create-account",
      sender: inputs.ownerAddress,
      collateralCoinType: inputs.collateralCoinType,
      ...trust,
    });
  }

  async buildDepositCollateralTransaction(inputs: {
    ownerAddress: string;
    accountId: string;
    collateralCoinType: string;
    amount: bigint;
  }): Promise<PreparedOwnerTransaction> {
    if (inputs.amount <= 0n) throw new Error("Deposit amount must be positive");
    const cap = await this.findAccountCap({
      walletAddress: inputs.ownerAddress,
      accountId: inputs.accountId,
      collateralCoinType: inputs.collateralCoinType,
      requireAgent: false,
    });
    const { account } = await this.sdk.Perpetuals().getAccount({
      accountCap: cap,
    });
    const { tx } = await account.getDepositCollateralTx({
      depositAmount: inputs.amount,
    });
    const trust = await this.ownerTransactionTrust();
    return this.prepareOwnerTransaction(tx, inputs.ownerAddress, {
      kind: "deposit",
      sender: inputs.ownerAddress,
      collateralCoinType: inputs.collateralCoinType,
      accountCapId: cap.objectId,
      accountObjectId: cap.accountObjectId,
      allowedMarketIds: account.account.positions.map(
        (position) => position.marketId,
      ),
      amount: inputs.amount,
      ...trust,
    });
  }

  /** Two owner accounts, one wallet signature; never signs or sends in control. */
  async buildDepositCollateralBatchTransaction(inputs: {
    ownerAddress: string;
    collateralCoinType: string;
    deposits: Array<{ accountId: string; amount: bigint }>;
  }): Promise<PreparedOwnerTransaction> {
    if (
      inputs.deposits.length < 1 ||
      inputs.deposits.length > 2 ||
      new Set(inputs.deposits.map((entry) => entry.accountId)).size !==
        inputs.deposits.length ||
      inputs.deposits.some((entry) => entry.amount <= 0n)
    ) {
      throw new Error(
        "Choose one or two different owned accounts with positive amounts",
      );
    }
    let tx = new Transaction();
    const deposits: Array<{
      accountCapId: string;
      accountObjectId: string;
      allowedMarketIds: string[];
      amount: bigint;
    }> = [];
    for (const entry of inputs.deposits) {
      const cap = await this.findAccountCap({
        walletAddress: inputs.ownerAddress,
        accountId: entry.accountId,
        collateralCoinType: inputs.collateralCoinType,
        requireAgent: false,
      });
      const { account } = await this.sdk
        .Perpetuals()
        .getAccount({ accountCap: cap });
      const prepared = await account.getDepositCollateralTx({
        depositAmount: entry.amount,
        tx,
      });
      tx = prepared.tx;
      deposits.push({
        accountCapId: cap.objectId,
        accountObjectId: cap.accountObjectId,
        allowedMarketIds: account.account.positions.map(
          (position) => position.marketId,
        ),
        amount: entry.amount,
      });
    }
    const trust = await this.ownerTransactionTrust();
    return this.prepareOwnerTransaction(tx, inputs.ownerAddress, {
      kind: "deposit-batch",
      sender: inputs.ownerAddress,
      collateralCoinType: inputs.collateralCoinType,
      deposits,
      ...trust,
    });
  }

  async buildTopUpAgentGasTransaction(inputs: {
    ownerAddress: string;
    accountId: string;
    collateralCoinType: string;
    agentAddress: string;
    gasMist: bigint;
  }): Promise<PreparedOwnerTransaction> {
    if (inputs.gasMist < 10_000_000n || inputs.gasMist > 10_000_000_000n) {
      throw new Error("Gas top-up must be between 0.01 and 10 SUI");
    }
    const cap = await this.findAccountCap({
      walletAddress: inputs.ownerAddress,
      accountId: inputs.accountId,
      collateralCoinType: inputs.collateralCoinType,
      requireAgent: false,
    });
    const { account } = await this.sdk
      .Perpetuals()
      .getAccount({ accountCap: cap });
    const tx = new Transaction();
    const [gasCoin] = tx.splitCoins(tx.gas, [inputs.gasMist]);
    tx.transferObjects([gasCoin], inputs.agentAddress);
    const trust = await this.ownerTransactionTrust();
    return this.prepareOwnerTransaction(tx, inputs.ownerAddress, {
      kind: "gas-top-up",
      sender: inputs.ownerAddress,
      collateralCoinType: inputs.collateralCoinType,
      accountCapId: cap.objectId,
      accountObjectId: cap.accountObjectId,
      allowedMarketIds: account.account.positions.map(
        (position) => position.marketId,
      ),
      agentAddress: inputs.agentAddress,
      gasMist: inputs.gasMist,
      ...trust,
    });
  }

  async buildWithdrawCollateralTransaction(inputs: {
    ownerAddress: string;
    accountId: string;
    collateralCoinType: string;
    amount: bigint;
  }): Promise<PreparedOwnerTransaction> {
    if (inputs.amount <= 0n)
      throw new Error("Withdrawal amount must be positive");
    const cap = await this.findAccountCap({
      walletAddress: inputs.ownerAddress,
      accountId: inputs.accountId,
      collateralCoinType: inputs.collateralCoinType,
      requireAgent: false,
    });
    const { account } = await this.sdk.Perpetuals().getAccount({
      accountCap: cap,
    });
    if (
      inputs.amount >
      BigInt(
        Math.max(
          0,
          Math.round(account.account.availableCollateralUsd * 1_000_000),
        ),
      )
    ) {
      throw new Error(
        "Withdrawal exceeds the venue's currently available collateral",
      );
    }
    const { tx } = await account.getWithdrawCollateralTx({
      withdrawAmount: inputs.amount,
      recipientAddress: inputs.ownerAddress,
    });
    const trust = await this.ownerTransactionTrust();
    return this.prepareOwnerTransaction(tx, inputs.ownerAddress, {
      kind: "withdraw",
      sender: inputs.ownerAddress,
      collateralCoinType: inputs.collateralCoinType,
      accountCapId: cap.objectId,
      accountObjectId: cap.accountObjectId,
      allowedMarketIds: account.account.positions.map(
        (position) => position.marketId,
      ),
      amount: inputs.amount,
      recipient: inputs.ownerAddress,
      ...trust,
    });
  }

  private async prepareOwnerTransaction(
    tx: Transaction,
    ownerAddress: string,
    intent: OwnerTransactionIntent,
  ): Promise<PreparedOwnerTransaction> {
    tx.setSender(ownerAddress);
    assertOwnerTransactionIntent(tx, intent);
    tx.setGasBudget(100_000_000n);
    const simulation = await this.client.simulateTransaction({
      transaction: tx,
      include: { effects: true, balanceChanges: true },
    });
    if (simulation.$kind === "FailedTransaction") {
      throw new Error(
        simulation.FailedTransaction.status.error?.message ??
          "Owner transaction simulation failed",
      );
    }
    assertOwnerSimulationEffects(simulation, intent);
    return {
      transaction: await tx.toJSON(),
      intent: serializeOwnerTransactionIntent(intent),
    };
  }

  private async findAccountCap(inputs: {
    walletAddress: string;
    accountId: string;
    collateralCoinType: string;
    requireAgent?: boolean;
  }): Promise<PerpetualsAccountCap> {
    const caps = await this.getOwnedAccountCaps({
      walletAddress: inputs.walletAddress,
      collateralCoinType: inputs.collateralCoinType,
    });
    const cap = caps.find(
      (candidate) =>
        candidate.accountId.toString() === inputs.accountId &&
        (inputs.requireAgent === undefined ||
          candidate.isAgent === inputs.requireAgent),
    );
    if (!cap) {
      throw new Error(
        `No matching ${inputs.requireAgent ? "agent" : "admin"} account capability found`,
      );
    }
    return cap;
  }

  async getAgentPortfolioSnapshot(inputs: {
    setup: Setup;
    agentAddress: string;
    marketIds: string[];
  }): Promise<PortfolioSnapshot> {
    const cap = await this.findAccountCap({
      walletAddress: inputs.agentAddress,
      accountId: inputs.setup.accountId,
      collateralCoinType: inputs.setup.collateralCoinType,
      requireAgent: true,
    });
    const perps = this.sdk.Perpetuals();
    const { account } = await perps.getAccount({
      accountCap: cap,
    });
    const allMarketIds = [
      ...new Set([
        ...inputs.marketIds,
        ...account.account.positions.map((position) => position.marketId),
      ]),
    ];
    const markedAt = new Date().toISOString();
    const markedMarkets = allMarketIds.length
      ? (await perps.getMarkets({ marketIds: allMarketIds })).markets
      : [];
    const indexByMarketId = new Map(
      markedMarkets.map((market) => [
        market.marketId.toLowerCase(),
        market.indexPrice,
      ]),
    );
    const positions = allMarketIds.map((marketId) => {
      const position = account.account.positions.find(
        (candidate) => candidate.marketId === marketId,
      );
      const makerOrderIds =
        position?.pendingOrders
          .filter((order) => isMakerClientOrderId(order.clientOrderId))
          .map((order) => order.orderId) ?? [];
      const hasPosition = Boolean(position && position.baseAssetAmount !== 0);
      const markPrice = hasPosition
        ? (indexByMarketId.get(marketId.toLowerCase()) ?? null)
        : null;
      if (hasPosition && (!markPrice || !Number.isFinite(markPrice))) {
        throw new Error(
          `Current index is unavailable for open position ${marketId}`,
        );
      }
      const liquidationPrice =
        hasPosition && position && position.liquidationPrice > 0
          ? position.liquidationPrice
          : null;
      return {
        marketId,
        baseAssetAmount: position?.baseAssetAmount ?? 0,
        pendingOrderCount: position?.pendingOrders.length ?? 0,
        inventoryUsd:
          hasPosition && position && markPrice
            ? markPositionInventoryUsd(position.baseAssetAmount, markPrice)
            : 0,
        unrealizedPnlUsd:
          (position?.unrealizedPnlUsd ?? 0) +
          (position?.unrealizedFundingsUsd ?? 0),
        collateralUsd: position?.collateralUsd ?? 0,
        freeMarginUsd: position?.freeMarginUsd ?? 0,
        marginRatio: hasPosition ? (position?.marginRatio ?? null) : null,
        liquidationPrice,
        markPrice,
        liquidationDistanceBps: hasPosition
          ? markPrice && liquidationPrice
            ? (Math.abs(markPrice - liquidationPrice) / markPrice) * 10_000
            : 1_000_000_000
          : null,
        makerOrderIds,
        hasPosition,
      };
    });
    const gas = await this.client.getBalance({ owner: inputs.agentAddress });

    return {
      markedAt,
      equityUsd: account.account.totalEquityUsd,
      availableCollateralUsd: account.account.availableCollateralUsd,
      allocatedCollateralUsd: positions.reduce(
        (sum, position) => sum + position.collateralUsd,
        0,
      ),
      freeMarginUsd: positions.reduce(
        (sum, position) => sum + position.freeMarginUsd,
        0,
      ),
      withdrawableCollateralUsd: account.account.availableCollateralUsd,
      grossExposureUsd: positions.reduce(
        (sum, position) => sum + Math.abs(position.inventoryUsd),
        0,
      ),
      unrealizedPnlUsd: positions.reduce(
        (sum, position) => sum + position.unrealizedPnlUsd,
        0,
      ),
      gasSui: totalSuiBalance(gas.balance),
      positions,
    };
  }

  async getAgentAccountSnapshot(inputs: {
    setup: Setup;
    agentAddress: string;
    marketId: string;
  }): Promise<AccountSnapshot> {
    const portfolio = await this.getAgentPortfolioSnapshot({
      setup: inputs.setup,
      agentAddress: inputs.agentAddress,
      marketIds: [inputs.marketId],
    });
    const position = portfolio.positions[0]!;
    return {
      ...position,
      equityUsd: portfolio.equityUsd,
      openOrderIds: position.makerOrderIds,
    };
  }

  async getAccountPerformanceHistory(inputs: {
    setup: Setup;
    agentAddress: string;
    limit?: number;
    timeframe?: PerpetualsAccountMarginHistoryTimeframeKey;
    sinceMs?: number;
  }): Promise<AccountPerformanceHistory> {
    const cap = await this.findAccountCap({
      walletAddress: inputs.agentAddress,
      accountId: inputs.setup.accountId,
      collateralCoinType: inputs.setup.collateralCoinType,
      requireAgent: true,
    });
    const { account } = await this.sdk.Perpetuals().getAccount({
      accountCap: cap,
    });
    const pageSize = Math.min(200, Math.max(1, inputs.limit ?? 200));
    const eventTypes = ["FilledMakerOrder", "FilledTakerOrder"] as const;
    const [history, margin] = await Promise.all([
      this.accountFillHistory.get({
        accountKey: inputs.setup.accountId.toLowerCase(),
        pageSize,
        ...(inputs.sinceMs === undefined ? {} : { sinceMs: inputs.sinceMs }),
        orderKey: (order) =>
          [
            order.txDigest,
            order.orderId ?? "",
            order.eventType,
            order.timestamp,
            order.marketId,
            order.side,
            order.price,
            order.size,
          ].join(":"),
        fetchPage: (pageInputs) =>
          account.getOrderHistory({
            limit: pageInputs.limit,
            eventTypes: [...eventTypes],
            ...(pageInputs.beforeTimestampCursor === undefined
              ? {}
              : {
                  beforeTimestampCursor: pageInputs.beforeTimestampCursor,
                }),
          }),
      }),
      account.getMarginHistory({ timeframe: inputs.timeframe ?? "1D" }),
    ]);

    const orders = history.orders
      .map((order) => ({
        timestampMs: timestampMs(order.timestamp),
        txDigest: order.txDigest,
        marketId: order.marketId,
        eventType: order.eventType,
        side:
          order.side === PerpetualsOrderSide.Bid
            ? ("bid" as const)
            : ("ask" as const),
        price: order.price,
        size: order.size,
        orderId: order.orderId ?? null,
        realizedPnlUsd: order.pnl ?? 0,
        feesUsd: order.fees ?? 0,
        maker: order.eventType.includes("FilledMakerOrder"),
      }))
      .filter(
        (order) =>
          inputs.sinceMs === undefined || order.timestampMs >= inputs.sinceMs,
      );

    return {
      orders,
      marginHistory: margin.marginHistoryDatas.filter(
        (point) =>
          inputs.sinceMs === undefined ||
          timestampMs(point.timestamp) >= inputs.sinceMs,
      ),
      historyComplete: history.historyComplete,
    };
  }

  async buildGrantAgentTransaction(inputs: {
    setup: Setup;
    agentAddress: string;
    gasMist: bigint;
    builderCode: BuilderFeePolicy | null;
  }): Promise<PreparedOwnerTransaction> {
    const cap = await this.findAccountCap({
      walletAddress: inputs.setup.ownerAddress,
      accountId: inputs.setup.accountId,
      collateralCoinType: inputs.setup.collateralCoinType,
      requireAgent: false,
    });
    if (cap.objectId !== inputs.setup.accountCapId) {
      throw new Error("Admin account capability does not match setup");
    }
    const { account } = await this.sdk.Perpetuals().getAccount({
      accountCap: cap,
    });
    let { tx } = await account.getGrantAgentWalletTx({
      recipientAddress: inputs.agentAddress,
    });
    if (inputs.builderCode) {
      ({ tx } = await this.sdk
        .Perpetuals()
        .getCreateBuilderCodeIntegratorConfigTx({
          accountId: BigInt(inputs.setup.accountId),
          integratorId: inputs.builderCode.integratorId,
          maxIntegratorFee: inputs.builderCode.integratorFee,
          tx,
        }));
    }
    const [gasCoin] = tx.splitCoins(tx.gas, [inputs.gasMist]);
    tx.transferObjects([gasCoin], inputs.agentAddress);
    const trust = await this.ownerTransactionTrust();
    return this.prepareOwnerTransaction(tx, inputs.setup.ownerAddress, {
      kind: "grant-agent",
      sender: inputs.setup.ownerAddress,
      collateralCoinType: inputs.setup.collateralCoinType,
      accountCapId: cap.objectId,
      accountObjectId: cap.accountObjectId,
      allowedMarketIds: account.account.positions.map(
        (position) => position.marketId,
      ),
      agentAddress: inputs.agentAddress,
      gasMist: inputs.gasMist,
      builderCode: inputs.builderCode,
      ...trust,
    });
  }

  async verifyAgentGrant(inputs: {
    setup: Setup;
    agentAddress: string;
    digest: string;
    builderCode: BuilderFeePolicy | null;
  }): Promise<{ agentCapId: string }> {
    const result = await this.client.waitForTransaction({
      digest: inputs.digest,
      timeout: 60_000,
      include: { transaction: true, effects: true },
    });
    if (result.$kind === "FailedTransaction") {
      throw new Error(
        result.FailedTransaction.status.error?.message ??
          "Agent authorization transaction failed",
      );
    }
    if (
      result.Transaction.transaction?.sender?.toLowerCase() !==
      inputs.setup.ownerAddress.toLowerCase()
    ) {
      throw new Error("Agent authorization was signed by another wallet");
    }

    const cap = await this.findAccountCap({
      walletAddress: inputs.agentAddress,
      accountId: inputs.setup.accountId,
      collateralCoinType: inputs.setup.collateralCoinType,
      requireAgent: true,
    });
    const createdCap = result.Transaction.effects?.changedObjects.find(
      (change) =>
        change.objectId.toLowerCase() === cap.objectId.toLowerCase() &&
        change.idOperation === "Created",
    );
    if (!createdCap) {
      throw new Error(
        "Transaction did not create the confirmed agent capability",
      );
    }
    if (inputs.builderCode) {
      const approval = await this.sdk
        .Perpetuals()
        .getBuilderCodeIntegratorConfig({
          accountId: BigInt(inputs.setup.accountId),
          integratorId: inputs.builderCode.integratorId,
        });
      if (
        !approval.exists ||
        approval.maxIntegratorFee === undefined ||
        approval.maxIntegratorFee + Number.EPSILON <
          inputs.builderCode.integratorFee
      ) {
        throw new Error("Builder-code approval was not confirmed on-chain");
      }
    }
    return { agentCapId: cap.objectId };
  }

  async buildRevokeAgentTransaction(inputs: {
    setup: Setup;
    agentCapId: string;
    builderCode: BuilderFeePolicy | null;
  }): Promise<PreparedOwnerTransaction> {
    const cap = await this.findAccountCap({
      walletAddress: inputs.setup.ownerAddress,
      accountId: inputs.setup.accountId,
      collateralCoinType: inputs.setup.collateralCoinType,
      requireAgent: false,
    });
    const perps = this.sdk.Perpetuals();
    const { account } = await perps.getAccount({
      accountCap: cap,
    });
    let { tx } = await account.getRevokeAgentWalletTx({
      accountCapId: inputs.agentCapId,
    });
    if (inputs.builderCode) {
      ({ tx } = await perps.getRemoveBuilderCodeIntegratorConfigTx({
        accountId: BigInt(inputs.setup.accountId),
        integratorId: inputs.builderCode.integratorId,
        tx,
      }));
    }
    const trust = await this.ownerTransactionTrust();
    return this.prepareOwnerTransaction(tx, inputs.setup.ownerAddress, {
      kind: "revoke-agent",
      sender: inputs.setup.ownerAddress,
      collateralCoinType: inputs.setup.collateralCoinType,
      accountCapId: cap.objectId,
      accountObjectId: cap.accountObjectId,
      allowedMarketIds: account.account.positions.map(
        (position) => position.marketId,
      ),
      agentCapId: inputs.agentCapId,
      builderCode: inputs.builderCode,
      ...trust,
    });
  }

  async verifyAgentRevocation(inputs: {
    setup: Setup;
    agentAddress: string;
    agentCapId: string;
    digest: string;
    builderCode: BuilderFeePolicy | null;
  }): Promise<void> {
    const result = await this.client.waitForTransaction({
      digest: inputs.digest,
      timeout: 60_000,
      include: { transaction: true, effects: true },
    });
    if (result.$kind === "FailedTransaction") {
      throw new Error(
        result.FailedTransaction.status.error?.message ??
          "Agent revocation transaction failed",
      );
    }
    if (
      result.Transaction.transaction?.sender?.toLowerCase() !==
      inputs.setup.ownerAddress.toLowerCase()
    ) {
      throw new Error("Agent revocation was signed by another wallet");
    }
    const deletedCap = result.Transaction.effects?.changedObjects.find(
      (change) =>
        change.objectId.toLowerCase() === inputs.agentCapId.toLowerCase() &&
        change.idOperation === "Deleted",
    );
    if (!deletedCap) {
      throw new Error(
        "Transaction did not delete the configured agent capability",
      );
    }

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const caps = await this.getOwnedAccountCaps({
        walletAddress: inputs.agentAddress,
        collateralCoinType: inputs.setup.collateralCoinType,
      });
      const agentStillAuthorized = caps.some(
        (candidate) =>
          candidate.isAgent &&
          candidate.accountId.toString() === inputs.setup.accountId,
      );
      const approval = inputs.builderCode
        ? await this.sdk.Perpetuals().getBuilderCodeIntegratorConfig({
            accountId: BigInt(inputs.setup.accountId),
            integratorId: inputs.builderCode.integratorId,
          })
        : { exists: false };
      if (!agentStillAuthorized && !approval.exists) return;
      if (attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    throw new Error(
      "Revocation transaction confirmed, but capability or fee approval still appears active",
    );
  }

  async inspectIntegrator(inputs: { accountId: string; integratorId: number }) {
    const result = await this.sdk.Perpetuals().getBuilderCodeIntegratorConfig({
      accountId: BigInt(inputs.accountId),
      integratorId: inputs.integratorId,
    });
    return {
      accountId: inputs.accountId,
      integratorId: inputs.integratorId,
      exists: result.exists,
      maxIntegratorFee: result.exists ? result.maxIntegratorFee : null,
      evidence: "Aftermath builder-codes/integrator-config",
      checkedAt: new Date().toISOString(),
    };
  }

  async buildIntegratorRegistrationTransaction(ownerAddress: string): Promise<{
    transaction: string;
    expectedIntegratorId: number;
  }> {
    const response = await fetch(
      "https://aftermath.finance/api/perpetuals/builder-codes/transactions/create-integrator-registration",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(15_000),
      },
    );
    const body = (await response.json()) as {
      txKind?: string;
      error?: string;
    };
    if (!response.ok || !body.txKind) {
      throw new Error(
        body.error ?? "Aftermath did not build the registration transaction",
      );
    }
    const tx = Transaction.fromKind(body.txKind);
    tx.setSender(ownerAddress);
    assertIntegratorRegistrationIntent(tx, ownerAddress);
    tx.setGasBudget(100_000_000n);
    const simulation = await this.client.simulateTransaction({
      transaction: tx,
      include: {
        commandResults: true,
        effects: true,
        balanceChanges: true,
      },
    });
    if (simulation.$kind === "FailedTransaction") {
      throw new Error(
        simulation.FailedTransaction.status.error?.message ??
          "Integrator registration simulation failed",
      );
    }
    assertAgentSimulationEffects(simulation, ownerAddress);
    const bytes = simulation.commandResults?.[0]?.returnValues[0]?.bcs;
    if (!bytes) {
      throw new Error("Aftermath did not return the next integrator ID");
    }
    const expectedIntegratorId = decodeIntegratorId(bytes);
    return {
      transaction: await tx.toJSON(),
      expectedIntegratorId,
    };
  }

  async confirmIntegratorRegistration(inputs: {
    digest: string;
    ownerAddress: string;
    expectedIntegratorId: number;
  }): Promise<{ integratorId: number; integratorAddress: string }> {
    const result = await this.client.waitForTransaction({
      digest: inputs.digest,
      timeout: 60_000,
      include: { transaction: true },
    });
    if (result.$kind === "FailedTransaction") {
      throw new Error(
        result.FailedTransaction.status.error?.message ??
          "Integrator registration failed",
      );
    }
    if (
      result.Transaction.transaction?.sender?.toLowerCase() !==
      inputs.ownerAddress.toLowerCase()
    ) {
      throw new Error("Integrator registration was signed by another wallet");
    }

    for (
      let integratorId = inputs.expectedIntegratorId;
      integratorId <= inputs.expectedIntegratorId + 32;
      integratorId += 1
    ) {
      const response = await fetch(
        "https://aftermath.finance/api/perpetuals/builder-codes/integrator-registration",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ integratorId }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) continue;
      const body = (await response.json()) as {
        integratorAddress?: string;
      };
      if (
        body.integratorAddress?.toLowerCase() ===
        inputs.ownerAddress.toLowerCase()
      ) {
        return { integratorId, integratorAddress: body.integratorAddress };
      }
    }

    throw new Error(
      "Registration confirmed on-chain, but its integrator ID could not be resolved",
    );
  }

  async cancelMakerOrders(inputs: {
    setup: Setup;
    marketIds: string[];
    signer: Ed25519Keypair;
    config: MakerConfig;
  }): Promise<ExecutionReceipt | null> {
    const signerAddress = inputs.signer.toSuiAddress();
    const cap = await this.findAccountCap({
      walletAddress: signerAddress,
      accountId: inputs.setup.accountId,
      collateralCoinType: inputs.setup.collateralCoinType,
      requireAgent: true,
    });
    const { account } = await this.sdk.Perpetuals().getAccount({
      accountCap: cap,
      marketIds: inputs.marketIds,
    });
    const marketIdsToData: Record<
      string,
      { orderIds: bigint[]; collateralChange: number }
    > = {};

    for (const position of account.account.positions) {
      const orderIds = position.pendingOrders
        .filter((order) => isMakerClientOrderId(order.clientOrderId))
        .map((order) => order.orderId);
      if (orderIds.length) {
        marketIdsToData[position.marketId] = {
          orderIds,
          collateralChange: 0,
        };
      }
    }

    if (!Object.keys(marketIdsToData).length) return null;

    const { tx } = await account.getCancelOrdersTx({ marketIdsToData });
    tx.setSender(signerAddress);
    const authorities = await Promise.all(
      Object.keys(marketIdsToData).map(async (marketId) => {
        const market = await this.getMarket(marketId);
        return { marketId, packageId: market.marketData.packageId };
      }),
    );
    return this.mutationQueue(signerAddress).run(async () => {
      await this.inspectTransaction({
        tx,
        config: inputs.config,
        intent: {
          kind: "cancel",
          sender: signerAddress,
          accountCapId: cap.objectId,
          accountObjectId: cap.accountObjectId,
          collateralCoinType: inputs.setup.collateralCoinType,
          maxLeverage: inputs.config.maxLeverage,
          markets: authorities,
          builderCode: null,
          orderIdsByMarket: Object.fromEntries(
            Object.entries(marketIdsToData).map(([marketId, data]) => [
              marketId,
              data.orderIds,
            ]),
          ),
        },
      });
      const result = await this.client.signAndExecuteTransaction({
        transaction: tx,
        signer: inputs.signer,
        include: { effects: true, events: true },
      });
      return {
        digest: transactionDigest(result),
        endpoint: this.endpoint,
        gasUsedMist: executionGasUsedMist(result),
        postedOrderIds: [],
      };
    }, "urgent");
  }

  private async setAgentGasPayment(
    tx: Transaction,
    signerAddress: string,
    budgetMist: bigint,
  ): Promise<void> {
    const coins: GasCoin[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.client.listCoins({
        owner: signerAddress,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      coins.push(...page.objects);
      if (
        coins.reduce((total, coin) => total + BigInt(coin.balance), 0n) >=
          budgetMist ||
        !page.hasNextPage
      ) {
        break;
      }
      cursor = page.cursor;
    } while (cursor);

    tx.setGasPayment(selectGasPaymentCoins(coins, budgetMist));
  }

  private async inspectTransaction(inputs: {
    tx: Transaction;
    config: MakerConfig;
    intent: AgentTransactionIntent;
  }): Promise<{ gasUsedMist: number }> {
    assertAgentTransactionIntent(inputs.tx, inputs.intent);
    const gasBudgetMist = BigInt(inputs.config.maxGasMist);
    inputs.tx.setGasBudget(gasBudgetMist);
    await this.setAgentGasPayment(
      inputs.tx,
      inputs.intent.sender,
      gasBudgetMist,
    );

    const simulation = await this.client.simulateTransaction({
      transaction: inputs.tx,
      include: {
        effects: true,
        balanceChanges: true,
      },
    });
    if (simulation.$kind === "FailedTransaction") {
      throw new Error(
        explainTransactionFailure(
          simulation.FailedTransaction.status.error?.message ??
            "Transaction simulation failed",
        ),
      );
    }
    assertAgentSimulationEffects(simulation, inputs.intent.sender);
    return { gasUsedMist: simulationGasUsedMist(simulation) };
  }

  async flattenPositions(inputs: {
    setup: Setup;
    config: MakerConfig;
    signer: Ed25519Keypair;
    marketIds: string[];
    maxSlippage: number;
    fallbackMarketIds?: string[];
  }): Promise<FlattenReceipt | null> {
    const signerAddress = inputs.signer.toSuiAddress();
    const cap = await this.findAccountCap({
      walletAddress: signerAddress,
      accountId: inputs.setup.accountId,
      collateralCoinType: inputs.setup.collateralCoinType,
      requireAgent: true,
    });
    const { account } = await this.sdk.Perpetuals().getAccount({
      accountCap: cap,
    });
    const positions = account.account.positions.filter(
      (position) =>
        position.baseAssetAmount !== 0 &&
        (!inputs.fallbackMarketIds ||
          inputs.fallbackMarketIds.includes(position.marketId)),
    );
    if (!positions.length) return null;

    let tx: Transaction | undefined;
    const flattenedMarketIds: string[] = [];
    const intendedOrders: Array<{
      marketId: string;
      side: "bid" | "ask";
      size: bigint;
    }> = [];
    for (const position of positions) {
      const market = await this.getMarket(position.marketId);
      const size = market.roundToValidSizeBigInt({
        size: Math.abs(position.baseAssetAmount),
        floor: true,
      });
      if (size <= 0n) continue;
      const order = {
        marketId: position.marketId,
        side:
          position.baseAssetAmount > 0
            ? PerpetualsOrderSide.Ask
            : PerpetualsOrderSide.Bid,
        size,
        collateralChange: 0,
        hasPosition: true,
        cancelSlTp: true,
        reduceOnly: true,
        slippage: inputs.maxSlippage,
        leverage: position.leverage,
      };
      assertNoBuilderFee(order);
      ({ tx } = await account.getPlaceMarketOrderTx({
        ...order,
        ...(tx ? { tx } : {}),
      }));
      flattenedMarketIds.push(position.marketId);
      intendedOrders.push({
        marketId: position.marketId,
        side: order.side === PerpetualsOrderSide.Bid ? "bid" : "ask",
        size,
      });
    }
    if (!tx || !flattenedMarketIds.length) return null;

    tx.setSender(signerAddress);
    const verifiedOrders = await Promise.all(
      intendedOrders.map(async (order) => {
        const market = await this.getMarket(order.marketId);
        const tick = BigInt(market.marketParams.tickSize);
        return {
          authority: {
            marketId: order.marketId,
            packageId: market.marketData.packageId,
          },
          order: {
            ...order,
            ...(order.side === "ask"
              ? {
                  minPrice:
                    market.roundToValidPriceBigInt({
                      price: market.indexPrice * (1 - inputs.maxSlippage),
                      floor: true,
                    }) -
                    tick * 2n,
                }
              : {
                  maxPrice:
                    market.roundToValidPriceBigInt({
                      price: market.indexPrice * (1 + inputs.maxSlippage),
                      ceil: true,
                    }) +
                    tick * 2n,
                }),
          },
        };
      }),
    );
    try {
      return await this.mutationQueue(signerAddress).run(async () => {
        await this.inspectTransaction({
          tx,
          config: inputs.config,
          intent: {
            kind: "market",
            sender: signerAddress,
            accountCapId: cap.objectId,
            accountObjectId: cap.accountObjectId,
            collateralCoinType: inputs.setup.collateralCoinType,
            maxLeverage: inputs.config.maxLeverage,
            markets: verifiedOrders.map((item) => item.authority),
            builderCode: null,
            orders: verifiedOrders.map((item) => item.order),
          },
        });
        const result = await this.client.signAndExecuteTransaction({
          transaction: tx,
          signer: inputs.signer,
          include: { effects: true, events: true, balanceChanges: true },
        });
        const digest = transactionDigest(result);
        return {
          digest,
          digests: [digest],
          endpoint: this.endpoint,
          gasUsedMist: executionGasUsedMist(result),
          postedOrderIds: [],
          flattenedMarketIds,
          residualMarketIds: [],
        };
      }, "urgent");
    } catch (error) {
      const detail = errorMessage(error);
      if (
        inputs.fallbackMarketIds ||
        positions.length === 1 ||
        (!detail.includes("abort code: 46") &&
          !detail.includes("configured slippage cap"))
      ) {
        throw error;
      }

      const receipts: FlattenReceipt[] = [];
      const residualMarketIds: string[] = [];
      for (const position of positions) {
        try {
          const receipt = await this.flattenPositions({
            ...inputs,
            fallbackMarketIds: [position.marketId],
          });
          if (receipt) receipts.push(receipt);
        } catch {
          residualMarketIds.push(position.marketId);
        }
      }
      if (!receipts.length && residualMarketIds.length) {
        throw new Error(
          `Per-market flatten failed for ${residualMarketIds.join(", ")} after the portfolio transaction hit its slippage cap`,
        );
      }
      if (!receipts.length) return null;
      const digests = receipts.flatMap(
        (receipt) => receipt.digests ?? [receipt.digest],
      );
      return {
        digest: digests[0]!,
        digests,
        endpoint: this.endpoint,
        gasUsedMist: receipts.reduce(
          (sum, receipt) => sum + receipt.gasUsedMist,
          0,
        ),
        postedOrderIds: [],
        flattenedMarketIds: receipts.flatMap(
          (receipt) => receipt.flattenedMarketIds,
        ),
        residualMarketIds,
      };
    }
  }

  async executeHedge(inputs: {
    setup: Setup;
    config: MakerConfig;
    signer: Ed25519Keypair;
    marketId: string;
    deltaUsd: number;
    maxOrderUsd: number;
    maxSlippage: number;
    builderCode: BuilderFeePolicy | null;
    shouldContinue: () => boolean;
  }): Promise<HedgeReceipt> {
    const signerAddress = inputs.signer.toSuiAddress();
    const cap = await this.findAccountCap({
      walletAddress: signerAddress,
      accountId: inputs.setup.accountId,
      collateralCoinType: inputs.setup.collateralCoinType,
      requireAgent: true,
    });
    const { account } = await this.sdk.Perpetuals().getAccount({
      accountCap: cap,
      marketIds: [inputs.marketId],
    });
    const market = await this.getMarket(inputs.marketId);
    const position = account.account.positions.find(
      (candidate) => candidate.marketId === inputs.marketId,
    );
    const requestedNotionalUsd = Math.min(
      Math.abs(inputs.deltaUsd),
      inputs.maxOrderUsd,
    );
    const size = market.roundToValidSizeBigInt({
      size: requestedNotionalUsd / market.indexPrice,
      floor: true,
    });
    if (size <= 0n) {
      throw new Error("Hedge size is below the market lot size");
    }

    const side =
      inputs.deltaUsd > 0 ? PerpetualsOrderSide.Ask : PerpetualsOrderSide.Bid;
    const order = {
      marketId: inputs.marketId,
      side,
      size,
      collateralChange: 0,
      hasPosition: Boolean(position),
      cancelSlTp: false,
      reduceOnly: false,
      slippage: inputs.maxSlippage,
      leverage: inputs.config.maxLeverage,
      ...(inputs.builderCode ? { builderCode: inputs.builderCode } : {}),
    };
    assertBuilderFeePolicy(order, inputs.builderCode);
    if (!inputs.shouldContinue()) {
      throw new Error("Hedge execution cancelled before transaction build");
    }
    const { tx } = await account.getPlaceMarketOrderTx(order);
    tx.setSender(signerAddress);
    const verifiedMarket = await this.getMarket(inputs.marketId);
    const tick = BigInt(verifiedMarket.marketParams.tickSize);
    return this.mutationQueue(signerAddress).run(async () => {
      if (!inputs.shouldContinue()) {
        throw new Error("Hedge execution cancelled before signing");
      }
      await this.inspectTransaction({
        tx,
        config: inputs.config,
        intent: {
          kind: "market",
          sender: signerAddress,
          accountCapId: cap.objectId,
          accountObjectId: cap.accountObjectId,
          collateralCoinType: inputs.setup.collateralCoinType,
          maxLeverage: inputs.config.maxLeverage,
          markets: [
            {
              marketId: inputs.marketId,
              packageId: verifiedMarket.marketData.packageId,
            },
          ],
          builderCode: inputs.builderCode,
          orders: [
            {
              marketId: inputs.marketId,
              side: side === PerpetualsOrderSide.Bid ? "bid" : "ask",
              size,
              ...(side === PerpetualsOrderSide.Ask
                ? {
                    minPrice:
                      verifiedMarket.roundToValidPriceBigInt({
                        price:
                          verifiedMarket.indexPrice * (1 - inputs.maxSlippage),
                        floor: true,
                      }) -
                      tick * 2n,
                  }
                : {
                    maxPrice:
                      verifiedMarket.roundToValidPriceBigInt({
                        price:
                          verifiedMarket.indexPrice * (1 + inputs.maxSlippage),
                        ceil: true,
                      }) +
                      tick * 2n,
                  }),
            },
          ],
        },
      });
      if (!inputs.shouldContinue()) {
        throw new Error("Hedge execution cancelled before signing");
      }

      const result = await this.client.signAndExecuteTransaction({
        transaction: tx,
        signer: inputs.signer,
        include: { effects: true, events: true, balanceChanges: true },
      });
      return {
        digest: transactionDigest(result),
        endpoint: this.endpoint,
        gasUsedMist: executionGasUsedMist(result),
        postedOrderIds: [],
        side: side === PerpetualsOrderSide.Bid ? "bid" : "ask",
        requestedNotionalUsd,
      };
    });
  }

  private async executeQuoteInternal(inputs: {
    setup: Setup;
    config: MakerConfig;
    quote: QuoteIntent;
    signer?: Ed25519Keypair;
    agentAddress: string;
    simulationOnly: boolean;
    builderCode: BuilderFeePolicy | null;
    shouldContinue: () => boolean;
    knownMakerOrderIds?: bigint[];
    cancelMarketIds?: string[];
    expectedCancelOrderIds?: Record<string, bigint[]>;
  }): Promise<ExecutionReceipt | PaperQuoteReceipt> {
    const signerAddress = inputs.agentAddress;
    const cap = await this.findAccountCap({
      walletAddress: signerAddress,
      accountId: inputs.setup.accountId,
      collateralCoinType: inputs.setup.collateralCoinType,
      requireAgent: true,
    });
    const perps = this.sdk.Perpetuals();
    const marketIds = [
      ...new Set([
        inputs.quote.marketId,
        ...(inputs.cancelMarketIds ?? []).filter(
          (marketId) => marketId !== inputs.quote.marketId,
        ),
      ]),
    ];
    const { account } = await perps.getAccount({
      accountCap: cap,
      marketIds,
    });
    const market = await this.getMarket(inputs.quote.marketId);
    const position = account.account.positions.find(
      (candidate) => candidate.marketId === inputs.quote.marketId,
    );

    const roundedSizeBase = market.roundToValidSize({
      size: inputs.quote.sizeBase,
      floor: true,
    });
    if (roundedSizeBase <= 0) {
      throw new Error("Quote size is below the market lot size");
    }
    const roundedBidPrice = market.roundToValidPrice({
      price: inputs.quote.bidPrice,
      floor: true,
    });
    const roundedAskPrice = market.roundToValidPrice({
      price: inputs.quote.askPrice,
      ceil: true,
    });
    assertRoundedQuoteOrderValue({
      symbol: market.metadata?.symbol ?? inputs.quote.marketId.slice(0, 10),
      sizeBase: roundedSizeBase,
      bidPrice: roundedBidPrice,
      askPrice: roundedAskPrice,
      minOrderUsdValue: market.marketParams.minOrderUsdValue,
    });

    const snapshotMakerOrders =
      position?.pendingOrders.filter((order) =>
        isMakerClientOrderId(order.clientOrderId),
      ) ?? [];
    const activeMakerOrderIds = [
      ...new Set([
        ...(inputs.knownMakerOrderIds ?? []),
        ...snapshotMakerOrders.map((order) => order.orderId),
      ]),
    ];
    const activeMakerClientOrderIds = [
      ...new Set(
        snapshotMakerOrders.flatMap((order) =>
          order.clientOrderId === undefined ? [] : [order.clientOrderId],
        ),
      ),
    ];

    const marketIdsToCancel = new Set(
      (inputs.cancelMarketIds ?? []).filter(
        (marketId) => marketId !== inputs.quote.marketId,
      ),
    );
    const crossMarketCancellations: Record<
      string,
      { orderIds: bigint[]; collateralChange: number }
    > = {};
    for (const candidate of account.account.positions) {
      if (!marketIdsToCancel.has(candidate.marketId)) continue;
      const orderIds = candidate.pendingOrders
        .filter((order) => isMakerClientOrderId(order.clientOrderId))
        .map((order) => order.orderId);
      if (orderIds.length) {
        crossMarketCancellations[candidate.marketId] = {
          orderIds,
          collateralChange: 0,
        };
      }
    }
    for (const marketId of marketIdsToCancel) {
      const expected = inputs.expectedCancelOrderIds?.[marketId] ?? [];
      if (
        expected.length &&
        !crossMarketCancellations[marketId]?.orderIds.length
      ) {
        throw new Error(
          `Single-slot switch blocked: ${marketId} order state is not yet visible`,
        );
      }
    }

    let switchTx: Transaction | undefined;
    if (Object.keys(crossMarketCancellations).length) {
      ({ tx: switchTx } = await account.getCancelOrdersTx({
        marketIdsToData: crossMarketCancellations,
      }));
    }

    const clientOrderIds = nextMakerClientOrderIds();
    const bidPrice = market.roundToValidPriceBigInt({
      price: roundedBidPrice,
    });
    const askPrice = market.roundToValidPriceBigInt({
      price: roundedAskPrice,
    });
    const size = market.roundToValidSizeBigInt({
      size: roundedSizeBase,
    });
    const request = buildQuoteReplacementRequest({
      marketId: inputs.quote.marketId,
      bidPrice,
      askPrice,
      size,
      leverage: inputs.config.maxLeverage,
      hasPosition: Boolean(position),
      activeMakerOrderIds,
      activeMakerClientOrderIds,
      clientOrderIds,
      ...(inputs.builderCode ? { builderCode: inputs.builderCode } : {}),
    });

    if (!inputs.shouldContinue()) {
      throw new Error("Live execution cancelled before transaction build");
    }
    assertBuilderFeePolicy(request, inputs.builderCode);
    const { tx } = await account.getCancelAndPlaceOrdersTx({
      ...request,
      ...(switchTx ? { tx: switchTx } : {}),
    });
    tx.setSender(signerAddress);
    const intentMarketIds = [
      inputs.quote.marketId,
      ...Object.keys(crossMarketCancellations),
    ];
    const authorities = await Promise.all(
      intentMarketIds.map(async (marketId) => {
        const verifiedMarket = await this.getMarket(marketId);
        return {
          marketId,
          packageId: verifiedMarket.marketData.packageId,
        };
      }),
    );
    const orderIdsByMarket: Record<string, bigint[]> = Object.fromEntries(
      Object.entries(crossMarketCancellations).map(([marketId, data]) => [
        marketId,
        data.orderIds,
      ]),
    );
    if (activeMakerOrderIds.length) {
      orderIdsByMarket[inputs.quote.marketId] = activeMakerOrderIds;
    }
    return this.mutationQueue(signerAddress).run(async () => {
      if (!inputs.shouldContinue()) {
        throw new Error("Live execution cancelled before signing");
      }
      const inspection = await this.inspectTransaction({
        tx,
        config: inputs.config,
        intent: {
          kind: "quote",
          sender: signerAddress,
          accountCapId: cap.objectId,
          accountObjectId: cap.accountObjectId,
          collateralCoinType: inputs.setup.collateralCoinType,
          maxLeverage: inputs.config.maxLeverage,
          markets: authorities,
          builderCode: inputs.builderCode,
          marketId: inputs.quote.marketId,
          size,
          bidPrice,
          askPrice,
          bidClientOrderId: clientOrderIds.bid,
          askClientOrderId: clientOrderIds.ask,
          orderIdsByMarket,
        },
      });
      if (inputs.simulationOnly) {
        return { endpoint: this.endpoint, gasUsedMist: inspection.gasUsedMist };
      }
      if (!inputs.shouldContinue()) {
        throw new Error("Live execution cancelled before signing");
      }
      if (!inputs.signer) {
        throw new Error("Live execution requires an agent signer");
      }

      const result = await this.client.signAndExecuteTransaction({
        transaction: tx,
        signer: inputs.signer,
        include: {
          effects: true,
          events: true,
          balanceChanges: true,
        },
      });

      return {
        digest: transactionDigest(result),
        endpoint: this.endpoint,
        gasUsedMist: executionGasUsedMist(result),
        postedOrderIds: postedOrderIds(result),
      };
    });
  }

  /**
   * Build exactly the same quote transaction and run the same on-chain
   * simulation as Live, while deliberately stopping before signing.
   */
  async simulateQuote(inputs: {
    setup: Setup;
    config: MakerConfig;
    quote: QuoteIntent;
    agentAddress: string;
    builderCode: BuilderFeePolicy | null;
    shouldContinue: () => boolean;
    knownMakerOrderIds?: bigint[];
    cancelMarketIds?: string[];
    expectedCancelOrderIds?: Record<string, bigint[]>;
  }): Promise<PaperQuoteReceipt> {
    const receipt = await this.executeQuoteInternal({
      ...inputs,
      simulationOnly: true,
    });
    if ("digest" in receipt) {
      throw new Error("Paper quote unexpectedly reached the signing path");
    }
    return receipt;
  }

  async executeQuote(inputs: {
    setup: Setup;
    config: MakerConfig;
    quote: QuoteIntent;
    signer: Ed25519Keypair;
    builderCode: BuilderFeePolicy | null;
    shouldContinue: () => boolean;
    knownMakerOrderIds?: bigint[];
    cancelMarketIds?: string[];
    expectedCancelOrderIds?: Record<string, bigint[]>;
  }): Promise<ExecutionReceipt> {
    const receipt = await this.executeQuoteInternal({
      ...inputs,
      agentAddress: inputs.signer.toSuiAddress(),
      simulationOnly: false,
    });
    if (!("digest" in receipt)) {
      throw new Error("Live quote did not reach the signing path");
    }
    return receipt;
  }
}
