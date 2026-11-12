import type { DecimalString } from "./inventory-recycling.js";
import type { PaperProfitabilityEvidenceResult } from "./paper-profitability-evidence.js";
import type { ExactDecimalRatio } from "./paper-profitability-ranking.js";

export type PaperProfitabilityStabilityWindow = Readonly<{
  windowId: string;
  /** Inclusive fixed-window boundary. */
  windowStartAtMs: number;
  /** Exclusive fixed-window boundary. */
  windowEndAtMs: number;
  result: PaperProfitabilityEvidenceResult | null;
}>;

export type PaperProfitabilityStabilityInput = Readonly<{
  candidateId: string;
  marketId: string;
  collateralUsd: DecimalString;
  minimumWindows: number;
  windows: readonly (PaperProfitabilityStabilityWindow | null)[];
}>;

export type PaperProfitabilityStabilityReason =
  | "malformed_candidate"
  | "malformed_windows"
  | "invalid_candidate_id"
  | "invalid_market_id"
  | "invalid_collateral_usd"
  | "non_positive_collateral_usd"
  | "invalid_minimum_windows"
  | "insufficient_windows"
  | "malformed_window"
  | "invalid_window_id"
  | "invalid_window_bounds"
  | "duplicate_window_id"
  | "duplicate_window_interval"
  | "overlapping_windows"
  | "malformed_result"
  | "result_not_positive"
  | "evidence_gaps_present"
  | "profitability_gaps_present"
  | "incomplete_components"
  | "incomplete_sample"
  | "missing_trading_net_usd"
  | "invalid_trading_net_usd"
  | "non_positive_trading_net_usd";

export type PaperProfitabilityStabilityWindowResult = Readonly<{
  windowId: string | null;
  windowStartAtMs: number | null;
  windowEndAtMs: number | null;
  measurementWindowMs: number | null;
  status: "positive" | "ineligible";
  reasons: readonly PaperProfitabilityStabilityReason[];
  netUsdPerDay: ExactDecimalRatio | null;
  netReturnBpsPerDay: ExactDecimalRatio | null;
}>;

export type PaperProfitabilityWorstWindow = Readonly<{
  windowId: string | null;
  windowStartAtMs: number | null;
  windowEndAtMs: number | null;
  measurementWindowMs: number | null;
  netUsdPerDay: ExactDecimalRatio;
  netReturnBpsPerDay: ExactDecimalRatio;
}>;

export type PaperProfitabilityStabilityResult = Readonly<{
  candidateId: string | null;
  marketId: string | null;
  collateralUsd: DecimalString | null;
  minimumWindows: number | null;
  status: "eligible" | "ineligible";
  reasons: readonly PaperProfitabilityStabilityReason[];
  windows: readonly PaperProfitabilityStabilityWindowResult[];
  worstWindow: PaperProfitabilityWorstWindow | null;
}>;

type ExactRational = Readonly<{
  numerator: bigint;
  denominator: bigint;
}>;

type CandidateSnapshot = Readonly<{
  malformed: boolean;
  candidateId: string | null;
  marketId: string | null;
  collateralUsd: string | null;
  minimumWindows: number | null;
  windows: readonly unknown[] | null;
}>;

type MutableWindow = {
  inputIndex: number;
  malformed: boolean;
  windowId: string | null;
  windowStartAtMs: number | null;
  windowEndAtMs: number | null;
  measurementWindowMs: number | null;
  reasons: PaperProfitabilityStabilityReason[];
  netUsdPerDay: ExactRational | null;
  netReturnBpsPerDay: ExactRational | null;
};

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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pushReason(
  reasons: PaperProfitabilityStabilityReason[],
  reason: PaperProfitabilityStabilityReason,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

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
  return reduceRatio(
    match[1] === "-" ? -magnitude : magnitude,
    10n ** BigInt(fraction.length),
  );
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

function hasCompleteSample(
  result: Readonly<Record<string, unknown>> | null,
): boolean {
  return (
    result !== null &&
    typeof result.sampleSize === "number" &&
    Number.isSafeInteger(result.sampleSize) &&
    result.sampleSize > 0 &&
    typeof result.minimumSampleSize === "number" &&
    Number.isSafeInteger(result.minimumSampleSize) &&
    result.minimumSampleSize > 0 &&
    result.sampleSize >= result.minimumSampleSize
  );
}

function hasCompleteComponents(
  result: Readonly<Record<string, unknown>> | null,
): boolean {
  if (result === null) return false;
  const components = result.components;
  if (!isRecord(components)) return false;
  return PROFITABILITY_COMPONENTS.every((name) => {
    const component = components[name];
    return (
      isRecord(component) &&
      component.coverage === "complete" &&
      typeof component.amountUsd === "string"
    );
  });
}

function snapshotCandidate(input: unknown): CandidateSnapshot {
  if (!isRecord(input)) {
    return {
      malformed: true,
      candidateId: null,
      marketId: null,
      collateralUsd: null,
      minimumWindows: null,
      windows: null,
    };
  }
  const candidateId =
    typeof input.candidateId === "string" ? input.candidateId : null;
  const marketId = typeof input.marketId === "string" ? input.marketId : null;
  const collateralUsd =
    typeof input.collateralUsd === "string" ? input.collateralUsd : null;
  const minimumWindows =
    typeof input.minimumWindows === "number" &&
    Number.isFinite(input.minimumWindows)
      ? input.minimumWindows
      : null;
  const windows = Array.isArray(input.windows) ? input.windows : null;
  return {
    malformed:
      candidateId === null ||
      marketId === null ||
      collateralUsd === null ||
      minimumWindows === null ||
      windows === null,
    candidateId,
    marketId,
    collateralUsd,
    minimumWindows,
    windows,
  };
}

function snapshotFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasValidBounds(window: MutableWindow): boolean {
  return (
    window.windowStartAtMs !== null &&
    Number.isSafeInteger(window.windowStartAtMs) &&
    window.windowStartAtMs >= 0 &&
    window.windowEndAtMs !== null &&
    Number.isSafeInteger(window.windowEndAtMs) &&
    window.windowEndAtMs > window.windowStartAtMs
  );
}

function parseWindow(
  input: unknown,
  inputIndex: number,
  collateral: ExactRational | null,
): MutableWindow {
  const source = isRecord(input) ? input : null;
  const windowId =
    typeof source?.windowId === "string" ? source.windowId : null;
  const windowStartAtMs = snapshotFiniteNumber(source?.windowStartAtMs);
  const windowEndAtMs = snapshotFiniteNumber(source?.windowEndAtMs);
  const result = isRecord(source?.result) ? source.result : null;
  const window: MutableWindow = {
    inputIndex,
    malformed:
      source === null ||
      windowId === null ||
      windowStartAtMs === null ||
      windowEndAtMs === null,
    windowId,
    windowStartAtMs,
    windowEndAtMs,
    measurementWindowMs: null,
    reasons: [],
    netUsdPerDay: null,
    netReturnBpsPerDay: null,
  };

  if (window.malformed) pushReason(window.reasons, "malformed_window");
  if (windowId === null || windowId.trim() === "") {
    pushReason(window.reasons, "invalid_window_id");
  }
  const boundsAreValid = hasValidBounds(window);
  if (!boundsAreValid) {
    pushReason(window.reasons, "invalid_window_bounds");
  } else {
    window.measurementWindowMs = windowEndAtMs! - windowStartAtMs!;
  }

  const resultShapeIsValid = hasValidResultShape(result);
  if (!resultShapeIsValid) pushReason(window.reasons, "malformed_result");
  if (result?.status !== "positive") {
    pushReason(window.reasons, "result_not_positive");
  }
  const evidenceIsGapFree =
    Array.isArray(result?.evidenceGaps) && result.evidenceGaps.length === 0;
  if (!evidenceIsGapFree) {
    pushReason(window.reasons, "evidence_gaps_present");
  }
  const profitabilityIsGapFree =
    Array.isArray(result?.gaps) && result.gaps.length === 0;
  if (!profitabilityIsGapFree) {
    pushReason(window.reasons, "profitability_gaps_present");
  }
  const componentsAreComplete = hasCompleteComponents(result);
  if (!componentsAreComplete) {
    pushReason(window.reasons, "incomplete_components");
  }
  const sampleIsComplete = hasCompleteSample(result);
  if (!sampleIsComplete) pushReason(window.reasons, "incomplete_sample");

  const tradingNetValue = result?.tradingNetUsd;
  const tradingNet = parseDecimal(tradingNetValue);
  if (tradingNetValue === null || tradingNetValue === undefined) {
    pushReason(window.reasons, "missing_trading_net_usd");
  } else if (tradingNet === null) {
    pushReason(window.reasons, "invalid_trading_net_usd");
  } else if (tradingNet.numerator <= 0n) {
    pushReason(window.reasons, "non_positive_trading_net_usd");
  }

  const measurementWindowMs = window.measurementWindowMs;
  const netEvidenceIsComplete =
    boundsAreValid &&
    measurementWindowMs !== null &&
    resultShapeIsValid &&
    evidenceIsGapFree &&
    profitabilityIsGapFree &&
    componentsAreComplete &&
    sampleIsComplete &&
    result?.status !== "unavailable" &&
    tradingNet !== null;
  if (netEvidenceIsComplete) {
    window.netUsdPerDay = reduceRatio(
      tradingNet.numerator * MILLISECONDS_PER_DAY,
      tradingNet.denominator * BigInt(measurementWindowMs),
    );
  }
  if (
    window.netUsdPerDay !== null &&
    collateral !== null &&
    collateral.numerator > 0n
  ) {
    window.netReturnBpsPerDay = reduceRatio(
      window.netUsdPerDay.numerator *
        collateral.denominator *
        BASIS_POINTS_PER_UNIT,
      window.netUsdPerDay.denominator * collateral.numerator,
    );
  }
  return window;
}

function compareNullableNumber(
  left: number | null,
  right: number | null,
): number {
  if (left === null && right !== null) return -1;
  if (left !== null && right === null) return 1;
  if (left === null || right === null) return 0;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareNullableText(
  left: string | null,
  right: string | null,
): number {
  const leftKey = left ?? "";
  const rightKey = right ?? "";
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return 0;
}

function compareWindows(left: MutableWindow, right: MutableWindow): number {
  const startComparison = compareNullableNumber(
    left.windowStartAtMs,
    right.windowStartAtMs,
  );
  if (startComparison !== 0) return startComparison;
  const endComparison = compareNullableNumber(
    left.windowEndAtMs,
    right.windowEndAtMs,
  );
  if (endComparison !== 0) return endComparison;
  const idComparison = compareNullableText(left.windowId, right.windowId);
  if (idComparison !== 0) return idComparison;
  return left.inputIndex - right.inputIndex;
}

function markDuplicateAndOverlappingWindows(windows: MutableWindow[]): void {
  const byId = new Map<string, MutableWindow[]>();
  const byInterval = new Map<string, MutableWindow[]>();
  for (const window of windows) {
    if (window.windowId !== null && window.windowId.trim() !== "") {
      const matching = byId.get(window.windowId) ?? [];
      matching.push(window);
      byId.set(window.windowId, matching);
    }
    if (hasValidBounds(window)) {
      const interval = `${window.windowStartAtMs}:${window.windowEndAtMs}`;
      const matching = byInterval.get(interval) ?? [];
      matching.push(window);
      byInterval.set(interval, matching);
    }
  }
  for (const duplicates of byId.values()) {
    if (duplicates.length > 1) {
      for (const window of duplicates) {
        pushReason(window.reasons, "duplicate_window_id");
      }
    }
  }
  for (const duplicates of byInterval.values()) {
    if (duplicates.length > 1) {
      for (const window of duplicates) {
        pushReason(window.reasons, "duplicate_window_interval");
      }
    }
  }
  for (let leftIndex = 0; leftIndex < windows.length; leftIndex += 1) {
    const left = windows[leftIndex]!;
    if (!hasValidBounds(left)) continue;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < windows.length;
      rightIndex += 1
    ) {
      const right = windows[rightIndex]!;
      if (!hasValidBounds(right)) continue;
      if (
        left.windowStartAtMs! < right.windowEndAtMs! &&
        right.windowStartAtMs! < left.windowEndAtMs!
      ) {
        pushReason(left.reasons, "overlapping_windows");
        pushReason(right.reasons, "overlapping_windows");
      }
    }
  }
}

function snapshotWindow(
  window: MutableWindow,
): PaperProfitabilityStabilityWindowResult {
  return {
    windowId: window.windowId,
    windowStartAtMs: window.windowStartAtMs,
    windowEndAtMs: window.windowEndAtMs,
    measurementWindowMs: window.measurementWindowMs,
    status: window.reasons.length === 0 ? "positive" : "ineligible",
    reasons: window.reasons,
    netUsdPerDay:
      window.netUsdPerDay === null ? null : snapshotRatio(window.netUsdPerDay),
    netReturnBpsPerDay:
      window.netReturnBpsPerDay === null
        ? null
        : snapshotRatio(window.netReturnBpsPerDay),
  };
}

function selectWorstWindow(
  windows: readonly MutableWindow[],
): MutableWindow | null {
  let worst: MutableWindow | null = null;
  for (const window of windows) {
    if (window.netReturnBpsPerDay === null || window.netUsdPerDay === null) {
      continue;
    }
    if (worst === null) {
      worst = window;
      continue;
    }
    const returnComparison = compareRatios(
      window.netReturnBpsPerDay,
      worst.netReturnBpsPerDay!,
    );
    if (
      returnComparison < 0 ||
      (returnComparison === 0 &&
        compareRatios(window.netUsdPerDay, worst.netUsdPerDay!) < 0)
    ) {
      worst = window;
    }
  }
  return worst;
}

/**
 * Evaluates conservative Paper admission across independent fixed windows.
 * Every supplied window must be complete, gap-free, non-overlapping and
 * strictly profitable; a large gain can never average away one loss.
 * Reporting eligibility cannot authorize execution or establish Live proof.
 */
export function assessPaperProfitabilityStability(
  input: PaperProfitabilityStabilityInput | null,
): PaperProfitabilityStabilityResult {
  const snapshot = snapshotCandidate(input);
  const reasons: PaperProfitabilityStabilityReason[] = [];
  if (snapshot.malformed) pushReason(reasons, "malformed_candidate");
  if (snapshot.candidateId === null || snapshot.candidateId.trim() === "") {
    pushReason(reasons, "invalid_candidate_id");
  }
  if (snapshot.marketId === null || snapshot.marketId.trim() === "") {
    pushReason(reasons, "invalid_market_id");
  }

  const collateral = parseDecimal(snapshot.collateralUsd);
  let collateralReason: PaperProfitabilityStabilityReason | null = null;
  if (collateral === null) {
    collateralReason = "invalid_collateral_usd";
  } else if (collateral.numerator <= 0n) {
    collateralReason = "non_positive_collateral_usd";
  }
  if (collateralReason !== null) pushReason(reasons, collateralReason);
  const minimumWindowsIsValid =
    snapshot.minimumWindows !== null &&
    Number.isSafeInteger(snapshot.minimumWindows) &&
    snapshot.minimumWindows > 0;
  if (!minimumWindowsIsValid) {
    pushReason(reasons, "invalid_minimum_windows");
  }
  if (snapshot.windows === null) pushReason(reasons, "malformed_windows");

  const windows = (snapshot.windows ?? [])
    .map((window, inputIndex) => parseWindow(window, inputIndex, collateral))
    .sort(compareWindows);
  if (collateralReason !== null) {
    for (const window of windows) pushReason(window.reasons, collateralReason);
  }
  markDuplicateAndOverlappingWindows(windows);

  const completePositiveWindows = windows.filter(
    (window) => window.reasons.length === 0,
  ).length;
  if (
    minimumWindowsIsValid &&
    completePositiveWindows < snapshot.minimumWindows!
  ) {
    pushReason(reasons, "insufficient_windows");
  }
  for (const window of windows) {
    for (const reason of window.reasons) pushReason(reasons, reason);
  }

  const worst = selectWorstWindow(windows);
  const worstWindow: PaperProfitabilityWorstWindow | null =
    worst === null ||
    worst.netUsdPerDay === null ||
    worst.netReturnBpsPerDay === null
      ? null
      : {
          windowId: worst.windowId,
          windowStartAtMs: worst.windowStartAtMs,
          windowEndAtMs: worst.windowEndAtMs,
          measurementWindowMs: worst.measurementWindowMs,
          netUsdPerDay: snapshotRatio(worst.netUsdPerDay),
          netReturnBpsPerDay: snapshotRatio(worst.netReturnBpsPerDay),
        };

  return {
    candidateId: snapshot.candidateId,
    marketId: snapshot.marketId,
    collateralUsd: snapshot.collateralUsd,
    minimumWindows: snapshot.minimumWindows,
    status: reasons.length === 0 ? "eligible" : "ineligible",
    reasons,
    windows: windows.map(snapshotWindow),
    worstWindow,
  };
}
