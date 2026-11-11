import { describe, expect, it } from "vitest";
import recordedObservation from "../fixtures/hip3-observation.json";
import { parsePublicHip3Observation } from "../public-adapter.js";

describe("public HIP-3 market observation adapter", () => {
  it("parses a recorded HIP-3 observation and rejects stale or missing market fields", () => {
    const parsed = parsePublicHip3Observation(recordedObservation, {
      maxAgeMs: 1_000,
    });

    expect(parsed).toEqual({
      status: "available",
      market: "xyz:TEST",
      observedAtMs: 1_735_689_600_000,
      book: {
        timestampMs: 1_735_689_599_500,
        bestBid: { price: "101.20", size: "2.50", orderCount: 2 },
        bestAsk: { price: "101.40", size: "1.75", orderCount: 1 },
      },
      mark: { timestampMs: 1_735_689_600_000, price: "101.30" },
      oracle: { timestampMs: 1_735_689_600_000, price: "101.10" },
      fundingHistory: [
        { timestampMs: 1_735_689_599_200, rate: "0.0001" },
        { timestampMs: 1_735_685_999_200, rate: "0.00008" },
      ],
    });

    const stale = parsePublicHip3Observation(recordedObservation, {
      maxAgeMs: 100,
    });
    expect(stale).toEqual({ status: "unavailable", reason: "stale" });

    for (const field of [
      "book",
      "metaAndAssetCtxs",
      "fundingHistory",
    ] as const) {
      const missing = { ...recordedObservation, [field]: undefined };
      expect(parsePublicHip3Observation(missing, { maxAgeMs: 1_000 })).toEqual({
        status: "unavailable",
        reason: "missing-field",
      });
    }
  });

  it("rejects malformed prices, funding values, timestamps, or market mismatches", () => {
    const cases = [
      {
        ...recordedObservation,
        metaAndAssetCtxs: [
          recordedObservation.metaAndAssetCtxs[0],
          [
            recordedObservation.metaAndAssetCtxs[1][0],
            {
              ...recordedObservation.metaAndAssetCtxs[1][1],
              markPx: "bad",
            },
          ],
        ],
      },
      {
        ...recordedObservation,
        fundingHistory: [
          { ...recordedObservation.fundingHistory[0], fundingRate: null },
        ],
      },
      {
        ...recordedObservation,
        book: { ...recordedObservation.book, time: 0 },
      },
      {
        ...recordedObservation,
        book: { ...recordedObservation.book, coin: "other:TEST" },
      },
    ];

    for (const input of cases) {
      expect(parsePublicHip3Observation(input, { maxAgeMs: 1_000 })).toEqual({
        status: "unavailable",
        reason: "malformed-field",
      });
    }
  });

  it("uses the recorded meta-and-context response index and fails closed when it is incomplete", () => {
    const metaAndAssetCtxs = [
      recordedObservation.metaAndAssetCtxs[0],
      [
        recordedObservation.metaAndAssetCtxs[1][0],
        { ...recordedObservation.metaAndAssetCtxs[1][1], oraclePx: undefined },
      ],
    ];

    expect(
      parsePublicHip3Observation(
        { ...recordedObservation, metaAndAssetCtxs },
        { maxAgeMs: 1_000 },
      ),
    ).toEqual({ status: "unavailable", reason: "missing-field" });
  });
});
