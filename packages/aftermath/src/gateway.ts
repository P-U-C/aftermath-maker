import {
  Aftermath,
  PerpetualsOrderSide,
  PerpetualsOrderType,
  type PerpetualsAccountCap,
  type PerpetualsAccountMarginHistoryData,
  type PerpetualsMarket,
  type SdkPerpetualsCancelAndPlaceOrdersInputs,
} from "aftermath-ts-sdk";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import {
  assertBuilderFeePolicy,
  assertNoBuilderFee,
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
  makerOrderIds: bigint[];
  hasPosition: boolean;
};

export type PortfolioSnapshot = {
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

export type FlattenReceipt = ExecutionReceipt & {
  flattenedMarketIds: string[];
};

export type HedgeReceipt = ExecutionReceipt & {
  side: "bid" | "ask";
  requestedNotionalUsd: number;
};

const PUBLIC_MAINNET_GRPC = "https://fullnode.mainnet.sui.io:443";
const AFTERMATH_API = "https://aftermath.finance/api";
const REWARD_MARKET_CACHE_MS = 60_000;

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

export function explainTransactionFailure(message: string): string {
  if (
    message.includes("abort code: 46") &&
    message.includes("::clearing_house::execute_limit_order")
  ) {
    return `Market order could not execute within the configured slippage cap. Increase the hedge or flatten slippage only after reviewing this market's depth. Venue error: ${message}`;
  }
  return message;
}

function timestampMs(value: number | bigint): number {
  const numeric = Number(value);
  return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
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
  const effects = tx.effects as
    | {
        gasUsed?: {
          computationCost?: string;
          storageCost?: string;
          storageRebate?: string;
          nonRefundableStorageFee?: string;
        };
      }
    | undefined;
  const gas = effects?.gasUsed;
  if (!gas) return 0;
  const used =
    BigInt(gas.computationCost ?? "0") +
    BigInt(gas.storageCost ?? "0") -
    BigInt(gas.storageRebate ?? "0");
  return Number(used > 0n ? used : 0n);
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

    return markets.map((market, index) => {
      const openInterestBase = Math.abs(market.marketState.openInterest);
      const maxOpenInterestBase = market.marketParams.maxOpenInterest;
      const stats = statsResult.marketsStats[index];
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

  async getMarket(marketId: string): Promise<PerpetualsMarket> {
    const { market } = await this.sdk.Perpetuals().getMarket({ marketId });
    if (!market) throw new Error(`Market ${marketId} was not found`);
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
        return {
          accountId: cap.accountId.toString(),
          accountCapId: cap.objectId,
          collateralCoinType: cap.collateralCoinType,
          equityUsd: account.account.totalEquityUsd,
          availableCollateralUsd: account.account.availableCollateralUsd,
          allocatedCollateralUsd,
          freeMarginUsd,
          positionCount: account.account.positions.filter(
            (position) => position.baseAssetAmount !== 0,
          ).length,
        };
      }),
    );
  }

  async buildCreateAccountTransaction(inputs: {
    ownerAddress: string;
    collateralCoinType: string;
  }): Promise<string> {
    const { tx } = await this.sdk.Perpetuals().getCreateAccountTx({
      walletAddress: inputs.ownerAddress,
      collateralCoinType: inputs.collateralCoinType,
    });
    return this.prepareOwnerTransaction(tx, inputs.ownerAddress);
  }

  async buildDepositCollateralTransaction(inputs: {
    ownerAddress: string;
    accountId: string;
    collateralCoinType: string;
    amount: bigint;
  }): Promise<string> {
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
    return this.prepareOwnerTransaction(tx, inputs.ownerAddress);
  }

  async buildWithdrawCollateralTransaction(inputs: {
    ownerAddress: string;
    accountId: string;
    collateralCoinType: string;
    amount: bigint;
  }): Promise<string> {
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
    const { tx } = await account.getWithdrawCollateralTx({
      withdrawAmount: inputs.amount,
      recipientAddress: inputs.ownerAddress,
    });
    return this.prepareOwnerTransaction(tx, inputs.ownerAddress);
  }

  private async prepareOwnerTransaction(
    tx: Transaction,
    ownerAddress: string,
  ): Promise<string> {
    tx.setSender(ownerAddress);
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
    return tx.toJSON();
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
    const { account } = await this.sdk.Perpetuals().getAccount({
      accountCap: cap,
      marketIds: inputs.marketIds,
    });
    const positions = inputs.marketIds.map((marketId) => {
      const position = account.account.positions.find(
        (candidate) => candidate.marketId === marketId,
      );
      const makerOrderIds =
        position?.pendingOrders
          .filter((order) => isMakerClientOrderId(order.clientOrderId))
          .map((order) => order.orderId) ?? [];
      return {
        marketId,
        baseAssetAmount: position?.baseAssetAmount ?? 0,
        pendingOrderCount: position?.pendingOrders.length ?? 0,
        inventoryUsd: position?.quoteAssetNotionalAmount ?? 0,
        unrealizedPnlUsd:
          (position?.unrealizedPnlUsd ?? 0) +
          (position?.unrealizedFundingsUsd ?? 0),
        collateralUsd: position?.collateralUsd ?? 0,
        freeMarginUsd: position?.freeMarginUsd ?? 0,
        makerOrderIds,
        hasPosition: Boolean(position && position.baseAssetAmount !== 0),
      };
    });
    const gas = await this.client.getBalance({ owner: inputs.agentAddress });

    return {
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
      gasSui: Number(BigInt(gas.balance.coinBalance)) / 1_000_000_000,
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
    const [orders, margin] = await Promise.all([
      account.getOrderHistory({
        limit: inputs.limit ?? 200,
        eventTypes: ["FilledMakerOrder", "FilledTakerOrder"],
      }),
      account.getMarginHistory({ timeframe: "1D" }),
    ]);
    return {
      orders: orders.orders.map((order) => ({
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
      })),
      marginHistory: margin.marginHistoryDatas,
    };
  }

  async buildGrantAgentTransaction(inputs: {
    setup: Setup;
    agentAddress: string;
    gasMist: bigint;
    builderCode: BuilderFeePolicy | null;
  }): Promise<string> {
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
    return this.prepareOwnerTransaction(tx, inputs.setup.ownerAddress);
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
  }): Promise<string> {
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
    return this.prepareOwnerTransaction(tx, inputs.setup.ownerAddress);
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
    const simulation = await this.client.simulateTransaction({
      transaction: tx,
      include: { commandResults: true },
    });
    if (simulation.$kind === "FailedTransaction") {
      throw new Error(
        simulation.FailedTransaction.status.error?.message ??
          "Integrator registration simulation failed",
      );
    }
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
      "Registration succeeded, but its integrator ID could not be verified",
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
    await this.inspectTransaction({ tx, config: inputs.config });
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
  }

  private async inspectTransaction(inputs: {
    tx: Transaction;
    config: MakerConfig;
  }): Promise<void> {
    inputs.tx.setGasBudget(BigInt(inputs.config.maxGasMist));

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
  }

  async flattenPositions(inputs: {
    setup: Setup;
    config: MakerConfig;
    signer: Ed25519Keypair;
    marketIds: string[];
    maxSlippage: number;
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
      marketIds: inputs.marketIds,
    });
    const positions = account.account.positions.filter(
      (position) =>
        inputs.marketIds.includes(position.marketId) &&
        position.baseAssetAmount !== 0,
    );
    if (!positions.length) return null;

    let tx: Transaction | undefined;
    const flattenedMarketIds: string[] = [];
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
    }
    if (!tx || !flattenedMarketIds.length) return null;

    tx.setSender(signerAddress);
    await this.inspectTransaction({ tx, config: inputs.config });
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
      flattenedMarketIds,
    };
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
    await this.inspectTransaction({ tx, config: inputs.config });
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
    const signerAddress = inputs.signer.toSuiAddress();
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

    const request = buildQuoteReplacementRequest({
      marketId: inputs.quote.marketId,
      bidPrice: market.roundToValidPriceBigInt({
        price: roundedBidPrice,
      }),
      askPrice: market.roundToValidPriceBigInt({
        price: roundedAskPrice,
      }),
      size: market.roundToValidSizeBigInt({
        size: roundedSizeBase,
      }),
      leverage: inputs.config.maxLeverage,
      hasPosition: Boolean(position),
      activeMakerOrderIds,
      activeMakerClientOrderIds,
      clientOrderIds: nextMakerClientOrderIds(),
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
    await this.inspectTransaction({ tx, config: inputs.config });
    if (!inputs.shouldContinue()) {
      throw new Error("Live execution cancelled before signing");
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
  }
}
