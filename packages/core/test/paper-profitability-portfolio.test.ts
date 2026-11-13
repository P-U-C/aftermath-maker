import { describe, expect, it } from "vitest";
import type {
  PaperProfitabilityCapacityResult,
  PaperProfitabilityCapacityWindowResult,
} from "../src/paper-profitability-capacity.js";
import {
  allocatePaperProfitabilityPortfolio,
  type PaperProfitabilityPortfolioInput,
} from "../src/paper-profitability-portfolio.js";

function capacityWindow(
  maxAllocatedUsd = "25",
  overrides: Partial<PaperProfitabilityCapacityWindowResult> = {},
): PaperProfitabilityCapacityWindowResult {
  return {
    windowId: "window-a",
    exposureUsd: "10",
    maxAllocatedUsd,
    remainingCapacityUsd: "15",
    status: "within_budget",
    reasons: [],
    ...overrides,
  };
}

function capacityResult(
  overrides: Partial<PaperProfitabilityCapacityResult> = {},
): PaperProfitabilityCapacityResult {
  return {
    candidateId: "candidate-a",
    marketId: "ETH-USDC",
    collateralUsd: "100",
    maxAllocationBps: 2500,
    maxAllocatedUsd: "25",
    baseStatus: "eligible",
    stressStatus: "eligible",
    status: "eligible",
    reasons: [],
    windows: [capacityWindow()],
    ...overrides,
  };
}

function portfolio(
  overrides: Partial<PaperProfitabilityPortfolioInput> = {},
): PaperProfitabilityPortfolioInput {
  return {
    totalCollateralUsd: "40",
    candidates: [
      capacityResult({
        candidateId: "candidate-b",
        marketId: "SOL-USDC",
        maxAllocatedUsd: "14.5",
        windows: [capacityWindow("14.5", { remainingCapacityUsd: "4.5" })],
      }),
      capacityResult(),
    ],
    ...overrides,
  };
}

describe("Paper profitability portfolio allocation", () => {
  it("allocates admitted Paper capacity only when the exact total request fits the portfolio collateral budget", () => {
    const result = allocatePaperProfitabilityPortfolio(portfolio());

    expect(result.status).toBe("eligible");
    expect(result.reasons).toEqual([]);
    expect(result.totalRequestedAllocationUsd).toBe("39.5");
    expect(result.remainingCollateralUsd).toBe("0.5");
    expect(result.candidates).toEqual([
      {
        candidateId: "candidate-a",
        marketId: "ETH-USDC",
        requestedAllocationUsd: "25",
        allocatedUsd: "25",
        status: "allocated",
        reasons: [],
      },
      {
        candidateId: "candidate-b",
        marketId: "SOL-USDC",
        requestedAllocationUsd: "14.5",
        allocatedUsd: "14.5",
        status: "allocated",
        reasons: [],
      },
    ]);
  });

  it("sums fractional requests exactly and fails closed one decimal unit above budget", () => {
    const over = allocatePaperProfitabilityPortfolio(
      portfolio({
        totalCollateralUsd: "39",
        candidates: [
          capacityResult({
            maxAllocatedUsd: "25",
            windows: [
              capacityWindow("25", {
                remainingCapacityUsd: "15",
              }),
            ],
          }),
          capacityResult({
            candidateId: "candidate-b",
            marketId: "SOL-USDC",
            maxAllocatedUsd: "14.5",
            windows: [capacityWindow("14.5", { remainingCapacityUsd: "4.5" })],
          }),
        ],
      }),
    );

    expect(over.status).toBe("ineligible");
    expect(over.reasons).toContain("portfolio_budget_exceeded");
    expect(over.totalRequestedAllocationUsd).toBe("39.5");
    expect(over.remainingCollateralUsd).toBe("-0.5");
    expect(
      over.candidates.every(
        (candidate) =>
          candidate.allocatedUsd === null &&
          candidate.reasons.includes("portfolio_budget_exceeded"),
      ),
    ).toBe(true);
  });

  it("requires a canonical positive safe-integer collateral budget", () => {
    for (const totalCollateralUsd of [
      "0",
      "-1",
      "1.5",
      "01",
      "+1",
      "1e3",
      "9007199254740992",
      "9".repeat(129),
    ]) {
      const result = allocatePaperProfitabilityPortfolio(
        portfolio({ totalCollateralUsd }),
      );
      expect(result.status, totalCollateralUsd).toBe("ineligible");
      expect(result.reasons, totalCollateralUsd).toContain(
        totalCollateralUsd === "0" || totalCollateralUsd === "-1"
          ? "non_positive_total_collateral_usd"
          : totalCollateralUsd === "9007199254740992"
            ? "unsafe_total_collateral_usd"
            : "invalid_total_collateral_usd",
      );
      expect(result.remainingCollateralUsd, totalCollateralUsd).toBeNull();
    }

    const maximumSafe = allocatePaperProfitabilityPortfolio(
      portfolio({ totalCollateralUsd: "9007199254740991" }),
    );
    expect(maximumSafe.status).toBe("eligible");
    expect(maximumSafe.totalCollateralUsd).toBe("9007199254740991");
  });

  it("requires a nonempty dense candidate collection and preserves malformed rows", () => {
    const empty = allocatePaperProfitabilityPortfolio(
      portfolio({ candidates: [] }),
    );
    expect(empty.reasons).toContain("empty_candidates");

    const malformed = allocatePaperProfitabilityPortfolio({
      ...portfolio(),
      candidates: null,
    } as unknown as PaperProfitabilityPortfolioInput);
    expect(malformed.reasons).toContain("malformed_candidates");

    const sparseCandidates = new Array(2) as PaperProfitabilityCapacityResult[];
    sparseCandidates[1] = capacityResult();
    const sparse = allocatePaperProfitabilityPortfolio(
      portfolio({ candidates: sparseCandidates }),
    );
    expect(sparse.status).toBe("ineligible");
    expect(sparse.reasons).toContain("sparse_candidates");
    expect(sparse.candidates).toHaveLength(2);
    expect(sparse.candidates[0]).toMatchObject({
      candidateId: null,
      marketId: null,
      status: "ineligible",
      reasons: expect.arrayContaining(["malformed_candidate"]),
    });
  });

  it("rejects duplicate candidate and market identities and marks every duplicate", () => {
    const duplicate = allocatePaperProfitabilityPortfolio(
      portfolio({
        candidates: [
          capacityResult(),
          capacityResult({
            maxAllocatedUsd: "20",
            windows: [capacityWindow("20")],
          }),
        ],
      }),
    );

    expect(duplicate.status).toBe("ineligible");
    expect(duplicate.reasons).toContain("duplicate_candidate");
    expect(
      duplicate.candidates.every((candidate) =>
        candidate.reasons.includes("duplicate_candidate"),
      ),
    ).toBe(true);
  });

  it("requires each candidate capacity result to be eligible, gap-free and positively allocated", () => {
    const cases: readonly [
      Partial<PaperProfitabilityCapacityResult>,
      string,
    ][] = [
      [{ status: "ineligible" }, "capacity_not_eligible"],
      [{ baseStatus: "ineligible" }, "capacity_not_eligible"],
      [{ stressStatus: "ineligible" }, "capacity_not_eligible"],
      [{ reasons: ["exposure_above_budget"] }, "capacity_gaps_present"],
      [{ maxAllocatedUsd: null }, "missing_max_allocated_usd"],
      [{ maxAllocatedUsd: "0" }, "non_positive_max_allocated_usd"],
      [{ maxAllocatedUsd: "-1" }, "non_positive_max_allocated_usd"],
      [{ maxAllocatedUsd: "+1" }, "invalid_max_allocated_usd"],
      [{ maxAllocatedUsd: "9".repeat(129) }, "invalid_max_allocated_usd"],
    ];

    for (const [overrides, expectedReason] of cases) {
      const result = allocatePaperProfitabilityPortfolio(
        portfolio({ candidates: [capacityResult(overrides)] }),
      );
      expect(result.status, expectedReason).toBe("ineligible");
      expect(result.reasons, expectedReason).toContain(expectedReason);
      expect(result.candidates[0]?.allocatedUsd, expectedReason).toBeNull();
    }
  });

  it("requires complete, unique capacity windows consistent with the candidate allocation", () => {
    const empty = allocatePaperProfitabilityPortfolio(
      portfolio({ candidates: [capacityResult({ windows: [] })] }),
    );
    expect(empty.reasons).toContain("empty_capacity_windows");

    const incomplete = allocatePaperProfitabilityPortfolio(
      portfolio({
        candidates: [
          capacityResult({
            windows: [
              capacityWindow("25", {
                status: "ineligible",
                reasons: ["exposure_above_budget"],
              }),
            ],
          }),
        ],
      }),
    );
    expect(incomplete.reasons).toContain("capacity_window_not_complete");

    const inconsistent = allocatePaperProfitabilityPortfolio(
      portfolio({
        candidates: [
          capacityResult({
            windows: [capacityWindow("24")],
          }),
        ],
      }),
    );
    expect(inconsistent.reasons).toContain("inconsistent_capacity_allocation");

    const negativeZero = allocatePaperProfitabilityPortfolio(
      portfolio({
        candidates: [
          capacityResult({
            windows: [
              capacityWindow("25", {
                exposureUsd: "-0",
                remainingCapacityUsd: "15",
              }),
            ],
          }),
        ],
      }),
    );
    expect(negativeZero.status).toBe("ineligible");
    expect(negativeZero.reasons).toContain("capacity_window_not_complete");

    const inconsistentRemaining = allocatePaperProfitabilityPortfolio(
      portfolio({
        candidates: [
          capacityResult({
            windows: [capacityWindow("25", { remainingCapacityUsd: "999" })],
          }),
        ],
      }),
    );
    expect(inconsistentRemaining.reasons).toContain(
      "inconsistent_capacity_remaining",
    );

    const inconsistentCandidate = allocatePaperProfitabilityPortfolio(
      portfolio({
        candidates: [
          capacityResult({
            collateralUsd: "1",
            maxAllocationBps: 1,
            maxAllocatedUsd: "25",
            windows: [capacityWindow("25", { remainingCapacityUsd: "15" })],
          }),
        ],
      }),
    );
    expect(inconsistentCandidate.reasons).toContain(
      "inconsistent_candidate_allocation",
    );

    const duplicate = allocatePaperProfitabilityPortfolio(
      portfolio({
        candidates: [
          capacityResult({
            windows: [
              capacityWindow(),
              capacityWindow("25", {
                exposureUsd: "5",
                remainingCapacityUsd: "20",
              }),
            ],
          }),
        ],
      }),
    );
    expect(duplicate.reasons).toContain("duplicate_capacity_window_id");

    const sparseWindows = new Array(
      2,
    ) as PaperProfitabilityCapacityWindowResult[];
    sparseWindows[1] = capacityWindow();
    const sparse = allocatePaperProfitabilityPortfolio(
      portfolio({
        candidates: [capacityResult({ windows: sparseWindows })],
      }),
    );
    expect(sparse.reasons).toContain("sparse_capacity_windows");
  });

  it("does not collide distinct candidate identities containing separators", () => {
    const result = allocatePaperProfitabilityPortfolio(
      portfolio({
        candidates: [
          capacityResult({ candidateId: "a\u0000b", marketId: "c" }),
          capacityResult({ candidateId: "a", marketId: "b\u0000c" }),
        ],
      }),
    );
    expect(result.reasons).not.toContain("duplicate_candidate");
  });

  it("rejects malformed identities, collateral and non-finite candidate limits without throwing", () => {
    expect(() => allocatePaperProfitabilityPortfolio(null)).not.toThrow();
    const nullResult = allocatePaperProfitabilityPortfolio(null);
    expect(nullResult.reasons).toEqual(
      expect.arrayContaining(["malformed_input", "malformed_candidates"]),
    );

    const symbolResult = allocatePaperProfitabilityPortfolio({
      totalCollateralUsd: Symbol("budget"),
      candidates: [
        {
          ...capacityResult(),
          candidateId: Symbol("candidate"),
          marketId: Symbol("market"),
          collateralUsd: Symbol("collateral"),
          maxAllocationBps: Number.NaN,
        },
        {
          ...capacityResult({
            candidateId: "candidate-b",
            marketId: "SOL-USDC",
          }),
          maxAllocationBps: Number.POSITIVE_INFINITY,
        },
      ],
    } as unknown as PaperProfitabilityPortfolioInput);
    expect(() =>
      allocatePaperProfitabilityPortfolio({
        totalCollateralUsd: "40",
        candidates: [null],
      } as unknown as PaperProfitabilityPortfolioInput),
    ).not.toThrow();
    expect(symbolResult.status).toBe("ineligible");
    expect(symbolResult.reasons).toEqual(
      expect.arrayContaining([
        "invalid_total_collateral_usd",
        "invalid_candidate_id",
        "invalid_market_id",
        "invalid_candidate_collateral_usd",
        "invalid_candidate_max_allocation_bps",
      ]),
    );
  });

  it("sorts output deterministically regardless of candidate input order", () => {
    const original = allocatePaperProfitabilityPortfolio(portfolio());
    const reversed = allocatePaperProfitabilityPortfolio(
      portfolio({ candidates: [...portfolio().candidates].reverse() }),
    );

    expect(reversed).toEqual(original);
    expect(
      reversed.candidates.map((candidate) => candidate.candidateId),
    ).toEqual(["candidate-a", "candidate-b"]);
  });

  it("returns only an authority-free reporting allowlist", () => {
    const authorityInput = {
      ...portfolio(),
      executionAuthorized: true,
      routeToLive: "mainnet",
      providerReceipt: "not-evidence",
      candidates: portfolio().candidates.map((candidate) => ({
        ...candidate!,
        executionAuthorized: true,
        providerReceipt: "not-evidence",
        windows: candidate!.windows.map((window) => ({
          ...window,
          routeToLive: true,
        })),
      })),
    } as unknown as PaperProfitabilityPortfolioInput;
    const result = allocatePaperProfitabilityPortfolio(authorityInput);

    expect(result.status).toBe("eligible");
    expect(Object.keys(result).sort()).toEqual(
      [
        "totalCollateralUsd",
        "totalRequestedAllocationUsd",
        "remainingCollateralUsd",
        "status",
        "reasons",
        "candidates",
      ].sort(),
    );
    expect(Object.keys(result.candidates[0]!).sort()).toEqual(
      [
        "candidateId",
        "marketId",
        "requestedAllocationUsd",
        "allocatedUsd",
        "status",
        "reasons",
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toContain("executionAuthorized");
    expect(JSON.stringify(result)).not.toContain("routeToLive");
    expect(JSON.stringify(result)).not.toContain("provider");
    expect(JSON.stringify(result)).not.toContain("receipt");
    expect(result).not.toHaveProperty("candidates.0.windows");
  });
});
