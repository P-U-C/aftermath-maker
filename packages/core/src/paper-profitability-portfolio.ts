import type { DecimalString } from "./inventory-recycling.js";
import type { PaperProfitabilityCapacityResult } from "./paper-profitability-capacity.js";

export type PaperProfitabilityPortfolioInput = Readonly<{
  /**
   * Canonical positive integer USD budget no larger than Number.MAX_SAFE_INTEGER.
   * Candidate allocations remain exact decimal strings.
   */
  totalCollateralUsd: DecimalString;
  candidates: readonly (PaperProfitabilityCapacityResult | null)[];
}>;

export type PaperProfitabilityPortfolioReason =
  | "malformed_input"
  | "invalid_total_collateral_usd"
  | "non_positive_total_collateral_usd"
  | "unsafe_total_collateral_usd"
  | "malformed_candidates"
  | "empty_candidates"
  | "sparse_candidates"
  | "malformed_candidate"
  | "invalid_candidate_id"
  | "invalid_market_id"
  | "duplicate_candidate"
  | "capacity_not_eligible"
  | "capacity_gaps_present"
  | "invalid_candidate_collateral_usd"
  | "invalid_candidate_max_allocation_bps"
  | "missing_max_allocated_usd"
  | "invalid_max_allocated_usd"
  | "non_positive_max_allocated_usd"
  | "malformed_capacity_windows"
  | "empty_capacity_windows"
  | "sparse_capacity_windows"
  | "malformed_capacity_window"
  | "invalid_capacity_window_id"
  | "duplicate_capacity_window_id"
  | "capacity_window_not_complete"
  | "inconsistent_capacity_allocation"
  | "inconsistent_capacity_remaining"
  | "inconsistent_candidate_allocation"
  | "portfolio_budget_exceeded";

export type PaperProfitabilityPortfolioCandidateResult = Readonly<{
  candidateId: string | null;
  marketId: string | null;
  requestedAllocationUsd: DecimalString | null;
  allocatedUsd: DecimalString | null;
  status: "allocated" | "ineligible";
  reasons: readonly PaperProfitabilityPortfolioReason[];
}>;

export type PaperProfitabilityPortfolioResult = Readonly<{
  totalCollateralUsd: DecimalString | null;
  totalRequestedAllocationUsd: DecimalString | null;
  remainingCollateralUsd: DecimalString | null;
  status: "eligible" | "ineligible";
  reasons: readonly PaperProfitabilityPortfolioReason[];
  candidates: readonly PaperProfitabilityPortfolioCandidateResult[];
}>;

type ParsedDecimal = Readonly<{
  units: bigint;
  scale: number;
  negativeSyntax: boolean;
}>;

type MutableCandidate = {
  inputIndex: number;
  candidateId: string | null;
  marketId: string | null;
  requestedAllocationUsd: string | null;
  requestedAllocation: ParsedDecimal | null;
  reasons: PaperProfitabilityPortfolioReason[];
};

const DECIMAL_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/;
const INTEGER_BUDGET_PATTERN = /^(0|[1-9]\d*)$/;
const MAX_DECIMAL_DIGITS = 128;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const BASIS_POINTS_SCALE = 4;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pushReason(
  reasons: PaperProfitabilityPortfolioReason[],
  reason: PaperProfitabilityPortfolioReason,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
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

function addDecimals(left: ParsedDecimal, right: ParsedDecimal): ParsedDecimal {
  const scale = Math.max(left.scale, right.scale);
  return normalizeDecimal({
    units: unitsAtScale(left, scale) + unitsAtScale(right, scale),
    scale,
    negativeSyntax: false,
  });
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

function compareDecimals(left: ParsedDecimal, right: ParsedDecimal): number {
  const scale = Math.max(left.scale, right.scale);
  const leftUnits = unitsAtScale(left, scale);
  const rightUnits = unitsAtScale(right, scale);
  if (leftUnits < rightUnits) return -1;
  if (leftUnits > rightUnits) return 1;
  return 0;
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

function hasArrayIndex(array: readonly unknown[], index: number): boolean {
  return Object.prototype.hasOwnProperty.call(array, index);
}

function snapshotText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isNonNegativeDecimal(value: unknown): boolean {
  const parsed = parseDecimal(value);
  return parsed !== null && !parsed.negativeSyntax && parsed.units >= 0n;
}

function isPositiveDecimal(value: unknown): boolean {
  const parsed = parseDecimal(value);
  return parsed !== null && parsed.units > 0n;
}

function capacityWindowIsComplete(
  value: unknown,
  requestedAllocation: ParsedDecimal | null,
): boolean {
  if (!isRecord(value)) return false;
  const windowAllocation = parseDecimal(value.maxAllocatedUsd);
  const exposure = parseDecimal(value.exposureUsd);
  const remaining = parseDecimal(value.remainingCapacityUsd);
  return (
    typeof value.windowId === "string" &&
    value.windowId.trim() !== "" &&
    value.status === "within_budget" &&
    Array.isArray(value.reasons) &&
    value.reasons.length === 0 &&
    isNonNegativeDecimal(value.exposureUsd) &&
    windowAllocation !== null &&
    windowAllocation.units > 0n &&
    requestedAllocation !== null &&
    compareDecimals(windowAllocation, requestedAllocation) === 0 &&
    isNonNegativeDecimal(value.remainingCapacityUsd) &&
    exposure !== null &&
    remaining !== null &&
    compareDecimals(remaining, subtractDecimals(windowAllocation, exposure)) ===
      0
  );
}

function parseCandidate(value: unknown, inputIndex: number): MutableCandidate {
  const source = isRecord(value) ? value : null;
  const candidateId = snapshotText(source?.candidateId);
  const marketId = snapshotText(source?.marketId);
  const requestedAllocationUsd = snapshotText(source?.maxAllocatedUsd);
  const requestedAllocation = parseDecimal(requestedAllocationUsd);
  const reasons: PaperProfitabilityPortfolioReason[] = [];

  if (source === null) pushReason(reasons, "malformed_candidate");
  if (candidateId === null || candidateId.trim() === "") {
    pushReason(reasons, "invalid_candidate_id");
  }
  if (marketId === null || marketId.trim() === "") {
    pushReason(reasons, "invalid_market_id");
  }
  if (
    source?.status !== "eligible" ||
    source?.baseStatus !== "eligible" ||
    source?.stressStatus !== "eligible"
  ) {
    pushReason(reasons, "capacity_not_eligible");
  }
  if (!Array.isArray(source?.reasons) || source.reasons.length > 0) {
    pushReason(reasons, "capacity_gaps_present");
  }

  const collateral = parseDecimal(source?.collateralUsd);
  if (collateral === null || collateral.units <= 0n) {
    pushReason(reasons, "invalid_candidate_collateral_usd");
  }
  const maxAllocationBps = source?.maxAllocationBps;
  if (
    typeof maxAllocationBps !== "number" ||
    !Number.isSafeInteger(maxAllocationBps) ||
    maxAllocationBps <= 0 ||
    maxAllocationBps > 10_000
  ) {
    pushReason(reasons, "invalid_candidate_max_allocation_bps");
  }

  if (
    requestedAllocationUsd === null ||
    source?.maxAllocatedUsd === null ||
    source?.maxAllocatedUsd === undefined
  ) {
    pushReason(reasons, "missing_max_allocated_usd");
  } else if (requestedAllocation === null) {
    pushReason(reasons, "invalid_max_allocated_usd");
  } else if (requestedAllocation.units <= 0n) {
    pushReason(reasons, "non_positive_max_allocated_usd");
  }
  if (
    collateral !== null &&
    collateral.units > 0n &&
    typeof maxAllocationBps === "number" &&
    Number.isSafeInteger(maxAllocationBps) &&
    maxAllocationBps > 0 &&
    maxAllocationBps <= 10_000 &&
    requestedAllocation !== null &&
    requestedAllocation.units > 0n
  ) {
    const expectedAllocation = normalizeDecimal({
      units: collateral.units * BigInt(maxAllocationBps),
      scale: collateral.scale + BASIS_POINTS_SCALE,
      negativeSyntax: false,
    });
    if (compareDecimals(requestedAllocation, expectedAllocation) > 0) {
      pushReason(reasons, "inconsistent_candidate_allocation");
    }
  }

  const windows = Array.isArray(source?.windows) ? source.windows : null;
  if (windows === null) {
    pushReason(reasons, "malformed_capacity_windows");
  } else if (windows.length === 0) {
    pushReason(reasons, "empty_capacity_windows");
  } else {
    const windowIds = new Set<string>();
    for (let index = 0; index < windows.length; index += 1) {
      if (!hasArrayIndex(windows, index)) {
        pushReason(reasons, "sparse_capacity_windows");
        continue;
      }
      const window = windows[index];
      if (!isRecord(window)) {
        pushReason(reasons, "malformed_capacity_window");
        continue;
      }
      const windowId = snapshotText(window.windowId);
      if (windowId === null || windowId.trim() === "") {
        pushReason(reasons, "invalid_capacity_window_id");
      } else if (windowIds.has(windowId)) {
        pushReason(reasons, "duplicate_capacity_window_id");
      } else {
        windowIds.add(windowId);
      }
      if (!capacityWindowIsComplete(window, requestedAllocation)) {
        if (
          parseDecimal(window.maxAllocatedUsd) !== null &&
          requestedAllocation !== null &&
          compareDecimals(
            parseDecimal(window.maxAllocatedUsd)!,
            requestedAllocation,
          ) !== 0
        ) {
          pushReason(reasons, "inconsistent_capacity_allocation");
        } else {
          const windowAllocation = parseDecimal(window.maxAllocatedUsd);
          const exposure = parseDecimal(window.exposureUsd);
          const remaining = parseDecimal(window.remainingCapacityUsd);
          if (
            windowAllocation !== null &&
            requestedAllocation !== null &&
            exposure !== null &&
            remaining !== null &&
            isNonNegativeDecimal(window.exposureUsd) &&
            isNonNegativeDecimal(window.remainingCapacityUsd) &&
            compareDecimals(
              remaining,
              subtractDecimals(windowAllocation, exposure),
            ) !== 0
          ) {
            pushReason(reasons, "inconsistent_capacity_remaining");
          } else {
            pushReason(reasons, "capacity_window_not_complete");
          }
        }
      }
    }
  }

  return {
    inputIndex,
    candidateId,
    marketId,
    requestedAllocationUsd,
    requestedAllocation:
      requestedAllocation !== null && requestedAllocation.units > 0n
        ? requestedAllocation
        : null,
    reasons,
  };
}

function markDuplicateCandidates(candidates: MutableCandidate[]): void {
  const byIdentity = new Map<string, MutableCandidate[]>();
  for (const candidate of candidates) {
    if (
      candidate.candidateId === null ||
      candidate.candidateId.trim() === "" ||
      candidate.marketId === null ||
      candidate.marketId.trim() === ""
    ) {
      continue;
    }
    const key = JSON.stringify([candidate.candidateId, candidate.marketId]);
    const matches = byIdentity.get(key) ?? [];
    matches.push(candidate);
    byIdentity.set(key, matches);
  }
  for (const matches of byIdentity.values()) {
    if (matches.length < 2) continue;
    for (const candidate of matches) {
      pushReason(candidate.reasons, "duplicate_candidate");
    }
  }
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

function compareCandidates(
  left: MutableCandidate,
  right: MutableCandidate,
): number {
  const candidateComparison = compareNullableText(
    left.candidateId,
    right.candidateId,
  );
  if (candidateComparison !== 0) return candidateComparison;
  const marketComparison = compareNullableText(left.marketId, right.marketId);
  if (marketComparison !== 0) return marketComparison;
  const allocationComparison = compareNullableText(
    left.requestedAllocationUsd,
    right.requestedAllocationUsd,
  );
  if (allocationComparison !== 0) return allocationComparison;
  const reasonComparison = compareNullableText(
    [...left.reasons].sort().join("\u0000"),
    [...right.reasons].sort().join("\u0000"),
  );
  if (reasonComparison !== 0) return reasonComparison;
  return left.inputIndex - right.inputIndex;
}

function inspectBudget(value: unknown): Readonly<{
  source: string | null;
  parsed: ParsedDecimal | null;
  reason: PaperProfitabilityPortfolioReason | null;
}> {
  const source = snapshotText(value);
  const generalDecimal = parseDecimal(source);
  if (generalDecimal !== null && generalDecimal.units <= 0n) {
    return {
      source,
      parsed: null,
      reason: "non_positive_total_collateral_usd",
    };
  }
  if (
    source === null ||
    source.length > MAX_DECIMAL_DIGITS ||
    !INTEGER_BUDGET_PATTERN.test(source)
  ) {
    return {
      source,
      parsed: null,
      reason: "invalid_total_collateral_usd",
    };
  }
  const units = BigInt(source);
  if (units > MAX_SAFE_INTEGER_BIGINT) {
    return {
      source,
      parsed: null,
      reason: "unsafe_total_collateral_usd",
    };
  }
  return {
    source,
    parsed: { units, scale: 0, negativeSyntax: false },
    reason: null,
  };
}

function sumRequestedAllocations(
  candidates: readonly MutableCandidate[],
): ParsedDecimal | null {
  let total: ParsedDecimal = { units: 0n, scale: 0, negativeSyntax: false };
  for (const candidate of candidates) {
    if (candidate.requestedAllocation === null) return null;
    total = addDecimals(total, candidate.requestedAllocation);
  }
  return total;
}

function snapshotCandidate(
  candidate: MutableCandidate,
  portfolioEligible: boolean,
): PaperProfitabilityPortfolioCandidateResult {
  const reasons = [...candidate.reasons].sort();
  return {
    candidateId: candidate.candidateId,
    marketId: candidate.marketId,
    requestedAllocationUsd: candidate.requestedAllocationUsd,
    allocatedUsd:
      portfolioEligible && candidate.requestedAllocation !== null
        ? formatDecimal(candidate.requestedAllocation)
        : null,
    status:
      portfolioEligible && reasons.length === 0 ? "allocated" : "ineligible",
    reasons,
  };
}

/**
 * Allocates already-admitted Paper capacity results inside one declared
 * portfolio collateral budget. This pure result is an assumption/report only:
 * it provides no provider evidence and cannot authorize execution, Live
 * trading or Mainnet.
 */
export function allocatePaperProfitabilityPortfolio(
  input: PaperProfitabilityPortfolioInput | null,
): PaperProfitabilityPortfolioResult {
  const source = isRecord(input) ? input : null;
  const reasons: PaperProfitabilityPortfolioReason[] = [];
  if (source === null) pushReason(reasons, "malformed_input");

  const budget = inspectBudget(source?.totalCollateralUsd);
  if (budget.reason !== null) pushReason(reasons, budget.reason);

  const rawCandidates = Array.isArray(source?.candidates)
    ? source.candidates
    : null;
  if (rawCandidates === null) {
    pushReason(reasons, "malformed_candidates");
  } else if (rawCandidates.length === 0) {
    pushReason(reasons, "empty_candidates");
  }

  const candidates: MutableCandidate[] = [];
  for (let index = 0; index < (rawCandidates?.length ?? 0); index += 1) {
    if (!hasArrayIndex(rawCandidates!, index)) {
      pushReason(reasons, "sparse_candidates");
      candidates.push(parseCandidate(null, index));
      continue;
    }
    candidates.push(parseCandidate(rawCandidates![index], index));
  }
  markDuplicateCandidates(candidates);

  const requestedTotal =
    candidates.length === 0 ? null : sumRequestedAllocations(candidates);
  const remaining =
    budget.parsed !== null && requestedTotal !== null
      ? subtractDecimals(budget.parsed, requestedTotal)
      : null;
  if (remaining !== null && remaining.units < 0n) {
    pushReason(reasons, "portfolio_budget_exceeded");
    for (const candidate of candidates) {
      pushReason(candidate.reasons, "portfolio_budget_exceeded");
    }
  }

  for (const candidate of candidates) {
    for (const reason of candidate.reasons) pushReason(reasons, reason);
  }
  reasons.sort();
  candidates.sort(compareCandidates);

  const portfolioEligible =
    reasons.length === 0 &&
    budget.parsed !== null &&
    requestedTotal !== null &&
    candidates.length > 0;
  return {
    totalCollateralUsd: budget.source,
    totalRequestedAllocationUsd:
      requestedTotal === null ? null : formatDecimal(requestedTotal),
    remainingCollateralUsd:
      remaining === null ? null : formatDecimal(remaining),
    status: portfolioEligible ? "eligible" : "ineligible",
    reasons,
    candidates: candidates.map((candidate) =>
      snapshotCandidate(candidate, portfolioEligible),
    ),
  };
}
