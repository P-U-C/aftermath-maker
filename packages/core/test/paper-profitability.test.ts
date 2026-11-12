import { describe, expect, it } from "vitest";
import {
  decomposePaperProfitability,
  type PaperProfitabilityInput,
} from "../src/paper-profitability.js";

function completeEvidence(
  overrides: Partial<PaperProfitabilityInput> = {},
): PaperProfitabilityInput {
  return {
    sampleSize: 12,
    minimumSampleSize: 10,
    components: {
      capturedMakerSpread: { amountUsd: "1.50", coverage: "complete" },
      makerCredit: { amountUsd: "0.20", coverage: "complete" },
      builderFees: { amountUsd: "0.10", coverage: "complete" },
      venueFees: { amountUsd: "0.05", coverage: "complete" },
      adverseFixedHorizonMarkout: {
        amountUsd: "0.25",
        coverage: "complete",
      },
      carryAndFundingNet: { amountUsd: "-0.10", coverage: "complete" },
      hedgeAndUnwindNet: { amountUsd: "-0.15", coverage: "complete" },
      gas: { amountUsd: "0.05", coverage: "complete" },
    },
    rewardsUsd: null,
    transfersUsd: null,
    ...overrides,
  };
}

describe("Paper profitability decomposition", () => {
  it("returns unavailable with an explicit gap when a component is missing", () => {
    const input = completeEvidence({
      components: {
        ...completeEvidence().components,
        gas: { amountUsd: null, coverage: "unavailable" },
      },
    });

    expect(decomposePaperProfitability(input)).toMatchObject({
      status: "unavailable",
      tradingNetUsd: null,
      gaps: [
        { component: "gas", reason: "missing_amount" },
        {
          component: "gas",
          reason: "coverage_incomplete",
          coverage: "unavailable",
        },
      ],
    });
  });

  it("returns unavailable for partial component coverage", () => {
    const input = completeEvidence({
      components: {
        ...completeEvidence().components,
        adverseFixedHorizonMarkout: {
          amountUsd: "0.25",
          coverage: "partial",
        },
      },
    });

    expect(decomposePaperProfitability(input)).toMatchObject({
      status: "unavailable",
      tradingNetUsd: null,
      gaps: [
        {
          component: "adverseFixedHorizonMarkout",
          reason: "coverage_incomplete",
          coverage: "partial",
        },
      ],
    });
  });

  it("reports a complete negative sample as non-positive", () => {
    const input = completeEvidence({
      components: {
        ...completeEvidence().components,
        adverseFixedHorizonMarkout: {
          amountUsd: "2.40",
          coverage: "complete",
        },
      },
    });

    expect(decomposePaperProfitability(input)).toMatchObject({
      status: "non_positive",
      tradingNetUsd: "-1.15",
      gaps: [],
    });
  });

  it("reports rewards and transfers but excludes them from trading net", () => {
    const baseline = decomposePaperProfitability(completeEvidence());
    const withExcludedAmounts = decomposePaperProfitability(
      completeEvidence({
        rewardsUsd: "999999.0000",
        transfersUsd: "-250000.500",
      }),
    );

    expect(withExcludedAmounts).toMatchObject({
      status: "positive",
      tradingNetUsd: baseline.tradingNetUsd,
      excluded: {
        rewardsUsd: "999999.0000",
        transfersUsd: "-250000.500",
      },
    });
  });

  it("preserves source decimal strings and computes beyond float precision", () => {
    const result = decomposePaperProfitability(
      completeEvidence({
        components: {
          capturedMakerSpread: {
            amountUsd: "0.123456789012345678901",
            coverage: "complete",
          },
          makerCredit: {
            amountUsd: "0.000000000000000000009",
            coverage: "complete",
          },
          builderFees: {
            amountUsd: "0.000000000000000000001",
            coverage: "complete",
          },
          venueFees: {
            amountUsd: "0.000000000000000000002",
            coverage: "complete",
          },
          adverseFixedHorizonMarkout: {
            amountUsd: "0.000000000000000000003",
            coverage: "complete",
          },
          carryAndFundingNet: {
            amountUsd: "-0.000000000000000000004",
            coverage: "complete",
          },
          hedgeAndUnwindNet: {
            amountUsd: "-0.000000000000000000005",
            coverage: "complete",
          },
          gas: {
            amountUsd: "0.000000000000000000006",
            coverage: "complete",
          },
        },
      }),
    );

    expect(result).toMatchObject({
      status: "positive",
      tradingNetUsd: "0.123456789012345678889",
      components: {
        capturedMakerSpread: {
          amountUsd: "0.123456789012345678901",
        },
        makerCredit: { amountUsd: "0.000000000000000000009" },
      },
    });
  });

  it("claims positive only for a complete sample meeting the minimum", () => {
    const profitable = decomposePaperProfitability(completeEvidence());
    expect(profitable).toEqual({
      status: "positive",
      sampleSize: 12,
      minimumSampleSize: 10,
      components: completeEvidence().components,
      tradingNetUsd: "1.00",
      excluded: { rewardsUsd: null, transfersUsd: null },
      gaps: [],
    });

    expect(
      decomposePaperProfitability(
        completeEvidence({ sampleSize: 9, minimumSampleSize: 10 }),
      ),
    ).toMatchObject({
      status: "unavailable",
      tradingNetUsd: null,
      gaps: [
        {
          component: "sampleSize",
          reason: "minimum_sample_not_met",
          observed: 9,
          minimum: 10,
        },
      ],
    });
  });

  it("rejects every negative cost magnitude instead of inflating net", () => {
    const costComponents = [
      "builderFees",
      "venueFees",
      "adverseFixedHorizonMarkout",
      "gas",
    ] as const;

    for (const componentName of costComponents) {
      const complete = completeEvidence();
      const result = decomposePaperProfitability({
        ...complete,
        components: {
          ...complete.components,
          [componentName]: {
            amountUsd: "-0.01",
            coverage: "complete",
          },
        },
      });

      expect(result, componentName).toMatchObject({
        status: "unavailable",
        tradingNetUsd: null,
        gaps: [
          {
            component: componentName,
            reason: "negative_cost_magnitude",
            amountUsd: "-0.01",
          },
        ],
      });
    }
  });

  it("adds signed carry/funding and hedge/unwind net contributions", () => {
    expect(decomposePaperProfitability(completeEvidence())).toMatchObject({
      status: "positive",
      tradingNetUsd: "1.00",
    });

    const complete = completeEvidence();
    expect(
      decomposePaperProfitability({
        ...complete,
        components: {
          ...complete.components,
          carryAndFundingNet: {
            amountUsd: "0.10",
            coverage: "complete",
          },
          hedgeAndUnwindNet: {
            amountUsd: "0.15",
            coverage: "complete",
          },
        },
      }),
    ).toMatchObject({ status: "positive", tradingNetUsd: "1.50" });
  });

  it("classifies exact breakeven as non-positive", () => {
    const complete = completeEvidence();
    expect(
      decomposePaperProfitability({
        ...complete,
        components: {
          ...complete.components,
          capturedMakerSpread: {
            amountUsd: "0.50",
            coverage: "complete",
          },
        },
      }),
    ).toMatchObject({
      status: "non_positive",
      tradingNetUsd: "0.00",
      gaps: [],
    });
  });

  it("returns unavailable for stale component coverage", () => {
    const complete = completeEvidence();
    expect(
      decomposePaperProfitability({
        ...complete,
        components: {
          ...complete.components,
          makerCredit: { amountUsd: "0.20", coverage: "stale" },
        },
      }),
    ).toMatchObject({
      status: "unavailable",
      tradingNetUsd: null,
      gaps: [
        {
          component: "makerCredit",
          reason: "coverage_incomplete",
          coverage: "stale",
        },
      ],
    });
  });

  it("returns unavailable for an invalid component decimal", () => {
    const complete = completeEvidence();
    expect(
      decomposePaperProfitability({
        ...complete,
        components: {
          ...complete.components,
          makerCredit: { amountUsd: "2e-1", coverage: "complete" },
        },
      }),
    ).toMatchObject({
      status: "unavailable",
      tradingNetUsd: null,
      gaps: [
        {
          component: "makerCredit",
          reason: "invalid_decimal",
          amountUsd: "2e-1",
        },
      ],
    });
  });

  it("accepts a complete sample exactly at the minimum boundary", () => {
    expect(
      decomposePaperProfitability(
        completeEvidence({ sampleSize: 10, minimumSampleSize: 10 }),
      ),
    ).toMatchObject({
      status: "positive",
      sampleSize: 10,
      minimumSampleSize: 10,
      tradingNetUsd: "1.00",
      gaps: [],
    });
  });

  it("fails closed for invalid sample sizes", () => {
    for (const invalidSampleSize of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        decomposePaperProfitability(
          completeEvidence({ sampleSize: invalidSampleSize }),
        ),
        String(invalidSampleSize),
      ).toMatchObject({
        status: "unavailable",
        tradingNetUsd: null,
        gaps: [
          {
            component: "sampleSize",
            reason: "invalid_sample_size",
            observed: invalidSampleSize,
          },
        ],
      });
    }
  });

  it("fails closed for invalid minimum sample sizes", () => {
    for (const invalidMinimum of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        decomposePaperProfitability(
          completeEvidence({ minimumSampleSize: invalidMinimum }),
        ),
        String(invalidMinimum),
      ).toMatchObject({
        status: "unavailable",
        tradingNetUsd: null,
        gaps: [
          {
            component: "minimumSampleSize",
            reason: "invalid_minimum_sample_size",
            minimum: invalidMinimum,
          },
        ],
      });
    }
  });

  it("fails closed when a required component object is absent", () => {
    const complete = completeEvidence();
    const malformed = { ...complete.components } as Partial<
      PaperProfitabilityInput["components"]
    >;
    delete malformed.gas;

    expect(
      decomposePaperProfitability({
        ...complete,
        components: malformed as PaperProfitabilityInput["components"],
      }),
    ).toMatchObject({
      status: "unavailable",
      tradingNetUsd: null,
      components: {
        gas: { amountUsd: null, coverage: "unavailable" },
      },
      gaps: [{ component: "gas", reason: "missing_component" }],
    });
  });
});
