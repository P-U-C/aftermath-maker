import { describe, expect, it } from "vitest";
import {
  normalizeAtomicTwapSnapshot,
  type AtomicTwapExpectedBasket,
} from "../src/index.js";

const expected: AtomicTwapExpectedBasket = {
  basketId: "basket-7",
  legs: [
    {
      twapOrderObjectId: "order-btc",
      details: {
        marketId: "market-btc",
        side: 0,
        size: 100,
        reduceOnly: false,
        chunksAmount: 4,
        executionGapMs: 60_000,
        executionTimeUncertaintyMs: 5_000,
        timeForRetryMs: 30_000,
        amountUncertaintyBps: 10,
        maxOneExecutionAmountBps: 2_500,
        smallTailMergeThresholdBps: 25,
        maxSlippageBps: 100,
      },
    },
    {
      twapOrderObjectId: "order-eth",
      details: {
        marketId: "market-eth",
        side: 1,
        size: 200,
        reduceOnly: true,
        chunksAmount: 4,
        executionGapMs: 60_000,
        executionTimeUncertaintyMs: 5_000,
        timeForRetryMs: 30_000,
        amountUncertaintyBps: 10,
        maxOneExecutionAmountBps: 2_500,
        smallTailMergeThresholdBps: 25,
        maxSlippageBps: 100,
      },
    },
  ],
};

function snapshot(
  records: unknown[],
  capturedAtMs = 1_000,
): { capturedAtMs: string; twapOrderDatas: unknown[] } {
  return { capturedAtMs: `${capturedAtMs}n`, twapOrderDatas: records };
}

function providerUnsigned(value: number | string): string {
  return typeof value === "number"
    ? `${value}n`
    : value.endsWith("n")
      ? value
      : `${value}n`;
}

function providerDetails(
  details: AtomicTwapExpectedBasket["legs"][number]["details"],
) {
  return {
    ...details,
    size: providerUnsigned(details.size),
    chunksAmount: providerUnsigned(details.chunksAmount),
    executionGapMs: providerUnsigned(details.executionGapMs),
    executionTimeUncertaintyMs: providerUnsigned(
      details.executionTimeUncertaintyMs,
    ),
    timeForRetryMs: providerUnsigned(details.timeForRetryMs),
    amountUncertaintyBps: providerUnsigned(details.amountUncertaintyBps),
    maxOneExecutionAmountBps: providerUnsigned(
      details.maxOneExecutionAmountBps,
    ),
    smallTailMergeThresholdBps: providerUnsigned(
      details.smallTailMergeThresholdBps,
    ),
    maxSlippageBps: providerUnsigned(details.maxSlippageBps),
  };
}

function record(
  leg: AtomicTwapExpectedBasket["legs"][number],
  overrides: Record<string, unknown> = {},
) {
  return {
    twapOrderObjectId: leg.twapOrderObjectId,
    basketId: expected.basketId,
    collateralType: "0x2::sui::SUI",
    orderState: "completed",
    details: providerDetails(leg.details),
    processedAmount: providerUnsigned(leg.details.size),
    scheduledAmount: providerUnsigned(0),
    lastExecutionTimestampMs: providerUnsigned(900),
    orderCreationTimestampMs: providerUnsigned(100),
    ...overrides,
  };
}

const options = {
  expected,
  nowMs: 1_500,
  maxSnapshotAgeMs: 1_000,
};

describe("Atomic TWAP provider snapshot reconciliation", () => {
  it("fails closed for incomplete, contradictory, stale, and non-terminal Atomic TWAP snapshots", () => {
    const complete = snapshot(expected.legs.map((leg) => record(leg)));
    expect(
      normalizeAtomicTwapSnapshot({ ...options, snapshot: complete }),
    ).toEqual({
      kind: "trusted",
      basketId: "basket-7",
      orderState: "completed",
      legs: [
        {
          twapOrderObjectId: "order-btc",
          processedAmount: "100n",
          scheduledAmount: "0n",
        },
        {
          twapOrderObjectId: "order-eth",
          processedAmount: "200n",
          scheduledAmount: "0n",
        },
      ],
    });

    const unavailable = (records: unknown[], capturedAtMs = 1_000) =>
      normalizeAtomicTwapSnapshot({
        ...options,
        snapshot: snapshot(records, capturedAtMs),
      });

    expect(unavailable([record(expected.legs[0]!)]).kind).toBe("unavailable");
    expect(
      unavailable([
        record(expected.legs[0]!),
        record(expected.legs[0]!),
        record(expected.legs[1]!),
      ]).kind,
    ).toBe("unavailable");

    const largeExpected: AtomicTwapExpectedBasket = {
      ...expected,
      legs: expected.legs.map((leg) => ({
        ...leg,
        details: { ...leg.details, size: "9007199254740993n" },
      })),
    };
    expect(
      normalizeAtomicTwapSnapshot({
        ...options,
        expected: largeExpected,
        snapshot: snapshot(largeExpected.legs.map((leg) => record(leg))),
      }),
    ).toMatchObject({
      kind: "trusted",
      legs: [
        { processedAmount: "9007199254740993n", scheduledAmount: "0n" },
        { processedAmount: "9007199254740993n", scheduledAmount: "0n" },
      ],
    });
    expect(
      normalizeAtomicTwapSnapshot({
        ...options,
        expected: largeExpected,
        snapshot: snapshot(
          largeExpected.legs.map((leg, index) =>
            record(
              leg,
              index === 0
                ? { processedAmount: Number.MAX_SAFE_INTEGER + 1 }
                : {},
            ),
          ),
        ),
      }).kind,
    ).toBe("unavailable");
    expect(
      normalizeAtomicTwapSnapshot({
        ...options,
        expected: largeExpected,
        snapshot: snapshot(
          largeExpected.legs.map((leg, index) =>
            record(
              leg,
              index === 0
                ? { details: { ...leg.details, size: "9007199254740992n" } }
                : {},
            ),
          ),
        ),
      }).kind,
    ).toBe("unavailable");
    expect(
      normalizeAtomicTwapSnapshot({
        ...options,
        expected: largeExpected,
        snapshot: snapshot(
          largeExpected.legs.map((leg, index) =>
            record(
              leg,
              index === 0 ? { processedAmount: "9007199254740992n" } : {},
            ),
          ),
        ),
      }).kind,
    ).toBe("unavailable");
    expect(
      unavailable([
        ...expected.legs.map((leg) => record(leg)),
        record(expected.legs[0]!, { twapOrderObjectId: "order-extra" }),
      ]).kind,
    ).toBe("unavailable");
    expect(
      unavailable([
        record(expected.legs[0]!, { basketId: "basket-other" }),
        record(expected.legs[1]!),
      ]).kind,
    ).toBe("unavailable");
    expect(
      unavailable(
        expected.legs.map((leg) => record(leg)),
        499,
      ).kind,
    ).toBe("unavailable");

    for (const orderState of [
      "pending",
      "active",
      "reservedForProcessing",
      "executing",
      "toCancel",
      "unknown-provider-state",
    ]) {
      expect(
        unavailable(expected.legs.map((leg) => record(leg, { orderState })))
          .kind,
      ).toBe("unavailable");
    }

    for (const override of [
      { lastError: { code: "retry", retryable: true } },
      { nextRetryTimestamp: 1_600, retryAttempt: 1, retryLimit: 3 },
      { processedAmount: 50, scheduledAmount: 0 },
      { processedAmount: 100, scheduledAmount: 1 },
      { processedAmount: Number.NaN },
      { lastExecutionTimestampMs: Number.POSITIVE_INFINITY },
      { lastExecutionTimestampMs: providerUnsigned(99) },
      { details: { ...expected.legs[0]!.details, size: 101 } },
    ]) {
      expect(
        unavailable([
          record(expected.legs[0]!, override),
          record(expected.legs[1]!),
        ]).kind,
      ).toBe("unavailable");
    }

    for (const orderState of ["cancelled", "completed"]) {
      expect(
        unavailable([
          record(expected.legs[0]!, {
            orderState,
            processedAmount: 0,
            scheduledAmount: 1,
          }),
          record(expected.legs[1]!, { orderState, processedAmount: 0 }),
        ]).kind,
      ).toBe("unavailable");
    }
  });
});
