import type { DecimalString } from "./inventory-recycling.js";
import type { PaperProfitabilityEvidenceResult } from "./paper-profitability-evidence.js";

/**
 * An exact reduced ratio. Ratios are used because a valid measurement window
 * can produce a repeating decimal that cannot be represented losslessly as a
 * finite decimal string.
 */
export type ExactDecimalRatio = Readonly<{
  numerator: string;
  denominator: string;
}>;

export type PaperProfitabilityRankingInput = Readonly<{
  candidateId: string;
  marketId: string;
  measurementWindowMs: number;
  collateralUsd: DecimalString;
  result: PaperProfitabilityEvidenceResult | null;
}>;

export type PaperProfitabilityRankingReason =
  | "malformed_candidate"
  | "malformed_result"
  | "invalid_candidate_id"
  | "invalid_market_id"
  | "invalid_measurement_window_ms"
  | "missing_trading_net_usd"
  | "invalid_trading_net_usd"
  | "non_positive_trading_net_usd"
  | "invalid_collateral_usd"
  | "non_positive_collateral_usd"
  | "result_not_positive"
  | "evidence_gaps_present"
  | "profitability_gaps_present"
  | "incomplete_sample";

/** An allowlisted reporting snapshot. Source evidence is never echoed. */
export type RankedPaperProfitabilityCandidate = Readonly<{
  candidateId: string | null;
  marketId: string | null;
  measurementWindowMs: number | null;
  collateralUsd: DecimalString | null;
  status: "eligible" | "ineligible";
  reasons: readonly PaperProfitabilityRankingReason[];
  netUsdPerDay: ExactDecimalRatio | null;
  netReturnBpsPerDay: ExactDecimalRatio | null;
}>;

type ExactRational = Readonly<{
  numerator: bigint;
  denominator: bigint;
}>;

type ParsedCandidate = Readonly<{
  candidate: RankedPaperProfitabilityCandidate;
  inputIndex: number;
  candidateSortKey: string;
  marketSortKey: string;
  netUsdPerDay: ExactRational | null;
  netReturnBpsPerDay: ExactRational | null;
}>;

type CandidateSnapshot = Readonly<{
  malformed: boolean;
  candidateId: string | null;
  marketId: string | null;
  measurementWindowMs: number | null;
  collateralUsd: string | null;
  result: Readonly<Record<string, unknown>> | null;
}>;

const DECIMAL_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/;
const MAX_DECIMAL_DIGITS = 128;
const MILLISECONDS_PER_DAY = 86_400_000n;
const BASIS_POINTS_PER_UNIT = 10_000n;
const PROFITABILITY_COMPONENTS = [
  "capturedMakerSpread",
  "makerCredit",
  "builderFees",
  "venueFees",
  "adverseFixedHorizonMarkout",
  "carryAndFundingNet",
  "hedgeAndUnwindNet",
  "gas",
] as const;

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function reduceRatio(numerator: bigint, denominator: bigint): ExactRational {
  const normalizedNumerator = denominator < 0n ? -numerator : numerator;
  const normalizedDenominator = denominator < 0n ? -denominator : denominator;
  const divisor = greatestCommonDivisor(
    normalizedNumerator,
    normalizedDenominator,
  );
  return {
    numerator: normalizedNumerator / divisor,
    denominator: normalizedDenominator / divisor,
  };
}

function parseDecimal(value: unknown): ExactRational | null {
  if (typeof value !== "string") return null;
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) return null;

  const whole = match[2]!;
  const fraction = match[3] ?? "";
  if (whole.length + fraction.length > MAX_DECIMAL_DIGITS) return null;

  const magnitude = BigInt(`${whole}${fraction}`);
  const numerator = match[1] === "-" ? -magnitude : magnitude;
  return reduceRatio(numerator, 10n ** BigInt(fraction.length));
}

function snapshotRatio(value: ExactRational): ExactDecimalRatio {
  return {
    numerator: value.numerator.toString(),
    denominator: value.denominator.toString(),
  };
}

function compareRatios(left: ExactRational, right: ExactRational): number {
  const leftProduct = left.numerator * right.denominator;
  const rightProduct = right.numerator * left.denominator;
  if (leftProduct < rightProduct) return -1;
  if (leftProduct > rightProduct) return 1;
  return 0;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function hasValidComponentShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNullableString(value.amountUsd) &&
    (value.coverage === "complete" ||
      value.coverage === "partial" ||
      value.coverage === "stale" ||
      value.coverage === "unavailable")
  );
}

function hasValidResultShape(
  result: Readonly<Record<string, unknown>> | null,
): boolean {
  if (result === null) return false;
  const components = result.components;
  const excluded = result.excluded;
  return (
    (result.status === "positive" ||
      result.status === "non_positive" ||
      result.status === "unavailable") &&
    typeof result.sampleSize === "number" &&
    typeof result.minimumSampleSize === "number" &&
    isNullableString(result.tradingNetUsd) &&
    Array.isArray(result.gaps) &&
    Array.isArray(result.evidenceGaps) &&
    Array.isArray(result.fixedHorizonEvidence) &&
    isRecord(components) &&
    PROFITABILITY_COMPONENTS.every((name) =>
      hasValidComponentShape(components[name]),
    ) &&
    isRecord(excluded) &&
    isNullableString(excluded.rewardsUsd) &&
    isNullableString(excluded.transfersUsd)
  );
}

function snapshotCandidate(input: unknown): CandidateSnapshot {
  if (!isRecord(input)) {
    return {
      malformed: true,
      candidateId: null,
      marketId: null,
      measurementWindowMs: null,
      collateralUsd: null,
      result: null,
    };
  }

  const candidateId =
    typeof input.candidateId === "string" ? input.candidateId : null;
  const marketId = typeof input.marketId === "string" ? input.marketId : null;
  const measurementWindowMs =
    typeof input.measurementWindowMs === "number" &&
    Number.isFinite(input.measurementWindowMs)
      ? input.measurementWindowMs
      : null;
  const collateralUsd =
    typeof input.collateralUsd === "string" ? input.collateralUsd : null;
  const result = isRecord(input.result) ? input.result : null;

  return {
    malformed:
      candidateId === null ||
      marketId === null ||
      typeof input.measurementWindowMs !== "number" ||
      collateralUsd === null,
    candidateId,
    marketId,
    measurementWindowMs,
    collateralUsd,
    result,
  };
}

function hasCompleteSample(
  result: Readonly<Record<string, unknown>> | null,
): boolean {
  if (result === null) return false;
  return (
    typeof result.sampleSize === "number" &&
    Number.isSafeInteger(result.sampleSize) &&
    result.sampleSize > 0 &&
    typeof result.minimumSampleSize === "number" &&
    Number.isSafeInteger(result.minimumSampleSize) &&
    result.minimumSampleSize > 0 &&
    result.sampleSize >= result.minimumSampleSize
  );
}

function parseCandidate(input: unknown, inputIndex: number): ParsedCandidate {
  const reasons: PaperProfitabilityRankingReason[] = [];
  const snapshot = snapshotCandidate(input);
  const result = snapshot.result;

  if (snapshot.malformed) reasons.push("malformed_candidate");
  if (!hasValidResultShape(result)) reasons.push("malformed_result");

  if (snapshot.candidateId === null || snapshot.candidateId.trim() === "") {
    reasons.push("invalid_candidate_id");
  }
  if (snapshot.marketId === null || snapshot.marketId.trim() === "") {
    reasons.push("invalid_market_id");
  }

  const windowIsValid =
    snapshot.measurementWindowMs !== null &&
    Number.isSafeInteger(snapshot.measurementWindowMs) &&
    snapshot.measurementWindowMs > 0;
  if (!windowIsValid) reasons.push("invalid_measurement_window_ms");

  if (result?.status !== "positive") {
    reasons.push("result_not_positive");
  }
  if (
    !Array.isArray(result?.evidenceGaps) ||
    result.evidenceGaps.length !== 0
  ) {
    reasons.push("evidence_gaps_present");
  }
  if (!Array.isArray(result?.gaps) || result.gaps.length !== 0) {
    reasons.push("profitability_gaps_present");
  }
  if (!hasCompleteSample(result)) reasons.push("incomplete_sample");

  const tradingNetValue = result?.tradingNetUsd;
  const tradingNet = parseDecimal(tradingNetValue);
  if (tradingNetValue === null || tradingNetValue === undefined) {
    reasons.push("missing_trading_net_usd");
  } else if (tradingNet === null) {
    reasons.push("invalid_trading_net_usd");
  } else if (tradingNet.numerator <= 0n) {
    reasons.push("non_positive_trading_net_usd");
  }

  const collateral = parseDecimal(snapshot.collateralUsd);
  if (collateral === null) {
    reasons.push("invalid_collateral_usd");
  } else if (collateral.numerator <= 0n) {
    reasons.push("non_positive_collateral_usd");
  }

  let netUsdPerDay: ExactRational | null = null;
  let netReturnBpsPerDay: ExactRational | null = null;
  if (
    reasons.length === 0 &&
    windowIsValid &&
    snapshot.measurementWindowMs !== null &&
    tradingNet !== null &&
    collateral !== null
  ) {
    netUsdPerDay = reduceRatio(
      tradingNet.numerator * MILLISECONDS_PER_DAY,
      tradingNet.denominator * BigInt(snapshot.measurementWindowMs),
    );
    netReturnBpsPerDay = reduceRatio(
      netUsdPerDay.numerator * collateral.denominator * BASIS_POINTS_PER_UNIT,
      netUsdPerDay.denominator * collateral.numerator,
    );
  }

  return {
    candidate: {
      candidateId: snapshot.candidateId,
      marketId: snapshot.marketId,
      measurementWindowMs: snapshot.measurementWindowMs,
      collateralUsd: snapshot.collateralUsd,
      status: reasons.length === 0 ? "eligible" : "ineligible",
      reasons,
      netUsdPerDay: netUsdPerDay === null ? null : snapshotRatio(netUsdPerDay),
      netReturnBpsPerDay:
        netReturnBpsPerDay === null ? null : snapshotRatio(netReturnBpsPerDay),
    },
    inputIndex,
    candidateSortKey: snapshot.candidateId ?? "",
    marketSortKey: snapshot.marketId ?? "",
    netUsdPerDay,
    netReturnBpsPerDay,
  };
}

function compareCandidates(
  left: ParsedCandidate,
  right: ParsedCandidate,
): number {
  const leftEligible = left.candidate.status === "eligible";
  const rightEligible = right.candidate.status === "eligible";
  if (leftEligible !== rightEligible) return leftEligible ? -1 : 1;

  if (
    leftEligible &&
    left.netReturnBpsPerDay !== null &&
    right.netReturnBpsPerDay !== null &&
    left.netUsdPerDay !== null &&
    right.netUsdPerDay !== null
  ) {
    const returnComparison = compareRatios(
      right.netReturnBpsPerDay,
      left.netReturnBpsPerDay,
    );
    if (returnComparison !== 0) return returnComparison;

    const netComparison = compareRatios(right.netUsdPerDay, left.netUsdPerDay);
    if (netComparison !== 0) return netComparison;
  }

  const candidateComparison = compareText(
    left.candidateSortKey,
    right.candidateSortKey,
  );
  if (candidateComparison !== 0) return candidateComparison;
  const marketComparison = compareText(left.marketSortKey, right.marketSortKey);
  if (marketComparison !== 0) return marketComparison;
  return left.inputIndex - right.inputIndex;
}

/**
 * Ranks measured Paper profitability evidence without silently dropping a
 * candidate. This is reporting output only: eligibility and rank cannot
 * authorize execution or be promoted to Live/provider evidence.
 *
 * All monetary calculations and comparisons use reduced bigint ratios. Number
 * operations are limited to validation of the caller's safe-integer time
 * window before its exact conversion to bigint.
 */
export function rankPaperProfitabilityCandidates(
  inputs: readonly (PaperProfitabilityRankingInput | null)[],
): readonly RankedPaperProfitabilityCandidate[] {
  return inputs
    .map((input, inputIndex) => parseCandidate(input, inputIndex))
    .sort(compareCandidates)
    .map(({ candidate }) => candidate);
}
