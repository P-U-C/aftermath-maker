import type { DecimalString } from "./inventory-recycling.js";

/** Paper-only allocation evidence used to cap market concentration. */
export type PaperProfitabilityConcentrationCandidate = Readonly<{
  candidateId: string;
  marketId: string;
  allocatedUsd: DecimalString;
  maxLossUsd: DecimalString;
  status: "eligible" | "ineligible";
  reasons: readonly string[];
}>;

export type PaperProfitabilityConcentrationInput = Readonly<{
  /** Inclusive maximum share of total allocation in one market. */
  maxMarketAllocationBps: number;
  /** Inclusive maximum share of total max loss in one market. */
  maxMarketLossBps: number;
  candidates: readonly (PaperProfitabilityConcentrationCandidate | null)[];
}>;

export type PaperProfitabilityConcentrationReason =
  | "malformed_input"
  | "invalid_max_market_allocation_bps"
  | "invalid_max_market_loss_bps"
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
  | "loss_exceeds_allocation"
  | "market_allocation_concentration"
  | "market_loss_concentration";

export type PaperProfitabilityConcentrationRatio = Readonly<{
  numerator: string;
  denominator: string;
}>;

export type PaperProfitabilityConcentrationCandidateResult = Readonly<{
  candidateId: string | null;
  marketId: string | null;
  allocatedUsd: DecimalString | null;
  maxLossUsd: DecimalString | null;
  marketAllocatedUsd: DecimalString | null;
  marketMaxLossUsd: DecimalString | null;
  allocationShareBps: PaperProfitabilityConcentrationRatio | null;
  lossShareBps: PaperProfitabilityConcentrationRatio | null;
  status: "eligible" | "ineligible";
  reasons: readonly PaperProfitabilityConcentrationReason[];
}>;

export type PaperProfitabilityConcentrationResult = Readonly<{
  maxMarketAllocationBps: number | null;
  maxMarketLossBps: number | null;
  totalAllocatedUsd: DecimalString | null;
  totalMaxLossUsd: DecimalString | null;
  status: "eligible" | "ineligible";
  reasons: readonly PaperProfitabilityConcentrationReason[];
  candidates: readonly PaperProfitabilityConcentrationCandidateResult[];
}>;

type ParsedDecimal = Readonly<{ units: bigint; scale: number }>;
type ExactRatio = Readonly<{ numerator: bigint; denominator: bigint }>;

type MutableCandidate = {
  inputIndex: number;
  candidateId: string | null;
  marketId: string | null;
  allocatedUsd: string | null;
  allocated: ParsedDecimal | null;
  maxLossUsd: string | null;
  maxLoss: ParsedDecimal | null;
  marketAllocated: ParsedDecimal | null;
  marketMaxLoss: ParsedDecimal | null;
  allocationShareBps: ExactRatio | null;
  lossShareBps: ExactRatio | null;
  reasons: PaperProfitabilityConcentrationReason[];
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
  reasons: PaperProfitabilityConcentrationReason[],
  reason: PaperProfitabilityConcentrationReason,
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
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function ratioSnapshot(
  value: ExactRatio,
): PaperProfitabilityConcentrationRatio {
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
    value > 0 &&
    value <= 10_000
    ? value
    : null;
}

function parseCandidate(value: unknown, inputIndex: number): MutableCandidate {
  const source = isRecord(value) ? value : null;
  const candidateId = snapshotString(source?.candidateId);
  const marketId = snapshotString(source?.marketId);
  const allocatedUsd = snapshotString(source?.allocatedUsd);
  const maxLossUsd = snapshotString(source?.maxLossUsd);
  const allocated = parseDecimal(allocatedUsd);
  const maxLoss = parseDecimal(maxLossUsd);
  const reasons: PaperProfitabilityConcentrationReason[] = [];

  if (source === null) pushReason(reasons, "malformed_candidate");
  if (candidateId === null || candidateId.trim() === "")
    pushReason(reasons, "invalid_candidate_id");
  if (marketId === null || marketId.trim() === "")
    pushReason(reasons, "invalid_market_id");
  if (source?.status !== "eligible")
    pushReason(reasons, "candidate_not_eligible");
  if (!Array.isArray(source?.reasons) || source.reasons.length > 0)
    pushReason(reasons, "candidate_gaps_present");
  if (allocated === null) pushReason(reasons, "invalid_allocated_usd");
  else if (allocated.units < 0n) pushReason(reasons, "invalid_allocated_usd");
  else if (allocated.units === 0n)
    pushReason(reasons, "non_positive_allocated_usd");
  if (maxLoss === null) pushReason(reasons, "invalid_max_loss_usd");
  else if (maxLoss.units < 0n) pushReason(reasons, "invalid_max_loss_usd");
  else if (maxLoss.units === 0n)
    pushReason(reasons, "non_positive_max_loss_usd");
  if (
    allocated !== null &&
    allocated.units > 0n &&
    maxLoss !== null &&
    maxLoss.units > 0n &&
    compareDecimals(maxLoss, allocated) > 0
  ) {
    pushReason(reasons, "loss_exceeds_allocation");
  }

  return {
    inputIndex,
    candidateId,
    marketId,
    allocatedUsd,
    allocated: allocated !== null && allocated.units > 0n ? allocated : null,
    maxLossUsd,
    maxLoss: maxLoss !== null && maxLoss.units > 0n ? maxLoss : null,
    marketAllocated: null,
    marketMaxLoss: null,
    allocationShareBps: null,
    lossShareBps: null,
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
  for (const [leftValue, rightValue] of [
    [left.allocatedUsd, right.allocatedUsd],
    [left.maxLossUsd, right.maxLossUsd],
  ] as const) {
    const leftKey = leftValue ?? "";
    const rightKey = rightValue ?? "";
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  }
  return left.inputIndex - right.inputIndex;
}

function snapshotCandidate(
  candidate: MutableCandidate,
  eligible: boolean,
): PaperProfitabilityConcentrationCandidateResult {
  const reasons = [...candidate.reasons].sort();
  return {
    candidateId: candidate.candidateId,
    marketId: candidate.marketId,
    allocatedUsd: candidate.allocatedUsd,
    maxLossUsd: candidate.maxLossUsd,
    marketAllocatedUsd:
      candidate.marketAllocated === null
        ? null
        : formatDecimal(candidate.marketAllocated),
    marketMaxLossUsd:
      candidate.marketMaxLoss === null
        ? null
        : formatDecimal(candidate.marketMaxLoss),
    allocationShareBps:
      candidate.allocationShareBps === null
        ? null
        : ratioSnapshot(candidate.allocationShareBps),
    lossShareBps:
      candidate.lossShareBps === null
        ? null
        : ratioSnapshot(candidate.lossShareBps),
    status: eligible && reasons.length === 0 ? "eligible" : "ineligible",
    reasons,
  };
}

/** Reports exact market concentration for already-admitted Paper candidates. */
export function assessPaperProfitabilityConcentration(
  input: PaperProfitabilityConcentrationInput | null,
): PaperProfitabilityConcentrationResult {
  const source = isRecord(input) ? input : null;
  const reasons: PaperProfitabilityConcentrationReason[] = [];
  if (source === null) pushReason(reasons, "malformed_input");

  const maxMarketAllocationBps = parseLimit(source?.maxMarketAllocationBps);
  const maxMarketLossBps = parseLimit(source?.maxMarketLossBps);
  if (maxMarketAllocationBps === null)
    pushReason(reasons, "invalid_max_market_allocation_bps");
  if (maxMarketLossBps === null)
    pushReason(reasons, "invalid_max_market_loss_bps");

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

  let totalAllocated: ParsedDecimal | null =
    candidates.length === 0 ? null : { units: 0n, scale: 0 };
  let totalMaxLoss: ParsedDecimal | null =
    candidates.length === 0 ? null : { units: 0n, scale: 0 };
  const markets = new Map<
    string,
    {
      candidates: MutableCandidate[];
      allocated: ParsedDecimal;
      maxLoss: ParsedDecimal;
    }
  >();
  for (const candidate of candidates) {
    if (totalAllocated !== null) {
      if (candidate.allocated === null) totalAllocated = null;
      else totalAllocated = addDecimals(totalAllocated, candidate.allocated);
    }
    if (totalMaxLoss !== null) {
      if (candidate.maxLoss === null) totalMaxLoss = null;
      else totalMaxLoss = addDecimals(totalMaxLoss, candidate.maxLoss);
    }
    if (
      candidate.marketId !== null &&
      candidate.marketId.trim() !== "" &&
      candidate.allocated !== null &&
      candidate.maxLoss !== null
    ) {
      const market = markets.get(candidate.marketId) ?? {
        candidates: [],
        allocated: { units: 0n, scale: 0 },
        maxLoss: { units: 0n, scale: 0 },
      };
      market.candidates.push(candidate);
      market.allocated = addDecimals(market.allocated, candidate.allocated);
      market.maxLoss = addDecimals(market.maxLoss, candidate.maxLoss);
      markets.set(candidate.marketId, market);
    }
  }

  if (
    totalAllocated !== null &&
    totalMaxLoss !== null &&
    maxMarketAllocationBps !== null &&
    maxMarketLossBps !== null &&
    totalAllocated.units > 0n &&
    totalMaxLoss.units > 0n
  ) {
    for (const market of markets.values()) {
      const allocationShare = reduceRatio(
        unitsAtScale(market.allocated, market.allocated.scale) *
          10_000n *
          powerOfTen(totalAllocated.scale),
        unitsAtScale(totalAllocated, totalAllocated.scale) *
          powerOfTen(market.allocated.scale),
      );
      const lossShare = reduceRatio(
        unitsAtScale(market.maxLoss, market.maxLoss.scale) *
          10_000n *
          powerOfTen(totalMaxLoss.scale),
        unitsAtScale(totalMaxLoss, totalMaxLoss.scale) *
          powerOfTen(market.maxLoss.scale),
      );
      const allocationLimit = reduceRatio(BigInt(maxMarketAllocationBps), 1n);
      const lossLimit = reduceRatio(BigInt(maxMarketLossBps), 1n);
      for (const candidate of market.candidates) {
        candidate.marketAllocated = market.allocated;
        candidate.marketMaxLoss = market.maxLoss;
        candidate.allocationShareBps = allocationShare;
        candidate.lossShareBps = lossShare;
        if (compareRatios(allocationShare, allocationLimit) > 0)
          pushReason(candidate.reasons, "market_allocation_concentration");
        if (compareRatios(lossShare, lossLimit) > 0)
          pushReason(candidate.reasons, "market_loss_concentration");
      }
    }
  }

  for (const candidate of candidates) {
    for (const reason of candidate.reasons) pushReason(reasons, reason);
  }
  reasons.sort();
  candidates.sort(compareCandidates);
  const eligible =
    reasons.length === 0 &&
    maxMarketAllocationBps !== null &&
    maxMarketLossBps !== null &&
    totalAllocated !== null &&
    totalMaxLoss !== null &&
    totalAllocated.units > 0n &&
    totalMaxLoss.units > 0n &&
    candidates.length > 0;
  return {
    maxMarketAllocationBps,
    maxMarketLossBps,
    totalAllocatedUsd:
      totalAllocated === null ? null : formatDecimal(totalAllocated),
    totalMaxLossUsd: totalMaxLoss === null ? null : formatDecimal(totalMaxLoss),
    status: eligible ? "eligible" : "ineligible",
    reasons,
    candidates: candidates.map((candidate) =>
      snapshotCandidate(candidate, eligible),
    ),
  };
}
