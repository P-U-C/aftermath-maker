import { describe, expect, it } from "vitest";
import type { PaperProfitabilityEvidenceResult } from "../src/paper-profitability-evidence.js";
import {
  assessPaperProfitabilityStability,
  type PaperProfitabilityStabilityInput,
  type PaperProfitabilityStabilityWindow,
} from "../src/paper-profitability-stability.js";

const DAY_MS = 86_400_000;

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

function fixedWindow(
  overrides: Partial<PaperProfitabilityStabilityWindow> = {},
): PaperProfitabilityStabilityWindow {
  return {
    windowId: "window-a",
    windowStartAtMs: 0,
    windowEndAtMs: DAY_MS,
    result: measuredResult(),
    ...overrides,
  };
}

function candidate(
  overrides: Partial<PaperProfitabilityStabilityInput> = {},
): PaperProfitabilityStabilityInput {
  return {
    candidateId: "candidate-a",
    marketId: "ETH-USDC",
    collateralUsd: "100",
    minimumWindows: 3,
    windows: [
      fixedWindow(),
      fixedWindow({
        windowId: "window-b",
        windowStartAtMs: DAY_MS,
        windowEndAtMs: 2 * DAY_MS,
        result: measuredResult({ tradingNetUsd: "1" }),
      }),
      fixedWindow({
        windowId: "window-c",
        windowStartAtMs: 2 * DAY_MS,
        windowEndAtMs: 3 * DAY_MS,
        result: measuredResult({ tradingNetUsd: "3" }),
      }),
    ],
    ...overrides,
  };
}

describe("Paper profitability multi-window stability", () => {
  it("admits a Paper candidate only when every independent fixed window is complete, gap-free and strictly positive", () => {
    const eligible = assessPaperProfitabilityStability(
      candidate({
        windows: [...candidate().windows].reverse(),
      }),
    );

    expect(eligible.status).toBe("eligible");
    expect(eligible.reasons).toEqual([]);
    expect(eligible.windows.map((window) => window.windowId)).toEqual([
      "window-a",
      "window-b",
      "window-c",
    ]);
    expect(
      eligible.windows.every((window) => window.status === "positive"),
    ).toBe(true);
    expect(eligible.worstWindow).toEqual({
      windowId: "window-b",
      windowStartAtMs: DAY_MS,
      windowEndAtMs: 2 * DAY_MS,
      measurementWindowMs: DAY_MS,
      netUsdPerDay: { numerator: "1", denominator: "1" },
      netReturnBpsPerDay: { numerator: "100", denominator: "1" },
    });

    const withLoss = assessPaperProfitabilityStability(
      candidate({
        windows: [
          fixedWindow({ result: measuredResult({ tradingNetUsd: "1000" }) }),
          fixedWindow({
            windowId: "window-b",
            windowStartAtMs: DAY_MS,
            windowEndAtMs: 2 * DAY_MS,
            result: measuredResult({
              status: "non_positive",
              tradingNetUsd: "-0.1",
            }),
          }),
          fixedWindow({
            windowId: "window-c",
            windowStartAtMs: 2 * DAY_MS,
            windowEndAtMs: 3 * DAY_MS,
          }),
        ],
      }),
    );
    expect(withLoss.status).toBe("ineligible");
    expect(withLoss.reasons).toEqual(
      expect.arrayContaining([
        "result_not_positive",
        "non_positive_trading_net_usd",
      ]),
    );
    expect(withLoss.worstWindow?.windowId).toBe("window-b");
    expect(withLoss.worstWindow?.netReturnBpsPerDay).toEqual({
      numerator: "-10",
      denominator: "1",
    });
  });

  it("requires the exact minimum independent-window boundary", () => {
    const windows = candidate().windows.slice(0, 2);
    const result = assessPaperProfitabilityStability(
      candidate({ minimumWindows: 3, windows }),
    );

    expect(result.status).toBe("ineligible");
    expect(result.reasons).toContain("insufficient_windows");
  });

  it("does not average away zero or negative windows", () => {
    for (const tradingNetUsd of ["0", "-0.00000001"]) {
      const result = assessPaperProfitabilityStability(
        candidate({
          windows: candidate().windows.map((window, index) =>
            index === 1
              ? fixedWindow({
                  ...window,
                  result: measuredResult({
                    status: "non_positive",
                    tradingNetUsd,
                  }),
                })
              : window,
          ),
        }),
      );
      expect(result.status, tradingNetUsd).toBe("ineligible");
      expect(result.reasons, tradingNetUsd).toContain(
        "non_positive_trading_net_usd",
      );
    }
  });

  it("rejects gaps, incomplete components and incomplete samples in any window", () => {
    const evidenceGap = fixedWindow({
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
    });
    const profitabilityGap = fixedWindow({
      windowId: "window-b",
      windowStartAtMs: DAY_MS,
      windowEndAtMs: 2 * DAY_MS,
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
    });
    const incompleteSample = fixedWindow({
      windowId: "window-c",
      windowStartAtMs: 2 * DAY_MS,
      windowEndAtMs: 3 * DAY_MS,
      result: measuredResult({ sampleSize: 9, minimumSampleSize: 10 }),
    });
    const result = assessPaperProfitabilityStability(
      candidate({ windows: [evidenceGap, profitabilityGap, incompleteSample] }),
    );

    expect(result.status).toBe("ineligible");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "evidence_gaps_present",
        "profitability_gaps_present",
        "incomplete_sample",
      ]),
    );

    const partialComponents = assessPaperProfitabilityStability(
      candidate({
        windows: candidate().windows.map((window, index) =>
          index === 0
            ? fixedWindow({
                ...window,
                result: measuredResult({
                  components: {
                    ...measuredResult().components,
                    builderFees: { amountUsd: "0", coverage: "partial" },
                  },
                }),
              })
            : window,
        ),
      }),
    );
    expect(partialComponents.status).toBe("ineligible");
    expect(partialComponents.reasons).toContain("incomplete_components");
  });

  it("rejects duplicate IDs, duplicate intervals and every overlapping window", () => {
    const result = assessPaperProfitabilityStability(
      candidate({
        minimumWindows: 4,
        windows: [
          fixedWindow({ windowId: "duplicate" }),
          fixedWindow({
            windowId: "duplicate",
            windowStartAtMs: DAY_MS,
            windowEndAtMs: 2 * DAY_MS,
          }),
          fixedWindow({ windowId: "same-interval" }),
          fixedWindow({
            windowId: "overlap",
            windowStartAtMs: DAY_MS / 2,
            windowEndAtMs: DAY_MS + DAY_MS / 2,
          }),
        ],
      }),
    );

    expect(result.status).toBe("ineligible");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "duplicate_window_id",
        "duplicate_window_interval",
        "overlapping_windows",
      ]),
    );
    expect(
      result.windows.filter((window) =>
        window.reasons.includes("overlapping_windows"),
      ),
    ).toHaveLength(4);
  });

  it("fails closed for null or malformed windows, bounds and results", () => {
    const malformedResult = {
      ...fixedWindow({
        windowId: "malformed-result",
        windowStartAtMs: DAY_MS,
        windowEndAtMs: 2 * DAY_MS,
      }),
      result: { ...measuredResult(), components: {} },
    } as unknown as PaperProfitabilityStabilityWindow;
    const result = assessPaperProfitabilityStability(
      candidate({
        windows: [null, fixedWindow({ windowEndAtMs: 0 }), malformedResult],
      }),
    );

    expect(result.status).toBe("ineligible");
    expect(result.windows).toHaveLength(3);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "malformed_window",
        "invalid_window_bounds",
        "malformed_result",
      ]),
    );
    expect(
      result.windows.every((window) => window.status === "ineligible"),
    ).toBe(true);
  });

  it("rejects invalid IDs, collateral and minimum-window values", () => {
    for (const collateralUsd of [
      "0",
      "-1",
      "01",
      "+1",
      "1e3",
      "9".repeat(129),
    ]) {
      const result = assessPaperProfitabilityStability(
        candidate({ collateralUsd }),
      );
      expect(result.status, collateralUsd).toBe("ineligible");
      expect(result.reasons, collateralUsd).toContain(
        collateralUsd === "0" || collateralUsd === "-1"
          ? "non_positive_collateral_usd"
          : "invalid_collateral_usd",
      );
      expect(
        result.windows.every((window) => window.status === "ineligible"),
        collateralUsd,
      ).toBe(true);
    }
    expect(
      assessPaperProfitabilityStability(candidate({ candidateId: " " }))
        .reasons,
    ).toContain("invalid_candidate_id");
    expect(
      assessPaperProfitabilityStability(candidate({ marketId: "" })).reasons,
    ).toContain("invalid_market_id");
    for (const minimumWindows of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(
        assessPaperProfitabilityStability(candidate({ minimumWindows }))
          .reasons,
      ).toContain("invalid_minimum_windows");
    }
  });

  it("handles null candidates and Symbol identities without throwing or unstable comparison", () => {
    expect(() => assessPaperProfitabilityStability(null)).not.toThrow();
    const nullCandidate = assessPaperProfitabilityStability(null);
    expect(nullCandidate.status).toBe("ineligible");
    expect(nullCandidate.reasons).toContain("malformed_candidate");

    const symbolInput = {
      ...candidate(),
      candidateId: Symbol("candidate"),
      marketId: Symbol("market"),
      windows: candidate().windows.map((window, index) => ({
        ...window,
        windowId: Symbol(`window-${index}`),
      })),
    } as unknown as PaperProfitabilityStabilityInput;
    const result = assessPaperProfitabilityStability(symbolInput);
    expect(result.candidateId).toBeNull();
    expect(result.marketId).toBeNull();
    expect(result.windows.map((window) => window.windowId)).toEqual([
      null,
      null,
      null,
    ]);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "malformed_candidate",
        "invalid_candidate_id",
        "invalid_market_id",
        "malformed_window",
        "invalid_window_id",
      ]),
    );
  });

  it("computes exact repeating per-window ratios and deterministic worst-window ties", () => {
    const result = assessPaperProfitabilityStability(
      candidate({
        collateralUsd: "12",
        minimumWindows: 2,
        windows: [
          fixedWindow({
            windowId: "window-z",
            windowEndAtMs: 64_800_000,
            result: measuredResult({ tradingNetUsd: "0.3" }),
          }),
          fixedWindow({
            windowId: "window-a",
            windowStartAtMs: DAY_MS,
            windowEndAtMs: DAY_MS + 64_800_000,
            result: measuredResult({ tradingNetUsd: "0.3" }),
          }),
        ],
      }),
    );

    expect(result.status).toBe("eligible");
    expect(result.windows[0]).toMatchObject({
      windowId: "window-z",
      netUsdPerDay: { numerator: "2", denominator: "5" },
      netReturnBpsPerDay: { numerator: "1000", denominator: "3" },
    });
    expect(result.worstWindow?.windowId).toBe("window-z");
  });

  it("returns only explicit reporting fields and drops authority-shaped extras", () => {
    const authorityInput = {
      ...candidate(),
      executionAuthorized: true,
      routeToLive: "mainnet",
      windows: candidate().windows.map((window) => ({
        ...window,
        executionAuthorized: true,
        result: { ...window.result, executionAuthorized: true },
      })),
    } as unknown as PaperProfitabilityStabilityInput;
    const result = assessPaperProfitabilityStability(authorityInput);

    expect(Object.keys(result).sort()).toEqual(
      [
        "candidateId",
        "marketId",
        "collateralUsd",
        "minimumWindows",
        "status",
        "reasons",
        "windows",
        "worstWindow",
      ].sort(),
    );
    expect(Object.keys(result.windows[0]!).sort()).toEqual(
      [
        "windowId",
        "windowStartAtMs",
        "windowEndAtMs",
        "measurementWindowMs",
        "status",
        "reasons",
        "netUsdPerDay",
        "netReturnBpsPerDay",
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toContain("executionAuthorized");
    expect(JSON.stringify(result)).not.toContain("routeToLive");
    expect(result).not.toHaveProperty("windows.0.result");
  });
});
