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
  /** Null only for historical data recorded before strategy versioning. */
  configVersion: number | null;
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

/** Non-fill effects remain separate from the fill ledger so a transfer or a
 * reward cannot accidentally become trading P&L. Signed USD values are income
 * when positive and costs when negative. */
export type InventoryLedgerEffect = {
  sourceEventKey: string;
  runId: string | null;
  configVersion: number | null;
  accountId: string;
  marketId: string | null;
  timestampMs: number;
  kind: "funding" | "gas" | "hedge" | "unwind" | "transfer";
  fundingUsd: DecimalString | null;
  gasUsedMist: string | null;
  gasUsd: DecimalString | null;
  externalTransferUsd: DecimalString | null;
  source: string;
  network: string;
  coverage: Coverage;
  raw: unknown;
};

export type InventoryPositionReconciliation = {
  accountId: string;
  marketId: string;
  expectedBase: DecimalString;
  observedBase: DecimalString | null;
};

export type InventoryOwnershipObservation = {
  accountId: string;
  parentCapId: string | null;
};

export type InventoryReconciliationReason =
  | "source_coverage_incomplete"
  | "missing_attributed_fill"
  | "unresolved_counterparty"
  | "known_same_parent"
  | "ownership_unresolved"
  | "position_unresolved";

export type InventoryReconciliation = {
  state: "reconciled" | "unresolved";
  /** Risk-increasing actions must use this, not merely a stale last success. */
  riskIncreasingAllowed: boolean;
  reasons: InventoryReconciliationReason[];
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

/**
 * The Paper model accepts a book observation only after a quote was resting.
 * A touch is deliberately not a fill: the queue in front of Maker's quote is
 * unknown.  A strict trade-through is conservative evidence that the level
 * was consumed.  This model remains entirely simulated and has no reward
 * field by design.
 */
export type InventoryPaperQuote = {
  side: "bid" | "ask";
  priceUsd: DecimalString;
  restingAtMs: number;
};

export type InventoryPaperBookObservation = {
  bestBidUsd: DecimalString | null;
  bestAskUsd: DecimalString | null;
  observedAtMs: number;
  coverage: Coverage;
};

export type InventoryPaperFillDecision = {
  estimatedFill: boolean;
  reason:
    | "trade_through"
    | "quote_not_resting"
    | "book_unavailable"
    | "book_not_proven";
};

/** A source-aware Markout record. Positive USD is favorable to the maker. */
export type InventoryPaperMarkout = {
  horizonMs: number;
  observedAtMs: number;
  markoutUsd: DecimalString | null;
  coverage: Coverage;
};

/**
 * A retained Paper markout is evidence about the simulated fill, not P&L. It
 * records exactly which later reference price was available at the requested
 * horizon so a missing mark can never be rendered as a zero loss.
 */
export type InventoryPaperMarkoutObservation = InventoryPaperMarkout & {
  sourceEventKey: string;
  runId: string;
  orderKey: string;
  marketId: string;
  fillAtMs: number;
  fillPriceUsd: DecimalString;
  side: "bid" | "ask";
  baseAssetAmount: DecimalString;
  referenceUsd: DecimalString | null;
  source: string;
  network: string;
  raw: unknown;
};

/**
 * A policy decision is append-only evidence. It explains a changed quote or
 * a pause without pretending a simulated fill was independently observed.
 */
export type InventoryQuoteDecision = {
  decisionKey: string;
  runId: string;
  marketId: string;
  observedAtMs: number;
  action: "quote" | "resize" | "widen" | "skew" | "pause";
  reason: string;
  policy: "fixed" | "adaptive";
  coverage: Coverage;
  detail: Record<string, unknown>;
};

/**
 * The first adaptive control is deliberately Paper-only and conservative. It
 * waits for a meaningful, recent sample of completed five-minute markouts
 * before it can suppress a fresh quote.  It is evidence, not P&L: a negative
 * markout says the simulated maker fill was selected adversely after it
 * happened, not that the strategy lost this amount.
 *
 * Keep this policy versioned and visible rather than inferring a zero loss
 * from missing observations.  Live quoting must opt into a separately
 * reviewed control; it never reaches this helper from the runtime today.
 */
export const PAPER_ADVERSE_SELECTION_POLICY = {
  horizonMs: 300_000,
  windowMs: 24 * 60 * 60_000,
  minimumMeasuredFills: 12,
  /** A maker loses at least 50 bps to the five-minute reference on average. */
  maximumAverageMarkoutBps: -50,
} as const;

export type PaperAdverseSelectionObservation = {
  fillAtMs: number;
  sizeUsd: number;
  markoutUsd: number | null;
  coverage: Coverage;
};

export type PaperAdverseSelectionEvidence = {
  state: "collecting" | "within_limit" | "blocked";
  measuredFills: number;
  unavailableFills: number;
  makerNotionalUsd: number;
  totalMarkoutUsd: number | null;
  averageMarkoutBps: number | null;
  windowStartedAtMs: number;
  policy: typeof PAPER_ADVERSE_SELECTION_POLICY;
};

/**
 * Scores only completed fixed-horizon Paper markouts inside a rolling window.
 * Incomplete marks stay counted as unavailable evidence, never as a free zero
 * loss.  The result is pure so the runtime, results API and fixtures cannot
 * accidentally use different guard thresholds.
 */
export function evaluatePaperAdverseSelection(inputs: {
  asOfMs: number;
  observations: readonly PaperAdverseSelectionObservation[];
  policy?: typeof PAPER_ADVERSE_SELECTION_POLICY;
}): PaperAdverseSelectionEvidence {
  if (!Number.isInteger(inputs.asOfMs) || inputs.asOfMs < 0) {
    throw new Error(
      "Paper adverse-selection time must be a non-negative integer",
    );
  }
  const policy = inputs.policy ?? PAPER_ADVERSE_SELECTION_POLICY;
  const windowStartedAtMs = inputs.asOfMs - policy.windowMs;
  let measuredFills = 0;
  let unavailableFills = 0;
  let makerNotionalUsd = 0;
  let totalMarkoutUsd = 0;
  for (const observation of inputs.observations) {
    if (
      !Number.isInteger(observation.fillAtMs) ||
      observation.fillAtMs < windowStartedAtMs ||
      observation.fillAtMs > inputs.asOfMs
    ) {
      continue;
    }
    if (!Number.isFinite(observation.sizeUsd) || observation.sizeUsd < 0) {
      throw new Error("Paper adverse-selection size must be non-negative");
    }
    if (
      observation.coverage !== "complete" ||
      observation.markoutUsd === null ||
      !Number.isFinite(observation.markoutUsd) ||
      observation.sizeUsd <= 0
    ) {
      unavailableFills += 1;
      continue;
    }
    measuredFills += 1;
    makerNotionalUsd += observation.sizeUsd;
    totalMarkoutUsd += observation.markoutUsd;
  }
  const averageMarkoutBps =
    makerNotionalUsd > 0 ? (totalMarkoutUsd / makerNotionalUsd) * 10_000 : null;
  const state =
    measuredFills < policy.minimumMeasuredFills
      ? "collecting"
      : averageMarkoutBps !== null &&
          averageMarkoutBps <= policy.maximumAverageMarkoutBps
        ? "blocked"
        : "within_limit";
  return {
    state,
    measuredFills,
    unavailableFills,
    makerNotionalUsd,
    totalMarkoutUsd: measuredFills ? totalMarkoutUsd : null,
    averageMarkoutBps,
    windowStartedAtMs,
    policy,
  };
}

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

function absoluteUnits(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Decide a simulated fill from a later observed top of book. The observation
 * must be complete and strictly cross the resting quote; equality is merely a
 * touch and cannot establish queue consumption.
 */
export function decideInventoryPaperFill(inputs: {
  quote: InventoryPaperQuote;
  observation: InventoryPaperBookObservation;
}): InventoryPaperFillDecision {
  // SQLite/JS timestamps are millisecond-resolution. An observation invoked
  // after a quote can legitimately share its millisecond, so only a strictly
  // earlier observation is disqualified here.
  if (inputs.observation.observedAtMs < inputs.quote.restingAtMs) {
    return { estimatedFill: false, reason: "quote_not_resting" };
  }
  if (
    inputs.observation.coverage !== "complete" ||
    inputs.observation.bestBidUsd === null ||
    inputs.observation.bestAskUsd === null
  ) {
    return {
      estimatedFill: false,
      reason:
        inputs.observation.bestBidUsd === null ||
        inputs.observation.bestAskUsd === null
          ? "book_unavailable"
          : "book_not_proven",
    };
  }
  const quotePrice = decimalToUnits(inputs.quote.priceUsd);
  const crosses =
    inputs.quote.side === "bid"
      ? decimalToUnits(inputs.observation.bestAskUsd) < quotePrice
      : decimalToUnits(inputs.observation.bestBidUsd) > quotePrice;
  return crosses
    ? { estimatedFill: true, reason: "trade_through" }
    : { estimatedFill: false, reason: "book_not_proven" };
}

/**
 * Computes a side-aware Paper markout from a later index/book reference. A
 * missing or incomplete observation stays visible as null rather than a zero
 * markout. `baseAssetAmount` is positive for the simulated maker fill's
 * absolute base size; direction is taken from the quote side.
 */
export function inventoryPaperMarkout(inputs: {
  quote: Pick<InventoryPaperQuote, "side" | "priceUsd">;
  baseAssetAmount: DecimalString;
  fillAtMs: number;
  horizonMs: number;
  referenceUsd: DecimalString | null;
  referenceObservedAtMs: number | null;
  coverage: Coverage;
}): InventoryPaperMarkout {
  if (!Number.isInteger(inputs.horizonMs) || inputs.horizonMs <= 0) {
    throw new Error("Markout horizon must be a positive integer");
  }
  const expectedAtMs = inputs.fillAtMs + inputs.horizonMs;
  const usable =
    inputs.coverage === "complete" &&
    inputs.referenceUsd !== null &&
    inputs.referenceObservedAtMs !== null &&
    inputs.referenceObservedAtMs >= expectedAtMs;
  if (!usable) {
    return {
      horizonMs: inputs.horizonMs,
      observedAtMs: inputs.referenceObservedAtMs ?? expectedAtMs,
      markoutUsd: null,
      coverage: inputs.coverage,
    };
  }
  const entry = decimalToUnits(inputs.quote.priceUsd);
  const reference = decimalToUnits(inputs.referenceUsd!);
  const base = decimalToUnits(inputs.baseAssetAmount);
  if (base < 0n) throw new Error("Paper base amount must not be negative");
  const direction = inputs.quote.side === "bid" ? 1n : -1n;
  return {
    horizonMs: inputs.horizonMs,
    observedAtMs: inputs.referenceObservedAtMs!,
    markoutUsd: unitsToDecimal(
      (direction * base * (reference - entry)) / DECIMAL_SCALE,
    ),
    coverage: "complete",
  };
}

/** Splits timestamped observations before scoring so an evaluation never
 * silently uses a fill/markout from its own future. */
export function splitInventoryRecyclingHistory<
  T extends { observedAtMs: number },
>(
  observations: readonly T[],
  asOfMs: number,
): { training: T[]; evaluation: T[] } {
  if (!Number.isInteger(asOfMs) || asOfMs < 0) {
    throw new Error("History split timestamp must be a non-negative integer");
  }
  const training: T[] = [];
  const evaluation: T[] = [];
  for (const observation of observations) {
    if (!Number.isInteger(observation.observedAtMs)) {
      throw new Error("Observation timestamp must be an integer");
    }
    if (observation.observedAtMs < asOfMs) training.push(observation);
    else evaluation.push(observation);
  }
  return { training, evaluation };
}

/**
 * The admission boundary for Inventory recycling. This is deliberately more
 * conservative than a reporting summary: incomplete source coverage, an
 * unobserved counterparty or owner, a missing expected fill, and a position
 * that cannot be proved flat/matched all prohibit a new quote.
 */
export function reconcileInventoryRecycling(inputs: {
  coverage: Coverage;
  expectedFillKeys: readonly string[];
  observedFillKeys: readonly string[];
  fills: readonly Pick<AttributedFill, "counterpartyClass">[];
  ownership: readonly InventoryOwnershipObservation[];
  positions: readonly InventoryPositionReconciliation[];
  positionToleranceBase: DecimalString;
}): InventoryReconciliation {
  const reasons = new Set<InventoryReconciliationReason>();
  if (inputs.coverage !== "complete") reasons.add("source_coverage_incomplete");
  const observed = new Set(inputs.observedFillKeys);
  if (inputs.expectedFillKeys.some((key) => !observed.has(key))) {
    reasons.add("missing_attributed_fill");
  }
  if (inputs.fills.some((fill) => fill.counterpartyClass === "unresolved")) {
    reasons.add("unresolved_counterparty");
  }
  if (
    inputs.fills.some((fill) => fill.counterpartyClass === "known_same_parent")
  ) {
    reasons.add("known_same_parent");
  }
  if (inputs.ownership.some((account) => account.parentCapId === null)) {
    reasons.add("ownership_unresolved");
  }
  const tolerance = decimalToUnits(inputs.positionToleranceBase);
  if (tolerance < 0n) {
    throw new Error("Position tolerance must not be negative");
  }
  if (
    inputs.positions.some((position) => {
      if (position.observedBase === null) return true;
      return (
        absoluteUnits(
          decimalToUnits(position.expectedBase) -
            decimalToUnits(position.observedBase),
        ) > tolerance
      );
    })
  ) {
    reasons.add("position_unresolved");
  }
  return {
    state: reasons.size ? "unresolved" : "reconciled",
    riskIncreasingAllowed: reasons.size === 0,
    reasons: [...reasons],
  };
}

/**
 * A trading-only result. Rewards and transfers are excluded by type, and an
 * incomplete effect source returns a visible gap instead of a fabricated net.
 */
export function summarizeInventoryTradingLedger(inputs: {
  fills: readonly Pick<
    AttributedFill,
    | "notionalUsd"
    | "venueFeeUsd"
    | "builderFeeUsd"
    | "realizedPnlUsd"
    | "coverage"
  >[];
  effects: readonly InventoryLedgerEffect[];
}): {
  makerNotionalUsd: DecimalString;
  venueFeesUsd: DecimalString;
  builderFeesUsd: DecimalString;
  realizedPnlUsd: DecimalString;
  fundingUsd: DecimalString | null;
  gasUsd: DecimalString | null;
  tradingNetUsd: DecimalString | null;
  gaps: string[];
} {
  let makerNotional = 0n;
  let venueFees = 0n;
  let builderFees = 0n;
  let realizedPnl = 0n;
  const gaps = new Set<string>();
  for (const fill of inputs.fills) {
    makerNotional += decimalToUnits(fill.notionalUsd);
    venueFees += decimalToUnits(fill.venueFeeUsd);
    builderFees += decimalToUnits(fill.builderFeeUsd ?? "0");
    realizedPnl += decimalToUnits(fill.realizedPnlUsd);
    if (fill.coverage !== "complete") gaps.add("Fill coverage is incomplete.");
  }
  let funding = 0n;
  let gas = 0n;
  let fundingKnown = true;
  let gasKnown = true;
  for (const effect of inputs.effects) {
    if (effect.coverage !== "complete") {
      gaps.add("Effect coverage is incomplete.");
      if (effect.kind === "funding") fundingKnown = false;
      if (effect.kind === "gas") gasKnown = false;
    }
    if (effect.kind === "funding") {
      if (effect.fundingUsd === null) fundingKnown = false;
      else funding += decimalToUnits(effect.fundingUsd);
    }
    if (effect.kind === "gas") {
      if (effect.gasUsd === null) gasKnown = false;
      else gas += decimalToUnits(effect.gasUsd);
    }
  }
  const fundingUsd = fundingKnown ? unitsToDecimal(funding) : null;
  const gasUsd = gasKnown ? unitsToDecimal(gas) : null;
  const tradingNetUsd =
    fundingUsd !== null && gasUsd !== null && gaps.size === 0
      ? unitsToDecimal(realizedPnl + funding - venueFees - builderFees - gas)
      : null;
  return {
    makerNotionalUsd: unitsToDecimal(makerNotional),
    venueFeesUsd: unitsToDecimal(venueFees),
    builderFeesUsd: unitsToDecimal(builderFees),
    realizedPnlUsd: unitsToDecimal(realizedPnl),
    fundingUsd,
    gasUsd,
    tradingNetUsd,
    gaps: [...gaps],
  };
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
