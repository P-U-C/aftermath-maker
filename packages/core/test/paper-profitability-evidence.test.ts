import { describe, expect, it } from "vitest";
import {
  decomposePaperProfitabilityEvidence,
  type PaperProfitabilityEvidenceInput,
} from "../src/paper-profitability-evidence.js";
import {
  PAPER_MARKOUT_HORIZONS_MS,
  type AttributedFill,
  type InventoryLedgerEffect,
  type InventoryPaperMarkoutObservation,
} from "../src/inventory-recycling.js";

const FILL_AT_MS = 1_000_000;
const AS_OF_MS = FILL_AT_MS + PAPER_MARKOUT_HORIZONS_MS.at(-1)! + 10_000;
const COHORT = {
  runId: "paper-run-1",
  accountId: "paper-maker",
  marketId: "ETH-USDC",
  configVersion: 1,
  source: "paper",
  network: "paper",
  windowStartAtMs: FILL_AT_MS,
} as const;

function fill(overrides: Partial<AttributedFill> = {}): AttributedFill {
  return {
    sourceEventKey: "fill:event:1",
    runId: "paper-run-1",
    configVersion: 1,
    accountId: "paper-maker",
    ownerWallet: "paper-owner",
    marketId: "ETH-USDC",
    orderId: "maker-order-1",
    txDigest: "paper:fill:1",
    eventIndex: 0,
    timestampMs: FILL_AT_MS,
    side: "buy",
    liquidity: "maker",
    sizeBase: "1",
    priceUsd: "100.00",
    notionalUsd: "100.00",
    venueFeeUsd: "0.05",
    builderFeeUsd: "0.10",
    realizedPnlUsd: "1.50",
    counterpartyClass: "verified_other_parent",
    classificationEvidence: ["paper-parent-proof"],
    source: "paper",
    network: "paper",
    coverage: "complete",
    raw: {},
    ...overrides,
  };
}

function markout(
  horizonMs: (typeof PAPER_MARKOUT_HORIZONS_MS)[number],
  markoutUsd: string,
  overrides: Partial<InventoryPaperMarkoutObservation> = {},
): InventoryPaperMarkoutObservation {
  return {
    sourceEventKey: `markout:maker-order-1:${horizonMs}`,
    runId: "paper-run-1",
    orderKey: "maker-order-1",
    marketId: "ETH-USDC",
    fillAtMs: FILL_AT_MS,
    fillPriceUsd: "100.00",
    side: "bid",
    baseAssetAmount: "1",
    horizonMs,
    referenceUsd:
      markoutUsd === "-0.10"
        ? "99.90"
        : markoutUsd === "0.05"
          ? "100.05"
          : markoutUsd === "-0.20"
            ? "99.80"
            : markoutUsd === "-0.15"
              ? "99.85"
              : "100.00",
    observedAtMs: FILL_AT_MS + horizonMs,
    markoutUsd,
    source: "paper",
    network: "paper",
    coverage: "complete",
    raw: {},
    ...overrides,
  };
}

function effect(
  kind: InventoryLedgerEffect["kind"],
  overrides: Partial<InventoryLedgerEffect> = {},
): InventoryLedgerEffect {
  return {
    sourceEventKey: `effect:${kind}:1`,
    runId: "paper-run-1",
    configVersion: 1,
    accountId: "paper-maker",
    marketId: "ETH-USDC",
    timestampMs: FILL_AT_MS + 500,
    kind,
    fundingUsd: kind === "funding" ? "-0.10" : null,
    gasUsedMist: kind === "gas" ? "500000" : null,
    gasUsd: kind === "gas" ? "0.05" : null,
    externalTransferUsd: kind === "transfer" ? "999999.99" : null,
    source: "paper",
    network: "paper",
    coverage: "complete",
    raw: {},
    ...overrides,
  };
}

function completeEvidence(
  overrides: Partial<PaperProfitabilityEvidenceInput> = {},
): PaperProfitabilityEvidenceInput {
  return {
    cohort: COHORT,
    asOfMs: AS_OF_MS,
    minimumSampleSize: 1,
    fills: [fill()],
    markouts: [
      markout(60_000, "-0.10"),
      markout(300_000, "0.05"),
      markout(1_800_000, "-0.20"),
      markout(3_600_000, "-0.15"),
    ],
    effects: [effect("funding"), effect("gas"), effect("transfer")],
    makerCredit: {
      sourceEventKey: "maker-credit:paper-run-1",
      runId: "paper-run-1",
      accountId: "paper-maker",
      marketId: "ETH-USDC",
      configVersion: 1,
      observedAtMs: AS_OF_MS - 1,
      makerCreditUsd: "0.20",
      source: "paper",
      network: "paper",
      coverage: "complete",
    },
    hedgeAndUnwind: {
      sourceEventKey: "hedge-unwind:paper-run-1",
      runId: "paper-run-1",
      accountId: "paper-maker",
      marketId: "ETH-USDC",
      configVersion: 1,
      observedAtMs: AS_OF_MS - 1,
      hedgeAndUnwindNetUsd: "-0.15",
      source: "paper",
      network: "paper",
      coverage: "complete",
    },
    rewardsUsd: "1234567.89",
    ...overrides,
  };
}

function expectUnavailable(
  input: PaperProfitabilityEvidenceInput,
  reason: string,
): void {
  const result = decomposePaperProfitabilityEvidence(input);
  expect(result).toMatchObject({
    status: "unavailable",
    tradingNetUsd: null,
  });
  expect(result.evidenceGaps.map((gap) => gap.reason)).toContain(reason);
}

describe("Paper profitability source-evidence adapter", () => {
  it("decomposes complete source-aware Paper evidence at the exact minimum boundary", () => {
    const result = decomposePaperProfitabilityEvidence(completeEvidence());

    expect(result).toMatchObject({
      status: "positive",
      sampleSize: 1,
      minimumSampleSize: 1,
      tradingNetUsd: "0.80",
      components: {
        capturedMakerSpread: { amountUsd: "1.50", coverage: "complete" },
        makerCredit: { amountUsd: "0.20", coverage: "complete" },
        builderFees: { amountUsd: "0.10", coverage: "complete" },
        venueFees: { amountUsd: "0.05", coverage: "complete" },
        adverseFixedHorizonMarkout: {
          amountUsd: "0.45",
          coverage: "complete",
        },
        carryAndFundingNet: {
          amountUsd: "-0.10",
          coverage: "complete",
        },
        hedgeAndUnwindNet: {
          amountUsd: "-0.15",
          coverage: "complete",
        },
        gas: { amountUsd: "0.05", coverage: "complete" },
      },
      excluded: {
        rewardsUsd: "1234567.89",
        transfersUsd: "999999.99",
      },
      gaps: [],
      evidenceGaps: [],
    });
    expect(result.fixedHorizonEvidence).toEqual([
      expect.objectContaining({
        horizonMs: 60_000,
        markoutUsd: "-0.10",
        adverseSelectionCostUsd: "0.10",
      }),
      expect.objectContaining({
        horizonMs: 300_000,
        markoutUsd: "0.05",
        adverseSelectionCostUsd: "0.00",
      }),
      expect.objectContaining({
        horizonMs: 1_800_000,
        markoutUsd: "-0.20",
        adverseSelectionCostUsd: "0.20",
      }),
      expect.objectContaining({
        horizonMs: 3_600_000,
        markoutUsd: "-0.15",
        adverseSelectionCostUsd: "0.15",
      }),
    ]);
  });

  it("rejects same-parent and unresolved maker fills", () => {
    for (const counterpartyClass of [
      "known_same_parent",
      "unresolved",
    ] as const) {
      expectUnavailable(
        completeEvidence({ fills: [fill({ counterpartyClass })] }),
        counterpartyClass === "known_same_parent"
          ? "same_parent_fill"
          : "unresolved_counterparty",
      );
    }
  });

  it("rejects taker fills and incomplete fill coverage", () => {
    expectUnavailable(
      completeEvidence({ fills: [fill({ liquidity: "taker" })] }),
      "fill_not_maker",
    );
    expectUnavailable(
      completeEvidence({ fills: [fill({ coverage: "partial" })] }),
      "fill_coverage_incomplete",
    );
  });

  it("rejects missing fill source and order identities", () => {
    expectUnavailable(
      completeEvidence({ fills: [fill({ sourceEventKey: "" })] }),
      "missing_fill_source_event_key",
    );
    expectUnavailable(
      completeEvidence({ fills: [fill({ orderId: null })] }),
      "missing_fill_order_id",
    );
  });

  it("rejects duplicate source-event and order fill identities", () => {
    const first = fill();
    expectUnavailable(
      completeEvidence({
        minimumSampleSize: 2,
        fills: [first, fill({ orderId: "maker-order-2" })],
      }),
      "duplicate_fill_source_event_key",
    );
    expectUnavailable(
      completeEvidence({
        minimumSampleSize: 2,
        fills: [first, fill({ sourceEventKey: "fill:event:2" })],
      }),
      "duplicate_fill_order_id",
    );
  });

  it("rejects invalid fill timestamps and decimal fields", () => {
    expectUnavailable(
      completeEvidence({ fills: [fill({ timestampMs: Number.NaN })] }),
      "invalid_fill_timestamp",
    );
    expectUnavailable(
      completeEvidence({ fills: [fill({ notionalUsd: "-0.01" })] }),
      "invalid_fill_decimal",
    );
    expectUnavailable(
      completeEvidence({ fills: [fill({ realizedPnlUsd: "Infinity" })] }),
      "invalid_fill_decimal",
    );
  });

  it("rejects a duplicate fixed-horizon markout", () => {
    const fixture = completeEvidence();
    expectUnavailable(
      completeEvidence({
        markouts: [...fixture.markouts, fixture.markouts[0]!],
      }),
      "duplicate_markout",
    );
  });

  it("rejects a missing fixed horizon", () => {
    const fixture = completeEvidence();
    expectUnavailable(
      completeEvidence({
        markouts: fixture.markouts.filter(
          (observation) => observation.horizonMs !== 300_000,
        ),
      }),
      "missing_markout_horizon",
    );
  });

  it("rejects future and stale markouts", () => {
    const fixture = completeEvidence();
    expectUnavailable(
      completeEvidence({
        markouts: fixture.markouts.map((observation, index) =>
          index === 0
            ? { ...observation, observedAtMs: AS_OF_MS + 1 }
            : observation,
        ),
      }),
      "future_markout",
    );
    expectUnavailable(
      completeEvidence({
        markouts: fixture.markouts.map((observation, index) =>
          index === 0
            ? { ...observation, coverage: "stale" as const }
            : observation,
        ),
      }),
      "markout_coverage_incomplete",
    );
  });

  it("rejects an unmatched markout", () => {
    const fixture = completeEvidence();
    expectUnavailable(
      completeEvidence({
        markouts: fixture.markouts.map((observation, index) =>
          index === 0
            ? { ...observation, orderKey: "unknown-order" }
            : observation,
        ),
      }),
      "unmatched_markout",
    );
  });

  it("binds every record to the Paper cohort and rejects foreign evidence", () => {
    expectUnavailable(
      completeEvidence({
        fills: [fill({ network: "mainnet" })],
      }),
      "evidence_attribution_mismatch",
    );
    expectUnavailable(
      completeEvidence({
        effects: [effect("funding", { runId: "foreign-run" }), effect("gas")],
      }),
      "evidence_attribution_mismatch",
    );
    expectUnavailable(
      completeEvidence({
        makerCredit: {
          ...completeEvidence().makerCredit!,
          network: "mainnet",
        },
      }),
      "evidence_attribution_mismatch",
    );
  });

  it("recomputes markouts from the retained fill and reference identity", () => {
    const fixture = completeEvidence();
    const result = decomposePaperProfitabilityEvidence({
      ...fixture,
      markouts: fixture.markouts.map((observation, index) =>
        index === 0 ? { ...observation, markoutUsd: "0.25" } : observation,
      ),
    });
    expect(result.status).toBe("unavailable");
    expect(result.evidenceGaps.map((entry) => entry.reason)).toContain(
      "markout_reference_mismatch",
    );
    expect(result.fixedHorizonEvidence).toHaveLength(3);

    expectUnavailable(
      completeEvidence({
        markouts: fixture.markouts.map((observation, index) =>
          index === 0
            ? { ...observation, fillPriceUsd: "101.00" }
            : observation,
        ),
      }),
      "markout_fill_mismatch",
    );
  });

  it("rejects late fixed-horizon marks and pre-window aggregate receipts", () => {
    const fixture = completeEvidence();
    expectUnavailable(
      completeEvidence({
        markouts: fixture.markouts.map((observation, index) =>
          index === 0
            ? {
                ...observation,
                observedAtMs:
                  observation.fillAtMs + observation.horizonMs + 30_001,
              }
            : observation,
        ),
      }),
      "late_markout",
    );
    expectUnavailable(
      completeEvidence({
        makerCredit: {
          ...fixture.makerCredit!,
          observedAtMs: FILL_AT_MS - 1,
        },
      }),
      "evidence_outside_window",
    );
  });

  it("rejects missing builder-fee evidence", () => {
    expectUnavailable(
      completeEvidence({ fills: [fill({ builderFeeUsd: null })] }),
      "missing_builder_fee",
    );
  });

  it("does not default absent maker-credit or hedge/unwind evidence to zero", () => {
    expectUnavailable(
      completeEvidence({ makerCredit: null }),
      "missing_maker_credit_evidence",
    );
    expectUnavailable(
      completeEvidence({ hedgeAndUnwind: null }),
      "missing_hedge_and_unwind_evidence",
    );
  });

  it("rejects incomplete funding and gas effects", () => {
    expectUnavailable(
      completeEvidence({
        effects: [effect("funding", { coverage: "partial" }), effect("gas")],
      }),
      "funding_coverage_incomplete",
    );
    expectUnavailable(
      completeEvidence({
        effects: [effect("funding"), effect("gas", { coverage: "stale" })],
      }),
      "gas_coverage_incomplete",
    );
  });

  it("rejects negative gas costs", () => {
    expectUnavailable(
      completeEvidence({
        effects: [effect("funding"), effect("gas", { gasUsd: "-0.01" })],
      }),
      "negative_gas",
    );
  });

  it("keeps rewards and transfers excluded from the trading net", () => {
    const baseline = decomposePaperProfitabilityEvidence(
      completeEvidence({
        rewardsUsd: null,
        effects: [effect("funding"), effect("gas")],
      }),
    );
    const excluded = decomposePaperProfitabilityEvidence(completeEvidence());

    expect(excluded.status).toBe("positive");
    expect(excluded.tradingNetUsd).toBe(baseline.tradingNetUsd);
    expect(excluded.excluded).toEqual({
      rewardsUsd: "1234567.89",
      transfersUsd: "999999.99",
    });
  });

  it("requires a nonempty sample and the exact minimum boundary", () => {
    expectUnavailable(
      completeEvidence({ fills: [], markouts: [] }),
      "empty_fill_sample",
    );

    const belowMinimum = completeEvidence({ minimumSampleSize: 2 });
    expect(decomposePaperProfitabilityEvidence(belowMinimum)).toMatchObject({
      status: "unavailable",
      tradingNetUsd: null,
      gaps: [
        expect.objectContaining({
          component: "sampleSize",
          reason: "minimum_sample_not_met",
          observed: 1,
          minimum: 2,
        }),
      ],
    });

    expect(
      decomposePaperProfitabilityEvidence(completeEvidence()),
    ).toMatchObject({
      status: "positive",
      sampleSize: 1,
      minimumSampleSize: 1,
    });
  });
});
