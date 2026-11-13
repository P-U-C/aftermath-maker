import { describe, expect, it } from "vitest";
import {
  assessPaperProfitabilityRisk,
  type PaperProfitabilityRiskInput,
  type PaperProfitabilityRiskCandidate,
} from "../src/paper-profitability-risk.js";

function candidate(
  overrides: Partial<PaperProfitabilityRiskCandidate> = {},
): PaperProfitabilityRiskCandidate {
  return {
    candidateId: "candidate-a",
    marketId: "ETH-USDC",
    allocatedUsd: "25.5",
    maxLossUsd: "2.5",
    status: "eligible",
    reasons: [],
    ...overrides,
  };
}

function portfolio(
  overrides: Partial<PaperProfitabilityRiskInput> = {},
): PaperProfitabilityRiskInput {
  return {
    totalCollateralUsd: "40",
    riskBudgetUsd: "5",
    candidates: [
      candidate(),
      candidate({
        candidateId: "candidate-b",
        marketId: "SOL-USDC",
        allocatedUsd: "14.5",
        maxLossUsd: "2.5",
      }),
    ],
    ...overrides,
  };
}

describe("Paper profitability risk admission", () => {
  it("admits complete allocations when exact max loss fits risk and collateral budgets", () => {
    const result = assessPaperProfitabilityRisk(portfolio());

    expect(result).toEqual({
      totalCollateralUsd: "40",
      riskBudgetUsd: "5",
      totalAllocatedUsd: "40",
      totalMaxLossUsd: "5",
      remainingRiskBudgetUsd: "0",
      status: "eligible",
      reasons: [],
      candidates: [
        {
          candidateId: "candidate-a",
          marketId: "ETH-USDC",
          allocatedUsd: "25.5",
          maxLossUsd: "2.5",
          status: "admitted",
          reasons: [],
        },
        {
          candidateId: "candidate-b",
          marketId: "SOL-USDC",
          allocatedUsd: "14.5",
          maxLossUsd: "2.5",
          status: "admitted",
          reasons: [],
        },
      ],
    });
  });

  it("fails closed one decimal unit above the risk budget and marks every candidate", () => {
    const result = assessPaperProfitabilityRisk(
      portfolio({
        riskBudgetUsd: "4.999999",
        candidates: [
          candidate({ maxLossUsd: "2.5" }),
          candidate({
            candidateId: "candidate-b",
            marketId: "SOL-USDC",
            allocatedUsd: "14.5",
            maxLossUsd: "2.5",
          }),
        ],
      }),
    );

    expect(result.status).toBe("ineligible");
    expect(result.reasons).toContain("risk_budget_exceeded");
    expect(result.totalMaxLossUsd).toBe("5");
    expect(result.remainingRiskBudgetUsd).toBe("-0.000001");
    expect(result.candidates.every((row) => row.status === "ineligible")).toBe(
      true,
    );
  });

  it("requires canonical positive safe-integer collateral and risk budgets", () => {
    for (const value of ["0", "-1", "01", "+1", "1e3", "9".repeat(129)]) {
      const result = assessPaperProfitabilityRisk(
        portfolio({ totalCollateralUsd: value }),
      );
      expect(result.status, value).toBe("ineligible");
      expect(result.reasons, value).toEqual(
        expect.arrayContaining([
          value === "0" || value === "-1"
            ? "non_positive_total_collateral_usd"
            : "invalid_total_collateral_usd",
        ]),
      );
    }

    for (const value of ["0", "-1", "01", "+1", "1e3", "9".repeat(129)]) {
      const result = assessPaperProfitabilityRisk(
        portfolio({ riskBudgetUsd: value }),
      );
      expect(result.status, value).toBe("ineligible");
      expect(result.reasons, value).toContain(
        value === "0" || value === "-1"
          ? "non_positive_risk_budget_usd"
          : "invalid_risk_budget_usd",
      );
    }
  });

  it("rejects empty, malformed, sparse and duplicate candidate identity rows", () => {
    expect(
      assessPaperProfitabilityRisk(portfolio({ candidates: [] })).reasons,
    ).toContain("empty_candidates");
    expect(
      assessPaperProfitabilityRisk({
        ...portfolio(),
        candidates: null,
      } as unknown as PaperProfitabilityRiskInput).reasons,
    ).toContain("malformed_candidates");

    const sparse = new Array(2) as PaperProfitabilityRiskCandidate[];
    sparse[1] = candidate();
    const sparseResult = assessPaperProfitabilityRisk(
      portfolio({ candidates: sparse }),
    );
    expect(sparseResult.reasons).toContain("sparse_candidates");
    expect(sparseResult.candidates[0]?.reasons).toContain(
      "malformed_candidate",
    );

    const duplicate = assessPaperProfitabilityRisk(
      portfolio({ candidates: [candidate(), candidate()] }),
    );
    expect(duplicate.reasons).toContain("duplicate_candidate");
    expect(
      duplicate.candidates.every((row) =>
        row.reasons.includes("duplicate_candidate"),
      ),
    ).toBe(true);
  });

  it("requires each candidate to be complete, positive, and within its declared loss", () => {
    const cases: readonly [Partial<PaperProfitabilityRiskCandidate>, string][] =
      [
        [{ status: "ineligible" }, "candidate_not_eligible"],
        [{ reasons: ["incomplete_validation"] }, "candidate_gaps_present"],
        [{ allocatedUsd: "0" }, "non_positive_allocated_usd"],
        [{ allocatedUsd: "-1" }, "invalid_allocated_usd"],
        [{ maxLossUsd: "-1" }, "invalid_max_loss_usd"],
        [{ maxLossUsd: "0" }, "non_positive_max_loss_usd"],
        [{ maxLossUsd: "9".repeat(129) }, "invalid_max_loss_usd"],
        [
          { allocatedUsd: "40.000001", maxLossUsd: "2.5" },
          "collateral_budget_exceeded",
        ],
      ];

    for (const [overrides, expected] of cases) {
      const result = assessPaperProfitabilityRisk(
        portfolio({ candidates: [candidate(overrides)] }),
      );
      expect(result.status, expected).toBe("ineligible");
      expect(result.reasons, expected).toContain(expected);
    }
  });

  it("handles null, Symbol and non-finite values without throwing", () => {
    expect(() => assessPaperProfitabilityRisk(null)).not.toThrow();
    const result = assessPaperProfitabilityRisk({
      totalCollateralUsd: Symbol("collateral"),
      riskBudgetUsd: "5",
      candidates: [
        {
          ...candidate(),
          candidateId: Symbol("candidate"),
          marketId: Symbol("market"),
          allocatedUsd: Symbol("allocation"),
          maxLossUsd: Symbol("loss"),
          status: "eligible",
          reasons: [],
          providerReceipt: "no",
        },
        { ...candidate({ candidateId: "b" }), maxLossUsd: Number.NaN },
      ],
    } as unknown as PaperProfitabilityRiskInput);

    expect(result.status).toBe("ineligible");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "invalid_total_collateral_usd",
        "invalid_max_loss_usd",
        "invalid_candidate_id",
        "invalid_market_id",
        "invalid_allocated_usd",
      ]),
    );
  });

  it("sorts candidates and all reasons deterministically", () => {
    const one = assessPaperProfitabilityRisk(portfolio());
    const two = assessPaperProfitabilityRisk(
      portfolio({ candidates: [...portfolio().candidates].reverse() }),
    );
    expect(two).toEqual(one);
  });

  it("strips authority and provider fields from the reporting result", () => {
    const result = assessPaperProfitabilityRisk({
      ...portfolio(),
      executionAuthorized: true,
      routeToLive: "mainnet",
      providerReceipt: "no",
      candidates: portfolio().candidates.map((row) => ({
        ...row,
        executionAuthorized: true,
        providerReceipt: "no",
      })),
    } as unknown as PaperProfitabilityRiskInput);

    expect(result.status).toBe("eligible");
    expect(JSON.stringify(result)).not.toContain("provider");
    expect(JSON.stringify(result)).not.toContain("mainnet");
    expect(Object.keys(result).sort()).toEqual(
      [
        "totalCollateralUsd",
        "riskBudgetUsd",
        "totalAllocatedUsd",
        "totalMaxLossUsd",
        "remainingRiskBudgetUsd",
        "status",
        "reasons",
        "candidates",
      ].sort(),
    );
  });
});
