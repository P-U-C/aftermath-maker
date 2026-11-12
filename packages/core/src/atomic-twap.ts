/** A declared source-time window for one deterministic Paper replay slice. */
export interface PaperAtomicTwapSourceWindow {
  readonly start: number;
  readonly end: number;
}

/** One non-overlapping, data-only Paper Atomic-TWAP slice. */
export interface PaperAtomicTwapSlice {
  readonly sliceId: string;
  readonly sourceWindow: PaperAtomicTwapSourceWindow;
  readonly sizeUsd: number;
}

/** Input for a deterministic, equal-sized Paper Atomic-TWAP schedule. */
export interface PaperAtomicTwapSchedule {
  readonly mode: "Paper";
  readonly basketId: string;
  /** Epoch-millisecond source time for the first slice. */
  readonly startSourceTime: number;
  /** Start-to-start source-time spacing in milliseconds. */
  readonly cadenceMs: number;
  /** Source-time window width in milliseconds. */
  readonly windowMs: number;
  readonly sliceCount: number;
  readonly totalUsd: number;
  /** Optional externally declared identities; otherwise identities are derived. */
  readonly sliceIds?: readonly string[];
}

/** The pure, Paper-only schedule emitted for atomic-basket replay. */
export interface PaperAtomicTwapPlan {
  readonly mode: "Paper";
  readonly basketId: string;
  readonly totalUsd: number;
  readonly slices: readonly PaperAtomicTwapSlice[];
}

// A larger plan is not a practical in-memory replay schedule. This bound keeps
// a malformed count from allocating an unbounded Paper plan.
const MAX_PAPER_ATOMIC_TWAP_SLICES = 10_000;

/**
 * Builds a deterministic, equal-sized Paper-only TWAP plan. This is only
 * schedule data: it has no venue, network, signing, runtime, or order logic.
 */
export function buildPaperAtomicTwapPlan(
  schedule: PaperAtomicTwapSchedule,
): PaperAtomicTwapPlan {
  validateSchedule(schedule);

  const sliceIds = resolveSliceIds(schedule);
  const baseSizeUsd = schedule.totalUsd / schedule.sliceCount;
  if (!Number.isFinite(baseSizeUsd) || baseSizeUsd <= 0) {
    throw new Error("slice size must be finite and positive");
  }

  const slices: PaperAtomicTwapSlice[] = [];
  let priorWindow: PaperAtomicTwapSourceWindow | null = null;
  let assignedUsd = 0;
  for (let index = 0; index < schedule.sliceCount; index += 1) {
    const sourceWindow = sourceWindowAt(schedule, index);
    if (priorWindow !== null && sourceWindow.start < priorWindow.end) {
      throw new Error("slice source-time windows must not overlap");
    }

    // Preserve the declared total in the final slice despite floating-point
    // division, while still rejecting an underflowed or non-finite remainder.
    const sizeUsd =
      index === schedule.sliceCount - 1
        ? schedule.totalUsd - assignedUsd
        : baseSizeUsd;
    if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) {
      throw new Error("slice size must be finite and positive");
    }
    const nextAssignedUsd = assignedUsd + sizeUsd;
    if (!Number.isFinite(nextAssignedUsd)) {
      throw new Error("USD allocation arithmetic overflow");
    }

    slices.push({ sliceId: sliceIds[index]!, sourceWindow, sizeUsd });
    priorWindow = sourceWindow;
    assignedUsd = nextAssignedUsd;
  }

  return {
    mode: "Paper",
    basketId: schedule.basketId,
    totalUsd: schedule.totalUsd,
    slices,
  };
}

function validateSchedule(schedule: PaperAtomicTwapSchedule): void {
  if (!schedule || typeof schedule !== "object") {
    throw new Error("Paper Atomic-TWAP schedule is required");
  }
  if (schedule.mode !== "Paper") {
    throw new Error("Paper Atomic-TWAP mode must be Paper");
  }
  if (
    typeof schedule.basketId !== "string" ||
    schedule.basketId.trim() === ""
  ) {
    throw new Error("basket ID is required");
  }
  if (!isNonNegativeSafeInteger(schedule.startSourceTime)) {
    throw new Error("start source time must be a non-negative safe integer");
  }
  if (!isPositiveSafeInteger(schedule.cadenceMs)) {
    throw new Error("cadence must be a positive safe integer");
  }
  if (!isPositiveSafeInteger(schedule.windowMs)) {
    throw new Error("window must be a positive safe integer");
  }
  if (schedule.windowMs > schedule.cadenceMs) {
    throw new Error("slice source-time windows must not overlap");
  }
  if (!isPositiveSafeInteger(schedule.sliceCount)) {
    throw new Error("slice count must be a positive safe integer");
  }
  if (schedule.sliceCount > MAX_PAPER_ATOMIC_TWAP_SLICES) {
    throw new Error("slice count exceeds the Paper Atomic-TWAP limit");
  }
  if (!Number.isFinite(schedule.totalUsd) || schedule.totalUsd <= 0) {
    throw new Error("total USD must be finite and positive");
  }
  if (
    schedule.sliceIds !== undefined &&
    (!Array.isArray(schedule.sliceIds) ||
      schedule.sliceIds.length !== schedule.sliceCount)
  ) {
    throw new Error("declared slice IDs must match slice count");
  }
}

function resolveSliceIds(schedule: PaperAtomicTwapSchedule): readonly string[] {
  const sliceIds =
    schedule.sliceIds ??
    Array.from(
      { length: schedule.sliceCount },
      (_, index) =>
        `${schedule.basketId}:twap:${schedule.startSourceTime}:${index}`,
    );
  const seen = new Set<string>();
  for (const sliceId of sliceIds) {
    if (typeof sliceId !== "string" || sliceId.trim() === "") {
      throw new Error("slice ID is required");
    }
    if (seen.has(sliceId)) {
      throw new Error("slice IDs must be unique");
    }
    seen.add(sliceId);
  }
  return sliceIds;
}

function sourceWindowAt(
  schedule: PaperAtomicTwapSchedule,
  index: number,
): PaperAtomicTwapSourceWindow {
  const offset = schedule.cadenceMs * index;
  if (!Number.isSafeInteger(offset)) {
    throw new Error("source-time arithmetic overflow");
  }
  const start = schedule.startSourceTime + offset;
  const end = start + schedule.windowMs;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new Error("source-time arithmetic overflow");
  }
  return { start, end };
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
