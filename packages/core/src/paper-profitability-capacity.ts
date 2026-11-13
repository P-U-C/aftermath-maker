import type { DecimalString } from "./inventory-recycling.js";
import type { PaperProfitabilityStressResult } from "./paper-profitability-stress.js";

export type PaperProfitabilityCapacityWindow = Readonly<{
  windowId: string;
  exposureUsd: DecimalString;
}>;

export type PaperProfitabilityCapacityInput = Readonly<{
  stressResult: PaperProfitabilityStressResult | null;
  maxAllocationBps: number;
  windows: readonly (PaperProfitabilityCapacityWindow | null)[];
}>;

export type PaperProfitabilityCapacityReason =
  | "malformed_input"
  | "malformed_stress_result"
  | "invalid_candidate_id"
  | "invalid_market_id"
  | "invalid_collateral_usd"
  | "non_positive_collateral_usd"
  | "invalid_max_allocation_bps"
  | "base_not_eligible"
  | "stress_not_eligible"
  | "stress_gaps_present"
  | "sparse_stress_evidence"
  | "malformed_stress_scenario"
  | "stress_scenario_not_eligible"
  | "malformed_stress_window"
  | "stress_window_not_positive"
  | "duplicate_stress_window_id"
  | "inconsistent_stress_window"
  | "incomplete_stress_evidence"
  | "malformed_windows"
  | "empty_windows"
  | "sparse_windows"
  | "malformed_window"
  | "invalid_window_id"
  | "duplicate_window_id"
  | "unmatched_window_id"
  | "missing_window_exposure"
  | "invalid_exposure_usd"
  | "negative_exposure_usd"
  | "exposure_above_budget";

export type PaperProfitabilityCapacityWindowResult = Readonly<{
  windowId: string | null;
  exposureUsd: DecimalString | null;
  maxAllocatedUsd: DecimalString | null;
  remainingCapacityUsd: DecimalString | null;
  status: "within_budget" | "ineligible";
  reasons: readonly PaperProfitabilityCapacityReason[];
}>;

export type PaperProfitabilityCapacityResult = Readonly<{
  candidateId: string | null;
  marketId: string | null;
  collateralUsd: DecimalString | null;
  maxAllocationBps: number | null;
  maxAllocatedUsd: DecimalString | null;
  baseStatus: "eligible" | "ineligible" | null;
  stressStatus: "eligible" | "ineligible" | null;
  status: "eligible" | "ineligible";
  reasons: readonly PaperProfitabilityCapacityReason[];
  windows: readonly PaperProfitabilityCapacityWindowResult[];
}>;

type ParsedDecimal = Readonly<{
  units: bigint;
  scale: number;
  negativeSyntax: boolean;
}>;

type StressWindowIdentity = Readonly<{
  windowId: string;
  windowStartAtMs: number;
  windowEndAtMs: number;
}>;

type StressSnapshot = Readonly<{
  candidateId: string | null;
  marketId: string | null;
  collateralUsd: string | null;
  baseStatus: "eligible" | "ineligible" | null;
  stressStatus: "eligible" | "ineligible" | null;
  windowIds: ReadonlySet<string>;
  reasons: readonly PaperProfitabilityCapacityReason[];
}>;

type MutableCapacityWindow = {
  inputIndex: number;
  windowId: string | null;
  exposureUsd: string | null;
  exposure: ParsedDecimal | null;
  reasons: PaperProfitabilityCapacityReason[];
  maxAllocatedUsd: string | null;
  remainingCapacityUsd: string | null;
};

const DECIMAL_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/;
const INTEGER_PATTERN = /^-?(0|[1-9]\d*)$/;
const MAX_DECIMAL_DIGITS = 128;
const BASIS_POINTS_SCALE = 4;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pushReason(
  reasons: PaperProfitabilityCapacityReason[],
  reason: PaperProfitabilityCapacityReason,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function sortedReasons(
  reasons: readonly PaperProfitabilityCapacityReason[],
): readonly PaperProfitabilityCapacityReason[] {
  return [...reasons].sort();
}

function parseDecimal(value: unknown): ParsedDecimal | null {
  if (typeof value !== "string") return null;
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) return null;
  const whole = match[2]!;
  const fraction = match[3] ?? "";
  if (whole.length + fraction.length > MAX_DECIMAL_DIGITS) return null;
  const magnitude = BigInt(`${whole}${fraction}`);
  return {
    units: match[1] === "-" ? -magnitude : magnitude,
    scale: fraction.length,
    negativeSyntax: match[1] === "-",
  };
}

function normalizeDecimal(value: ParsedDecimal): ParsedDecimal {
  let units = value.units;
  let scale = value.scale;
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n;
    scale -= 1;
  }
  return { units, scale, negativeSyntax: units < 0n };
}

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function unitsAtScale(value: ParsedDecimal, scale: number): bigint {
  return value.units * powerOfTen(scale - value.scale);
}

function formatDecimal(value: ParsedDecimal): string {
  const normalized = normalizeDecimal(value);
  const negative = normalized.units < 0n;
  const magnitude = negative ? -normalized.units : normalized.units;
  if (normalized.scale === 0) {
    return `${negative ? "-" : ""}${magnitude}`;
  }
  const digits = magnitude.toString().padStart(normalized.scale + 1, "0");
  return `${negative ? "-" : ""}${digits.slice(
    0,
    -normalized.scale,
  )}.${digits.slice(-normalized.scale)}`;
}

function subtractDecimals(
  left: ParsedDecimal,
  right: ParsedDecimal,
): ParsedDecimal {
  const scale = Math.max(left.scale, right.scale);
  return normalizeDecimal({
    units: unitsAtScale(left, scale) - unitsAtScale(right, scale),
    scale,
    negativeSyntax: false,
  });
}

function isValidPositiveRatio(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    typeof value.numerator !== "string" ||
    typeof value.denominator !== "string" ||
    !INTEGER_PATTERN.test(value.numerator) ||
    !INTEGER_PATTERN.test(value.denominator) ||
    value.numerator.replace("-", "").length > MAX_DECIMAL_DIGITS ||
    value.denominator.replace("-", "").length > MAX_DECIMAL_DIGITS
  ) {
    return false;
  }
  return BigInt(value.numerator) > 0n && BigInt(value.denominator) > 0n;
}

function hasArrayIndex(array: readonly unknown[], index: number): boolean {
  return Object.prototype.hasOwnProperty.call(array, index);
}

function snapshotText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function snapshotStatus(value: unknown): "eligible" | "ineligible" | null {
  return value === "eligible" || value === "ineligible" ? value : null;
}

function validStressWindow(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return false;
  const start = value.windowStartAtMs;
  const end = value.windowEndAtMs;
  const measurement = value.measurementWindowMs;
  const baseNet = parseDecimal(value.baseTradingNetUsd);
  const stressedNet = parseDecimal(value.stressedNetUsd);
  return (
    typeof value.windowId === "string" &&
    value.windowId.trim() !== "" &&
    typeof start === "number" &&
    Number.isSafeInteger(start) &&
    start >= 0 &&
    typeof end === "number" &&
    Number.isSafeInteger(end) &&
    end > start &&
    typeof measurement === "number" &&
    Number.isSafeInteger(measurement) &&
    measurement === end - start &&
    value.status === "positive" &&
    Array.isArray(value.reasons) &&
    value.reasons.length === 0 &&
    baseNet !== null &&
    baseNet.units > 0n &&
    stressedNet !== null &&
    stressedNet.units > 0n &&
    isValidPositiveRatio(value.netUsdPerDay) &&
    isValidPositiveRatio(value.netReturnBpsPerDay)
  );
}

function inspectStressResult(value: unknown): StressSnapshot {
  const source = isRecord(value) ? value : null;
  const reasons: PaperProfitabilityCapacityReason[] = [];
  const candidateId = snapshotText(source?.candidateId);
  const marketId = snapshotText(source?.marketId);
  const collateralUsd = snapshotText(source?.collateralUsd);
  const baseStatus = snapshotStatus(source?.baseStabilityStatus);
  const stressStatus = snapshotStatus(source?.status);

  if (source === null) pushReason(reasons, "malformed_stress_result");
  if (candidateId === null || candidateId.trim() === "") {
    pushReason(reasons, "invalid_candidate_id");
  }
  if (marketId === null || marketId.trim() === "") {
    pushReason(reasons, "invalid_market_id");
  }
  const collateral = parseDecimal(collateralUsd);
  if (collateral === null) {
    pushReason(reasons, "invalid_collateral_usd");
  } else if (collateral.units <= 0n) {
    pushReason(reasons, "non_positive_collateral_usd");
  }
  if (baseStatus !== "eligible") pushReason(reasons, "base_not_eligible");
  if (stressStatus !== "eligible") pushReason(reasons, "stress_not_eligible");
  if (
    !Array.isArray(source?.baseStabilityReasons) ||
    source.baseStabilityReasons.length > 0 ||
    !Array.isArray(source?.reasons) ||
    source.reasons.length > 0
  ) {
    pushReason(reasons, "stress_gaps_present");
  }

  const scenarios = Array.isArray(source?.scenarios) ? source.scenarios : null;
  const identities = new Map<string, StressWindowIdentity>();
  let expectedWindowIds: Set<string> | null = null;
  if (scenarios === null || scenarios.length === 0) {
    pushReason(reasons, "incomplete_stress_evidence");
  } else {
    const scenarioIds = new Set<string>();
    for (
      let scenarioIndex = 0;
      scenarioIndex < scenarios.length;
      scenarioIndex += 1
    ) {
      if (!hasArrayIndex(scenarios, scenarioIndex)) {
        pushReason(reasons, "sparse_stress_evidence");
        pushReason(reasons, "incomplete_stress_evidence");
        continue;
      }
      const scenario = scenarios[scenarioIndex];
      if (!isRecord(scenario)) {
        pushReason(reasons, "malformed_stress_scenario");
        pushReason(reasons, "incomplete_stress_evidence");
        continue;
      }
      const scenarioId = snapshotText(scenario.scenarioId);
      if (
        scenarioId === null ||
        scenarioId.trim() === "" ||
        scenarioIds.has(scenarioId)
      ) {
        pushReason(reasons, "malformed_stress_scenario");
      } else {
        scenarioIds.add(scenarioId);
      }
      const scenarioLabel = snapshotText(scenario.label);
      const scenarioShock = parseDecimal(scenario.shockUsd);
      if (
        scenarioLabel === null ||
        scenarioLabel.trim() === "" ||
        scenarioShock === null ||
        scenarioShock.negativeSyntax ||
        scenarioShock.units < 0n
      ) {
        pushReason(reasons, "malformed_stress_scenario");
        pushReason(reasons, "incomplete_stress_evidence");
      }
      if (
        scenario.status !== "eligible" ||
        !Array.isArray(scenario.reasons) ||
        scenario.reasons.length > 0
      ) {
        pushReason(reasons, "stress_scenario_not_eligible");
      }
      const windows = Array.isArray(scenario.windows) ? scenario.windows : null;
      if (windows === null || windows.length === 0) {
        pushReason(reasons, "incomplete_stress_evidence");
        continue;
      }
      const currentIds = new Set<string>();
      for (
        let windowIndex = 0;
        windowIndex < windows.length;
        windowIndex += 1
      ) {
        if (!hasArrayIndex(windows, windowIndex)) {
          pushReason(reasons, "sparse_stress_evidence");
          pushReason(reasons, "incomplete_stress_evidence");
          continue;
        }
        const window = windows[windowIndex];
        if (!isRecord(window)) {
          pushReason(reasons, "malformed_stress_window");
          pushReason(reasons, "incomplete_stress_evidence");
          continue;
        }
        const windowId = snapshotText(window.windowId);
        if (windowId === null || windowId.trim() === "") {
          pushReason(reasons, "malformed_stress_window");
          pushReason(reasons, "incomplete_stress_evidence");
          continue;
        }
        if (currentIds.has(windowId)) {
          pushReason(reasons, "duplicate_stress_window_id");
        }
        currentIds.add(windowId);
        if (!validStressWindow(window)) {
          pushReason(reasons, "stress_window_not_positive");
          pushReason(reasons, "incomplete_stress_evidence");
        }
        if (
          typeof window.windowStartAtMs === "number" &&
          Number.isSafeInteger(window.windowStartAtMs) &&
          typeof window.windowEndAtMs === "number" &&
          Number.isSafeInteger(window.windowEndAtMs)
        ) {
          const prior = identities.get(windowId);
          const identity = {
            windowId,
            windowStartAtMs: window.windowStartAtMs,
            windowEndAtMs: window.windowEndAtMs,
          };
          if (
            prior !== undefined &&
            (prior.windowStartAtMs !== identity.windowStartAtMs ||
              prior.windowEndAtMs !== identity.windowEndAtMs)
          ) {
            pushReason(reasons, "inconsistent_stress_window");
          } else if (prior === undefined) {
            identities.set(windowId, identity);
          }
        }
      }
      if (expectedWindowIds === null) {
        expectedWindowIds = currentIds;
      } else if (
        expectedWindowIds.size !== currentIds.size ||
        [...expectedWindowIds].some((windowId) => !currentIds.has(windowId))
      ) {
        pushReason(reasons, "incomplete_stress_evidence");
      }
    }
  }

  return {
    candidateId,
    marketId,
    collateralUsd,
    baseStatus,
    stressStatus,
    windowIds: new Set(identities.keys()),
    reasons,
  };
}

function parseCapacityWindow(
  value: unknown,
  inputIndex: number,
): MutableCapacityWindow {
  const source = isRecord(value) ? value : null;
  const windowId = snapshotText(source?.windowId);
  const exposureUsd = snapshotText(source?.exposureUsd);
  const exposure = parseDecimal(exposureUsd);
  const reasons: PaperProfitabilityCapacityReason[] = [];
  if (source === null || windowId === null || exposureUsd === null) {
    pushReason(reasons, "malformed_window");
  }
  if (windowId === null || windowId.trim() === "") {
    pushReason(reasons, "invalid_window_id");
  }
  if (exposure === null) {
    pushReason(reasons, "invalid_exposure_usd");
  } else if (exposure.negativeSyntax || exposure.units < 0n) {
    pushReason(reasons, "negative_exposure_usd");
  }
  return {
    inputIndex,
    windowId,
    exposureUsd,
    exposure:
      exposure !== null && !exposure.negativeSyntax && exposure.units >= 0n
        ? exposure
        : null,
    reasons,
    maxAllocatedUsd: null,
    remainingCapacityUsd: null,
  };
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

function compareCapacityWindows(
  left: MutableCapacityWindow,
  right: MutableCapacityWindow,
): number {
  const idComparison = compareNullableText(left.windowId, right.windowId);
  if (idComparison !== 0) return idComparison;
  const exposureComparison = compareNullableText(
    left.exposureUsd,
    right.exposureUsd,
  );
  if (exposureComparison !== 0) return exposureComparison;
  const reasonComparison = compareNullableText(
    left.reasons.join("\u0000"),
    right.reasons.join("\u0000"),
  );
  if (reasonComparison !== 0) return reasonComparison;
  return left.inputIndex - right.inputIndex;
}

function markDuplicateAndUnmatchedWindows(
  windows: MutableCapacityWindow[],
  stressWindowIds: ReadonlySet<string>,
): void {
  const byId = new Map<string, MutableCapacityWindow[]>();
  for (const window of windows) {
    if (window.windowId === null || window.windowId.trim() === "") continue;
    const matches = byId.get(window.windowId) ?? [];
    matches.push(window);
    byId.set(window.windowId, matches);
    if (!stressWindowIds.has(window.windowId)) {
      pushReason(window.reasons, "unmatched_window_id");
    }
  }
  for (const matches of byId.values()) {
    if (matches.length < 2) continue;
    for (const window of matches) {
      pushReason(window.reasons, "duplicate_window_id");
    }
  }
}

function addMissingStressWindows(
  windows: MutableCapacityWindow[],
  stressWindowIds: ReadonlySet<string>,
): void {
  const observedIds = new Set(
    windows
      .map((window) => window.windowId)
      .filter((windowId): windowId is string => windowId !== null),
  );
  let syntheticIndex = windows.length;
  for (const windowId of stressWindowIds) {
    if (observedIds.has(windowId)) continue;
    windows.push({
      inputIndex: syntheticIndex,
      windowId,
      exposureUsd: null,
      exposure: null,
      reasons: ["missing_window_exposure"],
      maxAllocatedUsd: null,
      remainingCapacityUsd: null,
    });
    syntheticIndex += 1;
  }
}

function calculateBudget(
  collateral: ParsedDecimal | null,
  maxAllocationBps: number | null,
): ParsedDecimal | null {
  if (
    collateral === null ||
    collateral.units <= 0n ||
    maxAllocationBps === null ||
    !Number.isSafeInteger(maxAllocationBps) ||
    maxAllocationBps <= 0 ||
    maxAllocationBps > 10_000
  ) {
    return null;
  }
  return normalizeDecimal({
    units: collateral.units * BigInt(maxAllocationBps),
    scale: collateral.scale + BASIS_POINTS_SCALE,
    negativeSyntax: false,
  });
}

function snapshotCapacityWindow(
  window: MutableCapacityWindow,
): PaperProfitabilityCapacityWindowResult {
  return {
    windowId: window.windowId,
    exposureUsd: window.exposureUsd,
    maxAllocatedUsd: window.maxAllocatedUsd,
    remainingCapacityUsd: window.remainingCapacityUsd,
    status: window.reasons.length === 0 ? "within_budget" : "ineligible",
    reasons: sortedReasons(window.reasons),
  };
}

/**
 * Checks a declared Paper exposure budget against already complete stress
 * evidence. The result is a deterministic assumption/report only. It is not
 * provider evidence and cannot authorize execution, Live trading or Mainnet.
 */
export function assessPaperProfitabilityCapacity(
  input: PaperProfitabilityCapacityInput | null,
): PaperProfitabilityCapacityResult {
  const source = isRecord(input) ? input : null;
  const reasons: PaperProfitabilityCapacityReason[] = [];
  if (source === null) pushReason(reasons, "malformed_input");

  const stress = inspectStressResult(source?.stressResult);
  for (const reason of stress.reasons) pushReason(reasons, reason);

  const maxAllocationBps =
    typeof source?.maxAllocationBps === "number" &&
    Number.isFinite(source.maxAllocationBps)
      ? source.maxAllocationBps
      : null;
  const maxAllocationIsValid =
    maxAllocationBps !== null &&
    Number.isSafeInteger(maxAllocationBps) &&
    maxAllocationBps > 0 &&
    maxAllocationBps <= 10_000;
  if (!maxAllocationIsValid) {
    pushReason(reasons, "invalid_max_allocation_bps");
  }

  const rawWindows = Array.isArray(source?.windows) ? source.windows : null;
  if (rawWindows === null) {
    pushReason(reasons, "malformed_windows");
  } else if (rawWindows.length === 0) {
    pushReason(reasons, "empty_windows");
  }
  const windows: MutableCapacityWindow[] = [];
  for (let index = 0; index < (rawWindows?.length ?? 0); index += 1) {
    if (!hasArrayIndex(rawWindows!, index)) {
      pushReason(reasons, "sparse_windows");
      windows.push(parseCapacityWindow(null, index));
      continue;
    }
    windows.push(parseCapacityWindow(rawWindows![index], index));
  }
  markDuplicateAndUnmatchedWindows(windows, stress.windowIds);
  addMissingStressWindows(windows, stress.windowIds);

  const collateral = parseDecimal(stress.collateralUsd);
  const budget = calculateBudget(
    collateral,
    maxAllocationIsValid ? maxAllocationBps : null,
  );
  const stressEvidenceIsComplete = stress.reasons.length === 0;
  for (const window of windows) {
    if (!stressEvidenceIsComplete) {
      pushReason(window.reasons, "incomplete_stress_evidence");
    }
    if (budget !== null) {
      window.maxAllocatedUsd = formatDecimal(budget);
    }
    if (budget !== null && window.exposure !== null) {
      const remaining = subtractDecimals(budget, window.exposure);
      window.remainingCapacityUsd = formatDecimal(remaining);
      if (remaining.units < 0n) {
        pushReason(window.reasons, "exposure_above_budget");
      }
    }
    for (const reason of window.reasons) pushReason(reasons, reason);
  }
  windows.sort(compareCapacityWindows);

  const windowResults = windows.map(snapshotCapacityWindow);
  return {
    candidateId: stress.candidateId,
    marketId: stress.marketId,
    collateralUsd: stress.collateralUsd,
    maxAllocationBps,
    maxAllocatedUsd: budget === null ? null : formatDecimal(budget),
    baseStatus: stress.baseStatus,
    stressStatus: stress.stressStatus,
    status:
      reasons.length === 0 &&
      windowResults.length > 0 &&
      windowResults.every((window) => window.status === "within_budget")
        ? "eligible"
        : "ineligible",
    reasons: sortedReasons(reasons),
    windows: windowResults,
  };
}
