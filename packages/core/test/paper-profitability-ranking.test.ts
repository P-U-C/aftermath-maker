import { describe, expect, it } from "vitest";
import type { PaperProfitabilityEvidenceResult } from "../src/paper-profitability-evidence.js";
import {
  rankPaperProfitabilityCandidates,
  type PaperProfitabilityRankingInput,
} from "../src/paper-profitability-ranking.js";

function measuredResult(
  overrides: Partial<PaperProfitabilityEvidenceResult> = {},
): PaperProfitabilityEvidenceResult {
  return {
    status: "positive",
    sampleSize: 10,
    minimumSampleSize: 10,
    components: {
      capturedMakerSpread: { amountUsd: "2", coverage: "complete" },
      makerCredit: { amountUsd: "0", coverage: "complete" },
      builderFees: { amountUsd: "0", coverage: "complete" },
      venueFees: { amountUsd: "0", coverage: "complete" },
      adverseFixedHorizonMarkout: {
        amountUsd: "0",
        coverage: "complete",
      },
      carryAndFundingNet: { amountUsd: "0", coverage: "complete" },
      hedgeAndUnwindNet: { amountUsd: "0", coverage: "complete" },
      gas: { amountUsd: "0", coverage: "complete" },
    },
    tradingNetUsd: "2",
    excluded: { rewardsUsd: null, transfersUsd: null },
    gaps: [],
    evidenceGaps: [],
    fixedHorizonEvidence: [],
    ...overrides,
  };
}

function candidate(
  overrides: Partial<PaperProfitabilityRankingInput> = {},
): PaperProfitabilityRankingInput {
  return {
    candidateId: "candidate-a",
    marketId: "ETH-USDC",
    measurementWindowMs: 86_400_000,
    collateralUsd: "100",
    result: measuredResult(),
    ...overrides,
  };
}

function reasonsFor(input: PaperProfitabilityRankingInput): string[] {
  return rankPaperProfitabilityCandidates([input])[0]!.reasons;
}

describe("Paper profitability measured-candidate ranking", () => {
  it("ranks complete positive Paper candidates by exact daily return without dropping ineligible inputs", () => {
    const ranked = rankPaperProfitabilityCandidates([
      candidate({
        candidateId: "lower",
        result: measuredResult({ tradingNetUsd: "1" }),
      }),
      candidate({
        candidateId: "invalid",
        result: measuredResult({ status: "unavailable" }),
      }),
      candidate({
        candidateId: "higher",
        result: measuredResult({ tradingNetUsd: "2" }),
      }),
    ]);

    expect(ranked.map((entry) => entry.candidateId)).toEqual([
      "higher",
      "lower",
      "invalid",
    ]);
    expect(ranked).toHaveLength(3);
    expect(ranked[0]).toMatchObject({
      status: "eligible",
      reasons: [],
      netUsdPerDay: { numerator: "2", denominator: "1" },
      netReturnBpsPerDay: { numerator: "200", denominator: "1" },
    });
    expect(ranked[2]).toMatchObject({
      status: "ineligible",
      reasons: ["result_not_positive"],
      netUsdPerDay: null,
      netReturnBpsPerDay: null,
    });
  });

  it("uses exact return, net, candidate and market tie breakers", () => {
    const ranked = rankPaperProfitabilityCandidates([
      candidate({
        candidateId: "b-equal",
        marketId: "market-z",
        result: measuredResult({ tradingNetUsd: "1" }),
      }),
      candidate({
        candidateId: "a-equal",
        marketId: "market-z",
        result: measuredResult({ tradingNetUsd: "1" }),
      }),
      candidate({
        candidateId: "a-equal",
        marketId: "market-a",
        result: measuredResult({ tradingNetUsd: "1" }),
      }),
      candidate({
        candidateId: "z-higher-net",
        collateralUsd: "200",
        result: measuredResult({ tradingNetUsd: "2" }),
      }),
    ]);

    expect(
      ranked.map(({ candidateId, marketId }) => [candidateId, marketId]),
    ).toEqual([
      ["z-higher-net", "ETH-USDC"],
      ["a-equal", "market-a"],
      ["a-equal", "market-z"],
      ["b-equal", "market-z"],
    ]);
  });

  it("fails closed for result status, source gaps, decomposition gaps and incomplete samples", () => {
    expect(
      reasonsFor(
        candidate({ result: measuredResult({ status: "non_positive" }) }),
      ),
    ).toContain("result_not_positive");
    expect(
      reasonsFor(
        candidate({ result: measuredResult({ status: "unavailable" }) }),
      ),
    ).toContain("result_not_positive");
    expect(
      reasonsFor(
        candidate({
          result: measuredResult({
            evidenceGaps: [
              {
                component: "fills",
                reason: "empty_fill_sample",
                sourceEventKey: null,
                orderKey: null,
                horizonMs: null,
              },
            ],
          }),
        }),
      ),
    ).toContain("evidence_gaps_present");
    expect(
      reasonsFor(
        candidate({
          result: measuredResult({
            gaps: [
              {
                component: "sampleSize",
                reason: "minimum_sample_not_met",
                observed: 9,
                minimum: 10,
              },
            ],
          }),
        }),
      ),
    ).toContain("profitability_gaps_present");
    expect(
      reasonsFor(
        candidate({
          result: measuredResult({ sampleSize: 9, minimumSampleSize: 10 }),
        }),
      ),
    ).toContain("incomplete_sample");
  });

  it("rejects zero, negative, noncanonical and overflow-like trading decimals", () => {
    for (const tradingNetUsd of [
      "0",
      "-1",
      "01",
      "+1",
      ".1",
      "1.",
      "1e3",
      "9".repeat(129),
    ]) {
      const reasons = reasonsFor(
        candidate({ result: measuredResult({ tradingNetUsd }) }),
      );
      expect(reasons, tradingNetUsd).toContain(
        tradingNetUsd === "0" || tradingNetUsd === "-1"
          ? "non_positive_trading_net_usd"
          : "invalid_trading_net_usd",
      );
    }
    expect(
      reasonsFor(
        candidate({ result: measuredResult({ tradingNetUsd: null }) }),
      ),
    ).toContain("missing_trading_net_usd");
  });

  it("rejects missing IDs and sorts every ineligible row deterministically", () => {
    expect(reasonsFor(candidate({ candidateId: "   " }))).toContain(
      "invalid_candidate_id",
    );
    expect(reasonsFor(candidate({ marketId: "" }))).toContain(
      "invalid_market_id",
    );

    const ranked = rankPaperProfitabilityCandidates([
      candidate({ candidateId: "z", marketId: "z", measurementWindowMs: 0 }),
      candidate({ candidateId: "", marketId: "z", measurementWindowMs: 0 }),
      candidate({ candidateId: "", marketId: "a", measurementWindowMs: 0 }),
    ]);
    expect(
      ranked.map(({ candidateId, marketId }) => [candidateId, marketId]),
    ).toEqual([
      ["", "a"],
      ["", "z"],
      ["z", "z"],
    ]);
    expect(ranked.every((entry) => entry.status === "ineligible")).toBe(true);
  });

  it("rejects nonpositive or unsafe windows and invalid collateral", () => {
    for (const measurementWindowMs of [
      0,
      -1,
      1.5,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(
        reasonsFor(candidate({ measurementWindowMs })),
        String(measurementWindowMs),
      ).toContain("invalid_measurement_window_ms");
    }
    for (const collateralUsd of [
      "0",
      "-1",
      "01",
      "+1",
      ".1",
      "1.",
      "1e3",
      "9".repeat(129),
    ]) {
      expect(reasonsFor(candidate({ collateralUsd })), collateralUsd).toContain(
        collateralUsd === "0" || collateralUsd === "-1"
          ? "non_positive_collateral_usd"
          : "invalid_collateral_usd",
      );
    }
  });

  it("computes both formulas as exact bigint ratios, including repeating returns", () => {
    const ranked = rankPaperProfitabilityCandidates([
      candidate({
        candidateId: "terminating",
        measurementWindowMs: 21_600_000,
        collateralUsd: "250",
        result: measuredResult({ tradingNetUsd: "1.25" }),
      }),
      candidate({
        candidateId: "repeating",
        measurementWindowMs: 64_800_000,
        collateralUsd: "12",
        result: measuredResult({ tradingNetUsd: "0.3" }),
      }),
    ]);
    const terminating = ranked.find(
      (entry) => entry.candidateId === "terminating",
    );
    const repeating = ranked.find((entry) => entry.candidateId === "repeating");

    expect(terminating).toMatchObject({
      candidateId: "terminating",
      netUsdPerDay: { numerator: "5", denominator: "1" },
      netReturnBpsPerDay: { numerator: "200", denominator: "1" },
    });
    expect(repeating).toMatchObject({
      candidateId: "repeating",
      netUsdPerDay: { numerator: "2", denominator: "5" },
      netReturnBpsPerDay: { numerator: "1000", denominator: "3" },
    });
  });

  it("keeps rewards and transfers excluded from candidate metrics", () => {
    const baseline = rankPaperProfitabilityCandidates([candidate()])[0]!;
    const excluded = rankPaperProfitabilityCandidates([
      candidate({
        result: measuredResult({
          excluded: {
            rewardsUsd: "999999999999",
            transfersUsd: "888888888888",
          },
        }),
      }),
    ])[0]!;

    expect(excluded.netUsdPerDay).toEqual(baseline.netUsdPerDay);
    expect(excluded.netReturnBpsPerDay).toEqual(baseline.netReturnBpsPerDay);
    expect(excluded.status).toBe("eligible");
  });

  it("fails closed without throwing for null candidates and malformed results", () => {
    const malformedShape = {
      ...candidate(),
      result: { ...measuredResult(), components: {} },
    } as unknown as PaperProfitabilityRankingInput;

    expect(() =>
      rankPaperProfitabilityCandidates([
        null,
        candidate({ result: null }),
        malformedShape,
      ]),
    ).not.toThrow();

    const ranked = rankPaperProfitabilityCandidates([
      null,
      candidate({ result: null }),
      malformedShape,
    ]);
    expect(ranked).toHaveLength(3);
    expect(ranked[0]).toMatchObject({
      candidateId: null,
      marketId: null,
      status: "ineligible",
      netUsdPerDay: null,
      netReturnBpsPerDay: null,
    });
    expect(ranked[0]!.reasons).toEqual(
      expect.arrayContaining(["malformed_candidate", "malformed_result"]),
    );
    for (const entry of ranked.slice(1)) {
      expect(entry.reasons).toContain("malformed_result");
      expect(entry.status).toBe("ineligible");
    }
  });

  it("sanitizes non-string IDs before deterministic ineligible sorting", () => {
    const first = {
      ...candidate({ measurementWindowMs: 0 }),
      candidateId: Symbol("candidate-first"),
      marketId: Symbol("market-first"),
    } as unknown as PaperProfitabilityRankingInput;
    const second = {
      ...candidate({ measurementWindowMs: -1 }),
      candidateId: Symbol("candidate-second"),
      marketId: Symbol("market-second"),
    } as unknown as PaperProfitabilityRankingInput;

    const ranked = rankPaperProfitabilityCandidates([first, second]);
    expect(ranked.map((entry) => entry.measurementWindowMs)).toEqual([0, -1]);
    expect(
      ranked.every(
        (entry) =>
          entry.candidateId === null &&
          entry.marketId === null &&
          entry.reasons.includes("malformed_candidate") &&
          entry.reasons.includes("invalid_candidate_id") &&
          entry.reasons.includes("invalid_market_id"),
      ),
    ).toBe(true);
  });

  it("returns only allowlisted reporting fields and drops authority-shaped extras", () => {
    const authorityShapedInput = {
      ...candidate(),
      executionAuthorized: true,
      routeToLive: "mainnet",
      result: {
        ...measuredResult(),
        executionAuthorized: true,
      },
    } as unknown as PaperProfitabilityRankingInput;

    const ranked = rankPaperProfitabilityCandidates([authorityShapedInput])[0]!;
    expect(Object.keys(ranked).sort()).toEqual(
      [
        "candidateId",
        "marketId",
        "measurementWindowMs",
        "collateralUsd",
        "status",
        "reasons",
        "netUsdPerDay",
        "netReturnBpsPerDay",
      ].sort(),
    );
    expect(ranked).not.toHaveProperty("executionAuthorized");
    expect(ranked).not.toHaveProperty("routeToLive");
    expect(ranked).not.toHaveProperty("result");
    expect(ranked.status).toBe("eligible");
  });
});
