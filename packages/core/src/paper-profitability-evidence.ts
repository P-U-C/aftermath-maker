import {
  PAPER_MARKOUT_HORIZONS_MS,
  type AttributedFill,
  type Coverage,
  type DecimalString,
  type InventoryLedgerEffect,
  type InventoryPaperMarkoutObservation,
} from "./inventory-recycling.js";
import {
  decomposePaperProfitability,
  type PaperProfitabilityComponent,
  type PaperProfitabilityComponents,
  type PaperProfitabilityInput,
  type PaperProfitabilityResult,
} from "./paper-profitability.js";

type SourceAwareEvidence = Readonly<{
  sourceEventKey: string;
  runId: string;
  accountId: string;
  marketId: string;
  configVersion: number | null;
  observedAtMs: number;
  source: string;
  network: string;
  coverage: Coverage;
}>;

export type PaperProfitabilityEvidenceCohort = Readonly<{
  runId: string;
  accountId: string;
  marketId: string;
  configVersion: number | null;
  source: string;
  network: string;
  windowStartAtMs: number;
}>;

export type PaperMakerCreditEvidence = SourceAwareEvidence &
  Readonly<{
    makerCreditUsd: DecimalString | null;
  }>;

export type PaperHedgeAndUnwindEvidence = SourceAwareEvidence &
  Readonly<{
    /** Positive is income and negative is cost. */
    hedgeAndUnwindNetUsd: DecimalString | null;
  }>;

export type PaperProfitabilityEvidenceInput = Readonly<{
  cohort: PaperProfitabilityEvidenceCohort;
  asOfMs: number;
  minimumSampleSize: number;
  /**
   * Complete, independently attributed Paper maker fills.
   *
   * This adapter intentionally maps `realizedPnlUsd` to captured maker spread.
   * Callers must not pass a provider's broader realized-P&L value under that
   * field: fees, funding, markouts, hedge/unwind and gas are accounted for by
   * their separate evidence below.
   */
  fills: readonly AttributedFill[];
  markouts: readonly InventoryPaperMarkoutObservation[];
  effects: readonly InventoryLedgerEffect[];
  /** Required aggregate evidence. Absence is unavailable, never zero. */
  makerCredit?: PaperMakerCreditEvidence | null;
  /** Required aggregate evidence. Absence is unavailable, never zero. */
  hedgeAndUnwind?: PaperHedgeAndUnwindEvidence | null;
  /** Audit-only reward total. It never enters the trading net. */
  rewardsUsd?: DecimalString | null;
}>;

export type PaperProfitabilityEvidenceComponent =
  | "cohort"
  | "asOfMs"
  | "minimumSampleSize"
  | "fills"
  | "markouts"
  | "makerCredit"
  | "funding"
  | "hedgeAndUnwind"
  | "gas";

export type PaperProfitabilityEvidenceGapReason =
  | "invalid_cohort"
  | "invalid_as_of"
  | "evidence_attribution_mismatch"
  | "evidence_outside_window"
  | "invalid_minimum_sample_size"
  | "empty_fill_sample"
  | "fill_not_maker"
  | "fill_coverage_incomplete"
  | "same_parent_fill"
  | "unresolved_counterparty"
  | "missing_fill_source_event_key"
  | "missing_fill_order_id"
  | "duplicate_fill_source_event_key"
  | "duplicate_fill_order_id"
  | "invalid_fill_timestamp"
  | "invalid_fill_decimal"
  | "missing_builder_fee"
  | "missing_markout_source_event_key"
  | "duplicate_markout_source_event_key"
  | "unmatched_markout"
  | "unsupported_markout_horizon"
  | "duplicate_markout"
  | "missing_markout_horizon"
  | "markout_coverage_incomplete"
  | "missing_markout_amount"
  | "missing_markout_reference"
  | "invalid_markout_timestamp"
  | "premature_markout"
  | "late_markout"
  | "future_markout"
  | "invalid_markout_decimal"
  | "markout_fill_mismatch"
  | "markout_reference_mismatch"
  | "missing_maker_credit_evidence"
  | "invalid_maker_credit_evidence"
  | "maker_credit_coverage_incomplete"
  | "missing_maker_credit_amount"
  | "future_maker_credit_evidence"
  | "missing_hedge_and_unwind_evidence"
  | "invalid_hedge_and_unwind_evidence"
  | "hedge_and_unwind_coverage_incomplete"
  | "missing_hedge_and_unwind_amount"
  | "future_hedge_and_unwind_evidence"
  | "missing_funding_evidence"
  | "funding_coverage_incomplete"
  | "missing_funding_amount"
  | "invalid_funding_decimal"
  | "future_funding_effect"
  | "missing_gas_evidence"
  | "gas_coverage_incomplete"
  | "missing_gas_amount"
  | "invalid_gas_decimal"
  | "negative_gas"
  | "future_gas_effect"
  | "missing_effect_source_event_key"
  | "duplicate_effect_source_event_key"
  | "invalid_effect_timestamp";

export type PaperProfitabilityEvidenceGap = Readonly<{
  component: PaperProfitabilityEvidenceComponent;
  reason: PaperProfitabilityEvidenceGapReason;
  sourceEventKey: string | null;
  orderKey: string | null;
  horizonMs: number | null;
}>;

export type PaperFixedHorizonProfitabilityEvidence = Readonly<{
  sourceEventKey: string;
  orderKey: string;
  horizonMs: (typeof PAPER_MARKOUT_HORIZONS_MS)[number];
  markoutUsd: DecimalString;
  adverseSelectionCostUsd: DecimalString;
}>;

export type PaperProfitabilityEvidenceResult = PaperProfitabilityResult &
  Readonly<{
    /** Adapter-level source gaps, kept separate from decomposition gaps. */
    evidenceGaps: readonly PaperProfitabilityEvidenceGap[];
    /** The validated fixed-horizon records used by the adverse-cost total. */
    fixedHorizonEvidence: readonly PaperFixedHorizonProfitabilityEvidence[];
  }>;

type ExactDecimal = Readonly<{
  units: bigint;
  scale: number;
}>;

const DECIMAL_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/;
const MARKOUT_HORIZONS = new Set<number>(PAPER_MARKOUT_HORIZONS_MS);
const MAX_MARKOUT_LAG_MS = 30_000;

function parseDecimal(value: string): ExactDecimal | null {
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) return null;
  const fraction = match[3] ?? "";
  const magnitude = BigInt(`${match[2]}${fraction}`);
  return {
    units: match[1] === "-" ? -magnitude : magnitude,
    scale: fraction.length,
  };
}

function unitsAtScale(value: ExactDecimal, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

function formatDecimal(units: bigint, scale: number): DecimalString {
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  if (scale === 0) return `${negative ? "-" : ""}${magnitude}`;
  const digits = magnitude.toString().padStart(scale + 1, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function sumDecimals(values: readonly ExactDecimal[]): DecimalString {
  if (values.length === 0) return "0";
  const scale = Math.max(...values.map((value) => value.scale));
  return formatDecimal(
    values.reduce((total, value) => total + unitsAtScale(value, scale), 0n),
    scale,
  );
}

function sameDecimal(left: string, right: string): boolean {
  const leftDecimal = parseDecimal(left);
  const rightDecimal = parseDecimal(right);
  if (leftDecimal === null || rightDecimal === null) return false;
  const scale = Math.max(leftDecimal.scale, rightDecimal.scale);
  return unitsAtScale(leftDecimal, scale) === unitsAtScale(rightDecimal, scale);
}

function nonempty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validCohort(
  cohort: PaperProfitabilityEvidenceCohort,
  asOfMs: number,
): boolean {
  return (
    nonempty(cohort.runId) &&
    nonempty(cohort.accountId) &&
    nonempty(cohort.marketId) &&
    nonempty(cohort.source) &&
    nonempty(cohort.network) &&
    (cohort.configVersion === null ||
      (Number.isSafeInteger(cohort.configVersion) &&
        cohort.configVersion >= 0)) &&
    validTimestamp(cohort.windowStartAtMs) &&
    validTimestamp(asOfMs) &&
    cohort.windowStartAtMs <= asOfMs
  );
}

function matchesCohort(
  evidence: Pick<
    SourceAwareEvidence,
    "runId" | "accountId" | "marketId" | "configVersion" | "source" | "network"
  >,
  cohort: PaperProfitabilityEvidenceCohort,
): boolean {
  return (
    evidence.runId === cohort.runId &&
    evidence.accountId === cohort.accountId &&
    evidence.marketId === cohort.marketId &&
    evidence.configVersion === cohort.configVersion &&
    evidence.source === cohort.source &&
    evidence.network === cohort.network
  );
}

function completeComponent(
  amountUsd: DecimalString,
): PaperProfitabilityComponent {
  return { amountUsd, coverage: "complete" };
}

function unavailableComponent(): PaperProfitabilityComponent {
  return { amountUsd: null, coverage: "unavailable" };
}

function gap(
  component: PaperProfitabilityEvidenceComponent,
  reason: PaperProfitabilityEvidenceGapReason,
  details: Partial<
    Pick<
      PaperProfitabilityEvidenceGap,
      "sourceEventKey" | "orderKey" | "horizonMs"
    >
  > = {},
): PaperProfitabilityEvidenceGap {
  return {
    component,
    reason,
    sourceEventKey: details.sourceEventKey ?? null,
    orderKey: details.orderKey ?? null,
    horizonMs: details.horizonMs ?? null,
  };
}

function invalidSourceEvidence(evidence: SourceAwareEvidence): boolean {
  return (
    !nonempty(evidence.sourceEventKey) ||
    !nonempty(evidence.runId) ||
    !nonempty(evidence.accountId) ||
    !nonempty(evidence.marketId) ||
    (evidence.configVersion !== null &&
      (!Number.isSafeInteger(evidence.configVersion) ||
        evidence.configVersion < 0)) ||
    !nonempty(evidence.source) ||
    !nonempty(evidence.network) ||
    !validTimestamp(evidence.observedAtMs)
  );
}

function collectTransferTotal(
  effects: readonly InventoryLedgerEffect[],
  asOfMs: number,
): DecimalString | null {
  const transfers = effects.filter((effect) => effect.kind === "transfer");
  if (transfers.length === 0) return null;
  const parsed: ExactDecimal[] = [];
  for (const transfer of transfers) {
    if (
      transfer.coverage !== "complete" ||
      transfer.externalTransferUsd === null ||
      !nonempty(transfer.sourceEventKey) ||
      !validTimestamp(transfer.timestampMs) ||
      transfer.timestampMs > asOfMs
    ) {
      return null;
    }
    const amount = parseDecimal(transfer.externalTransferUsd);
    if (amount === null) return null;
    parsed.push(amount);
  }
  return sumDecimals(parsed);
}

/**
 * Builds the merged Paper profitability contract from retained source records.
 *
 * This is Paper-only accounting. It does not infer provider or Live behavior.
 * Any missing source evidence forces `unavailable`, even if the partial sums
 * would otherwise be positive.
 */
export function decomposePaperProfitabilityEvidence(
  input: PaperProfitabilityEvidenceInput,
): PaperProfitabilityEvidenceResult {
  const evidenceGaps: PaperProfitabilityEvidenceGap[] = [];
  const cohortIsValid = validCohort(input.cohort, input.asOfMs);
  if (!cohortIsValid) evidenceGaps.push(gap("cohort", "invalid_cohort"));
  const asOfIsValid = validTimestamp(input.asOfMs);
  if (!asOfIsValid) evidenceGaps.push(gap("asOfMs", "invalid_as_of"));
  if (
    !Number.isSafeInteger(input.minimumSampleSize) ||
    input.minimumSampleSize <= 0
  ) {
    evidenceGaps.push(gap("minimumSampleSize", "invalid_minimum_sample_size"));
  }
  if (input.fills.length === 0) {
    evidenceGaps.push(gap("fills", "empty_fill_sample"));
  }

  const fillSourceKeys = new Set<string>();
  const fillOrderKeys = new Set<string>();
  const fillsByOrder = new Map<string, AttributedFill>();
  const capturedSpread: ExactDecimal[] = [];
  const venueFees: ExactDecimal[] = [];
  const builderFees: ExactDecimal[] = [];
  const fillGapStart = evidenceGaps.length;

  for (const fill of input.fills) {
    const sourceEventKey = nonempty(fill.sourceEventKey)
      ? fill.sourceEventKey
      : null;
    const orderKey = nonempty(fill.orderId) ? fill.orderId : null;
    const details = { sourceEventKey, orderKey };

    if (sourceEventKey === null) {
      evidenceGaps.push(gap("fills", "missing_fill_source_event_key", details));
    } else if (fillSourceKeys.has(sourceEventKey)) {
      evidenceGaps.push(
        gap("fills", "duplicate_fill_source_event_key", details),
      );
    } else {
      fillSourceKeys.add(sourceEventKey);
    }

    if (orderKey === null) {
      evidenceGaps.push(gap("fills", "missing_fill_order_id", details));
    } else if (fillOrderKeys.has(orderKey)) {
      evidenceGaps.push(gap("fills", "duplicate_fill_order_id", details));
    } else {
      fillOrderKeys.add(orderKey);
      fillsByOrder.set(orderKey, fill);
    }

    if (fill.liquidity !== "maker") {
      evidenceGaps.push(gap("fills", "fill_not_maker", details));
    }
    if (fill.coverage !== "complete") {
      evidenceGaps.push(gap("fills", "fill_coverage_incomplete", details));
    }
    if (
      !matchesCohort(fill, input.cohort) ||
      !nonempty(fill.source) ||
      !nonempty(fill.network)
    ) {
      evidenceGaps.push(gap("fills", "evidence_attribution_mismatch", details));
    }
    if (fill.counterpartyClass === "known_same_parent") {
      evidenceGaps.push(gap("fills", "same_parent_fill", details));
    } else if (fill.counterpartyClass === "unresolved") {
      evidenceGaps.push(gap("fills", "unresolved_counterparty", details));
    }
    if (!validTimestamp(fill.timestampMs)) {
      evidenceGaps.push(gap("fills", "invalid_fill_timestamp", details));
    } else if (
      fill.timestampMs < input.cohort.windowStartAtMs ||
      (asOfIsValid && fill.timestampMs > input.asOfMs)
    ) {
      evidenceGaps.push(gap("fills", "evidence_outside_window", details));
    }

    const sizeBase = parseDecimal(fill.sizeBase);
    const priceUsd = parseDecimal(fill.priceUsd);
    const notionalUsd = parseDecimal(fill.notionalUsd);
    const venueFeeUsd = parseDecimal(fill.venueFeeUsd);
    const realizedPnlUsd = parseDecimal(fill.realizedPnlUsd);
    const builderFeeUsd =
      fill.builderFeeUsd === null ? null : parseDecimal(fill.builderFeeUsd);

    if (fill.builderFeeUsd === null) {
      evidenceGaps.push(gap("fills", "missing_builder_fee", details));
    }
    if (
      sizeBase === null ||
      priceUsd === null ||
      notionalUsd === null ||
      venueFeeUsd === null ||
      realizedPnlUsd === null ||
      (fill.builderFeeUsd !== null && builderFeeUsd === null) ||
      sizeBase?.units < 0n ||
      priceUsd?.units < 0n ||
      notionalUsd?.units < 0n ||
      venueFeeUsd?.units < 0n ||
      realizedPnlUsd?.units < 0n ||
      (builderFeeUsd !== null && builderFeeUsd.units < 0n)
    ) {
      evidenceGaps.push(gap("fills", "invalid_fill_decimal", details));
      continue;
    }
    capturedSpread.push(realizedPnlUsd);
    venueFees.push(venueFeeUsd);
    if (builderFeeUsd !== null) builderFees.push(builderFeeUsd);
  }

  const fillsAreAvailable =
    input.fills.length > 0 && evidenceGaps.length === fillGapStart;

  const markoutGapStart = evidenceGaps.length;
  const markoutSourceKeys = new Set<string>();
  const markoutOrderHorizons = new Set<string>();
  const fixedHorizonEvidence: PaperFixedHorizonProfitabilityEvidence[] = [];
  const adverseSelectionCosts: ExactDecimal[] = [];

  for (const markout of input.markouts) {
    const recordGapStart = evidenceGaps.length;
    const sourceEventKey = nonempty(markout.sourceEventKey)
      ? markout.sourceEventKey
      : null;
    const orderKey = nonempty(markout.orderKey) ? markout.orderKey : null;
    const horizonMs = MARKOUT_HORIZONS.has(markout.horizonMs)
      ? (markout.horizonMs as (typeof PAPER_MARKOUT_HORIZONS_MS)[number])
      : null;
    const details = {
      sourceEventKey,
      orderKey,
      horizonMs: markout.horizonMs,
    };

    if (sourceEventKey === null) {
      evidenceGaps.push(
        gap("markouts", "missing_markout_source_event_key", details),
      );
    } else if (markoutSourceKeys.has(sourceEventKey)) {
      evidenceGaps.push(
        gap("markouts", "duplicate_markout_source_event_key", details),
      );
    } else {
      markoutSourceKeys.add(sourceEventKey);
    }

    const fill = orderKey === null ? undefined : fillsByOrder.get(orderKey);
    if (fill === undefined) {
      evidenceGaps.push(gap("markouts", "unmatched_markout", details));
    }
    if (
      !nonempty(markout.source) ||
      !nonempty(markout.network) ||
      markout.runId !== input.cohort.runId ||
      markout.marketId !== input.cohort.marketId ||
      markout.source !== input.cohort.source ||
      markout.network !== input.cohort.network
    ) {
      evidenceGaps.push(
        gap("markouts", "evidence_attribution_mismatch", details),
      );
    }
    if (horizonMs === null) {
      evidenceGaps.push(
        gap("markouts", "unsupported_markout_horizon", details),
      );
    }
    if (orderKey !== null && horizonMs !== null) {
      const orderHorizon = `${orderKey}\u0000${horizonMs}`;
      if (markoutOrderHorizons.has(orderHorizon)) {
        evidenceGaps.push(gap("markouts", "duplicate_markout", details));
      } else {
        markoutOrderHorizons.add(orderHorizon);
      }
    }
    if (markout.coverage !== "complete") {
      evidenceGaps.push(
        gap("markouts", "markout_coverage_incomplete", details),
      );
    }
    if (markout.markoutUsd === null) {
      evidenceGaps.push(gap("markouts", "missing_markout_amount", details));
    }
    if (markout.referenceUsd === null) {
      evidenceGaps.push(gap("markouts", "missing_markout_reference", details));
    }
    if (
      !validTimestamp(markout.fillAtMs) ||
      !validTimestamp(markout.observedAtMs)
    ) {
      evidenceGaps.push(gap("markouts", "invalid_markout_timestamp", details));
    } else {
      if (
        horizonMs !== null &&
        markout.observedAtMs < markout.fillAtMs + horizonMs
      ) {
        evidenceGaps.push(gap("markouts", "premature_markout", details));
      }
      if (
        horizonMs !== null &&
        markout.observedAtMs > markout.fillAtMs + horizonMs + MAX_MARKOUT_LAG_MS
      ) {
        evidenceGaps.push(gap("markouts", "late_markout", details));
      }
      if (asOfIsValid && markout.observedAtMs > input.asOfMs) {
        evidenceGaps.push(gap("markouts", "future_markout", details));
      }
      if (
        markout.observedAtMs < input.cohort.windowStartAtMs ||
        markout.fillAtMs < input.cohort.windowStartAtMs
      ) {
        evidenceGaps.push(gap("markouts", "evidence_outside_window", details));
      }
    }

    const fillPrice = parseDecimal(markout.fillPriceUsd);
    const baseAmount = parseDecimal(markout.baseAssetAmount);
    const reference =
      markout.referenceUsd === null ? null : parseDecimal(markout.referenceUsd);
    const markoutAmount =
      markout.markoutUsd === null ? null : parseDecimal(markout.markoutUsd);
    if (
      fillPrice === null ||
      baseAmount === null ||
      reference === null ||
      markoutAmount === null ||
      fillPrice?.units < 0n ||
      baseAmount?.units < 0n ||
      reference?.units < 0n
    ) {
      evidenceGaps.push(gap("markouts", "invalid_markout_decimal", details));
    }

    if (
      fill !== undefined &&
      (markout.runId !== fill.runId ||
        markout.marketId !== fill.marketId ||
        markout.fillAtMs !== fill.timestampMs ||
        markout.side !== (fill.side === "buy" ? "bid" : "ask") ||
        !sameDecimal(markout.fillPriceUsd, fill.priceUsd) ||
        !sameDecimal(markout.baseAssetAmount, fill.sizeBase))
    ) {
      evidenceGaps.push(gap("markouts", "markout_fill_mismatch", details));
    }

    if (
      fill !== undefined &&
      markoutAmount !== null &&
      reference !== null &&
      fillPrice !== null &&
      baseAmount !== null
    ) {
      const priceScale = Math.max(fillPrice.scale, reference.scale);
      const priceDifference = {
        units:
          unitsAtScale(reference, priceScale) -
          unitsAtScale(fillPrice, priceScale),
        scale: priceScale,
      };
      const computed = {
        units:
          (markout.side === "bid" ? 1n : -1n) *
          baseAmount.units *
          priceDifference.units,
        scale: baseAmount.scale + priceDifference.scale,
      };
      const computedText = formatDecimal(computed.units, computed.scale);
      if (!sameDecimal(markout.markoutUsd!, computedText)) {
        evidenceGaps.push(
          gap("markouts", "markout_reference_mismatch", details),
        );
      }
    }

    if (
      sourceEventKey !== null &&
      orderKey !== null &&
      horizonMs !== null &&
      markoutAmount !== null &&
      fill !== undefined &&
      evidenceGaps.length === recordGapStart
    ) {
      const computedMarkout = (() => {
        const price = parseDecimal(markout.fillPriceUsd)!;
        const referencePrice = parseDecimal(markout.referenceUsd!)!;
        const base = parseDecimal(markout.baseAssetAmount)!;
        const scale = Math.max(price.scale, referencePrice.scale);
        return {
          units:
            (markout.side === "bid" ? 1n : -1n) *
            base.units *
            (unitsAtScale(referencePrice, scale) - unitsAtScale(price, scale)),
          scale: base.scale + scale,
        };
      })();
      const adverseSelectionCost =
        computedMarkout.units < 0n
          ? { units: -computedMarkout.units, scale: computedMarkout.scale }
          : { units: 0n, scale: markoutAmount.scale };
      adverseSelectionCosts.push(adverseSelectionCost);
      fixedHorizonEvidence.push({
        sourceEventKey,
        orderKey,
        horizonMs,
        markoutUsd: formatDecimal(computedMarkout.units, computedMarkout.scale),
        adverseSelectionCostUsd: formatDecimal(
          adverseSelectionCost.units,
          adverseSelectionCost.scale,
        ),
      });
    }
  }

  for (const fill of input.fills) {
    if (!nonempty(fill.orderId)) continue;
    for (const horizonMs of PAPER_MARKOUT_HORIZONS_MS) {
      if (!markoutOrderHorizons.has(`${fill.orderId}\u0000${horizonMs}`)) {
        evidenceGaps.push(
          gap("markouts", "missing_markout_horizon", {
            sourceEventKey: fill.sourceEventKey,
            orderKey: fill.orderId,
            horizonMs,
          }),
        );
      }
    }
  }

  const markoutsAreAvailable =
    fillsAreAvailable && evidenceGaps.length === markoutGapStart;

  const makerCreditGapStart = evidenceGaps.length;
  let makerCreditAmount: ExactDecimal | null = null;
  if (input.makerCredit == null) {
    evidenceGaps.push(gap("makerCredit", "missing_maker_credit_evidence"));
  } else {
    const details = { sourceEventKey: input.makerCredit.sourceEventKey };
    if (invalidSourceEvidence(input.makerCredit)) {
      evidenceGaps.push(
        gap("makerCredit", "invalid_maker_credit_evidence", details),
      );
    } else if (!matchesCohort(input.makerCredit, input.cohort)) {
      evidenceGaps.push(
        gap("makerCredit", "evidence_attribution_mismatch", details),
      );
    } else if (asOfIsValid && input.makerCredit.observedAtMs > input.asOfMs) {
      evidenceGaps.push(
        gap("makerCredit", "future_maker_credit_evidence", details),
      );
    }
    if (
      validTimestamp(input.makerCredit.observedAtMs) &&
      input.makerCredit.observedAtMs < input.cohort.windowStartAtMs
    ) {
      evidenceGaps.push(gap("makerCredit", "evidence_outside_window", details));
    }
    if (input.makerCredit.coverage !== "complete") {
      evidenceGaps.push(
        gap("makerCredit", "maker_credit_coverage_incomplete", details),
      );
    }
    if (input.makerCredit.makerCreditUsd === null) {
      evidenceGaps.push(
        gap("makerCredit", "missing_maker_credit_amount", details),
      );
    } else {
      makerCreditAmount = parseDecimal(input.makerCredit.makerCreditUsd);
      if (makerCreditAmount === null) {
        evidenceGaps.push(
          gap("makerCredit", "invalid_maker_credit_evidence", details),
        );
      }
    }
  }
  const makerCreditIsAvailable =
    makerCreditAmount !== null && evidenceGaps.length === makerCreditGapStart;

  const hedgeGapStart = evidenceGaps.length;
  let hedgeAndUnwindAmount: ExactDecimal | null = null;
  if (input.hedgeAndUnwind == null) {
    evidenceGaps.push(
      gap("hedgeAndUnwind", "missing_hedge_and_unwind_evidence"),
    );
  } else {
    const details = { sourceEventKey: input.hedgeAndUnwind.sourceEventKey };
    if (invalidSourceEvidence(input.hedgeAndUnwind)) {
      evidenceGaps.push(
        gap("hedgeAndUnwind", "invalid_hedge_and_unwind_evidence", details),
      );
    } else if (!matchesCohort(input.hedgeAndUnwind, input.cohort)) {
      evidenceGaps.push(
        gap("hedgeAndUnwind", "evidence_attribution_mismatch", details),
      );
    } else if (
      asOfIsValid &&
      input.hedgeAndUnwind.observedAtMs > input.asOfMs
    ) {
      evidenceGaps.push(
        gap("hedgeAndUnwind", "future_hedge_and_unwind_evidence", details),
      );
    }
    if (
      validTimestamp(input.hedgeAndUnwind.observedAtMs) &&
      input.hedgeAndUnwind.observedAtMs < input.cohort.windowStartAtMs
    ) {
      evidenceGaps.push(
        gap("hedgeAndUnwind", "evidence_outside_window", details),
      );
    }
    if (input.hedgeAndUnwind.coverage !== "complete") {
      evidenceGaps.push(
        gap("hedgeAndUnwind", "hedge_and_unwind_coverage_incomplete", details),
      );
    }
    if (input.hedgeAndUnwind.hedgeAndUnwindNetUsd === null) {
      evidenceGaps.push(
        gap("hedgeAndUnwind", "missing_hedge_and_unwind_amount", details),
      );
    } else {
      hedgeAndUnwindAmount = parseDecimal(
        input.hedgeAndUnwind.hedgeAndUnwindNetUsd,
      );
      if (hedgeAndUnwindAmount === null) {
        evidenceGaps.push(
          gap("hedgeAndUnwind", "invalid_hedge_and_unwind_evidence", details),
        );
      }
    }
  }
  const hedgeIsAvailable =
    hedgeAndUnwindAmount !== null && evidenceGaps.length === hedgeGapStart;

  const fundingGapStart = evidenceGaps.length;
  const fundingAmounts: ExactDecimal[] = [];
  const fundingEffects = input.effects.filter(
    (effect) => effect.kind === "funding",
  );
  if (fundingEffects.length === 0) {
    evidenceGaps.push(gap("funding", "missing_funding_evidence"));
  }

  const gasGapStart = evidenceGaps.length;
  const gasAmounts: ExactDecimal[] = [];
  const gasEffects = input.effects.filter((effect) => effect.kind === "gas");
  if (gasEffects.length === 0) {
    evidenceGaps.push(gap("gas", "missing_gas_evidence"));
  }

  const effectSourceKeys = new Set<string>();
  for (const effect of [...fundingEffects, ...gasEffects]) {
    const component = effect.kind === "funding" ? "funding" : "gas";
    const sourceEventKey = nonempty(effect.sourceEventKey)
      ? effect.sourceEventKey
      : null;
    const details = { sourceEventKey };
    if (sourceEventKey === null) {
      evidenceGaps.push(
        gap(component, "missing_effect_source_event_key", details),
      );
    } else if (effectSourceKeys.has(sourceEventKey)) {
      evidenceGaps.push(
        gap(component, "duplicate_effect_source_event_key", details),
      );
    } else {
      effectSourceKeys.add(sourceEventKey);
    }
    if (
      effect.runId !== input.cohort.runId ||
      effect.accountId !== input.cohort.accountId ||
      (effect.marketId !== null && effect.marketId !== input.cohort.marketId) ||
      effect.configVersion !== input.cohort.configVersion ||
      effect.source !== input.cohort.source ||
      effect.network !== input.cohort.network
    ) {
      evidenceGaps.push(
        gap(component, "evidence_attribution_mismatch", details),
      );
    }
    if (!validTimestamp(effect.timestampMs)) {
      evidenceGaps.push(gap(component, "invalid_effect_timestamp", details));
    } else {
      if (effect.timestampMs < input.cohort.windowStartAtMs) {
        evidenceGaps.push(gap(component, "evidence_outside_window", details));
      }
      if (asOfIsValid && effect.timestampMs > input.asOfMs) {
        evidenceGaps.push(
          gap(
            component,
            effect.kind === "funding"
              ? "future_funding_effect"
              : "future_gas_effect",
            details,
          ),
        );
      }
    }

    if (effect.kind === "funding") {
      if (effect.coverage !== "complete") {
        evidenceGaps.push(
          gap("funding", "funding_coverage_incomplete", details),
        );
      }
      if (effect.fundingUsd === null) {
        evidenceGaps.push(gap("funding", "missing_funding_amount", details));
      } else {
        const amount = parseDecimal(effect.fundingUsd);
        if (amount === null) {
          evidenceGaps.push(gap("funding", "invalid_funding_decimal", details));
        } else {
          fundingAmounts.push(amount);
        }
      }
    } else {
      if (effect.coverage !== "complete") {
        evidenceGaps.push(gap("gas", "gas_coverage_incomplete", details));
      }
      if (effect.gasUsd === null) {
        evidenceGaps.push(gap("gas", "missing_gas_amount", details));
      } else {
        const amount = parseDecimal(effect.gasUsd);
        if (amount === null) {
          evidenceGaps.push(gap("gas", "invalid_gas_decimal", details));
        } else if (amount.units < 0n) {
          evidenceGaps.push(gap("gas", "negative_gas", details));
        } else {
          gasAmounts.push(amount);
        }
      }
    }
  }

  const fundingIsAvailable =
    fundingEffects.length > 0 &&
    fundingAmounts.length === fundingEffects.length &&
    !evidenceGaps
      .slice(fundingGapStart)
      .some((entry) => entry.component === "funding");
  const gasIsAvailable =
    gasEffects.length > 0 &&
    gasAmounts.length === gasEffects.length &&
    !evidenceGaps.slice(gasGapStart).some((entry) => entry.component === "gas");

  const components: PaperProfitabilityComponents = {
    capturedMakerSpread: fillsAreAvailable
      ? completeComponent(sumDecimals(capturedSpread))
      : unavailableComponent(),
    makerCredit: makerCreditIsAvailable
      ? completeComponent(input.makerCredit!.makerCreditUsd!)
      : unavailableComponent(),
    builderFees: fillsAreAvailable
      ? completeComponent(sumDecimals(builderFees))
      : unavailableComponent(),
    venueFees: fillsAreAvailable
      ? completeComponent(sumDecimals(venueFees))
      : unavailableComponent(),
    adverseFixedHorizonMarkout: markoutsAreAvailable
      ? completeComponent(sumDecimals(adverseSelectionCosts))
      : unavailableComponent(),
    carryAndFundingNet: fundingIsAvailable
      ? completeComponent(sumDecimals(fundingAmounts))
      : unavailableComponent(),
    hedgeAndUnwindNet: hedgeIsAvailable
      ? completeComponent(input.hedgeAndUnwind!.hedgeAndUnwindNetUsd!)
      : unavailableComponent(),
    gas: gasIsAvailable
      ? completeComponent(sumDecimals(gasAmounts))
      : unavailableComponent(),
  };

  const profitabilityInput: PaperProfitabilityInput = {
    sampleSize: input.fills.length,
    minimumSampleSize: input.minimumSampleSize,
    components,
    rewardsUsd: input.rewardsUsd ?? null,
    transfersUsd: asOfIsValid
      ? collectTransferTotal(input.effects, input.asOfMs)
      : null,
  };
  const decomposition = decomposePaperProfitability(profitabilityInput);
  const result = {
    ...decomposition,
    evidenceGaps,
    fixedHorizonEvidence,
  };
  if (evidenceGaps.length === 0) return result;
  return { ...result, status: "unavailable", tradingNetUsd: null };
}
