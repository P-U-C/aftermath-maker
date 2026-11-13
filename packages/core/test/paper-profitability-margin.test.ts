import { describe, expect, it } from "vitest";
import {
  assessPaperProfitabilityMargin,
  type PaperProfitabilityMarginCandidate,
  type PaperProfitabilityMarginInput,
} from "../src/paper-profitability-margin.js";

function candidate(
  overrides: Partial<PaperProfitabilityMarginCandidate> = {},
): PaperProfitabilityMarginCandidate {
  return {
    candidateId: "candidate-a",
    marketId: "ETH-USDC",
    collateralUsd: "1000",
    grossProfitUsd: "25",
    venueFeesUsd: "2",
    slippageUsd: "1",
    fundingUsd: "1",
    gasUsd: "1",
    status: "eligible",
    reasons: [],
    ...overrides,
  };
}

function input(
  overrides: Partial<PaperProfitabilityMarginInput> = {},
): PaperProfitabilityMarginInput {
  return {
    minimumNetUsd: "20",
    minimumMarginBps: 200,
    candidates: [candidate()],
    ...overrides,
  };
}

describe("Paper profitability margin admission", () => {
  it("admits a complete fee and slippage-adjusted margin at the exact boundary", () => {
    expect(assessPaperProfitabilityMargin(input())).toEqual({
      minimumNetUsd: "20",
      minimumMarginBps: 200,
      status: "eligible",
      reasons: [],
      candidates: [
        {
          candidateId: "candidate-a",
          marketId: "ETH-USDC",
          collateralUsd: "1000",
          grossProfitUsd: "25",
          totalCostsUsd: "5",
          netProfitUsd: "20",
          marginBps: { numerator: "200", denominator: "1" },
          status: "eligible",
          reasons: [],
        },
      ],
    });
  });

  it("fails closed for one decimal unit below net or margin thresholds", () => {
    const netMiss = assessPaperProfitabilityMargin(
      input({ minimumNetUsd: "20.000001" }),
    );
    expect(netMiss.status).toBe("ineligible");
    expect(netMiss.reasons).toContain("net_profit_below_minimum");

    const marginMiss = assessPaperProfitabilityMargin(
      input({ minimumMarginBps: 201 }),
    );
    expect(marginMiss.status).toBe("ineligible");
    expect(marginMiss.reasons).toContain("margin_below_minimum");
  });

  it("rejects incomplete, negative-cost, non-positive-collateral, and source-gap rows", () => {
    const cases: readonly [
      Partial<PaperProfitabilityMarginCandidate>,
      string,
    ][] = [
      [{ status: "ineligible" }, "candidate_not_eligible"],
      [{ reasons: ["missing_fill"] }, "candidate_gaps_present"],
      [{ collateralUsd: "0" }, "non_positive_collateral_usd"],
      [{ grossProfitUsd: "-1" }, "net_profit_non_positive"],
      [{ venueFeesUsd: "-1" }, "negative_cost_usd"],
      [{ slippageUsd: "-0.01" }, "negative_cost_usd"],
      [{ gasUsd: "1e2" }, "invalid_cost_usd"],
    ];
    for (const [overrides, reason] of cases) {
      const result = assessPaperProfitabilityMargin(
        input({ candidates: [candidate(overrides)] }),
      );
      expect(result.status, reason).toBe("ineligible");
      expect(result.reasons, reason).toContain(reason);
    }
  });

  it("handles malformed, sparse, duplicate, null and Symbol rows without throwing", () => {
    expect(() => assessPaperProfitabilityMargin(null)).not.toThrow();
    const sparse = new Array(2) as PaperProfitabilityMarginCandidate[];
    sparse[1] = candidate({ candidateId: "b" });
    const sparseResult = assessPaperProfitabilityMargin(
      input({ candidates: sparse }),
    );
    expect(sparseResult.reasons).toContain("sparse_candidates");
    expect(sparseResult.candidates[0]?.reasons).toContain(
      "malformed_candidate",
    );

    const duplicate = assessPaperProfitabilityMargin(
      input({ candidates: [candidate(), candidate()] }),
    );
    expect(duplicate.reasons).toContain("duplicate_candidate");

    const separatorSafe = assessPaperProfitabilityMargin(
      input({
        minimumMarginBps: 0,
        candidates: [
          candidate({ candidateId: "a\u0000b", marketId: "c" }),
          candidate({ candidateId: "a", marketId: "b\u0000c" }),
        ],
      }),
    );
    expect(separatorSafe.reasons).not.toContain("duplicate_candidate");

    const malformed = assessPaperProfitabilityMargin({
      ...input(),
      candidates: [null, { ...candidate(), candidateId: Symbol("id") }],
    } as unknown as PaperProfitabilityMarginInput);
    expect(malformed.status).toBe("ineligible");
    expect(malformed.reasons).toContain("malformed_candidate");
    expect(malformed.reasons).toContain("invalid_candidate_id");
  });

  it("sorts candidates and reason output deterministically and strips authority fields", () => {
    const first = assessPaperProfitabilityMargin({
      ...input({ minimumMarginBps: 0 }),
      executionAuthorized: true,
      routeToLive: "mainnet",
      candidates: [
        { ...candidate({ candidateId: "b" }), providerReceipt: "x" },
        { ...candidate({ candidateId: "a" }), providerReceipt: "y" },
      ],
    } as unknown as PaperProfitabilityMarginInput);
    const second = assessPaperProfitabilityMargin({
      ...input({ minimumMarginBps: 0 }),
      candidates: [
        candidate({ candidateId: "a" }),
        candidate({ candidateId: "b" }),
      ],
    });
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).not.toContain("provider");
    expect(JSON.stringify(first)).not.toContain("mainnet");

    const duplicateA = candidate({ collateralUsd: "900" });
    const duplicateB = candidate({ grossProfitUsd: "26" });
    const duplicateForward = assessPaperProfitabilityMargin(
      input({ minimumMarginBps: 0, candidates: [duplicateA, duplicateB] }),
    );
    const duplicateReverse = assessPaperProfitabilityMargin(
      input({ minimumMarginBps: 0, candidates: [duplicateB, duplicateA] }),
    );
    expect(duplicateReverse).toEqual(duplicateForward);
  });

  it("rejects invalid thresholds and non-finite runtime values", () => {
    for (const minimumNetUsd of ["0", "-1", "01", "1e2", "9".repeat(129)]) {
      const result = assessPaperProfitabilityMargin(input({ minimumNetUsd }));
      expect(result.status, minimumNetUsd).toBe("ineligible");
      expect(result.reasons, minimumNetUsd).toContain(
        minimumNetUsd === "0" || minimumNetUsd === "-1"
          ? "non_positive_minimum_net_usd"
          : "invalid_minimum_net_usd",
      );
    }
    for (const minimumMarginBps of [
      -1,
      10_001,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const result = assessPaperProfitabilityMargin(
        input({ minimumMarginBps }),
      );
      expect(result.status).toBe("ineligible");
      expect(result.reasons).toContain("invalid_minimum_margin_bps");
    }
  });
});
