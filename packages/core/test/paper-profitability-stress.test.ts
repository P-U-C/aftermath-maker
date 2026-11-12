import { describe, expect, it } from "vitest";
import type { PaperProfitabilityEvidenceResult } from "../src/paper-profitability-evidence.js";
import type { PaperProfitabilityStabilityWindow } from "../src/paper-profitability-stability.js";
import {
  assessPaperProfitabilityStress,
  type PaperProfitabilityStressInput,
  type PaperProfitabilityStressScenario,
} from "../src/paper-profitability-stress.js";

const DAY_MS = 86_400_000;

function measuredResult(
  tradingNetUsd = "2",
  overrides: Partial<PaperProfitabilityEvidenceResult> = {},
): PaperProfitabilityEvidenceResult {
  return {
    status: "positive",
    sampleSize: 10,
    minimumSampleSize: 10,
    components: {
      capturedMakerSpread: {
        amountUsd: tradingNetUsd,
        coverage: "complete",
      },
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
    tradingNetUsd,
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
    result: measuredResult("2"),
    ...overrides,
  };
}

function scenario(
  overrides: Partial<PaperProfitabilityStressScenario> = {},
): PaperProfitabilityStressScenario {
  return {
    scenarioId: "mild",
    label: "Mild Paper shock",
    shockUsd: "0.25",
    ...overrides,
  };
}

function candidate(
  overrides: Partial<PaperProfitabilityStressInput> = {},
): PaperProfitabilityStressInput {
  return {
    candidateId: "candidate-a",
    marketId: "ETH-USDC",
    collateralUsd: "100",
    minimumWindows: 3,
    windows: [
      fixedWindow({
        windowId: "window-c",
        windowStartAtMs: 2 * DAY_MS,
        windowEndAtMs: 3 * DAY_MS,
        result: measuredResult("3"),
      }),
      fixedWindow(),
      fixedWindow({
        windowId: "window-b",
        windowStartAtMs: DAY_MS,
        windowEndAtMs: 2 * DAY_MS,
        result: measuredResult("1"),
      }),
    ],
    scenarios: [
      scenario({
        scenarioId: "severe",
        label: "Severe Paper shock",
        shockUsd: "0.5",
      }),
      scenario(),
    ],
    ...overrides,
  };
}

describe("Paper profitability stress admission", () => {
  it("admits a Paper candidate only when every declared shock leaves every complete base window strictly positive", () => {
    const result = assessPaperProfitabilityStress(candidate());

    expect(result.status).toBe("eligible");
    expect(result.reasons).toEqual([]);
    expect(result.baseStabilityStatus).toBe("eligible");
    expect(result.baseStabilityReasons).toEqual([]);
    expect(result.scenarios.map((item) => item.scenarioId)).toEqual([
      "mild",
      "severe",
    ]);
    expect(
      result.scenarios.every(
        (item) =>
          item.status === "eligible" &&
          item.windows.every((window) => window.status === "positive"),
      ),
    ).toBe(true);
    expect(result.scenarios[1]?.windows[1]).toMatchObject({
      windowId: "window-b",
      baseTradingNetUsd: "1",
      stressedNetUsd: "0.5",
      netUsdPerDay: { numerator: "1", denominator: "2" },
      netReturnBpsPerDay: { numerator: "50", denominator: "1" },
    });
    expect(result.worstCase).toEqual({
      scenarioId: "severe",
      label: "Severe Paper shock",
      shockUsd: "0.5",
      windowId: "window-b",
      windowStartAtMs: DAY_MS,
      windowEndAtMs: 2 * DAY_MS,
      measurementWindowMs: DAY_MS,
      baseTradingNetUsd: "1",
      stressedNetUsd: "0.5",
      netUsdPerDay: { numerator: "1", denominator: "2" },
      netReturnBpsPerDay: { numerator: "50", denominator: "1" },
    });
  });

  it("subtracts each shock exactly and returns deterministic bigint ratios and ordering", () => {
    const exactInput = candidate({
      collateralUsd: "12",
      minimumWindows: 2,
      windows: [
        fixedWindow({
          windowId: "window-a",
          windowStartAtMs: DAY_MS,
          windowEndAtMs: DAY_MS + 64_800_000,
          result: measuredResult("0.3"),
        }),
        fixedWindow({
          windowId: "window-z",
          windowEndAtMs: 64_800_000,
          result: measuredResult("0.3"),
        }),
      ],
      scenarios: [
        scenario({
          scenarioId: "zero",
          label: "No Paper shock",
          shockUsd: "0",
        }),
        scenario({
          scenarioId: "fractional",
          label: "Fractional Paper shock",
          shockUsd: "0.1",
        }),
      ],
    });
    const first = assessPaperProfitabilityStress(exactInput);
    const permuted = assessPaperProfitabilityStress({
      ...exactInput,
      windows: [...exactInput.windows].reverse(),
      scenarios: [...exactInput.scenarios].reverse(),
    });

    expect(permuted).toEqual(first);
    expect(first.scenarios.map((item) => item.scenarioId)).toEqual([
      "fractional",
      "zero",
    ]);
    expect(
      first.scenarios[0]?.windows.map((window) => window.windowId),
    ).toEqual(["window-z", "window-a"]);
    expect(first.scenarios[0]?.windows[0]).toMatchObject({
      baseTradingNetUsd: "0.3",
      stressedNetUsd: "0.2",
      netUsdPerDay: { numerator: "4", denominator: "15" },
      netReturnBpsPerDay: { numerator: "2000", denominator: "9" },
    });
  });

  it("fails closed when base stability has gaps, incomplete evidence or duplicate windows", () => {
    const evidenceGap = {
      component: "fills" as const,
      reason: "empty_fill_sample" as const,
      sourceEventKey: null,
      orderKey: null,
      horizonMs: null,
    };
    const cases: readonly [PaperProfitabilityStabilityWindow, string][] = [
      [
        fixedWindow({
          result: measuredResult("2", { evidenceGaps: [evidenceGap] }),
        }),
        "evidence_gaps_present",
      ],
      [
        fixedWindow({
          result: measuredResult("2", {
            components: {
              ...measuredResult().components,
              gas: { amountUsd: "0", coverage: "partial" },
            },
          }),
        }),
        "incomplete_components",
      ],
      [
        fixedWindow({
          result: measuredResult("2", {
            sampleSize: 9,
            minimumSampleSize: 10,
          }),
        }),
        "incomplete_sample",
      ],
    ];

    for (const [badWindow, expectedReason] of cases) {
      const result = assessPaperProfitabilityStress(
        candidate({
          windows: [
            badWindow,
            candidate().windows[1]!,
            candidate().windows[2]!,
          ],
        }),
      );
      expect(result.status, expectedReason).toBe("ineligible");
      expect(result.reasons, expectedReason).toContain(
        "base_stability_ineligible",
      );
      expect(result.baseStabilityReasons, expectedReason).toContain(
        expectedReason,
      );
      expect(
        result.scenarios.every((item) => item.status === "ineligible"),
        expectedReason,
      ).toBe(true);
    }

    const duplicateWindows = assessPaperProfitabilityStress(
      candidate({
        windows: [
          fixedWindow({ windowId: "duplicate" }),
          fixedWindow({
            windowId: "duplicate",
            windowStartAtMs: DAY_MS,
            windowEndAtMs: 2 * DAY_MS,
          }),
          candidate().windows[0]!,
        ],
      }),
    );
    expect(duplicateWindows.status).toBe("ineligible");
    expect(duplicateWindows.baseStabilityReasons).toContain(
      "duplicate_window_id",
    );
  });

  it("does not average away a zero or negative stressed window", () => {
    for (const shockUsd of ["1", "1.25"]) {
      const result = assessPaperProfitabilityStress(
        candidate({
          scenarios: [
            scenario({
              scenarioId: `shock-${shockUsd}`,
              shockUsd,
            }),
          ],
        }),
      );
      expect(result.status, shockUsd).toBe("ineligible");
      expect(result.reasons, shockUsd).toContain(
        "non_positive_stressed_net_usd",
      );
      expect(result.scenarios[0]?.status, shockUsd).toBe("ineligible");
      expect(
        result.scenarios[0]?.windows.find(
          (window) => window.windowId === "window-b",
        ),
        shockUsd,
      ).toMatchObject({
        status: "ineligible",
        reasons: ["non_positive_stressed_net_usd"],
        stressedNetUsd: shockUsd === "1" ? "0" : "-0.25",
      });
    }
  });

  it("rejects invalid, negative and overlong shock decimals without defaulting them to zero", () => {
    for (const [shockUsd, expectedReason] of [
      ["-0.01", "negative_shock_usd"],
      ["-0", "negative_shock_usd"],
      ["+1", "invalid_shock_usd"],
      ["01", "invalid_shock_usd"],
      ["1e2", "invalid_shock_usd"],
      ["9".repeat(129), "invalid_shock_usd"],
    ] as const) {
      const result = assessPaperProfitabilityStress(
        candidate({ scenarios: [scenario({ shockUsd })] }),
      );
      expect(result.status, shockUsd).toBe("ineligible");
      expect(result.reasons, shockUsd).toContain(expectedReason);
      expect(result.scenarios[0]?.reasons, shockUsd).toContain(expectedReason);
      expect(
        result.scenarios[0]?.windows.every(
          (window) =>
            window.stressedNetUsd === null &&
            window.netUsdPerDay === null &&
            window.netReturnBpsPerDay === null,
        ),
        shockUsd,
      ).toBe(true);
    }
  });

  it("requires at least one uniquely identified, labelled scenario", () => {
    const empty = assessPaperProfitabilityStress(candidate({ scenarios: [] }));
    expect(empty.status).toBe("ineligible");
    expect(empty.reasons).toContain("empty_scenarios");

    const malformed = assessPaperProfitabilityStress({
      ...candidate(),
      scenarios: null,
    } as unknown as PaperProfitabilityStressInput);
    expect(malformed.status).toBe("ineligible");
    expect(malformed.reasons).toContain("malformed_scenarios");

    const duplicate = assessPaperProfitabilityStress(
      candidate({
        scenarios: [
          scenario({ scenarioId: "duplicate", label: "First" }),
          scenario({ scenarioId: "duplicate", label: "Second" }),
        ],
      }),
    );
    expect(duplicate.status).toBe("ineligible");
    expect(duplicate.reasons).toContain("duplicate_scenario_id");
    expect(
      duplicate.scenarios.every((item) =>
        item.reasons.includes("duplicate_scenario_id"),
      ),
    ).toBe(true);

    const blankLabel = assessPaperProfitabilityStress(
      candidate({ scenarios: [scenario({ label: " " })] }),
    );
    expect(blankLabel.reasons).toContain("invalid_scenario_label");
  });

  it("handles null and Symbol-shaped runtime rows without throwing or comparing symbols", () => {
    expect(() => assessPaperProfitabilityStress(null)).not.toThrow();
    const nullResult = assessPaperProfitabilityStress(null);
    expect(nullResult.status).toBe("ineligible");
    expect(nullResult.reasons).toEqual(
      expect.arrayContaining([
        "malformed_candidate",
        "malformed_scenarios",
        "base_stability_ineligible",
      ]),
    );

    const symbolInput = {
      ...candidate(),
      candidateId: Symbol("candidate"),
      marketId: Symbol("market"),
      windows: candidate().windows.map((window) => ({
        ...window,
        windowId: Symbol("window"),
      })),
      scenarios: [
        null,
        {
          scenarioId: Symbol("scenario"),
          label: Symbol("label"),
          shockUsd: Symbol("shock"),
        },
      ],
    } as unknown as PaperProfitabilityStressInput;
    expect(() => assessPaperProfitabilityStress(symbolInput)).not.toThrow();
    const result = assessPaperProfitabilityStress(symbolInput);
    expect(result.candidateId).toBeNull();
    expect(result.marketId).toBeNull();
    expect(result.status).toBe("ineligible");
    expect(result.scenarios).toHaveLength(2);
    expect(
      result.scenarios.every(
        (item) =>
          item.scenarioId === null &&
          item.label === null &&
          item.shockUsd === null,
      ),
    ).toBe(true);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "malformed_candidate",
        "invalid_candidate_id",
        "invalid_market_id",
        "malformed_scenario",
        "invalid_scenario_id",
        "invalid_scenario_label",
        "invalid_shock_usd",
      ]),
    );
  });

  it("rejects invalid candidate identity and collateral through the base stability contract", () => {
    for (const input of [
      candidate({ candidateId: " " }),
      candidate({ marketId: "" }),
      candidate({ collateralUsd: "0" }),
      candidate({ collateralUsd: "9".repeat(129) }),
    ]) {
      const result = assessPaperProfitabilityStress(input);
      expect(result.status).toBe("ineligible");
      expect(result.reasons).toContain("base_stability_ineligible");
      expect(result.baseStabilityReasons.length).toBeGreaterThan(0);
    }
  });

  it("keeps every scenario ineligible when the base stability evidence has no windows", () => {
    const result = assessPaperProfitabilityStress(
      candidate({
        candidateId: "",
        windows: [],
        scenarios: [scenario()],
      }),
    );

    expect(result.status).toBe("ineligible");
    expect(result.baseStabilityStatus).toBe("ineligible");
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0]?.status).toBe("ineligible");
    expect(result.scenarios[0]?.reasons).toEqual(
      expect.arrayContaining([
        "base_stability_ineligible",
        "invalid_candidate_id",
      ]),
    );
  });

  it("fails closed for sparse runtime windows and scenario arrays", () => {
    const sparseWindows = new Array(candidate().windows.length);
    sparseWindows[0] = candidate().windows[0];
    const sparseScenarios = new Array(2);
    sparseScenarios[1] = scenario({ scenarioId: "sparse" });

    expect(() =>
      assessPaperProfitabilityStress({
        ...candidate(),
        windows: sparseWindows,
        scenarios: sparseScenarios,
      } as unknown as PaperProfitabilityStressInput),
    ).not.toThrow();
    const result = assessPaperProfitabilityStress({
      ...candidate(),
      windows: sparseWindows,
      scenarios: sparseScenarios,
    } as unknown as PaperProfitabilityStressInput);
    expect(result.status).toBe("ineligible");
    expect(result.scenarios).toHaveLength(2);
    expect(result.scenarios.every((item) => item.status === "ineligible")).toBe(
      true,
    );
  });

  it("returns an explicit reporting allowlist and drops execution, provider and authority extras", () => {
    const authorityInput = {
      ...candidate(),
      executionAuthorized: true,
      routeToLive: "mainnet",
      providerEvidence: { receipt: "not-evidence" },
      windows: candidate().windows.map((window) => ({
        ...window,
        executionAuthorized: true,
        result: { ...window.result, routeToLive: true },
      })),
      scenarios: candidate().scenarios.map((item) => ({
        ...item,
        executionAuthorized: true,
        providerReceipt: "not-evidence",
      })),
    } as unknown as PaperProfitabilityStressInput;
    const result = assessPaperProfitabilityStress(authorityInput);

    expect(Object.keys(result).sort()).toEqual(
      [
        "candidateId",
        "marketId",
        "collateralUsd",
        "minimumWindows",
        "baseStabilityStatus",
        "baseStabilityReasons",
        "status",
        "reasons",
        "scenarios",
        "worstCase",
      ].sort(),
    );
    expect(Object.keys(result.scenarios[0]!).sort()).toEqual(
      [
        "scenarioId",
        "label",
        "shockUsd",
        "status",
        "reasons",
        "windows",
      ].sort(),
    );
    expect(Object.keys(result.scenarios[0]!.windows[0]!).sort()).toEqual(
      [
        "windowId",
        "windowStartAtMs",
        "windowEndAtMs",
        "measurementWindowMs",
        "baseTradingNetUsd",
        "stressedNetUsd",
        "status",
        "reasons",
        "netUsdPerDay",
        "netReturnBpsPerDay",
      ].sort(),
    );
    expect(Object.keys(result.worstCase!).sort()).toEqual(
      [
        "scenarioId",
        "label",
        "shockUsd",
        "windowId",
        "windowStartAtMs",
        "windowEndAtMs",
        "measurementWindowMs",
        "baseTradingNetUsd",
        "stressedNetUsd",
        "netUsdPerDay",
        "netReturnBpsPerDay",
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toContain("executionAuthorized");
    expect(JSON.stringify(result)).not.toContain("routeToLive");
    expect(JSON.stringify(result)).not.toContain("provider");
    expect(JSON.stringify(result)).not.toContain("receipt");
    expect(result.scenarios[0]!.windows[0]).not.toHaveProperty("result");
  });
});
