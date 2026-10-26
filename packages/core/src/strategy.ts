import type { MakerConfig, QuoteIntent } from "./schema.js";

export type MarketObservation = {
  marketId: string;
  bestBid: number;
  bestAsk: number;
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

  if (observation.bestBid <= 0 || observation.bestAsk <= 0) {
    throw new Error("Orderbook prices must be positive");
  }
  if (observation.bestBid >= observation.bestAsk) {
    throw new Error("Orderbook is crossed or locked");
  }

  const mid = (observation.bestBid + observation.bestAsk) / 2;
  const halfSpread = config.spreadBps / 20_000;
  const inventoryRatio = Math.max(
    -1,
    Math.min(1, inventoryUsd / config.maxInventoryUsd),
  );
  const skew = inventoryRatio * (config.inventorySkewBps / 10_000);

  const rawBid = mid * (1 - halfSpread - skew);
  const rawAsk = mid * (1 + halfSpread - skew);

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
    bidPrice: round(bidPrice),
    askPrice: round(askPrice),
    sizeBase: round(config.quoteSizeUsd / mid),
    sizeUsd: config.quoteSizeUsd,
    inventoryUsd,
    unrealizedPnlUsd,
  };
}
