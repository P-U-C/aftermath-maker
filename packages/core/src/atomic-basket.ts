/**
 * Deterministic, Paper-only replay for a basket reservation. It has no venue,
 * wallet, transport, or runtime dependencies.
 */
export type AtomicBasketLegStatus = "complete" | "pending" | "failed";

export interface AtomicBasketLegEvidence {
  readonly legId: string;
  readonly status: AtomicBasketLegStatus;
}

export interface AtomicBasketSlice {
  readonly sliceId: string;
  readonly legIds: readonly string[];
}

export interface AtomicBasketDefinition {
  readonly basketId: string;
  readonly slices: readonly AtomicBasketSlice[];
}

export interface AtomicBasketSliceEvidence {
  readonly sliceId: string;
  readonly legs: readonly AtomicBasketLegEvidence[];
}

interface AtomicBasketEventBase {
  readonly eventId: string;
  readonly sourceTime: number;
  readonly basketId: string;
}

export interface AtomicBasketSliceEvidenceEvent
  extends AtomicBasketEventBase, AtomicBasketSliceEvidence {
  readonly kind: "SLICE_EVIDENCE";
}

export interface AtomicBasketReconciliationEvent extends AtomicBasketEventBase {
  readonly kind: "BASKET_RECONCILIATION";
  readonly slices: readonly AtomicBasketSliceEvidence[];
}

export interface AtomicBasketRetryRequestedEvent extends AtomicBasketEventBase {
  readonly kind: "RETRY_REQUESTED";
  readonly riskIncreasing: boolean;
}

export interface AtomicBasketCancelConfirmedEvent extends AtomicBasketEventBase {
  readonly kind: "CANCEL_CONFIRMED";
}

export type AtomicBasketEvent =
  | AtomicBasketSliceEvidenceEvent
  | AtomicBasketReconciliationEvent
  | AtomicBasketRetryRequestedEvent
  | AtomicBasketCancelConfirmedEvent;

export interface AtomicBasketCheckpoint {
  readonly sourceTime: number;
  readonly eventId: string;
}

export type AtomicBasketReservation = "RESERVED" | "RELEASED";
export type AtomicBasketStatus =
  "PENDING" | "RECONCILIATION_REQUIRED" | "RECONCILED" | "CANCELLED";

export interface AtomicBasketState {
  readonly basket: AtomicBasketDefinition;
  readonly basketId: string;
  readonly reservation: AtomicBasketReservation;
  readonly status: AtomicBasketStatus;
  readonly riskIncreasingRetryAllowed: false;
  readonly checkpoint: AtomicBasketCheckpoint | null;
  readonly appliedEventIds: readonly string[];
  readonly events: readonly AtomicBasketEvent[];
  readonly rejectionReasons: readonly string[];
}

/** Creates a new reservation after validating its declared, unique legs. */
export function createAtomicBasketState(
  basket: AtomicBasketDefinition,
): AtomicBasketState {
  validateBasketDefinition(basket);
  return replayAtomicBasket(basket, []);
}

/**
 * Adds unseen evidence then deterministically replays the complete local log.
 * Applied event IDs are a checkpoint-safe dedupe boundary; source-time and
 * event ID provide a stable ordering for out-of-order input.
 */
export function applyAtomicBasketEvents(
  state: AtomicBasketState,
  incomingEvents: readonly AtomicBasketEvent[],
): AtomicBasketState {
  validateBasketDefinition(state.basket);

  const seenEventIds = new Set(state.appliedEventIds);
  const persistedEvents = [...state.events].sort(compareAtomicBasketEvents);
  for (const event of persistedEvents) {
    seenEventIds.add(event.eventId);
  }

  const unseenEvents: AtomicBasketEvent[] = [];
  for (const event of [...incomingEvents].sort(compareAtomicBasketEvents)) {
    if (!seenEventIds.has(event.eventId)) {
      seenEventIds.add(event.eventId);
      unseenEvents.push(event);
    }
  }

  return replayAtomicBasket(state.basket, [
    ...persistedEvents,
    ...unseenEvents,
  ]);
}

function replayAtomicBasket(
  basket: AtomicBasketDefinition,
  events: readonly AtomicBasketEvent[],
): AtomicBasketState {
  const orderedEvents = [...events].sort(compareAtomicBasketEvents);
  let reservation: AtomicBasketReservation = "RESERVED";
  let status: AtomicBasketStatus = "PENDING";
  let rejectionReasons: string[] = [];

  for (const event of orderedEvents) {
    if (event.basketId !== basket.basketId) {
      if (reservation === "RESERVED") {
        status = "RECONCILIATION_REQUIRED";
        rejectionReasons = appendReasons(rejectionReasons, [
          "basket-id-mismatch",
        ]);
      }
      continue;
    }

    if (reservation === "RELEASED") {
      continue;
    }

    switch (event.kind) {
      case "SLICE_EVIDENCE": {
        const reasons = validateSliceEvidence(basket, event);
        if (reasons.length > 0) {
          status = "RECONCILIATION_REQUIRED";
          rejectionReasons = appendReasons(rejectionReasons, reasons);
        }
        break;
      }
      case "BASKET_RECONCILIATION": {
        const reasons = validateBasketReconciliation(basket, event.slices);
        if (reasons.length > 0) {
          status = "RECONCILIATION_REQUIRED";
          rejectionReasons = appendReasons(rejectionReasons, reasons);
        } else {
          reservation = "RELEASED";
          status = "RECONCILED";
          rejectionReasons = [];
        }
        break;
      }
      case "RETRY_REQUESTED": {
        if (event.riskIncreasing) {
          rejectionReasons = appendReasons(rejectionReasons, [
            "risk-increasing-retry-blocked",
          ]);
        }
        break;
      }
      case "CANCEL_CONFIRMED": {
        reservation = "RELEASED";
        status = "CANCELLED";
        rejectionReasons = [];
        break;
      }
    }
  }

  const lastEvent = orderedEvents.at(-1);
  return {
    basket,
    basketId: basket.basketId,
    reservation,
    status,
    riskIncreasingRetryAllowed: false,
    checkpoint: lastEvent
      ? { sourceTime: lastEvent.sourceTime, eventId: lastEvent.eventId }
      : null,
    appliedEventIds: orderedEvents.map((event) => event.eventId),
    events: orderedEvents,
    rejectionReasons,
  };
}

function validateBasketDefinition(basket: AtomicBasketDefinition): void {
  if (basket.basketId.length === 0) {
    throw new Error("basket ID is required");
  }

  const sliceIds = new Set<string>();
  const legIds = new Set<string>();
  for (const slice of basket.slices) {
    if (slice.sliceId.length === 0) {
      throw new Error("slice ID is required");
    }
    if (sliceIds.has(slice.sliceId)) {
      throw new Error("slice IDs must be unique");
    }
    sliceIds.add(slice.sliceId);

    for (const legId of slice.legIds) {
      if (legId.length === 0) {
        throw new Error("declared leg ID is required");
      }
      if (legIds.has(legId)) {
        throw new Error("declared leg IDs must be unique");
      }
      legIds.add(legId);
    }
  }
}

function validateBasketReconciliation(
  basket: AtomicBasketDefinition,
  evidence: readonly AtomicBasketSliceEvidence[],
): string[] {
  const declaredSliceIds = new Set(basket.slices.map((slice) => slice.sliceId));
  const evidenceSliceIds = new Set<string>();
  const reasons: string[] = [];

  for (const sliceEvidence of evidence) {
    if (!declaredSliceIds.has(sliceEvidence.sliceId)) {
      reasons.push(`basket:unknown-slice:${sliceEvidence.sliceId}`);
      continue;
    }
    if (evidenceSliceIds.has(sliceEvidence.sliceId)) {
      reasons.push(`basket:duplicate-slice:${sliceEvidence.sliceId}`);
      continue;
    }
    evidenceSliceIds.add(sliceEvidence.sliceId);
    reasons.push(...validateSliceEvidence(basket, sliceEvidence));
  }

  for (const declaredSlice of basket.slices) {
    if (!evidenceSliceIds.has(declaredSlice.sliceId)) {
      reasons.push(`basket:missing-slice:${declaredSlice.sliceId}`);
    }
  }

  return reasons;
}

function validateSliceEvidence(
  basket: AtomicBasketDefinition,
  evidence: AtomicBasketSliceEvidence,
): string[] {
  const slice = basket.slices.find(
    (candidate) => candidate.sliceId === evidence.sliceId,
  );
  if (!slice) {
    return [`basket:unknown-slice:${evidence.sliceId}`];
  }

  const declaredLegIds = new Set(slice.legIds);
  const observedLegIds = new Set<string>();
  const reasons: string[] = [];
  for (const leg of evidence.legs) {
    if (!declaredLegIds.has(leg.legId)) {
      reasons.push(`${slice.sliceId}:unknown:${leg.legId}`);
      continue;
    }
    if (observedLegIds.has(leg.legId)) {
      reasons.push(`${slice.sliceId}:duplicate:${leg.legId}`);
      continue;
    }
    observedLegIds.add(leg.legId);
    if (leg.status !== "complete") {
      reasons.push(`${slice.sliceId}:incomplete:${leg.legId}`);
    }
  }

  for (const legId of slice.legIds) {
    if (!observedLegIds.has(legId)) {
      reasons.push(`${slice.sliceId}:missing:${legId}`);
    }
  }
  return reasons;
}

function appendReasons(
  current: readonly string[],
  next: readonly string[],
): string[] {
  return [...current, ...next.filter((reason) => !current.includes(reason))];
}

function compareAtomicBasketEvents(
  left: AtomicBasketEvent,
  right: AtomicBasketEvent,
): number {
  if (left.sourceTime !== right.sourceTime) {
    return left.sourceTime < right.sourceTime ? -1 : 1;
  }
  if (left.eventId !== right.eventId) {
    return left.eventId < right.eventId ? -1 : 1;
  }
  const leftPayload = stableJson(left);
  const rightPayload = stableJson(right);
  return leftPayload === rightPayload ? 0 : leftPayload < rightPayload ? -1 : 1;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
