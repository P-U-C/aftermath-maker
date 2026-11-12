import { describe, expect, it } from "vitest";
import {
  applyAtomicBasketEvents,
  createAtomicBasketState,
} from "../src/atomic-basket.js";

const basket = {
  basketId: "basket-123",
  reservationId: "reservation-123",
  slices: [
    { sliceId: "slice-a", legIds: ["leg-a1", "leg-a2"] },
    { sliceId: "slice-b", legIds: ["leg-b1", "leg-b2"] },
  ],
};

describe("Atomic basket Paper replay", () => {
  it("keeps an Atomic basket reservation unresolved across partial retry evidence, deduplicates checkpointed events, and releases it only after cancellation or a complete reconciled basket", () => {
    const partialEvidence = {
      eventId: "evidence-partial",
      sourceTime: 20,
      kind: "SLICE_EVIDENCE" as const,
      basketId: basket.basketId,
      sliceId: "slice-a",
      legs: [{ legId: "leg-a1", status: "complete" as const }],
    };
    const retry = {
      eventId: "retry-risk-increasing",
      sourceTime: 30,
      kind: "RETRY_REQUESTED" as const,
      basketId: basket.basketId,
      riskIncreasing: true,
    };
    const unknownLegEvidence = {
      eventId: "evidence-unknown-leg",
      sourceTime: 25,
      kind: "SLICE_EVIDENCE" as const,
      basketId: basket.basketId,
      sliceId: "slice-a",
      legs: [
        { legId: "leg-a1", status: "complete" as const },
        { legId: "leg-a1", status: "complete" as const },
        { legId: "leg-not-declared", status: "complete" as const },
      ],
    };

    const unresolved = applyAtomicBasketEvents(
      createAtomicBasketState(basket),
      [retry, partialEvidence, retry, unknownLegEvidence],
    );

    expect(unresolved).toMatchObject({
      basketId: "basket-123",
      reservation: "RESERVED",
      status: "RECONCILIATION_REQUIRED",
      riskIncreasingRetryAllowed: false,
      checkpoint: {
        sourceTime: 30,
        eventId: "retry-risk-increasing",
      },
      appliedEventIds: [
        "evidence-partial",
        "evidence-unknown-leg",
        "retry-risk-increasing",
      ],
      rejectionReasons: [
        "slice-a:missing:leg-a2",
        "slice-a:duplicate:leg-a1",
        "slice-a:unknown:leg-not-declared",
        "risk-increasing-retry-blocked",
      ],
    });
    expect(unresolved.events.map((event) => event.eventId)).toEqual([
      "evidence-partial",
      "evidence-unknown-leg",
      "retry-risk-increasing",
    ]);

    const replayedCheckpoint = applyAtomicBasketEvents(unresolved, [
      partialEvidence,
      retry,
      unknownLegEvidence,
    ]);
    expect(replayedCheckpoint).toEqual(unresolved);

    const completeReconciliation = {
      eventId: "reconcile-complete",
      sourceTime: 40,
      kind: "BASKET_RECONCILIATION" as const,
      basketId: basket.basketId,
      slices: [
        {
          sliceId: "slice-a",
          legs: [
            { legId: "leg-a1", status: "complete" as const },
            { legId: "leg-a2", status: "complete" as const },
          ],
        },
        {
          sliceId: "slice-b",
          legs: [
            { legId: "leg-b1", status: "complete" as const },
            { legId: "leg-b2", status: "complete" as const },
          ],
        },
      ],
    };
    const reconciled = applyAtomicBasketEvents(unresolved, [
      completeReconciliation,
    ]);

    expect(reconciled).toMatchObject({
      reservation: "RELEASED",
      status: "RECONCILED",
      riskIncreasingRetryAllowed: false,
      checkpoint: { sourceTime: 40, eventId: "reconcile-complete" },
      appliedEventIds: [
        "evidence-partial",
        "evidence-unknown-leg",
        "retry-risk-increasing",
        "reconcile-complete",
      ],
      rejectionReasons: [],
    });

    const cancelled = applyAtomicBasketEvents(createAtomicBasketState(basket), [
      partialEvidence,
      {
        eventId: "cancel-confirmed",
        sourceTime: 40,
        kind: "CANCEL_CONFIRMED" as const,
        basketId: basket.basketId,
        reservationId: basket.reservationId,
      },
    ]);
    expect(cancelled).toMatchObject({
      reservation: "RELEASED",
      status: "CANCELLED",
      riskIncreasingRetryAllowed: false,
      checkpoint: { sourceTime: 40, eventId: "cancel-confirmed" },
    });

    expect(() =>
      createAtomicBasketState({
        basketId: "duplicate-declared-leg",
        reservationId: "reservation-duplicate-declared-leg",
        slices: [
          { sliceId: "one", legIds: ["leg"] },
          { sliceId: "two", legIds: ["leg"] },
        ],
      }),
    ).toThrow("declared leg IDs must be unique");
  });

  it("requires a matching reservation identity before cancellation releases a basket", () => {
    const staleCancellation = applyAtomicBasketEvents(
      createAtomicBasketState(basket),
      [
        {
          eventId: "stale-cancel",
          sourceTime: 10,
          kind: "CANCEL_CONFIRMED" as const,
          basketId: basket.basketId,
          reservationId: "old-reservation",
        },
      ],
    );

    expect(staleCancellation).toMatchObject({
      reservation: "RESERVED",
      status: "RECONCILIATION_REQUIRED",
      rejectionReasons: ["cancellation-reservation-mismatch"],
    });
  });

  it("holds the reservation for malformed events or event-ID collisions", () => {
    const state = createAtomicBasketState(basket);
    const malformed = [
      {
        eventId: "",
        sourceTime: 10,
        kind: "RETRY_REQUESTED" as const,
        basketId: basket.basketId,
        riskIncreasing: false,
      },
      {
        eventId: "nan-time",
        sourceTime: Number.NaN,
        kind: "RETRY_REQUESTED" as const,
        basketId: basket.basketId,
        riskIncreasing: false,
      },
      {
        eventId: "infinite-time",
        sourceTime: Number.POSITIVE_INFINITY,
        kind: "RETRY_REQUESTED" as const,
        basketId: basket.basketId,
        riskIncreasing: false,
      },
      {
        eventId: "blank-basket",
        sourceTime: 10,
        kind: "RETRY_REQUESTED" as const,
        basketId: " ",
        riskIncreasing: false,
      },
    ];
    const malformedResult = applyAtomicBasketEvents(state, malformed);
    expect(malformedResult).toMatchObject({
      reservation: "RESERVED",
      status: "RECONCILIATION_REQUIRED",
      rejectionReasons: [
        "event-id-required",
        "event-source-time-invalid",
        "event-basket-id-required",
      ],
    });

    const collision = applyAtomicBasketEvents(state, [
      {
        eventId: "same-id",
        sourceTime: 10,
        kind: "RETRY_REQUESTED" as const,
        basketId: basket.basketId,
        riskIncreasing: false,
      },
      {
        eventId: "same-id",
        sourceTime: 11,
        kind: "RETRY_REQUESTED" as const,
        basketId: basket.basketId,
        riskIncreasing: true,
      },
    ]);
    expect(collision).toMatchObject({
      reservation: "RESERVED",
      status: "RECONCILIATION_REQUIRED",
      rejectionReasons: ["event-id-collision:same-id"],
    });
  });

  it("persists post-reconciliation malformed or colliding evidence across replay", () => {
    const reconciliation = {
      eventId: "reconcile-complete",
      sourceTime: 40,
      kind: "BASKET_RECONCILIATION" as const,
      basketId: basket.basketId,
      slices: [
        {
          sliceId: "slice-a",
          legs: [
            { legId: "leg-a1", status: "complete" as const },
            { legId: "leg-a2", status: "complete" as const },
          ],
        },
        {
          sliceId: "slice-b",
          legs: [
            { legId: "leg-b1", status: "complete" as const },
            { legId: "leg-b2", status: "complete" as const },
          ],
        },
      ],
    };
    const reconciled = applyAtomicBasketEvents(
      createAtomicBasketState(basket),
      [reconciliation],
    );
    expect(reconciled).toMatchObject({
      reservation: "RELEASED",
      status: "RECONCILED",
    });

    const malformed = applyAtomicBasketEvents(reconciled, [
      {
        eventId: "",
        sourceTime: 41,
        kind: "RETRY_REQUESTED" as const,
        basketId: basket.basketId,
        riskIncreasing: false,
      },
    ]);
    expect(malformed).toMatchObject({
      reservation: "RESERVED",
      status: "RECONCILIATION_REQUIRED",
      rejectionReasons: ["event-id-required"],
    });
    expect(applyAtomicBasketEvents(malformed, [])).toMatchObject({
      reservation: "RESERVED",
      status: "RECONCILIATION_REQUIRED",
      rejectionReasons: ["event-id-required"],
    });
    expect(
      applyAtomicBasketEvents(malformed, [
        {
          eventId: "cancel-after-malformed",
          sourceTime: 42,
          kind: "CANCEL_CONFIRMED" as const,
          basketId: basket.basketId,
          reservationId: basket.reservationId,
        },
      ]),
    ).toMatchObject({
      reservation: "RESERVED",
      status: "RECONCILIATION_REQUIRED",
      rejectionReasons: ["event-id-required"],
    });

    const collision = applyAtomicBasketEvents(reconciled, [
      {
        ...reconciliation,
        sourceTime: 41,
      },
    ]);
    expect(collision).toMatchObject({
      reservation: "RESERVED",
      status: "RECONCILIATION_REQUIRED",
      rejectionReasons: ["event-id-collision:reconcile-complete"],
    });
    expect(applyAtomicBasketEvents(collision, [])).toMatchObject({
      reservation: "RESERVED",
      status: "RECONCILIATION_REQUIRED",
      rejectionReasons: ["event-id-collision:reconcile-complete"],
    });
  });

  it("rejects empty declared baskets and slices", () => {
    expect(() =>
      createAtomicBasketState({
        basketId: "no-slices",
        reservationId: "reservation-no-slices",
        slices: [],
      }),
    ).toThrow("at least one slice is required");
    expect(() =>
      createAtomicBasketState({
        basketId: "empty-slice",
        reservationId: "reservation-empty-slice",
        slices: [{ sliceId: "slice", legIds: [] }],
      }),
    ).toThrow("at least one declared leg is required");
  });

  it("holds rather than throwing when persisted nested evidence is malformed", () => {
    const malformedEvidence = {
      eventId: "bad-nested-evidence",
      sourceTime: 10,
      kind: "SLICE_EVIDENCE" as const,
      basketId: basket.basketId,
      sliceId: "slice-a",
      legs: [null],
    };

    expect(() =>
      applyAtomicBasketEvents(createAtomicBasketState(basket), [
        malformedEvidence as never,
      ]),
    ).not.toThrow();
    expect(
      applyAtomicBasketEvents(createAtomicBasketState(basket), [
        malformedEvidence as never,
      ]),
    ).toMatchObject({
      reservation: "RESERVED",
      status: "RECONCILIATION_REQUIRED",
      rejectionReasons: ["event-leg-evidence-invalid"],
    });
  });
});
