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
    maxLeverage: market.overrides?.maxLeverage ?? config.maxLeverage,
  };
}

export type MarketObservation = {
  marketId: string;
  bestBid: number;
  bestAsk: number;
  indexPrice: number;
  observedAt: Date;
};

const round = (value: number, decimals = 8) => Number(value.toFixed(decimals));

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
    observation.indexPrice <= 0
  ) {
    throw new Error("Orderbook and index prices must be positive");
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

  // Post-only quotes must stay behind the opposite side.
  const bidPrice = Math.min(rawBid, observation.bestAsk - Number.EPSILON);
  const askPrice = Math.max(rawAsk, observation.bestBid + Number.EPSILON);

  if (bidPrice >= askPrice) {
    throw new Error("Calculated quote would self-cross");
  }

  return {
    marketId: observation.marketId,
    observedAt: observation.observedAt.toISOString(),
    bestBid: observation.bestBid,
    bestAsk: observation.bestAsk,
    indexPrice: observation.indexPrice,
    bidPrice: round(bidPrice),
    askPrice: round(askPrice),
    sizeBase: round(config.quoteSizeUsd / mid),
    sizeUsd: config.quoteSizeUsd,
    inventoryUsd,
    unrealizedPnlUsd,
  };
}
