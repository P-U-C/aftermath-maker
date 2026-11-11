/** How a strategy has done overall, from its fills. Paper and Live are always
 * computed and shown separately: Paper is an estimate, Live is confirmed.
 *
 * This is the trading result only. Rewards are never added to it: estimated
 * rewards can't pay for losses, and paid rewards are reported per wallet, not
 * per strategy.
 *
 *   tradingNet = realized price PnL + unrealized price PnL + funding income
 *                - execution fees - builder fees - gas
 *
 * Fees are signed costs: positive is paid, negative is a rebate received at
 * execution, so a rebate is credited exactly once. Funding is signed income.
 * A part that can't be measured is null and named in `gaps`; it is never
 * counted as zero.
 */

export type StrategyResultFill = {
  occurredAt: string;
  marketId: string;
  /** Positions are tracked per account, so a hedge leg never nets a maker leg. */
  account: string;
  side: "bid" | "ask";
  price: number;
  sizeUsd: number;
  /** Venue execution fee as a signed cost: negative is a rebate. */
  executionFeeUsd: number;
  /** Builder (integrator) fee charged on this fill. */
  builderFeeUsd: number;
  /** Live fills carry the venue's realized PnL. Paper fills don't. */
  realizedPnlUsd?: number | null;
};

export type StrategyResult = {
  fills: number;
  volumeUsd: number;
  realizedPricePnlUsd: number;
  unrealizedPricePnlUsd: number;
  executionFeesUsd: number;
  builderFeesUsd: number;
  /** Signed funding income, or null when it can't be measured. */
  fundingUsd: number | null;
  /** Gas spent in USD, or null when it can't be measured. */
  gasUsd: number | null;
  /** The no-rewards result: every known part above, nothing estimated. */
  tradingNetUsd: number;
  /** Trading net as a percentage of the strategy's required collateral. */
  returnPct: number | null;
  since: string | null;
  /** Parts of the result that are missing, in plain words. Empty when whole. */
  gaps: string[];
};

/** Fixed Live post-fill horizons. A Live result reports every one, including
 * unavailable evidence, so a caller cannot silently choose a favorable window.
 */
export const LIVE_MARKOUT_HORIZONS_MS = [
  60_000, 300_000, 1_800_000, 3_600_000,
] as const;

export type LiveMarkoutReference = {
  horizonMs: number;
  observedAtMs: number | null;
  priceUsd: number | null;
};

export type LiveResultEvidenceFillInput = {
  fillId: string;
  occurredAtMs: number;
  side: "bid" | "ask";
  priceUsd: number;
  sizeUsd: number;
  references: readonly LiveMarkoutReference[];
};

export type LiveFillMarkoutEvidence = {
  horizonMs: number;
  expectedAtMs: number;
  observedAtMs: number | null;
  /** Positive USD is favorable to the Live fill. Never a substitute for PnL. */
  markoutUsd: number | null;
  coverage: "complete" | "unavailable";
  reason: string | null;
};

export type LiveResultEvidence = {
  fills: Array<{
    fillId: string;
    markouts: LiveFillMarkoutEvidence[];
  }>;
  /** Signed funding income over this run, or null when its source is unknown. */
  fundingUsd: number | null;
  /** Gas cost over this run, or null when a receipt or its price is unknown. */
  gasUsd: number | null;
  /** Funding minus gas only when both inputs are known; never a fabricated zero. */
  netFundingAfterGasUsd: number | null;
  gaps: string[];
};

const finiteNumberOrNull = (value: number | null): number | null =>
  value !== null && Number.isFinite(value) ? value : null;

/**
 * Builds a read-only Live evidence record from a fill and later market
 * references. It is deliberately separate from `summarizeStrategyResult`:
 * markouts describe post-fill selection, while a trading result describes
 * realized and marked PnL.
 */
export function summarizeLiveResultEvidence(inputs: {
  fills: readonly LiveResultEvidenceFillInput[];
  fundingUsd: number | null;
  gasUsd: number | null;
}): LiveResultEvidence {
  const gaps: string[] = [];
  const fills = inputs.fills.map((fill) => {
    const validFill =
      Number.isInteger(fill.occurredAtMs) &&
      fill.occurredAtMs >= 0 &&
      Number.isFinite(fill.priceUsd) &&
      fill.priceUsd > 0 &&
      Number.isFinite(fill.sizeUsd) &&
      fill.sizeUsd >= 0;
    const markouts = LIVE_MARKOUT_HORIZONS_MS.map((horizonMs) => {
      const expectedAtMs = fill.occurredAtMs + horizonMs;
      const reference = fill.references.find(
        (candidate) => candidate.horizonMs === horizonMs,
      );
      const priceUsd = finiteNumberOrNull(reference?.priceUsd ?? null);
      const observedAtMs = finiteNumberOrNull(reference?.observedAtMs ?? null);
      let reason: string | null = null;
      if (!validFill) reason = "fill data is invalid";
      else if (!reference) reason = "reference is missing";
      else if (priceUsd === null || priceUsd <= 0)
        reason = "reference price is missing";
      else if (observedAtMs === null || !Number.isInteger(observedAtMs))
        reason = "reference time is missing";
      else if (observedAtMs < expectedAtMs)
        reason = "reference arrived before the requested horizon";

      const evidence: LiveFillMarkoutEvidence = reason
        ? {
            horizonMs,
            expectedAtMs,
            observedAtMs,
            markoutUsd: null,
            coverage: "unavailable",
            reason,
          }
        : {
            horizonMs,
            expectedAtMs,
            observedAtMs,
            markoutUsd:
              ((fill.side === "bid" ? 1 : -1) *
                fill.sizeUsd *
                (priceUsd! - fill.priceUsd)) /
              fill.priceUsd,
            coverage: "complete",
            reason: null,
          };
      if (reason)
        gaps.push(
          `Live markout for fill ${fill.fillId} at ${horizonMs}ms is unavailable: ${reason}.`,
        );
      return evidence;
    });
    return { fillId: fill.fillId, markouts };
  });
  const fundingUsd = finiteNumberOrNull(inputs.fundingUsd);
  const gasUsd = finiteNumberOrNull(inputs.gasUsd);
  if (fundingUsd === null) gaps.push("Run funding is unavailable.");
  if (gasUsd === null) gaps.push("Run gas is unavailable.");
  return {
    fills,
    fundingUsd,
    gasUsd,
    netFundingAfterGasUsd:
      fundingUsd !== null && gasUsd !== null ? fundingUsd - gasUsd : null,
    gaps,
  };
}

type Lot = { marketId: string; base: number; costUsd: number };

/**
 * Realized price PnL uses average cost per account and market: a fill that
 * reduces a position realizes (exit - average entry) on the reduced amount.
 * Open positions are marked at `marks`, falling back to the last fill price.
 * With `reportedRealized`, the venue's realized PnL is used instead and only
 * `unrealizedPnlUsd` (supplied by the caller from live positions) is added.
 */
export function summarizeStrategyResult(inputs: {
  fills: StrategyResultFill[];
  marks: ReadonlyMap<string, number>;
  requiredCollateralUsd: number;
  reportedRealized?: boolean;
  unrealizedPnlUsd?: number;
  fundingUsd: number | null;
  gasUsd: number | null;
  gaps?: string[];
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
  const finite = (value: number) => (Number.isFinite(value) ? value : 0);
  let realized = 0;
  let executionFees = 0;
  let builderFees = 0;
  let volume = 0;
  for (const fill of fills) {
    volume += fill.sizeUsd;
    executionFees += finite(fill.executionFeeUsd);
    builderFees += finite(fill.builderFeeUsd);
    lastPrice.set(fill.marketId, fill.price);
    if (inputs.reportedRealized) {
      realized += fill.realizedPnlUsd ?? 0;
      continue;
    }
    const key = `${fill.account}:${fill.marketId}`;
    const lot = lots.get(key) ?? {
      marketId: fill.marketId,
      base: 0,
      costUsd: 0,
    };
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
    for (const lot of lots.values()) {
      if (lot.base === 0) continue;
      const mark =
        inputs.marks.get(lot.marketId) ?? lastPrice.get(lot.marketId);
      if (mark === undefined) continue;
      unrealized += lot.base * mark - lot.costUsd;
    }
  }
  const fundingUsd =
    inputs.fundingUsd !== null && Number.isFinite(inputs.fundingUsd)
      ? inputs.fundingUsd
      : null;
  const gasUsd =
    inputs.gasUsd !== null && Number.isFinite(inputs.gasUsd)
      ? inputs.gasUsd
      : null;
  const tradingNet =
    realized +
    unrealized +
    (fundingUsd ?? 0) -
    executionFees -
    builderFees -
    (gasUsd ?? 0);
  return {
    fills: fills.length,
    volumeUsd: volume,
    realizedPricePnlUsd: realized,
    unrealizedPricePnlUsd: unrealized,
    executionFeesUsd: executionFees,
    builderFeesUsd: builderFees,
    fundingUsd,
    gasUsd,
    tradingNetUsd: tradingNet,
    returnPct:
      inputs.requiredCollateralUsd > 0 && fills.length
        ? (tradingNet / inputs.requiredCollateralUsd) * 100
        : null,
    since: fills[0]?.occurredAt ?? null,
    gaps: fills.length ? [...new Set(inputs.gaps ?? [])] : [],
  };
}

/** Gas in USD from transactions priced when they were spent. */
export function gasCostUsd(
  rows: Array<{ gasUsedMist: number | null; suiUsd: number | null }>,
): { usd: number; priced: number; unpriced: number } {
  let usd = 0;
  let priced = 0;
  let unpriced = 0;
  for (const row of rows) {
    if (row.gasUsedMist === null || !Number.isFinite(row.gasUsedMist)) continue;
    if (row.suiUsd === null || !Number.isFinite(row.suiUsd)) {
      unpriced += 1;
      continue;
    }
    usd += (row.gasUsedMist / 1_000_000_000) * row.suiUsd;
    priced += 1;
  }
  return { usd, priced, unpriced };
}
