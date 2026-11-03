import type { MakerConfig, MakerMarket, QuoteIntent } from "./schema.js";

export function resolveMarketConfig(
  config: MakerConfig,
  market: MakerMarket,
): MakerConfig {
  return {
    ...config,
    markets: config.markets,
    quoteSizeUsd: market.overrides?.quoteSizeUsd ?? config.quoteSizeUsd,
    spreadBps: market.overrides?.spreadBps ?? config.spreadBps,
    maxInventoryUsd:
      market.overrides?.maxInventoryUsd ?? config.maxInventoryUsd,
    inventoryTargetUsd:
      market.overrides?.inventoryTargetUsd ?? config.inventoryTargetUsd,
    inventorySkewBps:
      market.overrides?.inventorySkewBps ?? config.inventorySkewBps,
    maxLeverage: resolveEffectiveLeverage({
      requestedLeverage: market.overrides?.maxLeverage ?? config.maxLeverage,
      ...(market.marketMaxLeverage === undefined
        ? {}
        : { marketMaxLeverage: market.marketMaxLeverage }),
    }),
  };
}

/** Resolve leverage once so quote sizing and capital checks share the cap. */
export function resolveEffectiveLeverage(inputs: {
  requestedLeverage: number;
  marketMaxLeverage?: number | null;
}): number {
  return Math.min(
    inputs.requestedLeverage,
    Math.max(1, inputs.marketMaxLeverage ?? inputs.requestedLeverage),
  );
}

export function marketRiskThresholds(inputs: {
  effectiveLeverage: number;
  maintenanceMarginRatio: number;
}): { minMarginRatio: number; minLiquidationDistanceBps: number } {
  if (inputs.effectiveLeverage <= 3) {
    return { minMarginRatio: 0.12, minLiquidationDistanceBps: 1_000 };
  }
  const cushion = Math.max(
    0,
    1 / inputs.effectiveLeverage - inputs.maintenanceMarginRatio,
  );
  return {
    minMarginRatio: Number(
      Math.min(0.12, inputs.maintenanceMarginRatio + cushion / 2).toFixed(10),
    ),
    minLiquidationDistanceBps: Number(
      Math.min(1_000, cushion * 5_000).toFixed(6),
    ),
  };
}

/** Quote only the side that moves inventory back to its configured target. */
export function reduceOnlyQuoteIntent(inputs: {
  quote: QuoteIntent;
  inventoryUsd: number;
  targetUsd: number;
}): QuoteIntent | null {
  const remainingUsd = Math.abs(inputs.inventoryUsd - inputs.targetUsd);
  if (remainingUsd < 0.000_001) return null;
  const sizeUsd = Math.min(inputs.quote.sizeUsd, remainingUsd);
  return {
    ...inputs.quote,
    sizeUsd,
    sizeBase: (inputs.quote.sizeBase * sizeUsd) / inputs.quote.sizeUsd,
    sides: inputs.inventoryUsd > inputs.targetUsd ? "ask" : "bid",
  };
}

export type MarketObservation = {
  marketId: string;
  bestBid: number;
  bestAsk: number;
  indexPrice: number;
  tickSize: number;
  observedAt: Date;
};

const round = (value: number, decimals = 8) => Number(value.toFixed(decimals));

function tickDecimals(tickSize: number): number {
  const fixed = tickSize.toFixed(12).replace(/0+$/, "");
  const decimal = fixed.indexOf(".");
  return decimal === -1 ? 0 : fixed.length - decimal - 1;
}

function roundToTick(
  value: number,
  tickSize: number,
  direction: "floor" | "ceil",
): number {
  const scaled = value / tickSize;
  const units =
    direction === "floor"
      ? Math.floor(scaled + 1e-9)
      : Math.ceil(scaled - 1e-9);
  return Number((units * tickSize).toFixed(tickDecimals(tickSize)));
}

export function buildQuoteIntent(inputs: {
  config: MakerConfig;
  observation: MarketObservation;
  inventoryUsd: number;
  unrealizedPnlUsd: number;
}): QuoteIntent {
  const { config, observation, inventoryUsd, unrealizedPnlUsd } = inputs;

  if (
    observation.bestBid <= 0 ||
    observation.bestAsk <= 0 ||
    observation.indexPrice <= 0 ||
    !Number.isFinite(observation.tickSize) ||
    observation.tickSize <= 0
  ) {
    throw new Error("Orderbook, index price, and tick size must be positive");
  }
  if (observation.bestBid >= observation.bestAsk) {
    throw new Error("Orderbook is crossed or locked");
  }

  const mid = (observation.bestBid + observation.bestAsk) / 2;
  const fairValue = observation.indexPrice;
  const halfSpread = config.spreadBps / 20_000;
  const inventoryDeltaUsd = inventoryUsd - config.inventoryTargetUsd;
  const inventoryRatio = Math.max(
    -1,
    Math.min(1, inventoryDeltaUsd / config.maxInventoryUsd),
  );
  const skew = inventoryRatio * (config.inventorySkewBps / 10_000);

  const rawBid = fairValue * (1 - halfSpread - skew);
  const rawAsk = fairValue * (1 + halfSpread - skew);

  // Reserve one venue tick before rounding so post-only prices cannot
  // round back onto the opposite side of the book.
  const bidPrice = roundToTick(
    Math.min(rawBid, observation.bestAsk - observation.tickSize),
    observation.tickSize,
    "floor",
  );
  const askPrice = roundToTick(
    Math.max(rawAsk, observation.bestBid + observation.tickSize),
    observation.tickSize,
    "ceil",
  );

  if (
    bidPrice <= 0 ||
    bidPrice >= askPrice ||
    bidPrice >= observation.bestAsk ||
    askPrice <= observation.bestBid
  ) {
    throw new Error("Calculated quote would cross the orderbook");
  }

  return {
    marketId: observation.marketId,
    observedAt: observation.observedAt.toISOString(),
    bestBid: observation.bestBid,
    bestAsk: observation.bestAsk,
    indexPrice: observation.indexPrice,
    bidPrice,
    askPrice,
    sizeBase: round(config.quoteSizeUsd / mid),
    sizeUsd: config.quoteSizeUsd,
    sides: "both",
    inventoryUsd,
    unrealizedPnlUsd,
  };
}
