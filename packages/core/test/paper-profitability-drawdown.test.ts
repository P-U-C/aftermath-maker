import { describe, expect, it } from "vitest";
import {
  assessPaperProfitabilityDrawdown,
  type PaperProfitabilityDrawdownCandidate,
  type PaperProfitabilityDrawdownInput,
} from "../src/paper-profitability-drawdown.js";

function candidate(
  overrides: Partial<PaperProfitabilityDrawdownCandidate> = {},
): PaperProfitabilityDrawdownCandidate {
  return {
    candidateId: "candidate-a",
    marketId: "ETH-USDC",
    points: [
      { observedAtMs: 1_000, equityUsd: "100" },
      { observedAtMs: 2_000, equityUsd: "110" },
      { observedAtMs: 3_000, equityUsd: "99" },
    ],
    status: "eligible",
    reasons: [],
    ...overrides,
  };
}

function input(
  overrides: Partial<PaperProfitabilityDrawdownInput> = {},
): PaperProfitabilityDrawdownInput {
  return {
    maxDrawdownBps: 1000,
    minimumPoints: 3,
    candidates: [candidate()],
    ...overrides,
  };
}

describe("Paper profitability drawdown admission", () => {
  it("computes an exact peak-to-trough drawdown and admits the inclusive boundary", () => {
    const result = assessPaperProfitabilityDrawdown(input());
    expect(result).toEqual({
      maxDrawdownBps: 1000,
      minimumPoints: 3,
      status: "eligible",
      reasons: [],
      candidates: [
        {
          candidateId: "candidate-a",
          marketId: "ETH-USDC",
          pointCount: 3,
          startAtMs: 1_000,
          endAtMs: 3_000,
          peakEquityUsd: "110",
          troughEquityUsd: "99",
          maxDrawdownUsd: "11",
          maxDrawdownBps: { numerator: "1000", denominator: "1" },
          status: "eligible",
          reasons: [],
        },
      ],
    });
  });

  it("fails closed when drawdown exceeds the limit by one exact unit", () => {
    const result = assessPaperProfitabilityDrawdown(
      input({ maxDrawdownBps: 999 }),
    );
    expect(result.status).toBe("ineligible");
    expect(result.reasons).toContain("drawdown_above_limit");
    expect(result.candidates[0]?.status).toBe("ineligible");
  });

  it("rejects incomplete, non-monotonic, non-positive and insufficient evidence", () => {
    const cases: readonly [
      Partial<PaperProfitabilityDrawdownCandidate>,
      string,
    ][] = [
      [{ status: "ineligible" }, "candidate_not_eligible"],
      [{ reasons: ["missing_mark"] }, "candidate_gaps_present"],
      [
        { points: [{ observedAtMs: 1_000, equityUsd: "100" }] },
        "insufficient_points",
      ],
      [
        {
          points: [
            { observedAtMs: 2_000, equityUsd: "100" },
            { observedAtMs: 1_000, equityUsd: "101" },
            { observedAtMs: 3_000, equityUsd: "99" },
          ],
        },
        "non_monotonic_points",
      ],
      [
        {
          points: [
            { observedAtMs: 1_000, equityUsd: "100" },
            { observedAtMs: 2_000, equityUsd: "0" },
            { observedAtMs: 3_000, equityUsd: "99" },
          ],
        },
        "non_positive_equity_usd",
      ],
    ];
    for (const [overrides, reason] of cases) {
      const result = assessPaperProfitabilityDrawdown(
        input({ candidates: [candidate(overrides)] }),
      );
      expect(result.status, reason).toBe("ineligible");
      expect(result.reasons, reason).toContain(reason);
    }
  });

  it("handles sparse, null, Symbol and non-finite inputs without throwing", () => {
    expect(() => assessPaperProfitabilityDrawdown(null)).not.toThrow();
    const sparse = new Array(2) as PaperProfitabilityDrawdownCandidate[];
    sparse[1] = candidate({ candidateId: "b" });
    const sparseResult = assessPaperProfitabilityDrawdown(
      input({ candidates: sparse }),
    );
    expect(sparseResult.reasons).toContain("sparse_candidates");
    expect(sparseResult.candidates[0]?.reasons).toContain(
      "malformed_candidate",
    );
    const malformed = assessPaperProfitabilityDrawdown({
      ...input(),
      maxDrawdownBps: Number.NaN,
      minimumPoints: Number.POSITIVE_INFINITY,
      candidates: [null, { ...candidate(), candidateId: Symbol("id") }],
    } as unknown as PaperProfitabilityDrawdownInput);
    expect(malformed.status).toBe("ineligible");
    expect(malformed.reasons).toContain("invalid_max_drawdown_bps");
    expect(malformed.reasons).toContain("invalid_minimum_points");
    expect(malformed.reasons).toContain("invalid_candidate_id");
  });

  it("sorts candidates deterministically and strips authority/provider fields", () => {
    const first = assessPaperProfitabilityDrawdown({
      ...input(),
      executionAuthorized: true,
      routeToLive: "mainnet",
      candidates: [
        { ...candidate({ candidateId: "b" }), providerReceipt: "x" },
        { ...candidate({ candidateId: "a" }), providerReceipt: "y" },
      ],
    } as unknown as PaperProfitabilityDrawdownInput);
    const second = assessPaperProfitabilityDrawdown(
      input({
        candidates: [
          candidate({ candidateId: "a" }),
          candidate({ candidateId: "b" }),
        ],
      }),
    );
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).not.toContain("provider");
    expect(JSON.stringify(first)).not.toContain("mainnet");
  });

  it("rejects empty candidates, duplicate identities and invalid limits", () => {
    expect(
      assessPaperProfitabilityDrawdown(input({ candidates: [] })).reasons,
    ).toContain("empty_candidates");
    for (const maxDrawdownBps of [
      -1,
      10_001,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const result = assessPaperProfitabilityDrawdown(
        input({ maxDrawdownBps }),
      );
      expect(result.status).toBe("ineligible");
      expect(result.reasons).toContain("invalid_max_drawdown_bps");
    }
    for (const minimumPoints of [0, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = assessPaperProfitabilityDrawdown(input({ minimumPoints }));
      expect(result.status).toBe("ineligible");
      expect(result.reasons).toContain("invalid_minimum_points");
    }
    const duplicate = assessPaperProfitabilityDrawdown(
      input({ candidates: [candidate(), candidate()] }),
    );
    expect(duplicate.reasons).toContain("duplicate_candidate");
  });
});
