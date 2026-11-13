import { describe, expect, it } from "vitest";
import type {
  PaperProfitabilityStressResult,
  PaperProfitabilityStressScenarioResult,
  PaperProfitabilityStressWindowResult,
} from "../src/paper-profitability-stress.js";
import {
  assessPaperProfitabilityCapacity,
  type PaperProfitabilityCapacityInput,
  type PaperProfitabilityCapacityWindow,
} from "../src/paper-profitability-capacity.js";

const DAY_MS = 86_400_000;

function stressWindow(
  overrides: Partial<PaperProfitabilityStressWindowResult> = {},
): PaperProfitabilityStressWindowResult {
  return {
    windowId: "window-a",
    windowStartAtMs: 0,
    windowEndAtMs: DAY_MS,
    measurementWindowMs: DAY_MS,
    baseTradingNetUsd: "10",
    stressedNetUsd: "8",
    status: "positive",
    reasons: [],
    netUsdPerDay: { numerator: "8", denominator: "1" },
    netReturnBpsPerDay: { numerator: "80", denominator: "1" },
    ...overrides,
  };
}

function stressScenario(
  overrides: Partial<PaperProfitabilityStressScenarioResult> = {},
): PaperProfitabilityStressScenarioResult {
  return {
    scenarioId: "mild",
    label: "Mild Paper shock",
    shockUsd: "2",
    status: "eligible",
    reasons: [],
    windows: [
      stressWindow({
        windowId: "window-b",
        windowStartAtMs: DAY_MS,
        windowEndAtMs: 2 * DAY_MS,
      }),
      stressWindow(),
    ],
    ...overrides,
  };
}

function stressResult(
  overrides: Partial<PaperProfitabilityStressResult> = {},
): PaperProfitabilityStressResult {
  return {
    candidateId: "candidate-a",
    marketId: "ETH-USDC",
    collateralUsd: "1000",
    minimumWindows: 2,
    baseStabilityStatus: "eligible",
    baseStabilityReasons: [],
    status: "eligible",
    reasons: [],
    scenarios: [
      stressScenario({
        scenarioId: "severe",
        label: "Severe Paper shock",
        shockUsd: "4",
        windows: [
          stressWindow({
            windowId: "window-b",
            windowStartAtMs: DAY_MS,
            windowEndAtMs: 2 * DAY_MS,
            stressedNetUsd: "6",
          }),
          stressWindow({ stressedNetUsd: "6" }),
        ],
      }),
      stressScenario(),
    ],
    worstCase: null,
    ...overrides,
  };
}

function capacityWindow(
  overrides: Partial<PaperProfitabilityCapacityWindow> = {},
): PaperProfitabilityCapacityWindow {
  return {
    windowId: "window-a",
    exposureUsd: "200",
    ...overrides,
  };
}

function candidate(
  overrides: Partial<PaperProfitabilityCapacityInput> = {},
): PaperProfitabilityCapacityInput {
  return {
    stressResult: stressResult(),
    maxAllocationBps: 2500,
    windows: [
      capacityWindow({ windowId: "window-b", exposureUsd: "250" }),
      capacityWindow(),
    ],
    ...overrides,
  };
}

describe("Paper profitability capacity admission", () => {
  it("admits only when eligible Paper evidence keeps every declared window exposure within the exact allocation budget", () => {
    const result = assessPaperProfitabilityCapacity(candidate());

    expect(result.status).toBe("eligible");
    expect(result.reasons).toEqual([]);
    expect(result.baseStatus).toBe("eligible");
    expect(result.stressStatus).toBe("eligible");
    expect(result.maxAllocatedUsd).toBe("250");
    expect(result.windows.map((window) => window.windowId)).toEqual([
      "window-a",
      "window-b",
    ]);
    expect(result.windows).toEqual([
      {
        windowId: "window-a",
        exposureUsd: "200",
        maxAllocatedUsd: "250",
        remainingCapacityUsd: "50",
        status: "within_budget",
        reasons: [],
      },
      {
        windowId: "window-b",
        exposureUsd: "250",
        maxAllocatedUsd: "250",
        remainingCapacityUsd: "0",
        status: "within_budget",
        reasons: [],
      },
    ]);
  });

  it("computes the exact collateral-times-BPS boundary without Number money math", () => {
    const exact = assessPaperProfitabilityCapacity(
      candidate({
        stressResult: stressResult({ collateralUsd: "12.34" }),
        maxAllocationBps: 3333,
        windows: [
          capacityWindow({
            windowId: "window-b",
            exposureUsd: "4.112922",
          }),
          capacityWindow({
            windowId: "window-a",
            exposureUsd: "4.1",
          }),
        ],
      }),
    );

    expect(exact.status).toBe("eligible");
    expect(exact.maxAllocatedUsd).toBe("4.112922");
    expect(exact.windows[0]).toMatchObject({
      remainingCapacityUsd: "0.012922",
      status: "within_budget",
    });
    expect(exact.windows[1]).toMatchObject({
      remainingCapacityUsd: "0",
      status: "within_budget",
    });

    const oneUnitOver = assessPaperProfitabilityCapacity(
      candidate({
        stressResult: stressResult({ collateralUsd: "12.34" }),
        maxAllocationBps: 3333,
        windows: [
          capacityWindow({
            windowId: "window-b",
            exposureUsd: "4.112923",
          }),
          capacityWindow(),
        ],
      }),
    );
    expect(oneUnitOver.status).toBe("ineligible");
    expect(oneUnitOver.reasons).toContain("exposure_above_budget");
    expect(oneUnitOver.windows[1]).toMatchObject({
      windowId: "window-b",
      remainingCapacityUsd: "-0.000001",
      status: "ineligible",
      reasons: ["exposure_above_budget"],
    });
  });

  it("requires a positive safe-integer allocation BPS no greater than 10000", () => {
    for (const maxAllocationBps of [
      0,
      -1,
      1.5,
      10_001,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const result = assessPaperProfitabilityCapacity(
        candidate({ maxAllocationBps }),
      );
      expect(result.status, String(maxAllocationBps)).toBe("ineligible");
      expect(result.reasons, String(maxAllocationBps)).toContain(
        "invalid_max_allocation_bps",
      );
      expect(result.maxAllocatedUsd, String(maxAllocationBps)).toBeNull();
    }

    const symbol = assessPaperProfitabilityCapacity({
      ...candidate(),
      maxAllocationBps: Symbol("bps"),
    } as unknown as PaperProfitabilityCapacityInput);
    expect(symbol.reasons).toContain("invalid_max_allocation_bps");

    const full = assessPaperProfitabilityCapacity(
      candidate({
        maxAllocationBps: 10_000,
        windows: [
          capacityWindow({ windowId: "window-b", exposureUsd: "1000" }),
          capacityWindow({ exposureUsd: "1000" }),
        ],
      }),
    );
    expect(full.status).toBe("eligible");
    expect(full.maxAllocatedUsd).toBe("1000");
  });

  it("requires valid positive collateral and nonempty candidate identities", () => {
    for (const collateralUsd of [
      "0",
      "-1",
      "+1",
      "01",
      "1e3",
      "9".repeat(129),
    ]) {
      const result = assessPaperProfitabilityCapacity(
        candidate({ stressResult: stressResult({ collateralUsd }) }),
      );
      expect(result.status, collateralUsd).toBe("ineligible");
      expect(result.reasons, collateralUsd).toContain(
        collateralUsd === "0" || collateralUsd === "-1"
          ? "non_positive_collateral_usd"
          : "invalid_collateral_usd",
      );
    }

    expect(
      assessPaperProfitabilityCapacity(
        candidate({ stressResult: stressResult({ candidateId: " " }) }),
      ).reasons,
    ).toContain("invalid_candidate_id");
    expect(
      assessPaperProfitabilityCapacity(
        candidate({ stressResult: stressResult({ marketId: "" }) }),
      ).reasons,
    ).toContain("invalid_market_id");
  });

  it("fails closed unless base, stress, every scenario and every evidence window are complete and positive", () => {
    const baseIneligible = assessPaperProfitabilityCapacity(
      candidate({
        stressResult: stressResult({
          baseStabilityStatus: "ineligible",
          baseStabilityReasons: ["evidence_gaps_present"],
        }),
      }),
    );
    expect(baseIneligible.reasons).toEqual(
      expect.arrayContaining(["base_not_eligible", "stress_gaps_present"]),
    );

    const stressIneligible = assessPaperProfitabilityCapacity(
      candidate({
        stressResult: stressResult({
          status: "ineligible",
          reasons: ["non_positive_stressed_net_usd"],
        }),
      }),
    );
    expect(stressIneligible.reasons).toEqual(
      expect.arrayContaining(["stress_not_eligible", "stress_gaps_present"]),
    );

    const scenarioIneligible = assessPaperProfitabilityCapacity(
      candidate({
        stressResult: stressResult({
          scenarios: [
            stressScenario({
              status: "ineligible",
              reasons: ["non_positive_stressed_net_usd"],
            }),
          ],
        }),
      }),
    );
    expect(scenarioIneligible.reasons).toContain(
      "stress_scenario_not_eligible",
    );

    const windowIneligible = assessPaperProfitabilityCapacity(
      candidate({
        stressResult: stressResult({
          scenarios: [
            stressScenario({
              windows: [
                stressWindow({
                  status: "ineligible",
                  reasons: ["non_positive_stressed_net_usd"],
                  stressedNetUsd: "0",
                }),
                stressWindow({
                  windowId: "window-b",
                  windowStartAtMs: DAY_MS,
                  windowEndAtMs: 2 * DAY_MS,
                }),
              ],
            }),
          ],
        }),
      }),
    );
    expect(windowIneligible.reasons).toContain("stress_window_not_positive");
  });

  it("requires every stress scenario to retain its declared label and shock", () => {
    for (const overrides of [
      { label: undefined },
      { label: " " },
      { shockUsd: undefined },
      { shockUsd: "-1" },
      { shockUsd: "1e2" },
    ] as const) {
      const result = assessPaperProfitabilityCapacity(
        candidate({
          stressResult: stressResult({
            scenarios: [stressScenario(overrides as never)],
          }),
        }),
      );
      expect(result.status, JSON.stringify(overrides)).toBe("ineligible");
      expect(result.reasons, JSON.stringify(overrides)).toContain(
        "malformed_stress_scenario",
      );
      expect(result.reasons, JSON.stringify(overrides)).toContain(
        "incomplete_stress_evidence",
      );
    }
  });

  it("keeps malformed reason arrays deterministic when evidence order changes", () => {
    const scenarioFailure = stressScenario({
      scenarioId: "failure",
      status: "ineligible",
      reasons: ["non_positive_stressed_net_usd"],
    });
    const scenarioMalformed = stressScenario({
      scenarioId: "malformed",
      label: " ",
    });
    const first = assessPaperProfitabilityCapacity(
      candidate({
        stressResult: stressResult({
          scenarios: [scenarioFailure, scenarioMalformed],
        }),
        windows: [
          capacityWindow({ windowId: "window-a", exposureUsd: "-1" }),
          capacityWindow({ windowId: "window-b", exposureUsd: "+1" }),
        ],
      }),
    );
    const second = assessPaperProfitabilityCapacity(
      candidate({
        stressResult: stressResult({
          scenarios: [scenarioMalformed, scenarioFailure],
        }),
        windows: [
          capacityWindow({ windowId: "window-b", exposureUsd: "+1" }),
          capacityWindow({ windowId: "window-a", exposureUsd: "-1" }),
        ],
      }),
    );

    expect(first.reasons).toEqual(second.reasons);
    expect(first.windows.map((window) => window.reasons)).toEqual(
      second.windows.map((window) => window.reasons),
    );
    expect(first.reasons).toEqual([...first.reasons].sort());
    for (const window of first.windows) {
      expect(window.reasons).toEqual([...window.reasons].sort());
    }
  });

  it("rejects missing, unmatched, duplicate and sparse exposure windows", () => {
    const missing = assessPaperProfitabilityCapacity(
      candidate({ windows: [capacityWindow()] }),
    );
    expect(missing.reasons).toContain("missing_window_exposure");

    const unmatched = assessPaperProfitabilityCapacity(
      candidate({
        windows: [
          capacityWindow(),
          capacityWindow({ windowId: "window-b" }),
          capacityWindow({ windowId: "window-extra" }),
        ],
      }),
    );
    expect(unmatched.reasons).toContain("unmatched_window_id");

    const duplicate = assessPaperProfitabilityCapacity(
      candidate({
        windows: [
          capacityWindow(),
          capacityWindow({ exposureUsd: "10" }),
          capacityWindow({ windowId: "window-b" }),
        ],
      }),
    );
    expect(duplicate.reasons).toContain("duplicate_window_id");
    expect(
      duplicate.windows.filter((window) =>
        window.reasons.includes("duplicate_window_id"),
      ),
    ).toHaveLength(2);

    const sparseWindows = new Array(2) as PaperProfitabilityCapacityWindow[];
    sparseWindows[1] = capacityWindow({ windowId: "window-b" });
    const sparse = assessPaperProfitabilityCapacity(
      candidate({ windows: sparseWindows }),
    );
    expect(sparse.reasons).toEqual(
      expect.arrayContaining(["sparse_windows", "missing_window_exposure"]),
    );
  });

  it("rejects missing, malformed, negative and overlong exposures instead of defaulting them to zero", () => {
    for (const [exposureUsd, expectedReason] of [
      ["-0.01", "negative_exposure_usd"],
      ["+1", "invalid_exposure_usd"],
      ["01", "invalid_exposure_usd"],
      ["1e2", "invalid_exposure_usd"],
      ["9".repeat(129), "invalid_exposure_usd"],
    ] as const) {
      const result = assessPaperProfitabilityCapacity(
        candidate({
          windows: [
            capacityWindow({ exposureUsd }),
            capacityWindow({ windowId: "window-b" }),
          ],
        }),
      );
      expect(result.status, exposureUsd).toBe("ineligible");
      expect(result.reasons, exposureUsd).toContain(expectedReason);
      expect(result.windows[0]?.remainingCapacityUsd, exposureUsd).toBeNull();
    }

    const malformed = assessPaperProfitabilityCapacity({
      ...candidate(),
      windows: [
        null,
        {
          windowId: Symbol("window"),
          exposureUsd: Symbol("exposure"),
        },
      ],
    } as unknown as PaperProfitabilityCapacityInput);
    expect(malformed.reasons).toEqual(
      expect.arrayContaining([
        "malformed_window",
        "invalid_window_id",
        "invalid_exposure_usd",
      ]),
    );
  });

  it("rejects duplicate or inconsistent stress evidence window identities", () => {
    const duplicateStress = assessPaperProfitabilityCapacity(
      candidate({
        stressResult: stressResult({
          scenarios: [
            stressScenario({
              windows: [
                stressWindow(),
                stressWindow({ exposureUsd: undefined } as never),
              ],
            }),
          ],
        }),
      }),
    );
    expect(duplicateStress.reasons).toContain("duplicate_stress_window_id");

    const inconsistent = assessPaperProfitabilityCapacity(
      candidate({
        stressResult: stressResult({
          scenarios: [
            stressScenario({ scenarioId: "mild" }),
            stressScenario({
              scenarioId: "severe",
              windows: [
                stressWindow({ windowEndAtMs: DAY_MS / 2 }),
                stressWindow({
                  windowId: "window-b",
                  windowStartAtMs: DAY_MS,
                  windowEndAtMs: 2 * DAY_MS,
                }),
              ],
            }),
          ],
        }),
      }),
    );
    expect(inconsistent.reasons).toContain("inconsistent_stress_window");
  });

  it("handles null, Symbol and sparse stress runtime structures without throwing", () => {
    expect(() => assessPaperProfitabilityCapacity(null)).not.toThrow();
    const nullResult = assessPaperProfitabilityCapacity(null);
    expect(nullResult.status).toBe("ineligible");
    expect(nullResult.reasons).toEqual(
      expect.arrayContaining([
        "malformed_input",
        "malformed_stress_result",
        "malformed_windows",
      ]),
    );

    const sparseScenarios = new Array(
      2,
    ) as PaperProfitabilityStressScenarioResult[];
    sparseScenarios[1] = stressScenario();
    const symbolInput = {
      ...candidate(),
      stressResult: {
        ...stressResult(),
        candidateId: Symbol("candidate"),
        marketId: Symbol("market"),
        collateralUsd: Symbol("collateral"),
        scenarios: sparseScenarios,
      },
    } as unknown as PaperProfitabilityCapacityInput;
    expect(() => assessPaperProfitabilityCapacity(symbolInput)).not.toThrow();
    const result = assessPaperProfitabilityCapacity(symbolInput);
    expect(result.candidateId).toBeNull();
    expect(result.marketId).toBeNull();
    expect(result.collateralUsd).toBeNull();
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "invalid_candidate_id",
        "invalid_market_id",
        "invalid_collateral_usd",
        "sparse_stress_evidence",
      ]),
    );
  });

  it("sorts deterministically and returns only an authority-free reporting allowlist", () => {
    const clean = candidate();
    const authorityInput = {
      ...clean,
      executionAuthorized: true,
      routeToLive: "mainnet",
      providerReceipt: "not-evidence",
      stressResult: {
        ...clean.stressResult,
        executionAuthorized: true,
        scenarios: [...clean.stressResult!.scenarios].reverse().map((item) => ({
          ...item,
          providerReceipt: "not-evidence",
          windows: [...item.windows].reverse().map((window) => ({
            ...window,
            routeToLive: true,
          })),
        })),
      },
      windows: [...clean.windows].reverse().map((window) => ({
        ...window!,
        executionAuthorized: true,
      })),
    } as unknown as PaperProfitabilityCapacityInput;
    const result = assessPaperProfitabilityCapacity(authorityInput);
    const baseline = assessPaperProfitabilityCapacity(clean);

    expect(result).toEqual(baseline);
    expect(Object.keys(result).sort()).toEqual(
      [
        "candidateId",
        "marketId",
        "collateralUsd",
        "maxAllocationBps",
        "maxAllocatedUsd",
        "baseStatus",
        "stressStatus",
        "status",
        "reasons",
        "windows",
      ].sort(),
    );
    expect(Object.keys(result.windows[0]!).sort()).toEqual(
      [
        "windowId",
        "exposureUsd",
        "maxAllocatedUsd",
        "remainingCapacityUsd",
        "status",
        "reasons",
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toContain("executionAuthorized");
    expect(JSON.stringify(result)).not.toContain("routeToLive");
    expect(JSON.stringify(result)).not.toContain("provider");
    expect(JSON.stringify(result)).not.toContain("receipt");
    expect(result).not.toHaveProperty("stressResult");
  });
});
