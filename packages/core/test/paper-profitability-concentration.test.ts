import { describe, expect, it } from "vitest";
import {
  assessPaperProfitabilityConcentration,
  type PaperProfitabilityConcentrationCandidate,
  type PaperProfitabilityConcentrationInput,
} from "../src/paper-profitability-concentration.js";

function candidate(
  overrides: Partial<PaperProfitabilityConcentrationCandidate> = {},
): PaperProfitabilityConcentrationCandidate {
  return {
    candidateId: "candidate-a",
    marketId: "ETH-USDC",
    allocatedUsd: "25",
    maxLossUsd: "2",
    status: "eligible",
    reasons: [],
    ...overrides,
  };
}

function input(
  overrides: Partial<PaperProfitabilityConcentrationInput> = {},
): PaperProfitabilityConcentrationInput {
  return {
    maxMarketAllocationBps: 7000,
    maxMarketLossBps: 7000,
    candidates: [
      candidate(),
      candidate({
        candidateId: "candidate-b",
        marketId: "SOL-USDC",
        allocatedUsd: "25",
        maxLossUsd: "2",
      }),
      candidate({
        candidateId: "candidate-c",
        marketId: "BTC-USDC",
        allocatedUsd: "50",
        maxLossUsd: "6",
      }),
    ],
    ...overrides,
  };
}

describe("Paper profitability concentration admission", () => {
  it("admits exact market allocation and loss concentration boundaries", () => {
    const result = assessPaperProfitabilityConcentration(input());
    expect(result.status).toBe("eligible");
    expect(result.reasons).toEqual([]);
    expect(result.totalAllocatedUsd).toBe("100");
    expect(result.totalMaxLossUsd).toBe("10");
    expect(result.candidates.map((row) => row.marketId)).toEqual([
      "ETH-USDC",
      "SOL-USDC",
      "BTC-USDC",
    ]);
    expect(
      result.candidates.find((row) => row.marketId === "BTC-USDC"),
    ).toMatchObject({
      marketAllocatedUsd: "50",
      marketMaxLossUsd: "6",
      allocationShareBps: { numerator: "5000", denominator: "1" },
      lossShareBps: { numerator: "6000", denominator: "1" },
      status: "eligible",
      reasons: [],
    });
  });

  it("fails every candidate in an over-concentrated market using exact decimals", () => {
    const result = assessPaperProfitabilityConcentration(
      input({
        maxMarketAllocationBps: 4999,
        maxMarketLossBps: 5999,
      }),
    );
    expect(result.status).toBe("ineligible");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "market_allocation_concentration",
        "market_loss_concentration",
      ]),
    );
    expect(
      result.candidates
        .filter((row) => row.marketId === "BTC-USDC")
        .every((row) => row.status === "ineligible"),
    ).toBe(true);
  });

  it("rejects malformed, negative, zero, gapful and duplicate rows", () => {
    const cases: readonly [
      Partial<PaperProfitabilityConcentrationCandidate>,
      string,
    ][] = [
      [{ status: "ineligible" }, "candidate_not_eligible"],
      [{ reasons: ["gap"] }, "candidate_gaps_present"],
      [{ allocatedUsd: "0" }, "non_positive_allocated_usd"],
      [{ maxLossUsd: "-1" }, "invalid_max_loss_usd"],
      [{ maxLossUsd: "0" }, "non_positive_max_loss_usd"],
      [{ maxLossUsd: "26" }, "loss_exceeds_allocation"],
    ];
    for (const [overrides, reason] of cases) {
      const result = assessPaperProfitabilityConcentration(
        input({ candidates: [candidate(overrides)] }),
      );
      expect(result.status, reason).toBe("ineligible");
      expect(result.reasons, reason).toContain(reason);
    }
    const duplicate = assessPaperProfitabilityConcentration(
      input({ candidates: [candidate(), candidate()] }),
    );
    expect(duplicate.reasons).toContain("duplicate_candidate");
  });

  it("handles sparse, null, Symbol and non-finite threshold inputs without throwing", () => {
    expect(() => assessPaperProfitabilityConcentration(null)).not.toThrow();
    const sparse = new Array(2) as PaperProfitabilityConcentrationCandidate[];
    sparse[1] = candidate({ candidateId: "b" });
    const sparseResult = assessPaperProfitabilityConcentration(
      input({ candidates: sparse }),
    );
    expect(sparseResult.reasons).toContain("sparse_candidates");
    expect(sparseResult.candidates[0]?.reasons).toContain(
      "malformed_candidate",
    );
    const malformed = assessPaperProfitabilityConcentration({
      ...input(),
      maxMarketAllocationBps: Number.NaN,
      maxMarketLossBps: Number.POSITIVE_INFINITY,
      candidates: [null, { ...candidate(), marketId: Symbol("market") }],
    } as unknown as PaperProfitabilityConcentrationInput);
    expect(malformed.status).toBe("ineligible");
    expect(malformed.reasons).toContain("invalid_max_market_allocation_bps");
    expect(malformed.reasons).toContain("invalid_max_market_loss_bps");
    expect(malformed.reasons).toContain("invalid_market_id");
  });

  it("sorts duplicate/error output deterministically and strips authority fields", () => {
    const first = assessPaperProfitabilityConcentration({
      ...input(),
      executionAuthorized: true,
      routeToLive: "mainnet",
      candidates: [
        { ...candidate({ candidateId: "b" }), providerReceipt: "x" },
        { ...candidate({ candidateId: "a" }), providerReceipt: "y" },
      ],
    } as unknown as PaperProfitabilityConcentrationInput);
    const second = assessPaperProfitabilityConcentration(
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

  it("rejects empty candidate sets and invalid concentration limits", () => {
    expect(
      assessPaperProfitabilityConcentration(input({ candidates: [] })).reasons,
    ).toContain("empty_candidates");
    for (const maxMarketAllocationBps of [-1, 0, 10_001, Number.NaN]) {
      const result = assessPaperProfitabilityConcentration(
        input({ maxMarketAllocationBps }),
      );
      expect(result.status).toBe("ineligible");
      expect(result.reasons).toContain("invalid_max_market_allocation_bps");
    }
    for (const maxMarketLossBps of [-1, 0, 10_001, Number.POSITIVE_INFINITY]) {
      const result = assessPaperProfitabilityConcentration(
        input({ maxMarketLossBps }),
      );
      expect(result.status).toBe("ineligible");
      expect(result.reasons).toContain("invalid_max_market_loss_bps");
    }
  });
});
