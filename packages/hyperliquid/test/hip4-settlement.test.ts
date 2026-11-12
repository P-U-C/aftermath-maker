import { describe, expect, it } from "vitest";
import recordedSettlement from "../fixtures/hip4-settlement.json";
import { selectRecordedHip4Settlement } from "../hip4-settlement.js";

const request = {
  market: {
    venue: "hyperliquid" as const,
    kind: "hip4" as const,
    name: "xyz:TEST-2025-01-31",
    assetId: 1042,
  },
  asOfMs: 1_735_689_700_000,
};

describe("recorded HIP-4 settlement selector", () => {
  it("accepts a pinned HIP-4 settlement record and rejects an unpinned market", () => {
    expect(selectRecordedHip4Settlement(recordedSettlement, request)).toEqual({
      status: "available",
      market: request.market,
      observedAtMs: 1_735_689_600_000,
      observationWindow: {
        startMs: 1_735_603_200_000,
        endMs: 1_735_689_600_000,
      },
      settlement: {
        source: {
          id: "recorded-index-snapshot",
          uri: "https://evidence.example.invalid/hip4/xyz-test-2025-01-31.json",
          pinnedDigest:
            "sha256:2d27d863d66a7b7c7ec14a28b9f38f7a75ddcf75b30e4d0c74b5f53aa5432c97",
        },
        rules: {
          version: "hip4-settlement-v1",
          pinnedDigest:
            "sha256:ae4476d21be22c474d07440a8c37f614dfb0b8ea78c11f1292caeab4d7365dd7",
          text: "Settlement uses the recorded index snapshot at the completed observation window end.",
        },
        expiryMs: 1_735_776_000_000,
      },
    });

    const withoutPinnedRules = {
      ...recordedSettlement,
      settlement: {
        ...recordedSettlement.settlement,
        rules: { ...recordedSettlement.settlement.rules, pinnedDigest: "" },
      },
    };
    expect(selectRecordedHip4Settlement(withoutPinnedRules, request)).toEqual({
      status: "unavailable",
      reason: "unpinned-settlement",
    });

    const withoutSource = {
      ...recordedSettlement,
      settlement: { ...recordedSettlement.settlement, source: undefined },
    };
    expect(selectRecordedHip4Settlement(withoutSource, request)).toEqual({
      status: "unavailable",
      reason: "missing-field",
    });

    const cases: Array<[unknown, string]> = [
      [
        {
          ...recordedSettlement,
          observedAtMs: request.asOfMs + 1,
        },
        "future-observation",
      ],
      [
        {
          ...recordedSettlement,
          settlement: {
            ...recordedSettlement.settlement,
            expiryMs: request.asOfMs,
          },
        },
        "expired",
      ],
      [
        {
          ...recordedSettlement,
          observationWindow: {
            ...recordedSettlement.observationWindow,
            startMs: 1735603200,
          },
        },
        "malformed-field",
      ],
      [
        {
          ...recordedSettlement,
          market: { ...recordedSettlement.market, assetId: 1043 },
        },
        "market-mismatch",
      ],
    ];

    for (const [input, reason] of cases) {
      expect(selectRecordedHip4Settlement(input, request)).toEqual({
        status: "unavailable",
        reason,
      });
    }
  });
});
