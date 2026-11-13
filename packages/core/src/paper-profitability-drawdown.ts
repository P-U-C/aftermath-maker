import type { DecimalString } from "./inventory-recycling.js";

export type PaperProfitabilityDrawdownPoint = Readonly<{
  observedAtMs: number;
  equityUsd: DecimalString;
}>;

export type PaperProfitabilityDrawdownCandidate = Readonly<{
  candidateId: string;
  marketId: string;
  points: readonly (PaperProfitabilityDrawdownPoint | null)[];
  status: "eligible" | "ineligible";
  reasons: readonly string[];
}>;

export type PaperProfitabilityDrawdownInput = Readonly<{
  /** Inclusive maximum peak-to-trough drawdown, in basis points. */
  maxDrawdownBps: number;
  /** Minimum number of ordered equity observations required. */
  minimumPoints: number;
  candidates: readonly (PaperProfitabilityDrawdownCandidate | null)[];
}>;

export type PaperProfitabilityDrawdownReason =
  | "malformed_input"
  | "invalid_max_drawdown_bps"
  | "invalid_minimum_points"
  | "malformed_candidates"
  | "empty_candidates"
  | "sparse_candidates"
  | "malformed_candidate"
  | "invalid_candidate_id"
  | "invalid_market_id"
  | "duplicate_candidate"
  | "candidate_not_eligible"
  | "candidate_gaps_present"
  | "malformed_points"
  | "empty_points"
  | "sparse_points"
  | "malformed_point"
  | "invalid_observed_at_ms"
  | "invalid_equity_usd"
  | "non_positive_equity_usd"
  | "non_monotonic_points"
  | "insufficient_points"
  | "drawdown_above_limit";

export type PaperProfitabilityDrawdownRatio = Readonly<{
  numerator: string;
  denominator: string;
}>;

export type PaperProfitabilityDrawdownCandidateResult = Readonly<{
  candidateId: string | null;
  marketId: string | null;
  pointCount: number;
  startAtMs: number | null;
  endAtMs: number | null;
  peakEquityUsd: DecimalString | null;
  troughEquityUsd: DecimalString | null;
  maxDrawdownUsd: DecimalString | null;
  maxDrawdownBps: PaperProfitabilityDrawdownRatio | null;
  status: "eligible" | "ineligible";
  reasons: readonly PaperProfitabilityDrawdownReason[];
}>;

export type PaperProfitabilityDrawdownResult = Readonly<{
  maxDrawdownBps: number | null;
  minimumPoints: number | null;
  status: "eligible" | "ineligible";
  reasons: readonly PaperProfitabilityDrawdownReason[];
  candidates: readonly PaperProfitabilityDrawdownCandidateResult[];
}>;

type ParsedDecimal = Readonly<{ units: bigint; scale: number }>;
type ExactRatio = Readonly<{ numerator: bigint; denominator: bigint }>;

type MutableCandidate = {
  inputIndex: number;
  candidateId: string | null;
  marketId: string | null;
  pointCount: number;
  startAtMs: number | null;
  endAtMs: number | null;
  peakEquity: ParsedDecimal | null;
  troughEquity: ParsedDecimal | null;
  maxDrawdown: ParsedDecimal | null;
  maxDrawdownBps: ExactRatio | null;
  reasons: PaperProfitabilityDrawdownReason[];
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
  reasons: PaperProfitabilityDrawdownReason[],
  reason: PaperProfitabilityDrawdownReason,
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

function compareDecimals(left: ParsedDecimal, right: ParsedDecimal): number {
  const scale = Math.max(left.scale, right.scale);
  const leftUnits = unitsAtScale(left, scale);
  const rightUnits = unitsAtScale(right, scale);
  return leftUnits < rightUnits ? -1 : leftUnits > rightUnits ? 1 : 0;
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
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function ratioSnapshot(value: ExactRatio): PaperProfitabilityDrawdownRatio {
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

function parseLimit(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 10_000
    ? value
    : null;
}

function parseMinimumPoints(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 2 &&
    value <= 1_000_000
    ? value
    : null;
}

function parseCandidate(value: unknown, inputIndex: number): MutableCandidate {
  const source = isRecord(value) ? value : null;
  const candidateId = snapshotString(source?.candidateId);
  const marketId = snapshotString(source?.marketId);
  const reasons: PaperProfitabilityDrawdownReason[] = [];
  if (source === null) pushReason(reasons, "malformed_candidate");
  if (candidateId === null || candidateId.trim() === "")
    pushReason(reasons, "invalid_candidate_id");
  if (marketId === null || marketId.trim() === "")
    pushReason(reasons, "invalid_market_id");
  if (source?.status !== "eligible")
    pushReason(reasons, "candidate_not_eligible");
  if (!Array.isArray(source?.reasons) || source.reasons.length > 0)
    pushReason(reasons, "candidate_gaps_present");

  const rawPoints = Array.isArray(source?.points) ? source.points : null;
  if (rawPoints === null) pushReason(reasons, "malformed_points");
  else if (rawPoints.length === 0) pushReason(reasons, "empty_points");

  const points: { observedAtMs: number; equity: ParsedDecimal }[] = [];
  for (let index = 0; index < (rawPoints?.length ?? 0); index += 1) {
    if (!Object.prototype.hasOwnProperty.call(rawPoints!, index)) {
      pushReason(reasons, "sparse_points");
      pushReason(reasons, "malformed_point");
      continue;
    }
    const rawPoint = rawPoints![index];
    if (!isRecord(rawPoint)) {
      pushReason(reasons, "malformed_point");
      continue;
    }
    const observedAtMs = rawPoint.observedAtMs;
    const equity = parseDecimal(rawPoint.equityUsd);
    if (
      typeof observedAtMs !== "number" ||
      !Number.isSafeInteger(observedAtMs) ||
      observedAtMs < 0
    ) {
      pushReason(reasons, "invalid_observed_at_ms");
    }
    if (equity === null) pushReason(reasons, "invalid_equity_usd");
    else if (equity.units <= 0n) pushReason(reasons, "non_positive_equity_usd");
    if (
      typeof observedAtMs === "number" &&
      Number.isSafeInteger(observedAtMs) &&
      observedAtMs >= 0 &&
      equity !== null &&
      equity.units > 0n
    ) {
      points.push({ observedAtMs, equity });
    }
  }
  if (points.length > 1) {
    for (let index = 1; index < points.length; index += 1) {
      if (points[index]!.observedAtMs <= points[index - 1]!.observedAtMs) {
        pushReason(reasons, "non_monotonic_points");
        break;
      }
    }
  }

  let peak: ParsedDecimal | null = null;
  let peakAtMs: number | null = null;
  let trough: ParsedDecimal | null = null;
  let maxDrawdown: ParsedDecimal | null = null;
  let drawdownPeak: ParsedDecimal | null = null;
  if (points.length > 0 && !reasons.includes("non_monotonic_points")) {
    for (const point of points) {
      if (peak === null || compareDecimals(point.equity, peak) > 0) {
        peak = point.equity;
        peakAtMs = point.observedAtMs;
      }
      if (peak !== null && peakAtMs !== null) {
        const drawdown = subtractDecimals(peak, point.equity);
        if (
          maxDrawdown === null ||
          compareDecimals(drawdown, maxDrawdown) > 0
        ) {
          maxDrawdown = drawdown;
          drawdownPeak = peak;
          trough = point.equity;
        }
      }
    }
  }
  const maxDrawdownBps =
    maxDrawdown !== null && drawdownPeak !== null
      ? reduceRatio(
          unitsAtScale(maxDrawdown, maxDrawdown.scale) *
            10_000n *
            powerOfTen(drawdownPeak.scale),
          unitsAtScale(drawdownPeak, drawdownPeak.scale) *
            powerOfTen(maxDrawdown.scale),
        )
      : null;
  return {
    inputIndex,
    candidateId,
    marketId,
    pointCount: points.length,
    startAtMs: points[0]?.observedAtMs ?? null,
    endAtMs: points.at(-1)?.observedAtMs ?? null,
    peakEquity: drawdownPeak,
    troughEquity: trough,
    maxDrawdown,
    maxDrawdownBps,
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
    const key = JSON.stringify([candidate.candidateId, candidate.marketId]);
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
  return left.inputIndex - right.inputIndex;
}

function snapshotCandidate(
  candidate: MutableCandidate,
  eligible: boolean,
): PaperProfitabilityDrawdownCandidateResult {
  const reasons = [...candidate.reasons].sort();
  return {
    candidateId: candidate.candidateId,
    marketId: candidate.marketId,
    pointCount: candidate.pointCount,
    startAtMs: candidate.startAtMs,
    endAtMs: candidate.endAtMs,
    peakEquityUsd:
      candidate.peakEquity === null
        ? null
        : formatDecimal(candidate.peakEquity),
    troughEquityUsd:
      candidate.troughEquity === null
        ? null
        : formatDecimal(candidate.troughEquity),
    maxDrawdownUsd:
      candidate.maxDrawdown === null
        ? null
        : formatDecimal(candidate.maxDrawdown),
    maxDrawdownBps:
      candidate.maxDrawdownBps === null
        ? null
        : ratioSnapshot(candidate.maxDrawdownBps),
    status: eligible && reasons.length === 0 ? "eligible" : "ineligible",
    reasons,
  };
}

/** Computes a conservative peak-to-trough drawdown gate from Paper evidence. */
export function assessPaperProfitabilityDrawdown(
  input: PaperProfitabilityDrawdownInput | null,
): PaperProfitabilityDrawdownResult {
  const source = isRecord(input) ? input : null;
  const reasons: PaperProfitabilityDrawdownReason[] = [];
  if (source === null) pushReason(reasons, "malformed_input");
  const maxDrawdownBps = parseLimit(source?.maxDrawdownBps);
  const minimumPoints = parseMinimumPoints(source?.minimumPoints);
  if (maxDrawdownBps === null) pushReason(reasons, "invalid_max_drawdown_bps");
  if (minimumPoints === null) pushReason(reasons, "invalid_minimum_points");

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
    if (minimumPoints !== null && candidate.pointCount < minimumPoints) {
      pushReason(candidate.reasons, "insufficient_points");
    }
    if (
      maxDrawdownBps !== null &&
      candidate.maxDrawdownBps !== null &&
      compareRatios(
        candidate.maxDrawdownBps,
        reduceRatio(BigInt(maxDrawdownBps), 1n),
      ) > 0
    ) {
      pushReason(candidate.reasons, "drawdown_above_limit");
    }
    for (const reason of candidate.reasons) pushReason(reasons, reason);
  }
  reasons.sort();
  candidates.sort(compareCandidates);
  const eligible =
    reasons.length === 0 &&
    maxDrawdownBps !== null &&
    minimumPoints !== null &&
    candidates.length > 0;
  return {
    maxDrawdownBps,
    minimumPoints,
    status: eligible ? "eligible" : "ineligible",
    reasons,
    candidates: candidates.map((candidate) =>
      snapshotCandidate(candidate, eligible),
    ),
  };
}
