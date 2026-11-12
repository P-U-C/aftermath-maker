import type { DecimalString } from "./inventory-recycling.js";
import type { ExactDecimalRatio } from "./paper-profitability-ranking.js";
import {
  assessPaperProfitabilityStability,
  type PaperProfitabilityStabilityInput,
  type PaperProfitabilityStabilityReason,
  type PaperProfitabilityStabilityWindow,
  type PaperProfitabilityStabilityWindowResult,
} from "./paper-profitability-stability.js";

/**
 * A declared Paper sensitivity assumption. It is neither venue/provider
 * evidence nor authority to execute.
 */
export type PaperProfitabilityStressScenario = Readonly<{
  scenarioId: string;
  label: string;
  shockUsd: DecimalString;
}>;

export type PaperProfitabilityStressInput = Readonly<{
  candidateId: string;
  marketId: string;
  collateralUsd: DecimalString;
  minimumWindows: number;
  windows: readonly (PaperProfitabilityStabilityWindow | null)[];
  scenarios: readonly (PaperProfitabilityStressScenario | null)[];
}>;

export type PaperProfitabilityStressReason =
  | PaperProfitabilityStabilityReason
  | "base_stability_ineligible"
  | "malformed_scenarios"
  | "empty_scenarios"
  | "malformed_scenario"
  | "invalid_scenario_id"
  | "invalid_scenario_label"
  | "invalid_shock_usd"
  | "negative_shock_usd"
  | "duplicate_scenario_id"
  | "non_positive_stressed_net_usd";

export type PaperProfitabilityStressWindowResult = Readonly<{
  windowId: string | null;
  windowStartAtMs: number | null;
  windowEndAtMs: number | null;
  measurementWindowMs: number | null;
  baseTradingNetUsd: DecimalString | null;
  stressedNetUsd: DecimalString | null;
  status: "positive" | "ineligible";
  reasons: readonly PaperProfitabilityStressReason[];
  netUsdPerDay: ExactDecimalRatio | null;
  netReturnBpsPerDay: ExactDecimalRatio | null;
}>;

export type PaperProfitabilityStressScenarioResult = Readonly<{
  scenarioId: string | null;
  label: string | null;
  shockUsd: DecimalString | null;
  status: "eligible" | "ineligible";
  reasons: readonly PaperProfitabilityStressReason[];
  windows: readonly PaperProfitabilityStressWindowResult[];
}>;

export type PaperProfitabilityStressWorstCase = Readonly<{
  scenarioId: string;
  label: string;
  shockUsd: DecimalString;
  windowId: string;
  windowStartAtMs: number;
  windowEndAtMs: number;
  measurementWindowMs: number;
  baseTradingNetUsd: DecimalString;
  stressedNetUsd: DecimalString;
  netUsdPerDay: ExactDecimalRatio;
  netReturnBpsPerDay: ExactDecimalRatio;
}>;

export type PaperProfitabilityStressResult = Readonly<{
  candidateId: string | null;
  marketId: string | null;
  collateralUsd: DecimalString | null;
  minimumWindows: number | null;
  baseStabilityStatus: "eligible" | "ineligible";
  baseStabilityReasons: readonly PaperProfitabilityStabilityReason[];
  status: "eligible" | "ineligible";
  reasons: readonly PaperProfitabilityStressReason[];
  scenarios: readonly PaperProfitabilityStressScenarioResult[];
  worstCase: PaperProfitabilityStressWorstCase | null;
}>;

type ParsedDecimal = Readonly<{
  units: bigint;
  scale: number;
  negativeSyntax: boolean;
}>;

type ExactRational = Readonly<{
  numerator: bigint;
  denominator: bigint;
}>;

type StressInputSnapshot = Readonly<{
  baseInput: PaperProfitabilityStabilityInput | null;
  rawWindows: readonly unknown[] | null;
  rawScenarios: readonly unknown[] | null;
}>;

type MutableScenario = {
  inputIndex: number;
  scenarioId: string | null;
  label: string | null;
  shockUsd: string | null;
  shock: ParsedDecimal | null;
  reasons: PaperProfitabilityStressReason[];
  windows: MutableStressWindow[];
};

type MutableStressWindow = {
  scenario: MutableScenario;
  windowId: string | null;
  windowStartAtMs: number | null;
  windowEndAtMs: number | null;
  measurementWindowMs: number | null;
  baseTradingNetUsd: string | null;
  stressedNetUsd: string | null;
  reasons: PaperProfitabilityStressReason[];
  netUsdPerDay: ExactRational | null;
  netReturnBpsPerDay: ExactRational | null;
};

const DECIMAL_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/;
const MAX_DECIMAL_DIGITS = 128;
const MILLISECONDS_PER_DAY = 86_400_000n;
const BASIS_POINTS_PER_UNIT = 10_000n;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pushReason(
  reasons: PaperProfitabilityStressReason[],
  reason: PaperProfitabilityStressReason,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function parseDecimal(value: unknown): ParsedDecimal | null {
  if (typeof value !== "string") return null;
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) return null;
  const whole = match[2]!;
  const fraction = match[3] ?? "";
  if (whole.length + fraction.length > MAX_DECIMAL_DIGITS) return null;
  const magnitude = BigInt(`${whole}${fraction}`);
  return {
    units: match[1] === "-" ? -magnitude : magnitude,
    scale: fraction.length,
    negativeSyntax: match[1] === "-",
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

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function reduceRatio(numerator: bigint, denominator: bigint): ExactRational {
  const normalizedNumerator = denominator < 0n ? -numerator : numerator;
  const normalizedDenominator = denominator < 0n ? -denominator : denominator;
  const divisor = greatestCommonDivisor(
    normalizedNumerator,
    normalizedDenominator,
  );
  return {
    numerator: normalizedNumerator / divisor,
    denominator: normalizedDenominator / divisor,
  };
}

function snapshotRatio(value: ExactRational): ExactDecimalRatio {
  return {
    numerator: value.numerator.toString(),
    denominator: value.denominator.toString(),
  };
}

function compareRatios(left: ExactRational, right: ExactRational): number {
  const leftProduct = left.numerator * right.denominator;
  const rightProduct = right.numerator * left.denominator;
  if (leftProduct < rightProduct) return -1;
  if (leftProduct > rightProduct) return 1;
  return 0;
}

function compareNullableText(
  left: string | null,
  right: string | null,
): number {
  const leftKey = left ?? "";
  const rightKey = right ?? "";
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return 0;
}

function compareScenarios(
  left: MutableScenario,
  right: MutableScenario,
): number {
  const idComparison = compareNullableText(left.scenarioId, right.scenarioId);
  if (idComparison !== 0) return idComparison;
  const labelComparison = compareNullableText(left.label, right.label);
  if (labelComparison !== 0) return labelComparison;
  const shockComparison = compareNullableText(left.shockUsd, right.shockUsd);
  if (shockComparison !== 0) return shockComparison;
  const reasonComparison = compareNullableText(
    left.reasons.join("\u0000"),
    right.reasons.join("\u0000"),
  );
  if (reasonComparison !== 0) return reasonComparison;
  return left.inputIndex - right.inputIndex;
}

function snapshotInput(input: unknown): StressInputSnapshot {
  const source = isRecord(input) ? input : null;
  if (source === null) {
    return {
      baseInput: null,
      rawWindows: null,
      rawScenarios: null,
    };
  }
  const rawWindows = Array.isArray(source.windows)
    ? Array.from(source.windows)
    : null;
  const rawScenarios = Array.isArray(source.scenarios)
    ? Array.from(source.scenarios)
    : null;
  const baseInput = {
    candidateId: source.candidateId,
    marketId: source.marketId,
    collateralUsd: source.collateralUsd,
    minimumWindows: source.minimumWindows,
    windows: rawWindows,
  } as unknown as PaperProfitabilityStabilityInput;
  return { baseInput, rawWindows, rawScenarios };
}

function parseScenario(input: unknown, inputIndex: number): MutableScenario {
  const source = isRecord(input) ? input : null;
  const scenarioId =
    typeof source?.scenarioId === "string" ? source.scenarioId : null;
  const label = typeof source?.label === "string" ? source.label : null;
  const shockUsd =
    typeof source?.shockUsd === "string" ? source.shockUsd : null;
  const shock = parseDecimal(shockUsd);
  const reasons: PaperProfitabilityStressReason[] = [];

  if (
    source === null ||
    scenarioId === null ||
    label === null ||
    shockUsd === null
  ) {
    pushReason(reasons, "malformed_scenario");
  }
  if (scenarioId === null || scenarioId.trim() === "") {
    pushReason(reasons, "invalid_scenario_id");
  }
  if (label === null || label.trim() === "") {
    pushReason(reasons, "invalid_scenario_label");
  }
  if (shock === null) {
    pushReason(reasons, "invalid_shock_usd");
  } else if (shock.negativeSyntax) {
    pushReason(reasons, "negative_shock_usd");
  }

  return {
    inputIndex,
    scenarioId,
    label,
    shockUsd,
    shock:
      shock !== null && !shock.negativeSyntax && shock.units >= 0n
        ? shock
        : null,
    reasons,
    windows: [],
  };
}

function markDuplicateScenarioIds(scenarios: MutableScenario[]): void {
  const scenariosById = new Map<string, MutableScenario[]>();
  for (const scenario of scenarios) {
    if (scenario.scenarioId === null || scenario.scenarioId.trim() === "") {
      continue;
    }
    const matches = scenariosById.get(scenario.scenarioId) ?? [];
    matches.push(scenario);
    scenariosById.set(scenario.scenarioId, matches);
  }
  for (const matches of scenariosById.values()) {
    if (matches.length < 2) continue;
    for (const scenario of matches) {
      pushReason(scenario.reasons, "duplicate_scenario_id");
    }
  }
}

function windowKey(
  windowId: string,
  windowStartAtMs: number,
  windowEndAtMs: number,
): string {
  return `${windowStartAtMs}\u0000${windowEndAtMs}\u0000${windowId}`;
}

function indexBaseTradingNet(
  rawWindows: readonly unknown[] | null,
): ReadonlyMap<string, string> {
  const byWindow = new Map<string, string>();
  for (const rawWindow of rawWindows ?? []) {
    if (!isRecord(rawWindow)) continue;
    const windowId =
      typeof rawWindow.windowId === "string" ? rawWindow.windowId : null;
    const windowStartAtMs =
      typeof rawWindow.windowStartAtMs === "number" &&
      Number.isSafeInteger(rawWindow.windowStartAtMs)
        ? rawWindow.windowStartAtMs
        : null;
    const windowEndAtMs =
      typeof rawWindow.windowEndAtMs === "number" &&
      Number.isSafeInteger(rawWindow.windowEndAtMs)
        ? rawWindow.windowEndAtMs
        : null;
    const result = isRecord(rawWindow.result) ? rawWindow.result : null;
    const tradingNetUsd =
      typeof result?.tradingNetUsd === "string" ? result.tradingNetUsd : null;
    if (
      windowId === null ||
      windowStartAtMs === null ||
      windowEndAtMs === null ||
      tradingNetUsd === null
    ) {
      continue;
    }
    byWindow.set(
      windowKey(windowId, windowStartAtMs, windowEndAtMs),
      tradingNetUsd,
    );
  }
  return byWindow;
}

function baseTradingNetForWindow(
  window: PaperProfitabilityStabilityWindowResult,
  tradingNetByWindow: ReadonlyMap<string, string>,
): string | null {
  if (
    window.windowId === null ||
    window.windowStartAtMs === null ||
    window.windowEndAtMs === null
  ) {
    return null;
  }
  return (
    tradingNetByWindow.get(
      windowKey(window.windowId, window.windowStartAtMs, window.windowEndAtMs),
    ) ?? null
  );
}

function makeStressWindow(
  scenario: MutableScenario,
  baseWindow: PaperProfitabilityStabilityWindowResult,
  baseIsEligible: boolean,
  baseTradingNetUsd: string | null,
  collateral: ParsedDecimal | null,
): MutableStressWindow {
  const reasons: PaperProfitabilityStressReason[] = [];
  if (!baseIsEligible) {
    for (const reason of baseWindow.reasons) pushReason(reasons, reason);
    pushReason(reasons, "base_stability_ineligible");
  }
  for (const reason of scenario.reasons) pushReason(reasons, reason);

  const window: MutableStressWindow = {
    scenario,
    windowId: baseWindow.windowId,
    windowStartAtMs: baseWindow.windowStartAtMs,
    windowEndAtMs: baseWindow.windowEndAtMs,
    measurementWindowMs: baseWindow.measurementWindowMs,
    baseTradingNetUsd: baseIsEligible ? baseTradingNetUsd : null,
    stressedNetUsd: null,
    reasons,
    netUsdPerDay: null,
    netReturnBpsPerDay: null,
  };

  if (
    reasons.length > 0 ||
    baseTradingNetUsd === null ||
    scenario.shock === null ||
    collateral === null ||
    collateral.units <= 0n ||
    baseWindow.measurementWindowMs === null ||
    !Number.isSafeInteger(baseWindow.measurementWindowMs) ||
    baseWindow.measurementWindowMs <= 0
  ) {
    return window;
  }

  const baseTradingNet = parseDecimal(baseTradingNetUsd);
  if (baseTradingNet === null) {
    pushReason(window.reasons, "invalid_trading_net_usd");
    return window;
  }
  const stressedScale = Math.max(baseTradingNet.scale, scenario.shock.scale);
  const stressedUnits =
    unitsAtScale(baseTradingNet, stressedScale) -
    unitsAtScale(scenario.shock, stressedScale);
  window.stressedNetUsd = formatUnits(stressedUnits, stressedScale);
  window.netUsdPerDay = reduceRatio(
    stressedUnits * MILLISECONDS_PER_DAY,
    powerOfTen(stressedScale) * BigInt(baseWindow.measurementWindowMs),
  );
  window.netReturnBpsPerDay = reduceRatio(
    window.netUsdPerDay.numerator *
      powerOfTen(collateral.scale) *
      BASIS_POINTS_PER_UNIT,
    window.netUsdPerDay.denominator * collateral.units,
  );
  if (stressedUnits <= 0n) {
    pushReason(window.reasons, "non_positive_stressed_net_usd");
  }
  return window;
}

function snapshotStressWindow(
  window: MutableStressWindow,
): PaperProfitabilityStressWindowResult {
  return {
    windowId: window.windowId,
    windowStartAtMs: window.windowStartAtMs,
    windowEndAtMs: window.windowEndAtMs,
    measurementWindowMs: window.measurementWindowMs,
    baseTradingNetUsd: window.baseTradingNetUsd,
    stressedNetUsd: window.stressedNetUsd,
    status: window.reasons.length === 0 ? "positive" : "ineligible",
    reasons: window.reasons,
    netUsdPerDay:
      window.netUsdPerDay === null ? null : snapshotRatio(window.netUsdPerDay),
    netReturnBpsPerDay:
      window.netReturnBpsPerDay === null
        ? null
        : snapshotRatio(window.netReturnBpsPerDay),
  };
}

function snapshotScenario(
  scenario: MutableScenario,
): PaperProfitabilityStressScenarioResult {
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    shockUsd: scenario.shockUsd,
    status:
      scenario.reasons.length === 0 &&
      scenario.windows.every((window) => window.reasons.length === 0)
        ? "eligible"
        : "ineligible",
    reasons: scenario.reasons,
    windows: scenario.windows.map(snapshotStressWindow),
  };
}

function compareStressWindows(
  left: MutableStressWindow,
  right: MutableStressWindow,
): number {
  if (
    left.netReturnBpsPerDay === null ||
    left.netUsdPerDay === null ||
    right.netReturnBpsPerDay === null ||
    right.netUsdPerDay === null
  ) {
    return 0;
  }
  const returnComparison = compareRatios(
    left.netReturnBpsPerDay,
    right.netReturnBpsPerDay,
  );
  if (returnComparison !== 0) return returnComparison;
  const netComparison = compareRatios(left.netUsdPerDay, right.netUsdPerDay);
  if (netComparison !== 0) return netComparison;
  const scenarioComparison = compareNullableText(
    left.scenario.scenarioId,
    right.scenario.scenarioId,
  );
  if (scenarioComparison !== 0) return scenarioComparison;
  if (left.windowStartAtMs !== right.windowStartAtMs) {
    return (left.windowStartAtMs ?? -1) - (right.windowStartAtMs ?? -1);
  }
  if (left.windowEndAtMs !== right.windowEndAtMs) {
    return (left.windowEndAtMs ?? -1) - (right.windowEndAtMs ?? -1);
  }
  return compareNullableText(left.windowId, right.windowId);
}

function snapshotWorstCase(
  scenarios: readonly MutableScenario[],
): PaperProfitabilityStressWorstCase | null {
  const measuredWindows = scenarios
    .flatMap((scenario) => scenario.windows)
    .filter(
      (
        window,
      ): window is MutableStressWindow & {
        scenario: MutableScenario & {
          scenarioId: string;
          label: string;
          shockUsd: string;
        };
        windowId: string;
        windowStartAtMs: number;
        windowEndAtMs: number;
        measurementWindowMs: number;
        baseTradingNetUsd: string;
        stressedNetUsd: string;
        netUsdPerDay: ExactRational;
        netReturnBpsPerDay: ExactRational;
      } =>
        window.scenario.scenarioId !== null &&
        window.scenario.label !== null &&
        window.scenario.shockUsd !== null &&
        window.windowId !== null &&
        window.windowStartAtMs !== null &&
        window.windowEndAtMs !== null &&
        window.measurementWindowMs !== null &&
        window.baseTradingNetUsd !== null &&
        window.stressedNetUsd !== null &&
        window.netUsdPerDay !== null &&
        window.netReturnBpsPerDay !== null,
    )
    .sort(compareStressWindows);
  const worst = measuredWindows[0];
  if (worst === undefined) return null;
  return {
    scenarioId: worst.scenario.scenarioId,
    label: worst.scenario.label,
    shockUsd: worst.scenario.shockUsd,
    windowId: worst.windowId,
    windowStartAtMs: worst.windowStartAtMs,
    windowEndAtMs: worst.windowEndAtMs,
    measurementWindowMs: worst.measurementWindowMs,
    baseTradingNetUsd: worst.baseTradingNetUsd,
    stressedNetUsd: worst.stressedNetUsd,
    netUsdPerDay: snapshotRatio(worst.netUsdPerDay),
    netReturnBpsPerDay: snapshotRatio(worst.netReturnBpsPerDay),
  };
}

/**
 * Applies declared Paper shock assumptions to every independently complete
 * profitability window. Admission is conservative: the base stability
 * contract must be eligible and every declared scenario/window must retain a
 * strictly positive stressed net. This reporting result cannot authorize
 * execution and does not turn assumptions into provider or Live evidence.
 */
export function assessPaperProfitabilityStress(
  input: PaperProfitabilityStressInput | null,
): PaperProfitabilityStressResult {
  const snapshot = snapshotInput(input);
  const base = assessPaperProfitabilityStability(snapshot.baseInput);
  const reasons: PaperProfitabilityStressReason[] = [];

  if (base.status !== "eligible") {
    pushReason(reasons, "base_stability_ineligible");
    for (const reason of base.reasons) pushReason(reasons, reason);
  }
  if (snapshot.rawScenarios === null) {
    pushReason(reasons, "malformed_scenarios");
  } else if (snapshot.rawScenarios.length === 0) {
    pushReason(reasons, "empty_scenarios");
  }

  const scenarios = (snapshot.rawScenarios ?? [])
    .map(parseScenario)
    .sort(compareScenarios);
  markDuplicateScenarioIds(scenarios);
  scenarios.sort(compareScenarios);

  const collateral = parseDecimal(base.collateralUsd);
  const tradingNetByWindow = indexBaseTradingNet(snapshot.rawWindows);
  for (const scenario of scenarios) {
    if (base.status !== "eligible") {
      pushReason(scenario.reasons, "base_stability_ineligible");
      for (const reason of base.reasons) pushReason(scenario.reasons, reason);
    }
    scenario.windows = base.windows.map((baseWindow) =>
      makeStressWindow(
        scenario,
        baseWindow,
        base.status === "eligible",
        baseTradingNetForWindow(baseWindow, tradingNetByWindow),
        collateral,
      ),
    );
    for (const window of scenario.windows) {
      for (const reason of window.reasons) pushReason(scenario.reasons, reason);
    }
    for (const reason of scenario.reasons) pushReason(reasons, reason);
  }

  const scenarioResults = scenarios.map(snapshotScenario);
  const status =
    reasons.length === 0 &&
    scenarios.length > 0 &&
    scenarioResults.every((scenario) => scenario.status === "eligible")
      ? "eligible"
      : "ineligible";

  return {
    candidateId: base.candidateId,
    marketId: base.marketId,
    collateralUsd: base.collateralUsd,
    minimumWindows: base.minimumWindows,
    baseStabilityStatus: base.status,
    baseStabilityReasons: base.reasons,
    status,
    reasons,
    scenarios: scenarioResults,
    worstCase: snapshotWorstCase(scenarios),
  };
}
