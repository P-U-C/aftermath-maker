import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  normalizeAtomicMarketCapability,
  type AtomicMarketCapabilityInput,
} from "../src/atomic-market-capability.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/atomic-market-capability.snapshot.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, unknown>;

const intendedMarkets: AtomicMarketCapabilityInput["intendedMarkets"] = [
  { marketId: "market-btc", side: 0, size: "10n", notionalUsd: 100 },
  { marketId: "market-eth", side: 1, size: "20n", notionalUsd: 200 },
];

const input: AtomicMarketCapabilityInput = {
  intendedMarkets,
  snapshot: fixture,
  nowMs: 1_500,
  maxSnapshotAgeMs: 1_000,
};

function unavailable(snapshot: unknown = fixture) {
  return normalizeAtomicMarketCapability({ ...input, snapshot });
}

describe("Atomic market capability snapshots", () => {
  it("fails closed when a recorded Atomic market capability snapshot is incomplete, stale, or unsafe", () => {
    expect(unavailable()).toEqual({
      kind: "unavailable",
      reason: "gas-reserve-unavailable",
      constraints: [
        {
          marketId: "market-btc",
          makerFee: 0.0002,
          takerFee: 0.0005,
          priorityTakerFee: 0.0001,
          marginRatioInitial: 0.1,
          marginRatioMaintenance: 0.05,
          minOrderUsdValue: 10,
          lotSize: "5n",
          tickSize: "1n",
          maxPendingOrders: "32n",
          maxOpenInterest: 1000000,
          maxOpenInterestThreshold: 100,
          maxOpenInterestPositionPercent: 0.1,
          openInterest: 1000,
        },
        {
          marketId: "market-eth",
          makerFee: 0.0002,
          takerFee: 0.0005,
          priorityTakerFee: null,
          marginRatioInitial: 0.1,
          marginRatioMaintenance: 0.05,
          minOrderUsdValue: 10,
          lotSize: "10n",
          tickSize: "1n",
          maxPendingOrders: "32n",
          maxOpenInterest: 1000000,
          maxOpenInterestThreshold: 100,
          maxOpenInterestPositionPercent: 0.1,
          openInterest: 2000,
        },
      ],
    });

    const missingFee = structuredClone(fixture);
    delete (missingFee.markets as Array<Record<string, unknown>>)[0]!
      .marketParams.takerFee;
    expect(unavailable(missingFee)).toEqual({
      kind: "unavailable",
      reason: "malformed-market-snapshot",
      constraints: [],
    });

    const missingProviderState = structuredClone(fixture);
    delete (missingProviderState.markets as Array<Record<string, unknown>>)[0]!
      .marketState.premiumTwapLastUpdateTimestamp;
    expect(unavailable(missingProviderState).reason).toBe(
      "malformed-market-snapshot",
    );

    const missingProviderPrice = structuredClone(fixture);
    delete (missingProviderPrice.markets as Array<Record<string, unknown>>)[0]!
      .indexPrice;
    expect(unavailable(missingProviderPrice).reason).toBe(
      "malformed-market-snapshot",
    );

    const invalidPriorityFee = structuredClone(fixture);
    (
      invalidPriorityFee.markets as Array<Record<string, unknown>>
    )[0]!.marketParams.priorityTakerFee = 1.1;
    expect(unavailable(invalidPriorityFee).reason).toBe(
      "malformed-market-snapshot",
    );

    const duplicateMarket = structuredClone(fixture);
    (duplicateMarket.markets as unknown[]).push(
      (duplicateMarket.markets as unknown[])[0],
    );
    expect(unavailable(duplicateMarket).reason).toBe(
      "duplicate-market-snapshot",
    );

    const crossMarket = structuredClone(fixture);
    (
      crossMarket.atomicPreview as {
        response: { orders: Array<Record<string, unknown>> };
      }
    ).response.orders[1]!.marketId = "market-btc";
    expect(unavailable(crossMarket).reason).toBe("preview-order-mismatch");

    const partial = structuredClone(fixture);
    (
      partial.atomicPreview as {
        response: { orders: Array<Record<string, unknown>> };
      }
    ).response.orders[0]!.postedSize = 1;
    expect(unavailable(partial).reason).toBe("partial-or-posted-preview");

    const underMinimumPreview = structuredClone(fixture);
    (
      underMinimumPreview.atomicPreview as {
        response: { orders: Array<Record<string, unknown>> };
      }
    ).response.orders[0]!.filledSizeUsd = 1;
    expect(
      normalizeAtomicMarketCapability({
        ...input,
        intendedMarkets: [
          { ...intendedMarkets[0]!, notionalUsd: 1000 },
          intendedMarkets[1]!,
        ],
        snapshot: underMinimumPreview,
      }).reason,
    ).toBe("minimum-order-not-met");

    const inconsistentPreviewTotal = structuredClone(fixture);
    (
      inconsistentPreviewTotal.atomicPreview as {
        response: { collateralChange: number };
      }
    ).response.collateralChange = 31;
    expect(unavailable(inconsistentPreviewTotal).reason).toBe(
      "preview-unavailable",
    );

    const exhaustedOi = structuredClone(fixture);
    (
      exhaustedOi.markets as Array<Record<string, unknown>>
    )[0]!.marketParams.maxOpenInterest = 0;
    expect(unavailable(exhaustedOi).reason).toBe("malformed-market-snapshot");

    const opaqueOiCapacity = structuredClone(fixture);
    (
      opaqueOiCapacity.markets as Array<Record<string, unknown>>
    )[0]!.marketState.openInterest = 1000000;
    expect(
      normalizeAtomicMarketCapability({
        ...input,
        snapshot: opaqueOiCapacity,
        gasReserveReceipt: {
          receiptId: "recorded-atomic-gas-1",
          reservedMist: "1000000n",
          capturedAtMs: "1000n",
        },
      }).reason,
    ).toBe("oi-unit-semantics-unavailable");

    expect(
      normalizeAtomicMarketCapability({
        ...input,
        nowMs: 2_001,
      }).reason,
    ).toBe("stale-snapshot");

    expect(
      normalizeAtomicMarketCapability({
        ...input,
        intendedMarkets: [
          ...intendedMarkets,
          { marketId: "market-btc", side: 0, size: "10n", notionalUsd: 100 },
        ],
      }).reason,
    ).toBe("invalid-intended-markets");

    expect(
      normalizeAtomicMarketCapability({
        ...input,
        intendedMarkets: [
          { marketId: "market-btc", side: 0, size: "11n", notionalUsd: 100 },
          intendedMarkets[1]!,
        ],
      }).reason,
    ).toBe("invalid-order-lot");

    expect(
      normalizeAtomicMarketCapability({
        ...input,
        snapshot: { ...fixture, capturedAtMs: Number.MAX_SAFE_INTEGER + 1 },
      }).reason,
    ).toBe("malformed-snapshot");
    expect(
      normalizeAtomicMarketCapability({
        ...input,
        snapshot: { ...fixture, capturedAtMs: "9007199254740993n" },
        nowMs: "9007199254740994n",
        maxSnapshotAgeMs: "2n",
      }).reason,
    ).toBe("gas-reserve-unavailable");

    expect(
      normalizeAtomicMarketCapability({
        ...input,
        gasReserveReceipt: {
          receiptId: "recorded-atomic-gas-1",
          reservedMist: "1000000n",
          capturedAtMs: "1000n",
        },
      }),
    ).toMatchObject({
      kind: "unavailable",
      reason: "oi-unit-semantics-unavailable",
    });
  });
});
