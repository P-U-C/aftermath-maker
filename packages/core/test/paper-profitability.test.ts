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
      carryAndFunding: { amountUsd: "0.10", coverage: "complete" },
      hedgeAndUnwind: { amountUsd: "0.15", coverage: "complete" },
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
          carryAndFunding: {
            amountUsd: "0.000000000000000000004",
            coverage: "complete",
          },
          hedgeAndUnwind: {
            amountUsd: "0.000000000000000000005",
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
});
