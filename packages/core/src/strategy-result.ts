/** How a strategy has done overall, from its fills. Paper and Live are always
 * computed and shown separately: Paper is an estimate, Live is confirmed. */

export type StrategyResultFill = {
  occurredAt: string;
  marketId: string;
  /** Positions are tracked per account, so a hedge leg never nets a maker leg. */
  account: string;
  side: "bid" | "ask";
  price: number;
  sizeUsd: number;
  feesUsd: number;
  /** Live fills carry the venue's realized PnL. Paper fills don't. */
  realizedPnlUsd?: number | null;
};

export type StrategyResult = {
  fills: number;
  volumeUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  feesUsd: number;
  netUsd: number;
  /** Net as a percentage of the strategy's required collateral, or null. */
  returnPct: number | null;
  since: string | null;
};

type Lot = { base: number; costUsd: number };

/**
 * Realized PnL uses average cost per account and market: a fill that reduces a
 * position realizes (exit - average entry) on the reduced amount. Open
 * positions are marked at `marks`, falling back to the last fill price.
 * With `reportedRealized`, the venue's realized PnL is used instead and only
 * `unrealizedPnlUsd` (supplied by the caller from live positions) is added.
 */
export function summarizeStrategyResult(inputs: {
  fills: StrategyResultFill[];
  marks: ReadonlyMap<string, number>;
  requiredCollateralUsd: number;
  reportedRealized?: boolean;
  unrealizedPnlUsd?: number;
}): StrategyResult {
  const fills = [...inputs.fills]
    .filter(
      (fill) =>
        Number.isFinite(fill.price) &&
        fill.price > 0 &&
        Number.isFinite(fill.sizeUsd) &&
        fill.sizeUsd > 0,
    )
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  const lots = new Map<string, Lot>();
  const lastPrice = new Map<string, number>();
  let realized = 0;
  let fees = 0;
  let volume = 0;
  for (const fill of fills) {
    volume += fill.sizeUsd;
    fees += Number.isFinite(fill.feesUsd) ? fill.feesUsd : 0;
    lastPrice.set(fill.marketId, fill.price);
    if (inputs.reportedRealized) {
      realized += fill.realizedPnlUsd ?? 0;
      continue;
    }
    const key = `${fill.account}:${fill.marketId}`;
    const lot = lots.get(key) ?? { base: 0, costUsd: 0 };
    const signed = (fill.side === "bid" ? 1 : -1) * (fill.sizeUsd / fill.price);
    if (lot.base === 0 || Math.sign(lot.base) === Math.sign(signed)) {
      lot.base += signed;
      lot.costUsd += signed * fill.price;
    } else {
      const average = lot.costUsd / lot.base;
      const closing = Math.min(Math.abs(signed), Math.abs(lot.base));
      realized += closing * (fill.price - average) * Math.sign(lot.base);
      const remaining = Math.abs(signed) - closing;
      lot.base -= Math.sign(lot.base) * closing;
      lot.costUsd = lot.base * average;
      if (remaining > 1e-12) {
        // The fill flipped the position: the rest opens at this price.
        lot.base = Math.sign(signed) * remaining;
        lot.costUsd = lot.base * fill.price;
      }
      if (Math.abs(lot.base) < 1e-12) {
        lot.base = 0;
        lot.costUsd = 0;
      }
    }
    lots.set(key, lot);
  }
  let unrealized = inputs.reportedRealized ? (inputs.unrealizedPnlUsd ?? 0) : 0;
  if (!inputs.reportedRealized) {
    for (const [key, lot] of lots) {
      if (lot.base === 0) continue;
      const marketId = key.slice(key.indexOf(":") + 1);
      const mark = inputs.marks.get(marketId) ?? lastPrice.get(marketId);
      if (mark === undefined) continue;
      unrealized += lot.base * mark - lot.costUsd;
    }
  }
  const net = realized + unrealized - fees;
  return {
    fills: fills.length,
    volumeUsd: volume,
    realizedPnlUsd: realized,
    unrealizedPnlUsd: unrealized,
    feesUsd: fees,
    netUsd: net,
    returnPct:
      inputs.requiredCollateralUsd > 0 && fills.length
        ? (net / inputs.requiredCollateralUsd) * 100
        : null,
    since: fills[0]?.occurredAt ?? null,
  };
}
