import type { DecimalString } from "./inventory-recycling.js";

export type PaperProfitabilityRiskCandidate = Readonly<{
  candidateId: string;
  marketId: string;
  allocatedUsd: DecimalString;
  maxLossUsd: DecimalString;
  status: "eligible" | "ineligible";
  reasons: readonly string[];
}>;

export type PaperProfitabilityRiskInput = Readonly<{
  totalCollateralUsd: DecimalString;
  riskBudgetUsd: DecimalString;
  candidates: readonly (PaperProfitabilityRiskCandidate | null)[];
}>;

export type PaperProfitabilityRiskReason =
  | "malformed_input"
  | "invalid_total_collateral_usd"
  | "non_positive_total_collateral_usd"
  | "unsafe_total_collateral_usd"
  | "invalid_risk_budget_usd"
  | "non_positive_risk_budget_usd"
  | "unsafe_risk_budget_usd"
  | "malformed_candidates"
  | "empty_candidates"
  | "sparse_candidates"
  | "malformed_candidate"
  | "invalid_candidate_id"
  | "invalid_market_id"
  | "duplicate_candidate"
  | "candidate_not_eligible"
  | "candidate_gaps_present"
  | "invalid_allocated_usd"
  | "non_positive_allocated_usd"
  | "invalid_max_loss_usd"
  | "non_positive_max_loss_usd"
  | "candidate_loss_exceeds_allocation"
  | "collateral_budget_exceeded"
  | "risk_budget_exceeded";

export type PaperProfitabilityRiskCandidateResult = Readonly<{
  candidateId: string | null;
  marketId: string | null;
  allocatedUsd: DecimalString | null;
  maxLossUsd: DecimalString | null;
  status: "admitted" | "ineligible";
  reasons: readonly PaperProfitabilityRiskReason[];
}>;

export type PaperProfitabilityRiskResult = Readonly<{
  totalCollateralUsd: DecimalString | null;
  riskBudgetUsd: DecimalString | null;
  totalAllocatedUsd: DecimalString | null;
  totalMaxLossUsd: DecimalString | null;
  remainingRiskBudgetUsd: DecimalString | null;
  status: "eligible" | "ineligible";
  reasons: readonly PaperProfitabilityRiskReason[];
  candidates: readonly PaperProfitabilityRiskCandidateResult[];
}>;

type ParsedDecimal = Readonly<{ units: bigint; scale: number }>;
type MutableCandidate = {
  inputIndex: number;
  candidateId: string | null;
  marketId: string | null;
  allocatedUsd: string | null;
  allocated: ParsedDecimal | null;
  maxLossUsd: string | null;
  maxLoss: ParsedDecimal | null;
  reasons: PaperProfitabilityRiskReason[];
};

const DECIMAL_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/;
const INTEGER_BUDGET_PATTERN = /^(0|[1-9]\d*)$/;
const MAX_DECIMAL_DIGITS = 128;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pushReason(
  reasons: PaperProfitabilityRiskReason[],
  reason: PaperProfitabilityRiskReason,
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
  };
}

function normalizeDecimal(value: ParsedDecimal): ParsedDecimal {
  let units = value.units;
  let scale = value.scale;
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n;
    scale -= 1;
  }
  return { units, scale };
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
  });
}

function compareDecimals(left: ParsedDecimal, right: ParsedDecimal): number {
  const scale = Math.max(left.scale, right.scale);
  const leftUnits = unitsAtScale(left, scale);
  const rightUnits = unitsAtScale(right, scale);
  return leftUnits < rightUnits ? -1 : leftUnits > rightUnits ? 1 : 0;
}

function formatDecimal(value: ParsedDecimal): string {
  const normalized = normalizeDecimal(value);
  const negative = normalized.units < 0n;
  const magnitude = negative ? -normalized.units : normalized.units;
  if (normalized.scale === 0) return `${negative ? "-" : ""}${magnitude}`;
  const digits = magnitude.toString().padStart(normalized.scale + 1, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -normalized.scale)}.${digits.slice(-normalized.scale)}`;
}

function snapshotText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function hasArrayIndex(array: readonly unknown[], index: number): boolean {
  return Object.prototype.hasOwnProperty.call(array, index);
}

function inspectBudget(
  value: unknown,
  risk: boolean,
): {
  source: string | null;
  parsed: ParsedDecimal | null;
  reason: PaperProfitabilityRiskReason | null;
} {
  const source = snapshotText(value);
  const parsed = parseDecimal(source);
  const invalidReason = risk
    ? "invalid_risk_budget_usd"
    : "invalid_total_collateral_usd";
  const nonPositiveReason = risk
    ? "non_positive_risk_budget_usd"
    : "non_positive_total_collateral_usd";
  const unsafeReason = risk
    ? "unsafe_risk_budget_usd"
    : "unsafe_total_collateral_usd";
  if (parsed !== null && parsed.units <= 0n) {
    return { source, parsed: null, reason: nonPositiveReason };
  }
  if (risk) {
    if (source === null || parsed === null) {
      return { source, parsed: null, reason: invalidReason };
    }
    return { source, parsed, reason: null };
  }
  if (
    source === null ||
    source.length > MAX_DECIMAL_DIGITS ||
    !INTEGER_BUDGET_PATTERN.test(source)
  ) {
    return { source, parsed: null, reason: invalidReason };
  }
  const units = BigInt(source);
  if (units > MAX_SAFE_INTEGER_BIGINT) {
    return { source, parsed: null, reason: unsafeReason };
  }
  return { source, parsed: { units, scale: 0 }, reason: null };
}

function parseCandidate(value: unknown, inputIndex: number): MutableCandidate {
  const source = isRecord(value) ? value : null;
  const candidateId = snapshotText(source?.candidateId);
  const marketId = snapshotText(source?.marketId);
  const allocatedUsd = snapshotText(source?.allocatedUsd);
  const maxLossUsd = snapshotText(source?.maxLossUsd);
  const allocated = parseDecimal(allocatedUsd);
  const maxLoss = parseDecimal(maxLossUsd);
  const reasons: PaperProfitabilityRiskReason[] = [];

  if (source === null) pushReason(reasons, "malformed_candidate");
  if (candidateId === null || candidateId.trim() === "") {
    pushReason(reasons, "invalid_candidate_id");
  }
  if (marketId === null || marketId.trim() === "") {
    pushReason(reasons, "invalid_market_id");
  }
  if (source?.status !== "eligible") {
    pushReason(reasons, "candidate_not_eligible");
  }
  if (!Array.isArray(source?.reasons) || source.reasons.length > 0) {
    pushReason(reasons, "candidate_gaps_present");
  }
  if (allocated === null) {
    pushReason(reasons, "invalid_allocated_usd");
  } else if (allocated.units < 0n) {
    pushReason(reasons, "invalid_allocated_usd");
  } else if (allocated.units === 0n) {
    pushReason(reasons, "non_positive_allocated_usd");
  }
  if (maxLoss === null) {
    pushReason(reasons, "invalid_max_loss_usd");
  } else if (maxLoss.units < 0n) {
    pushReason(reasons, "invalid_max_loss_usd");
  } else if (maxLoss.units === 0n) {
    pushReason(reasons, "non_positive_max_loss_usd");
  }
  if (
    allocated !== null &&
    allocated.units > 0n &&
    maxLoss !== null &&
    maxLoss.units > 0n &&
    compareDecimals(maxLoss, allocated) > 0
  ) {
    pushReason(reasons, "candidate_loss_exceeds_allocation");
  }

  return {
    inputIndex,
    candidateId,
    marketId,
    allocatedUsd,
    allocated: allocated !== null && allocated.units > 0n ? allocated : null,
    maxLossUsd,
    maxLoss: maxLoss !== null && maxLoss.units > 0n ? maxLoss : null,
    reasons,
  };
}

function markDuplicateCandidates(candidates: MutableCandidate[]): void {
  const groups = new Map<string, MutableCandidate[]>();
  for (const candidate of candidates) {
    if (
      candidate.candidateId === null ||
      candidate.candidateId.trim() === "" ||
      candidate.marketId === null ||
      candidate.marketId.trim() === ""
    ) {
      continue;
    }
    const key = `${candidate.candidateId}\u0000${candidate.marketId}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const candidate of group)
      pushReason(candidate.reasons, "duplicate_candidate");
  }
}

function compareText(left: string | null, right: string | null): number {
  const leftKey = left ?? "";
  const rightKey = right ?? "";
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function compareCandidates(
  left: MutableCandidate,
  right: MutableCandidate,
): number {
  const candidateComparison = compareText(left.candidateId, right.candidateId);
  if (candidateComparison !== 0) return candidateComparison;
  const marketComparison = compareText(left.marketId, right.marketId);
  if (marketComparison !== 0) return marketComparison;
  const allocationComparison = compareText(
    left.allocatedUsd,
    right.allocatedUsd,
  );
  if (allocationComparison !== 0) return allocationComparison;
  return left.inputIndex - right.inputIndex;
}

function snapshotCandidate(
  candidate: MutableCandidate,
  portfolioEligible: boolean,
): PaperProfitabilityRiskCandidateResult {
  const reasons = [...candidate.reasons].sort();
  return {
    candidateId: candidate.candidateId,
    marketId: candidate.marketId,
    allocatedUsd: candidate.allocatedUsd,
    maxLossUsd: candidate.maxLossUsd,
    status:
      portfolioEligible && reasons.length === 0 ? "admitted" : "ineligible",
    reasons,
  };
}

/**
 * Admits already allocated Paper candidates against an explicit collateral and
 * loss budget. This is an assumption/report contract only and cannot authorize
 * venue execution, Live trading or Mainnet.
 */
export function assessPaperProfitabilityRisk(
  input: PaperProfitabilityRiskInput | null,
): PaperProfitabilityRiskResult {
  const source = isRecord(input) ? input : null;
  const reasons: PaperProfitabilityRiskReason[] = [];
  if (source === null) pushReason(reasons, "malformed_input");

  const collateral = inspectBudget(source?.totalCollateralUsd, false);
  const riskBudget = inspectBudget(source?.riskBudgetUsd, true);
  if (collateral.reason !== null) pushReason(reasons, collateral.reason);
  if (riskBudget.reason !== null) pushReason(reasons, riskBudget.reason);

  const rawCandidates = Array.isArray(source?.candidates)
    ? source.candidates
    : null;
  if (rawCandidates === null) pushReason(reasons, "malformed_candidates");
  else if (rawCandidates.length === 0) pushReason(reasons, "empty_candidates");

  const candidates: MutableCandidate[] = [];
  for (let index = 0; index < (rawCandidates?.length ?? 0); index += 1) {
    if (!hasArrayIndex(rawCandidates!, index)) {
      pushReason(reasons, "sparse_candidates");
      candidates.push(parseCandidate(null, index));
    } else {
      candidates.push(parseCandidate(rawCandidates![index], index));
    }
  }
  markDuplicateCandidates(candidates);

  let totalAllocated: ParsedDecimal | null =
    candidates.length === 0 ? null : { units: 0n, scale: 0 };
  let totalMaxLoss: ParsedDecimal | null =
    candidates.length === 0 ? null : { units: 0n, scale: 0 };
  for (const candidate of candidates) {
    if (totalAllocated !== null) {
      if (candidate.allocated === null) totalAllocated = null;
      else totalAllocated = addDecimals(totalAllocated, candidate.allocated);
    }
    if (totalMaxLoss !== null) {
      if (candidate.maxLoss === null) totalMaxLoss = null;
      else totalMaxLoss = addDecimals(totalMaxLoss, candidate.maxLoss);
    }
  }

  const remainingRiskBudget =
    riskBudget.parsed !== null && totalMaxLoss !== null
      ? subtractDecimals(riskBudget.parsed, totalMaxLoss)
      : null;
  if (
    collateral.parsed !== null &&
    totalAllocated !== null &&
    compareDecimals(totalAllocated, collateral.parsed) > 0
  ) {
    pushReason(reasons, "collateral_budget_exceeded");
    for (const candidate of candidates)
      pushReason(candidate.reasons, "collateral_budget_exceeded");
  }
  if (
    riskBudget.parsed !== null &&
    totalMaxLoss !== null &&
    compareDecimals(totalMaxLoss, riskBudget.parsed) > 0
  ) {
    pushReason(reasons, "risk_budget_exceeded");
    for (const candidate of candidates)
      pushReason(candidate.reasons, "risk_budget_exceeded");
  }

  for (const candidate of candidates) {
    for (const reason of candidate.reasons) pushReason(reasons, reason);
  }
  reasons.sort();
  candidates.sort(compareCandidates);

  const eligible =
    reasons.length === 0 &&
    collateral.parsed !== null &&
    riskBudget.parsed !== null &&
    totalAllocated !== null &&
    totalMaxLoss !== null &&
    candidates.length > 0;
  return {
    totalCollateralUsd: collateral.source,
    riskBudgetUsd: riskBudget.source,
    totalAllocatedUsd:
      totalAllocated === null ? null : formatDecimal(totalAllocated),
    totalMaxLossUsd: totalMaxLoss === null ? null : formatDecimal(totalMaxLoss),
    remainingRiskBudgetUsd:
      remainingRiskBudget === null ? null : formatDecimal(remainingRiskBudget),
    status: eligible ? "eligible" : "ineligible",
    reasons,
    candidates: candidates.map((candidate) =>
      snapshotCandidate(candidate, eligible),
    ),
  };
}
