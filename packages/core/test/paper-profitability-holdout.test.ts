import { describe, expect, it } from "vitest";
import type { PaperProfitabilityEvidenceResult } from "../src/paper-profitability-evidence.js";
import {
  assessPaperProfitabilityHoldout,
  type PaperProfitabilityHoldoutInput,
  type PaperProfitabilityHoldoutWindow,
} from "../src/paper-profitability-holdout.js";

const DAY_MS = 86_400_000;
const COHORT = {
  runId: "run-a",
  accountId: "account-a",
  marketId: "ETH-USDC",
  configVersion: 7,
  network: "testnet",
} as const;

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

function holdoutWindow(
  overrides: Partial<PaperProfitabilityHoldoutWindow> = {},
): PaperProfitabilityHoldoutWindow {
  return {
    windowId: "train-a",
    windowStartAtMs: 0,
    windowEndAtMs: DAY_MS,
    cohort: COHORT,
    result: measuredResult(),
    ...overrides,
  };
}

function candidate(
  overrides: Partial<PaperProfitabilityHoldoutInput> = {},
): PaperProfitabilityHoldoutInput {
  return {
    candidateId: "candidate-a",
    marketId: "ETH-USDC",
    collateralUsd: "100",
    cohort: COHORT,
    minimumTrainWindows: 2,
    minimumValidationWindows: 2,
    trainWindows: [
      holdoutWindow(),
      holdoutWindow({
        windowId: "train-b",
        windowStartAtMs: DAY_MS,
        windowEndAtMs: 2 * DAY_MS,
        result: measuredResult({
          status: "non_positive",
          tradingNetUsd: "-1",
        }),
      }),
    ],
    validationWindows: [
      holdoutWindow({
        windowId: "validation-a",
        windowStartAtMs: 2 * DAY_MS,
        windowEndAtMs: 3 * DAY_MS,
        result: measuredResult({ tradingNetUsd: "1" }),
      }),
      holdoutWindow({
        windowId: "validation-b",
        windowStartAtMs: 3 * DAY_MS,
        windowEndAtMs: 4 * DAY_MS,
        result: measuredResult({ tradingNetUsd: "2" }),
      }),
    ],
    ...overrides,
  };
}

describe("Paper profitability walk-forward holdout admission", () => {
  it("admits only chronologically held-out positive validation windows from one cohort", () => {
    const eligible = assessPaperProfitabilityHoldout(
      candidate({
        trainWindows: [...candidate().trainWindows].reverse(),
        validationWindows: [...candidate().validationWindows].reverse(),
      }),
    );

    expect(eligible.status).toBe("eligible");
    expect(eligible.reasons).toEqual([]);
    expect(eligible.trainWindows.map((window) => window.windowId)).toEqual([
      "train-a",
      "train-b",
    ]);
    expect(eligible.trainWindows.map((window) => window.status)).toEqual([
      "complete",
      "complete",
    ]);
    expect(eligible.validationWindows.map((window) => window.status)).toEqual([
      "positive",
      "positive",
    ]);
    expect(eligible.worstValidationWindow).toMatchObject({
      windowId: "validation-a",
      netUsdPerDay: { numerator: "1", denominator: "1" },
      netReturnBpsPerDay: { numerator: "100", denominator: "1" },
    });

    const failedHoldout = assessPaperProfitabilityHoldout(
      candidate({
        trainWindows: candidate().trainWindows.map((window) => ({
          ...window!,
          result: measuredResult({ tradingNetUsd: "1000" }),
        })),
        validationWindows: candidate().validationWindows.map((window, index) =>
          index === 0
            ? {
                ...window!,
                result: measuredResult({
                  status: "non_positive",
                  tradingNetUsd: "-0.1",
                }),
              }
            : window,
        ),
      }),
    );
    expect(failedHoldout.status).toBe("ineligible");
    expect(failedHoldout.reasons).toContain("non_positive_trading_net_usd");
    expect(failedHoldout.worstValidationWindow?.netReturnBpsPerDay).toEqual({
      numerator: "-10",
      denominator: "1",
    });
  });

  it("enforces exact minimum train and validation counts", () => {
    const insufficientTrain = assessPaperProfitabilityHoldout(
      candidate({ trainWindows: candidate().trainWindows.slice(0, 1) }),
    );
    const insufficientValidation = assessPaperProfitabilityHoldout(
      candidate({
        validationWindows: candidate().validationWindows.slice(0, 1),
      }),
    );
    expect(insufficientTrain.reasons).toContain("insufficient_train_windows");
    expect(insufficientValidation.reasons).toContain(
      "insufficient_validation_windows",
    );
  });

  it("rejects gaps, overlaps and train windows after validation begins", () => {
    const gap = assessPaperProfitabilityHoldout(
      candidate({
        validationWindows: candidate().validationWindows.map((window) => ({
          ...window!,
          windowStartAtMs: window!.windowStartAtMs + 1,
          windowEndAtMs: window!.windowEndAtMs + 1,
        })),
      }),
    );
    expect(gap.reasons).toContain("chronological_gap");

    const overlap = assessPaperProfitabilityHoldout(
      candidate({
        validationWindows: candidate().validationWindows.map((window, index) =>
          index === 0
            ? { ...window!, windowStartAtMs: 2 * DAY_MS - 1 }
            : window,
        ),
      }),
    );
    expect(overlap.reasons).toContain("overlapping_windows");

    const trainAfterValidation = assessPaperProfitabilityHoldout(
      candidate({
        trainWindows: [
          candidate().trainWindows[0]!,
          holdoutWindow({
            windowId: "late-train",
            windowStartAtMs: 3 * DAY_MS,
            windowEndAtMs: 4 * DAY_MS,
          }),
        ],
        validationWindows: [
          holdoutWindow({
            windowId: "early-validation",
            windowStartAtMs: DAY_MS,
            windowEndAtMs: 2 * DAY_MS,
          }),
          holdoutWindow({
            windowId: "validation-b",
            windowStartAtMs: 2 * DAY_MS,
            windowEndAtMs: 3 * DAY_MS,
          }),
        ],
      }),
    );
    expect(trainAfterValidation.reasons).toContain("train_after_validation");
  });

  it("rejects every cohort identity, config and network mismatch", () => {
    for (const cohort of [
      { ...COHORT, runId: "other" },
      { ...COHORT, accountId: "other" },
      { ...COHORT, marketId: "BTC-USDC" },
      { ...COHORT, configVersion: 8 },
      { ...COHORT, network: "othernet" },
    ]) {
      const result = assessPaperProfitabilityHoldout(
        candidate({
          validationWindows: candidate().validationWindows.map(
            (window, index) => (index === 0 ? { ...window!, cohort } : window),
          ),
        }),
      );
      expect(result.status, JSON.stringify(cohort)).toBe("ineligible");
      expect(result.reasons, JSON.stringify(cohort)).toContain(
        "cohort_mismatch",
      );
    }
  });

  it("rejects incomplete or gap-bearing validation evidence", () => {
    const result = assessPaperProfitabilityHoldout(
      candidate({
        validationWindows: candidate().validationWindows.map((window, index) =>
          index === 0
            ? {
                ...window!,
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
              }
            : {
                ...window!,
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
              },
        ),
      }),
    );
    expect(result.status).toBe("ineligible");
    expect(result.reasons).toContain("evidence_gaps_present");
    expect(result.reasons).toContain("profitability_gaps_present");
  });

  it("rejects duplicate IDs and malformed or null windows", () => {
    const result = assessPaperProfitabilityHoldout(
      candidate({
        trainWindows: [null, candidate().trainWindows[0]],
        validationWindows: candidate().validationWindows.map(
          (window, index) =>
            ({
              ...window!,
              windowId: "duplicate",
              result:
                index === 0 ? null : { ...measuredResult(), components: {} },
            }) as unknown as PaperProfitabilityHoldoutWindow,
        ),
      }),
    );
    expect(result.status).toBe("ineligible");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "malformed_window",
        "malformed_result",
        "duplicate_window_id",
      ]),
    );
  });

  it("fails closed for invalid IDs, collateral, cohort and minimum counts", () => {
    expect(
      assessPaperProfitabilityHoldout(candidate({ candidateId: " " })).reasons,
    ).toContain("invalid_candidate_id");
    expect(
      assessPaperProfitabilityHoldout(candidate({ marketId: "" })).reasons,
    ).toContain("invalid_market_id");
    for (const collateralUsd of ["0", "-1", "01", "1e3"]) {
      expect(
        assessPaperProfitabilityHoldout(candidate({ collateralUsd })).status,
      ).toBe("ineligible");
    }
    expect(
      assessPaperProfitabilityHoldout(
        candidate({ cohort: { ...COHORT, network: "" } }),
      ).reasons,
    ).toContain("invalid_cohort");
    expect(
      assessPaperProfitabilityHoldout(candidate({ minimumTrainWindows: 0 }))
        .reasons,
    ).toContain("invalid_minimum_train_windows");
    expect(
      assessPaperProfitabilityHoldout(
        candidate({ minimumValidationWindows: 1.5 }),
      ).reasons,
    ).toContain("invalid_minimum_validation_windows");
  });

  it("handles null and Symbol-shaped runtime rows deterministically", () => {
    expect(() => assessPaperProfitabilityHoldout(null)).not.toThrow();
    expect(assessPaperProfitabilityHoldout(null).reasons).toContain(
      "malformed_candidate",
    );

    const symbolInput = {
      ...candidate(),
      candidateId: Symbol("candidate"),
      marketId: Symbol("market"),
      validationWindows: candidate().validationWindows.map((window) => ({
        ...window!,
        windowId: Symbol("window"),
      })),
    } as unknown as PaperProfitabilityHoldoutInput;
    const result = assessPaperProfitabilityHoldout(symbolInput);
    expect(result.candidateId).toBeNull();
    expect(result.marketId).toBeNull();
    expect(
      result.validationWindows.every((window) => window.windowId === null),
    ).toBe(true);
    expect(result.status).toBe("ineligible");
  });

  it("preserves exact repeating holdout ratios", () => {
    const result = assessPaperProfitabilityHoldout(
      candidate({
        collateralUsd: "12",
        validationWindows: [
          holdoutWindow({
            windowId: "validation-a",
            windowStartAtMs: 2 * DAY_MS,
            windowEndAtMs: 2 * DAY_MS + 64_800_000,
            result: measuredResult({ tradingNetUsd: "0.3" }),
          }),
          holdoutWindow({
            windowId: "validation-b",
            windowStartAtMs: 2 * DAY_MS + 64_800_000,
            windowEndAtMs: 2 * DAY_MS + 2 * 64_800_000,
            result: measuredResult({ tradingNetUsd: "0.6" }),
          }),
        ],
      }),
    );
    expect(result.status).toBe("eligible");
    expect(result.validationWindows[0]).toMatchObject({
      netUsdPerDay: { numerator: "2", denominator: "5" },
      netReturnBpsPerDay: { numerator: "1000", denominator: "3" },
    });
  });

  it("returns an authority-free deterministic allowlist", () => {
    const authorityInput = {
      ...candidate(),
      executionAuthorized: true,
      trainWindows: candidate().trainWindows.map((window) => ({
        ...window!,
        executionAuthorized: true,
        cohort: { ...window!.cohort, executionAuthorized: true },
        result: { ...window!.result!, executionAuthorized: true },
      })),
    } as unknown as PaperProfitabilityHoldoutInput;
    const result = assessPaperProfitabilityHoldout(authorityInput);
    expect(Object.keys(result).sort()).toEqual(
      [
        "candidateId",
        "marketId",
        "collateralUsd",
        "cohort",
        "minimumTrainWindows",
        "minimumValidationWindows",
        "status",
        "reasons",
        "trainWindows",
        "validationWindows",
        "worstValidationWindow",
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toContain("executionAuthorized");
    expect(result).not.toHaveProperty("trainWindows.0.result");
  });
});
