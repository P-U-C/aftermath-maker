import { createHash } from "node:crypto";
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
          payload:
            '{"market":{"venue":"hyperliquid","kind":"hip4","name":"xyz:TEST-2025-01-31","assetId":1042},"observedAtMs":1735689600000,"observationWindow":{"startMs":1735603200000,"endMs":1735689600000},"source":{"id":"recorded-index-snapshot","uri":"https://evidence.example.invalid/hip4/xyz-test-2025-01-31.json"}}',
          pinnedDigest:
            "sha256:7a51983006f34501f60839b46b1674e7e6e6941bca32390ce3fbcba8ffbd29e4",
        },
        rules: {
          version: "hip4-settlement-v1",
          payload:
            '{"version":"hip4-settlement-v1","text":"Settlement uses the recorded index snapshot at the completed observation window end."}',
          pinnedDigest:
            "sha256:21459e1d357328f5e5207afda1e5d77394f0fefe6c9401f59fe39893eecc89ec",
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

    const tamperedSourceUri = {
      ...recordedSettlement,
      settlement: {
        ...recordedSettlement.settlement,
        source: {
          ...recordedSettlement.settlement.source,
          uri: "https://evidence.example.invalid/tampered.json",
        },
      },
    };
    const tamperedSourceId = {
      ...recordedSettlement,
      settlement: {
        ...recordedSettlement.settlement,
        source: {
          ...recordedSettlement.settlement.source,
          id: "other-recorded-index-snapshot",
        },
      },
    };
    const tamperedSourcePayload = {
      ...recordedSettlement,
      settlement: {
        ...recordedSettlement.settlement,
        source: {
          ...recordedSettlement.settlement.source,
          payload: `${recordedSettlement.settlement.source.payload} `,
        },
      },
    };
    const arbitrarySourceDigest = {
      ...recordedSettlement,
      settlement: {
        ...recordedSettlement.settlement,
        source: {
          ...recordedSettlement.settlement.source,
          pinnedDigest:
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        },
      },
    };
    const tamperedRulesText = {
      ...recordedSettlement,
      settlement: {
        ...recordedSettlement.settlement,
        rules: {
          ...recordedSettlement.settlement.rules,
          text: "A different settlement rule.",
        },
      },
    };
    const arbitraryRulesDigest = {
      ...recordedSettlement,
      settlement: {
        ...recordedSettlement.settlement,
        rules: {
          ...recordedSettlement.settlement.rules,
          pinnedDigest:
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        },
      },
    };
    for (const input of [
      tamperedSourceUri,
      tamperedSourceId,
      tamperedSourcePayload,
      arbitrarySourceDigest,
      tamperedRulesText,
      arbitraryRulesDigest,
    ]) {
      expect(selectRecordedHip4Settlement(input, request)).toEqual({
        status: "unavailable",
        reason: "unpinned-settlement",
      });
    }

    const sourceWithRegeneratedUri = regeneratedSource(recordedSettlement, {
      ...recordedSettlement.settlement.source,
      uri: "https://attacker.example.invalid/settlement.json",
    });
    const sourceWithRegeneratedId = regeneratedSource(recordedSettlement, {
      ...recordedSettlement.settlement.source,
      id: "attacker-source",
    });
    const rulesWithRegeneratedVersion = regeneratedRules({
      ...recordedSettlement.settlement.rules,
      version: "attacker-rules-v2",
    });
    const rulesWithRegeneratedText = regeneratedRules({
      ...recordedSettlement.settlement.rules,
      text: "Attacker-controlled settlement text.",
    });
    const attackerMarket = {
      ...recordedSettlement.market,
      name: "xyz:ATTACKER-2025-01-31",
    };
    const attackerMarketEvidence = {
      ...recordedSettlement,
      market: attackerMarket,
    };

    const regeneratedAttackCases: Array<[unknown, unknown]> = [
      [
        {
          ...recordedSettlement,
          settlement: {
            ...recordedSettlement.settlement,
            source: sourceWithRegeneratedUri,
          },
        },
        request,
      ],
      [
        {
          ...recordedSettlement,
          settlement: {
            ...recordedSettlement.settlement,
            source: sourceWithRegeneratedId,
          },
        },
        request,
      ],
      [
        {
          ...recordedSettlement,
          settlement: {
            ...recordedSettlement.settlement,
            rules: rulesWithRegeneratedVersion,
          },
        },
        request,
      ],
      [
        {
          ...recordedSettlement,
          settlement: {
            ...recordedSettlement.settlement,
            rules: rulesWithRegeneratedText,
          },
        },
        request,
      ],
      [
        {
          ...attackerMarketEvidence,
          settlement: {
            ...attackerMarketEvidence.settlement,
            source: regeneratedSource(
              attackerMarketEvidence,
              attackerMarketEvidence.settlement.source,
            ),
          },
        },
        { ...request, market: attackerMarket },
      ],
    ];
    for (const [input, attackRequest] of regeneratedAttackCases) {
      expect(selectRecordedHip4Settlement(input, attackRequest)).toEqual({
        status: "unavailable",
        reason: "unpinned-settlement",
      });
    }

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
          observationWindow: {
            ...recordedSettlement.observationWindow,
            endMs: recordedSettlement.observedAtMs - 1,
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

    for (const market of [
      { ...recordedSettlement.market, venue: "other" },
      { ...recordedSettlement.market, kind: "other" },
      { ...recordedSettlement.market, name: "xyz:OTHER-2025-01-31" },
      { ...recordedSettlement.market, assetId: 1043 },
    ]) {
      expect(
        selectRecordedHip4Settlement(
          { ...recordedSettlement, market },
          request,
        ),
      ).toMatchObject({ status: "unavailable" });
    }

    for (const market of [
      { ...recordedSettlement.market, name: "xyz:OTHER-2025-01-31" },
      { ...recordedSettlement.market, assetId: 1043 },
    ]) {
      expect(
        selectRecordedHip4Settlement(
          { ...recordedSettlement, market },
          { ...request, market },
        ),
      ).toEqual({ status: "unavailable", reason: "unpinned-settlement" });
    }
  });
});

function regeneratedSource(
  evidence: typeof recordedSettlement,
  source: typeof recordedSettlement.settlement.source,
) {
  const payload = JSON.stringify({
    market: evidence.market,
    observedAtMs: evidence.observedAtMs,
    observationWindow: evidence.observationWindow,
    source: { id: source.id, uri: source.uri },
  });
  return { ...source, payload, pinnedDigest: sha256(payload) };
}

function regeneratedRules(rules: typeof recordedSettlement.settlement.rules) {
  const payload = JSON.stringify({ version: rules.version, text: rules.text });
  return { ...rules, payload, pinnedDigest: sha256(payload) };
}

function sha256(payload: string): string {
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}
