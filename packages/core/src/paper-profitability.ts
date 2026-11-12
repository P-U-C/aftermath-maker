/**
 * Pure, Paper-only profitability accounting.
 *
 * The contract deliberately distinguishes a positive measured trading result
 * from missing evidence. Rewards and transfers are retained for auditability,
 * but never enter the trading net. A positive status is evidence only: it
 * cannot authorize Live execution.
 */

export type PaperProfitabilityCoverage =
  "complete" | "partial" | "stale" | "unavailable";

export const PAPER_PROFITABILITY_COMPONENTS = [
  "capturedMakerSpread",
  "makerCredit",
  "builderFees",
  "venueFees",
  "adverseFixedHorizonMarkout",
  "carryAndFundingNet",
  "hedgeAndUnwindNet",
  "gas",
] as const;

export type PaperProfitabilityComponentName =
  (typeof PAPER_PROFITABILITY_COMPONENTS)[number];

export type PaperProfitabilityComponent = Readonly<{
  /**
   * Source decimal text. It is returned unchanged; component-specific sign
   * semantics are documented on `decomposePaperProfitability`.
   */
  amountUsd: string | null;
  coverage: PaperProfitabilityCoverage;
}>;

export type PaperProfitabilityComponents = Readonly<
  Record<PaperProfitabilityComponentName, PaperProfitabilityComponent>
>;

export type PaperProfitabilityInput = Readonly<{
  sampleSize: number;
  minimumSampleSize: number;
  components: PaperProfitabilityComponents;
  /** Audit-only wallet reward total; excluded from trading net. */
  rewardsUsd?: string | null;
  /** Audit-only external transfer total; excluded from trading net. */
  transfersUsd?: string | null;
}>;

type IncompleteCoverage = Exclude<PaperProfitabilityCoverage, "complete">;

export type PaperProfitabilityGap =
  | Readonly<{
      component: PaperProfitabilityComponentName;
      reason: "missing_component";
    }>
  | Readonly<{
      component: PaperProfitabilityComponentName;
      reason: "malformed_component";
    }>
  | Readonly<{
      component: PaperProfitabilityComponentName;
      reason: "missing_amount";
    }>
  | Readonly<{
      component: PaperProfitabilityComponentName;
      reason: "invalid_decimal";
      amountUsd: string;
    }>
  | Readonly<{
      component: PaperProfitabilityComponentName;
      reason: "negative_cost_magnitude";
      amountUsd: string;
    }>
  | Readonly<{
      component: PaperProfitabilityComponentName;
      reason: "coverage_incomplete";
      coverage: IncompleteCoverage;
    }>
  | Readonly<{
      component: "sampleSize";
      reason: "invalid_sample_size";
      observed: number;
    }>
  | Readonly<{
      component: "minimumSampleSize";
      reason: "invalid_minimum_sample_size";
      minimum: number;
    }>
  | Readonly<{
      component: "sampleSize";
      reason: "minimum_sample_not_met";
      observed: number;
      minimum: number;
    }>;

export type PaperProfitabilityResult = Readonly<{
  status: "positive" | "non_positive" | "unavailable";
  sampleSize: number;
  minimumSampleSize: number;
  /** Component decimal strings are retained byte-for-byte. */
  components: PaperProfitabilityComponents;
  /** Null until every required component and the sample are complete. */
  tradingNetUsd: string | null;
  /** These values are display/audit evidence only, never trading P&L. */
  excluded: Readonly<{
    rewardsUsd: string | null;
    transfersUsd: string | null;
  }>;
  gaps: readonly PaperProfitabilityGap[];
}>;

type ParsedDecimal = Readonly<{
  units: bigint;
  scale: number;
}>;

const DECIMAL_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/;

function parseDecimal(value: string): ParsedDecimal | null {
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) return null;

  const fraction = match[3] ?? "";
  const magnitude = BigInt(`${match[2]}${fraction}`);
  return {
    units: match[1] === "-" ? -magnitude : magnitude,
    scale: fraction.length,
  };
}

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function unitsAtScale(value: ParsedDecimal, scale: number): bigint {
  return value.units * powerOfTen(scale - value.scale);
}

function formatUnits(units: bigint, scale: number): string {
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  if (scale === 0) return `${negative ? "-" : ""}${magnitude}`;

  const digits = magnitude.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

type ComponentShapeGap = Extract<
  PaperProfitabilityGap,
  { reason: "missing_component" | "malformed_component" }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCoverage(value: unknown): value is PaperProfitabilityCoverage {
  return (
    value === "complete" ||
    value === "partial" ||
    value === "stale" ||
    value === "unavailable"
  );
}

function snapshotComponents(value: unknown): Readonly<{
  components: PaperProfitabilityComponents;
  gaps: readonly ComponentShapeGap[];
  malformed: ReadonlySet<PaperProfitabilityComponentName>;
}> {
  const source = isRecord(value) ? value : null;
  const components = {} as Record<
    PaperProfitabilityComponentName,
    PaperProfitabilityComponent
  >;
  const gaps: ComponentShapeGap[] = [];
  const malformed = new Set<PaperProfitabilityComponentName>();

  for (const componentName of PAPER_PROFITABILITY_COMPONENTS) {
    const rawComponent = source?.[componentName];
    if (rawComponent === undefined) {
      components[componentName] = {
        amountUsd: null,
        coverage: "unavailable",
      };
      gaps.push({ component: componentName, reason: "missing_component" });
      malformed.add(componentName);
      continue;
    }

    if (
      !isRecord(rawComponent) ||
      (rawComponent.amountUsd !== null &&
        typeof rawComponent.amountUsd !== "string") ||
      !isCoverage(rawComponent.coverage)
    ) {
      components[componentName] = {
        amountUsd: null,
        coverage: "unavailable",
      };
      gaps.push({ component: componentName, reason: "malformed_component" });
      malformed.add(componentName);
      continue;
    }

    components[componentName] = {
      amountUsd: rawComponent.amountUsd,
      coverage: rawComponent.coverage,
    };
  }

  return { components, gaps, malformed };
}

function isCostMagnitude(
  componentName: PaperProfitabilityComponentName,
): boolean {
  return (
    componentName === "builderFees" ||
    componentName === "venueFees" ||
    componentName === "adverseFixedHorizonMarkout" ||
    componentName === "gas"
  );
}

/**
 * Decomposes complete Paper evidence into an all-in, no-reward trading net.
 *
 * Captured spread and maker credit are added. Builder fees, venue fees,
 * adverse fixed-horizon markout and gas are non-negative cost magnitudes and
 * are subtracted. Carry/funding net and hedge/unwind net follow the existing
 * signed-income convention: positive is income, negative is cost, and both
 * are added. The maximum source scale is used for the result, so the
 * computation neither rounds through binary floats nor drops declared decimal
 * precision.
 */
export function decomposePaperProfitability(
  input: PaperProfitabilityInput,
): PaperProfitabilityResult {
  const snapshot = snapshotComponents(input.components);
  const components = snapshot.components;
  const gaps: PaperProfitabilityGap[] = [...snapshot.gaps];
  const parsed = new Map<PaperProfitabilityComponentName, ParsedDecimal>();

  const sampleSizeIsValid =
    Number.isSafeInteger(input.sampleSize) && input.sampleSize >= 0;
  const minimumSampleSizeIsValid =
    Number.isSafeInteger(input.minimumSampleSize) &&
    input.minimumSampleSize > 0;

  if (!sampleSizeIsValid) {
    gaps.push({
      component: "sampleSize",
      reason: "invalid_sample_size",
      observed: input.sampleSize,
    });
  }
  if (!minimumSampleSizeIsValid) {
    gaps.push({
      component: "minimumSampleSize",
      reason: "invalid_minimum_sample_size",
      minimum: input.minimumSampleSize,
    });
  }
  if (
    sampleSizeIsValid &&
    minimumSampleSizeIsValid &&
    input.sampleSize < input.minimumSampleSize
  ) {
    gaps.push({
      component: "sampleSize",
      reason: "minimum_sample_not_met",
      observed: input.sampleSize,
      minimum: input.minimumSampleSize,
    });
  }

  for (const componentName of PAPER_PROFITABILITY_COMPONENTS) {
    if (snapshot.malformed.has(componentName)) continue;

    const component = components[componentName];
    if (component.amountUsd === null) {
      gaps.push({ component: componentName, reason: "missing_amount" });
    } else {
      const decimal = parseDecimal(component.amountUsd);
      if (decimal === null) {
        gaps.push({
          component: componentName,
          reason: "invalid_decimal",
          amountUsd: component.amountUsd,
        });
      } else if (isCostMagnitude(componentName) && decimal.units < 0n) {
        gaps.push({
          component: componentName,
          reason: "negative_cost_magnitude",
          amountUsd: component.amountUsd,
        });
      } else {
        parsed.set(componentName, decimal);
      }
    }

    if (component.coverage !== "complete") {
      gaps.push({
        component: componentName,
        reason: "coverage_incomplete",
        coverage: component.coverage,
      });
    }
  }

  const baseResult = {
    sampleSize: input.sampleSize,
    minimumSampleSize: input.minimumSampleSize,
    components,
    excluded: {
      rewardsUsd: input.rewardsUsd ?? null,
      transfersUsd: input.transfersUsd ?? null,
    },
    gaps,
  };

  if (gaps.length > 0) {
    return {
      status: "unavailable",
      ...baseResult,
      tradingNetUsd: null,
    };
  }

  const scale = Math.max(
    ...Array.from(parsed.values(), (value) => value.scale),
  );
  const amount = (name: PaperProfitabilityComponentName): bigint =>
    unitsAtScale(parsed.get(name)!, scale);
  const tradingNet =
    amount("capturedMakerSpread") +
    amount("makerCredit") -
    amount("builderFees") -
    amount("venueFees") -
    amount("adverseFixedHorizonMarkout") -
    amount("gas") +
    amount("carryAndFundingNet") +
    amount("hedgeAndUnwindNet");

  return {
    status: tradingNet > 0n ? "positive" : "non_positive",
    ...baseResult,
    tradingNetUsd: formatUnits(tradingNet, scale),
  };
}
