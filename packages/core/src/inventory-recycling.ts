/**
 * Durable, source-aware contracts for the measured Inventory recycling
 * strategy. Monetary values stay as decimal strings at this boundary: source
 * precision is evidence, and callers must not turn it into binary floats just
 * to persist it.
 */

export type DecimalString = string;

export type Coverage = "complete" | "partial" | "stale" | "unavailable";

export type CounterpartyClass =
  "known_same_parent" | "verified_other_parent" | "unresolved";

export type SourceCheckpoint = {
  source: string;
  network: string;
  cursor: string | null;
  coverage: Coverage;
  observedAtMs: number;
  missingReason: string | null;
};

export type InventoryMarketObservation = {
  marketId: string;
  observedAtMs: number;
  sourceTimestampMs: number | null;
  indexUsd: DecimalString;
  bestBidUsd: DecimalString;
  bestAskUsd: DecimalString;
  depthBid50BpsUsd: DecimalString;
  depthAsk50BpsUsd: DecimalString;
  volume24hUsd: DecimalString;
  openInterestUsd: DecimalString;
  fundingRateRaw: string;
  fundingPeriodMs: number;
  makerFeeRate: DecimalString;
  takerFeeRate: DecimalString;
  sessionOpen: boolean;
  source: string;
  network: string;
  coverage: Coverage;
  raw: unknown;
};

export type AttributedFill = {
  sourceEventKey: string;
  runId: string;
  accountId: string;
  ownerWallet: string;
  marketId: string;
  orderId: string | null;
  txDigest: string;
  eventIndex: number | null;
  timestampMs: number;
  side: "buy" | "sell";
  liquidity: "maker" | "taker";
  sizeBase: DecimalString;
  priceUsd: DecimalString;
  notionalUsd: DecimalString;
  venueFeeUsd: DecimalString;
  builderFeeUsd: DecimalString | null;
  realizedPnlUsd: DecimalString;
  counterpartyClass: CounterpartyClass;
  classificationEvidence: string[];
  source: string;
  network: string;
  coverage: Coverage;
  raw: unknown;
};

export type RewardAllocation = {
  epoch: number;
  ownerWallet: string;
  status: "estimate" | "final_export" | "paid_verified";
  makerRewardUsd: DecimalString;
  takerRewardUsd: DecimalString;
  makerVolumeRebateUsd: DecimalString;
  makerFeeRebateUsd: DecimalString;
  takerFeeRebateUsd: DecimalString;
  referralUsd: DecimalString;
  integratorUsd: DecimalString;
  sourceFetchedAtMs: number;
  source: string;
  network: string;
  coverage: Coverage;
  raw: unknown;
};

/** Parent-cap evidence is deliberately strict: an unseen counterparty is not
 * evidence of independent volume. */
export function classifyCounterparty(inputs: {
  ownerParentCapId: string | null;
  counterpartyParentCapId: string | null;
}): CounterpartyClass {
  if (!inputs.ownerParentCapId || !inputs.counterpartyParentCapId) {
    return "unresolved";
  }
  return inputs.ownerParentCapId === inputs.counterpartyParentCapId
    ? "known_same_parent"
    : "verified_other_parent";
}

/** A canonical on-chain event never needs a heuristic hash. Sources that omit
 * the event index must supply their own stable normalized-event fingerprint. */
export function sourceEventKey(inputs: {
  network: string;
  txDigest: string;
  eventIndex: number | null;
  normalizedEventFingerprint?: string;
}): string {
  if (inputs.eventIndex !== null) {
    if (!Number.isInteger(inputs.eventIndex) || inputs.eventIndex < 0) {
      throw new Error("Event index must be a non-negative integer");
    }
    return `${inputs.network}:${inputs.txDigest}:${inputs.eventIndex}`;
  }
  if (!inputs.normalizedEventFingerprint) {
    throw new Error("Missing normalized event fingerprint");
  }
  return `${inputs.network}:${inputs.txDigest}:hash:${inputs.normalizedEventFingerprint}`;
}

export function isDecimalString(value: string): value is DecimalString {
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}

export type InventoryRecyclingReason =
  | "session_closed"
  | "book_unavailable"
  | "insufficient_volume"
  | "insufficient_balanced_depth"
  | "open_interest_unavailable"
  | "stale_or_incomplete_coverage"
  | "same_parent_detected"
  | "insufficient_evidence"
  | "non_positive_no_reward_edge";

/**
 * Inputs are pre-computed from source-aware observations. The scorer neither
 * guesses a missing cost nor turns a wallet-level reward into a trade result.
 * Decimal strings preserve the source boundary; the calculation below uses
 * fixed-point integers instead of JavaScript floating point.
 */
export type InventoryRecyclingScoreInput = {
  marketId: string;
  symbol: string;
  coverage: Coverage;
  sessionOpen: boolean;
  bestBidUsd: DecimalString;
  bestAskUsd: DecimalString;
  volume24hUsd: DecimalString;
  openInterestUsd: DecimalString;
  depthBid50BpsUsd: DecimalString;
  depthAsk50BpsUsd: DecimalString;
  collateralUsd: DecimalString;
  independentFillSample: number;
  knownSameParentFills: number;
  unresolvedFills: number;
  expectedIndependentFillsPerDay: DecimalString;
  expectedCapturedSpreadUsdPerFill: DecimalString;
  expectedMakerCreditUsdPerFill: DecimalString;
  expectedBuilderFeeUsdPerFill: DecimalString;
  expectedAdverseMarkoutUsdPerFill: DecimalString;
  expectedCarryAndFundingUsdPerFill: DecimalString;
  expectedHedgeAndUnwindUsdPerFill: DecimalString;
  expectedQuoteGasUsdPerDay: DecimalString;
  tailReserveUsdPerDay: DecimalString;
  /** A display-only hypothesis. It never enters no-reward economics. */
  rewardSignal?: DecimalString | null;
};

export type InventoryRecyclingScorePolicy = {
  minimumVolume24hUsd: DecimalString;
  minimumBalancedDepthUsd: DecimalString;
  minimumIndependentFillSample: number;
};

export type InventoryRecyclingScore = {
  marketId: string;
  symbol: string;
  eligible: boolean;
  reasons: InventoryRecyclingReason[];
  independentFillSample: number;
  knownSameParentFills: number;
  unresolvedFills: number;
  expectedGrossMakerEdgeUsdPerFill: DecimalString | null;
  expectedNoRewardUsdPerDay: DecimalString | null;
  expectedNoRewardUsdPerCollateralDay: DecimalString | null;
  /** Kept separate so callers cannot accidentally add it to trading P&L. */
  rewardSignal: DecimalString | null;
};

const DECIMAL_SCALE = 100_000_000n;

function decimalToUnits(value: DecimalString): bigint {
  if (!isDecimalString(value)) {
    throw new Error(`Invalid decimal value: ${value}`);
  }
  const negative = value.startsWith("-");
  const [wholePart = "0", fractionalPart = ""] = (
    negative ? value.slice(1) : value
  ).split(".");
  const fraction = `${fractionalPart}00000000`.slice(0, 8);
  const units = BigInt(wholePart) * DECIMAL_SCALE + BigInt(fraction);
  return negative ? -units : units;
}

function unitsToDecimal(value: bigint): DecimalString {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / DECIMAL_SCALE;
  const fraction = (absolute % DECIMAL_SCALE)
    .toString()
    .padStart(8, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function multiplyUnits(left: bigint, right: bigint): bigint {
  return (left * right) / DECIMAL_SCALE;
}

function allFiniteCounts(...counts: number[]): boolean {
  return counts.every((count) => Number.isInteger(count) && count >= 0);
}

/**
 * Produces a conservative, no-reward rank. A structural failure or incomplete
 * evidence never becomes a zero-cost estimate. Rewards remain an adjacent
 * hypothesis and cannot make an otherwise negative market eligible.
 */
export function scoreInventoryRecyclingMarket(
  input: InventoryRecyclingScoreInput,
  policy: InventoryRecyclingScorePolicy,
): InventoryRecyclingScore {
  if (
    !allFiniteCounts(
      input.independentFillSample,
      input.knownSameParentFills,
      input.unresolvedFills,
    )
  ) {
    throw new Error("Fill counts must be non-negative integers");
  }
  if (
    !Number.isInteger(policy.minimumIndependentFillSample) ||
    policy.minimumIndependentFillSample < 1
  ) {
    throw new Error(
      "Minimum independent fill sample must be a positive integer",
    );
  }
  const bestBid = decimalToUnits(input.bestBidUsd);
  const bestAsk = decimalToUnits(input.bestAskUsd);
  const volume = decimalToUnits(input.volume24hUsd);
  const openInterest = decimalToUnits(input.openInterestUsd);
  const bidDepth = decimalToUnits(input.depthBid50BpsUsd);
  const askDepth = decimalToUnits(input.depthAsk50BpsUsd);
  const reasons: InventoryRecyclingReason[] = [];
  if (!input.sessionOpen) reasons.push("session_closed");
  if (bestBid <= 0n || bestAsk <= 0n || bestAsk < bestBid) {
    reasons.push("book_unavailable");
  }
  if (volume < decimalToUnits(policy.minimumVolume24hUsd)) {
    reasons.push("insufficient_volume");
  }
  if (
    bidDepth < decimalToUnits(policy.minimumBalancedDepthUsd) ||
    askDepth < decimalToUnits(policy.minimumBalancedDepthUsd)
  ) {
    reasons.push("insufficient_balanced_depth");
  }
  if (openInterest <= 0n) reasons.push("open_interest_unavailable");
  if (input.coverage !== "complete")
    reasons.push("stale_or_incomplete_coverage");
  if (input.knownSameParentFills > 0) reasons.push("same_parent_detected");
  if (input.independentFillSample < policy.minimumIndependentFillSample) {
    reasons.push("insufficient_evidence");
  }

  const grossMakerEdge =
    decimalToUnits(input.expectedCapturedSpreadUsdPerFill) +
    decimalToUnits(input.expectedMakerCreditUsdPerFill) -
    decimalToUnits(input.expectedBuilderFeeUsdPerFill) -
    decimalToUnits(input.expectedAdverseMarkoutUsdPerFill) -
    decimalToUnits(input.expectedCarryAndFundingUsdPerFill) -
    decimalToUnits(input.expectedHedgeAndUnwindUsdPerFill);
  const expectedPerDay =
    multiplyUnits(
      decimalToUnits(input.expectedIndependentFillsPerDay),
      grossMakerEdge,
    ) -
    decimalToUnits(input.expectedQuoteGasUsdPerDay) -
    decimalToUnits(input.tailReserveUsdPerDay);
  const collateral = decimalToUnits(input.collateralUsd);
  if (expectedPerDay <= 0n) reasons.push("non_positive_no_reward_edge");
  const economicsKnown = !reasons.some((reason) =>
    ["stale_or_incomplete_coverage", "insufficient_evidence"].includes(reason),
  );
  const economics =
    economicsKnown && collateral > 0n
      ? {
          gross: unitsToDecimal(grossMakerEdge),
          perDay: unitsToDecimal(expectedPerDay),
          perCollateralDay: unitsToDecimal(
            (expectedPerDay * DECIMAL_SCALE) / collateral,
          ),
        }
      : null;
  return {
    marketId: input.marketId,
    symbol: input.symbol,
    eligible: reasons.length === 0,
    reasons,
    independentFillSample: input.independentFillSample,
    knownSameParentFills: input.knownSameParentFills,
    unresolvedFills: input.unresolvedFills,
    expectedGrossMakerEdgeUsdPerFill: economics?.gross ?? null,
    expectedNoRewardUsdPerDay: economics?.perDay ?? null,
    expectedNoRewardUsdPerCollateralDay: economics?.perCollateralDay ?? null,
    rewardSignal: input.rewardSignal ?? null,
  };
}

/** Positive proven economics first; every ineligible or uncertain row stays
 * below it. A tie is deterministic so a refreshed snapshot cannot reorder
 * markets merely from iteration order. */
export function rankInventoryRecyclingMarkets(
  inputs: readonly InventoryRecyclingScoreInput[],
  policy: InventoryRecyclingScorePolicy,
): InventoryRecyclingScore[] {
  return inputs
    .map((input) => scoreInventoryRecyclingMarket(input, policy))
    .sort((left, right) => {
      if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
      const leftScore = left.expectedNoRewardUsdPerCollateralDay;
      const rightScore = right.expectedNoRewardUsdPerCollateralDay;
      if (leftScore !== null && rightScore !== null) {
        const difference =
          decimalToUnits(rightScore) - decimalToUnits(leftScore);
        if (difference !== 0n) return difference > 0n ? 1 : -1;
      }
      if (leftScore !== null) return -1;
      if (rightScore !== null) return 1;
      return left.marketId.localeCompare(right.marketId);
    });
}
