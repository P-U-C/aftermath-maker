import type { DecimalString } from "./inventory-recycling.js";

/** A measured, Paper-only profitability row with costs expressed as magnitudes. */
export type PaperProfitabilityMarginCandidate = Readonly<{
  candidateId: string;
  marketId: string;
  collateralUsd: DecimalString;
  grossProfitUsd: DecimalString;
  venueFeesUsd: DecimalString;
  slippageUsd: DecimalString;
  fundingUsd: DecimalString;
  gasUsd: DecimalString;
  status: "eligible" | "ineligible";
  reasons: readonly string[];
}>;

export type PaperProfitabilityMarginInput = Readonly<{
  /** Positive decimal threshold for net profit after every listed cost. */
  minimumNetUsd: DecimalString;
  /** Integer basis-point threshold, inclusive, in [0, 10_000]. */
  minimumMarginBps: number;
  candidates: readonly (PaperProfitabilityMarginCandidate | null)[];
}>;

export type PaperProfitabilityMarginReason =
  | "malformed_input"
  | "invalid_minimum_net_usd"
  | "non_positive_minimum_net_usd"
  | "invalid_minimum_margin_bps"
  | "malformed_candidates"
  | "empty_candidates"
  | "sparse_candidates"
  | "malformed_candidate"
  | "invalid_candidate_id"
  | "invalid_market_id"
  | "duplicate_candidate"
  | "candidate_not_eligible"
  | "candidate_gaps_present"
  | "invalid_collateral_usd"
  | "non_positive_collateral_usd"
  | "invalid_gross_profit_usd"
  | "invalid_cost_usd"
  | "negative_cost_usd"
  | "net_profit_non_positive"
  | "net_profit_below_minimum"
  | "margin_below_minimum";

export type PaperProfitabilityMarginRatio = Readonly<{
  numerator: string;
  denominator: string;
}>;

export type PaperProfitabilityMarginCandidateResult = Readonly<{
  candidateId: string | null;
  marketId: string | null;
  collateralUsd: DecimalString | null;
  grossProfitUsd: DecimalString | null;
  totalCostsUsd: DecimalString | null;
  netProfitUsd: DecimalString | null;
  marginBps: PaperProfitabilityMarginRatio | null;
  status: "eligible" | "ineligible";
  reasons: readonly PaperProfitabilityMarginReason[];
}>;

export type PaperProfitabilityMarginResult = Readonly<{
  minimumNetUsd: DecimalString | null;
  minimumMarginBps: number | null;
  status: "eligible" | "ineligible";
  reasons: readonly PaperProfitabilityMarginReason[];
  candidates: readonly PaperProfitabilityMarginCandidateResult[];
}>;

type ParsedDecimal = Readonly<{ units: bigint; scale: number }>;
type ExactRatio = Readonly<{ numerator: bigint; denominator: bigint }>;

type MutableCandidate = {
  inputIndex: number;
  candidateId: string | null;
  marketId: string | null;
  collateralUsd: string | null;
  collateral: ParsedDecimal | null;
  grossProfitUsd: string | null;
  grossProfit: ParsedDecimal | null;
  totalCostsUsd: string | null;
  totalCosts: ParsedDecimal | null;
  netProfit: ParsedDecimal | null;
  marginBps: ExactRatio | null;
  reasons: PaperProfitabilityMarginReason[];
};

const DECIMAL_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/;
const MAX_DECIMAL_DIGITS = 128;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function pushReason(
  reasons: PaperProfitabilityMarginReason[],
  reason: PaperProfitabilityMarginReason,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function parseDecimal(value: unknown): ParsedDecimal | null {
  if (typeof value !== "string") return null;
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) return null;
  const fraction = match[3] ?? "";
  if (match[2]!.length + fraction.length > MAX_DECIMAL_DIGITS) return null;
  const magnitude = BigInt(`${match[2]}${fraction}`);
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

function reduceRatio(numerator: bigint, denominator: bigint): ExactRatio {
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function ratioToSnapshot(value: ExactRatio): PaperProfitabilityMarginRatio {
  return {
    numerator: value.numerator.toString(),
    denominator: value.denominator.toString(),
  };
}

function compareRatios(left: ExactRatio, right: ExactRatio): number {
  const leftProduct = left.numerator * right.denominator;
  const rightProduct = right.numerator * left.denominator;
  return leftProduct < rightProduct ? -1 : leftProduct > rightProduct ? 1 : 0;
}

function parseMarginBps(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 10_000
    ? value
    : null;
}

function parseCandidate(value: unknown, inputIndex: number): MutableCandidate {
  const source = isRecord(value) ? value : null;
  const candidateId = snapshotString(source?.candidateId);
  const marketId = snapshotString(source?.marketId);
  const collateralUsd = snapshotString(source?.collateralUsd);
  const grossProfitUsd = snapshotString(source?.grossProfitUsd);
  const collateral = parseDecimal(collateralUsd);
  const grossProfit = parseDecimal(grossProfitUsd);
  const reasons: PaperProfitabilityMarginReason[] = [];

  if (source === null) pushReason(reasons, "malformed_candidate");
  if (candidateId === null || candidateId.trim() === "")
    pushReason(reasons, "invalid_candidate_id");
  if (marketId === null || marketId.trim() === "")
    pushReason(reasons, "invalid_market_id");
  if (source?.status !== "eligible")
    pushReason(reasons, "candidate_not_eligible");
  if (!Array.isArray(source?.reasons) || source.reasons.length > 0)
    pushReason(reasons, "candidate_gaps_present");

  if (collateral === null) pushReason(reasons, "invalid_collateral_usd");
  else if (collateral.units <= 0n)
    pushReason(reasons, "non_positive_collateral_usd");
  if (grossProfit === null) pushReason(reasons, "invalid_gross_profit_usd");

  const costs: (keyof PaperProfitabilityMarginCandidate)[] = [
    "venueFeesUsd",
    "slippageUsd",
    "fundingUsd",
    "gasUsd",
  ];
  let totalCosts: ParsedDecimal | null = { units: 0n, scale: 0 };
  for (const key of costs) {
    const parsed = parseDecimal(source?.[key]);
    if (parsed === null) {
      pushReason(reasons, "invalid_cost_usd");
      totalCosts = null;
    } else if (parsed.units < 0n) {
      pushReason(reasons, "negative_cost_usd");
      totalCosts = null;
    } else if (totalCosts !== null) {
      totalCosts = addDecimals(totalCosts, parsed);
    }
  }

  const netProfit =
    grossProfit !== null && totalCosts !== null
      ? subtractDecimals(grossProfit, totalCosts)
      : null;
  if (netProfit !== null && netProfit.units <= 0n)
    pushReason(reasons, "net_profit_non_positive");

  const marginBps =
    netProfit !== null && collateral !== null && collateral.units > 0n
      ? reduceRatio(
          unitsAtScale(netProfit, netProfit.scale) *
            10_000n *
            powerOfTen(collateral.scale),
          unitsAtScale(collateral, collateral.scale) *
            powerOfTen(netProfit.scale),
        )
      : null;

  return {
    inputIndex,
    candidateId,
    marketId,
    collateralUsd,
    collateral:
      collateral !== null && collateral.units > 0n ? collateral : null,
    grossProfitUsd,
    grossProfit,
    totalCostsUsd: totalCosts === null ? null : formatDecimal(totalCosts),
    totalCosts,
    netProfit,
    marginBps,
    reasons,
  };
}

function markDuplicates(candidates: MutableCandidate[]): void {
  const groups = new Map<string, MutableCandidate[]>();
  for (const candidate of candidates) {
    if (
      candidate.candidateId === null ||
      candidate.candidateId.trim() === "" ||
      candidate.marketId === null ||
      candidate.marketId.trim() === ""
    )
      continue;
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

function compareCandidates(
  left: MutableCandidate,
  right: MutableCandidate,
): number {
  const leftId = left.candidateId ?? "";
  const rightId = right.candidateId ?? "";
  if (leftId !== rightId) return leftId < rightId ? -1 : 1;
  const leftMarket = left.marketId ?? "";
  const rightMarket = right.marketId ?? "";
  if (leftMarket !== rightMarket) return leftMarket < rightMarket ? -1 : 1;
  for (const [leftValue, rightValue] of [
    [left.collateralUsd, right.collateralUsd],
    [left.grossProfitUsd, right.grossProfitUsd],
    [left.totalCostsUsd, right.totalCostsUsd],
  ] as const) {
    const leftKey = leftValue ?? "";
    const rightKey = rightValue ?? "";
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  }
  return left.inputIndex - right.inputIndex;
}

function snapshotCandidate(
  candidate: MutableCandidate,
  portfolioEligible: boolean,
): PaperProfitabilityMarginCandidateResult {
  const reasons = [...candidate.reasons].sort();
  return {
    candidateId: candidate.candidateId,
    marketId: candidate.marketId,
    collateralUsd: candidate.collateralUsd,
    grossProfitUsd: candidate.grossProfitUsd,
    totalCostsUsd: candidate.totalCostsUsd,
    netProfitUsd:
      candidate.netProfit === null ? null : formatDecimal(candidate.netProfit),
    marginBps:
      candidate.marginBps === null
        ? null
        : ratioToSnapshot(candidate.marginBps),
    status:
      portfolioEligible && reasons.length === 0 ? "eligible" : "ineligible",
    reasons,
  };
}

/**
 * Screens measured Paper candidates after explicit venue, slippage, funding,
 * and gas costs. It reports evidence only and cannot authorize execution.
 */
export function assessPaperProfitabilityMargin(
  input: PaperProfitabilityMarginInput | null,
): PaperProfitabilityMarginResult {
  const source = isRecord(input) ? input : null;
  const reasons: PaperProfitabilityMarginReason[] = [];
  if (source === null) pushReason(reasons, "malformed_input");

  const minimumNetUsd = snapshotString(source?.minimumNetUsd);
  const minimumNet = parseDecimal(minimumNetUsd);
  if (minimumNet === null) pushReason(reasons, "invalid_minimum_net_usd");
  else if (minimumNet.units <= 0n)
    pushReason(reasons, "non_positive_minimum_net_usd");

  const minimumMarginBps = parseMarginBps(source?.minimumMarginBps);
  if (minimumMarginBps === null)
    pushReason(reasons, "invalid_minimum_margin_bps");

  const rawCandidates = Array.isArray(source?.candidates)
    ? source.candidates
    : null;
  if (rawCandidates === null) pushReason(reasons, "malformed_candidates");
  else if (rawCandidates.length === 0) pushReason(reasons, "empty_candidates");

  const candidates: MutableCandidate[] = [];
  for (let index = 0; index < (rawCandidates?.length ?? 0); index += 1) {
    if (!Object.prototype.hasOwnProperty.call(rawCandidates!, index)) {
      pushReason(reasons, "sparse_candidates");
      candidates.push(parseCandidate(null, index));
    } else {
      candidates.push(parseCandidate(rawCandidates![index], index));
    }
  }
  markDuplicates(candidates);

  for (const candidate of candidates) {
    if (
      minimumNet !== null &&
      minimumNet.units > 0n &&
      candidate.netProfit !== null &&
      compareDecimals(candidate.netProfit, minimumNet) < 0
    ) {
      pushReason(candidate.reasons, "net_profit_below_minimum");
    }
    if (
      minimumMarginBps !== null &&
      candidate.marginBps !== null &&
      compareRatios(
        candidate.marginBps,
        reduceRatio(BigInt(minimumMarginBps), 1n),
      ) < 0
    ) {
      pushReason(candidate.reasons, "margin_below_minimum");
    }
    for (const reason of candidate.reasons) pushReason(reasons, reason);
  }
  reasons.sort();
  candidates.sort(compareCandidates);
  const eligible =
    reasons.length === 0 &&
    minimumNet !== null &&
    minimumNet.units > 0n &&
    minimumMarginBps !== null &&
    candidates.length > 0;
  return {
    minimumNetUsd,
    minimumMarginBps,
    status: eligible ? "eligible" : "ineligible",
    reasons,
    candidates: candidates.map((candidate) =>
      snapshotCandidate(candidate, eligible),
    ),
  };
}
