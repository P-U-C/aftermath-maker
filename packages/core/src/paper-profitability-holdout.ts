import type { DecimalString } from "./inventory-recycling.js";
import type { PaperProfitabilityEvidenceResult } from "./paper-profitability-evidence.js";
import {
  assessPaperProfitabilityStability,
  type PaperProfitabilityStabilityReason,
  type PaperProfitabilityStabilityWindow,
  type PaperProfitabilityWorstWindow,
} from "./paper-profitability-stability.js";
import type { ExactDecimalRatio } from "./paper-profitability-ranking.js";

export type PaperProfitabilityHoldoutCohort = Readonly<{
  runId: string;
  accountId: string;
  marketId: string;
  configVersion: number;
  network: string;
}>;

export type PaperProfitabilityHoldoutWindow = Readonly<{
  windowId: string;
  windowStartAtMs: number;
  windowEndAtMs: number;
  cohort: PaperProfitabilityHoldoutCohort;
  result: PaperProfitabilityEvidenceResult | null;
}>;

export type PaperProfitabilityHoldoutInput = Readonly<{
  candidateId: string;
  marketId: string;
  collateralUsd: DecimalString;
  cohort: PaperProfitabilityHoldoutCohort;
  minimumTrainWindows: number;
  minimumValidationWindows: number;
  trainWindows: readonly (PaperProfitabilityHoldoutWindow | null)[];
  validationWindows: readonly (PaperProfitabilityHoldoutWindow | null)[];
}>;

export type PaperProfitabilityHoldoutReason =
  | PaperProfitabilityStabilityReason
  | "malformed_candidate"
  | "malformed_train_windows"
  | "malformed_validation_windows"
  | "invalid_candidate_id"
  | "invalid_market_id"
  | "invalid_collateral_usd"
  | "non_positive_collateral_usd"
  | "invalid_cohort"
  | "cohort_mismatch"
  | "invalid_minimum_train_windows"
  | "invalid_minimum_validation_windows"
  | "insufficient_train_windows"
  | "insufficient_validation_windows"
  | "chronological_gap"
  | "train_after_validation";

export type PaperProfitabilityHoldoutCohortSnapshot = Readonly<{
  runId: string | null;
  accountId: string | null;
  marketId: string | null;
  configVersion: number | null;
  network: string | null;
}>;

export type PaperProfitabilityHoldoutWindowResult = Readonly<{
  phase: "train" | "validation";
  windowId: string | null;
  windowStartAtMs: number | null;
  windowEndAtMs: number | null;
  measurementWindowMs: number | null;
  cohort: PaperProfitabilityHoldoutCohortSnapshot;
  status: "complete" | "positive" | "ineligible";
  reasons: readonly PaperProfitabilityHoldoutReason[];
  netUsdPerDay: ExactDecimalRatio | null;
  netReturnBpsPerDay: ExactDecimalRatio | null;
}>;

export type PaperProfitabilityHoldoutResult = Readonly<{
  candidateId: string | null;
  marketId: string | null;
  collateralUsd: DecimalString | null;
  cohort: PaperProfitabilityHoldoutCohortSnapshot;
  minimumTrainWindows: number | null;
  minimumValidationWindows: number | null;
  status: "eligible" | "ineligible";
  reasons: readonly PaperProfitabilityHoldoutReason[];
  trainWindows: readonly PaperProfitabilityHoldoutWindowResult[];
  validationWindows: readonly PaperProfitabilityHoldoutWindowResult[];
  worstValidationWindow: PaperProfitabilityWorstWindow | null;
}>;

type CandidateSnapshot = Readonly<{
  malformed: boolean;
  candidateId: string | null;
  marketId: string | null;
  collateralUsd: string | null;
  cohort: PaperProfitabilityHoldoutCohortSnapshot;
  minimumTrainWindows: number | null;
  minimumValidationWindows: number | null;
  trainWindows: readonly unknown[] | null;
  validationWindows: readonly unknown[] | null;
}>;

type IndexedWindow = Readonly<{
  raw: unknown;
  inputIndex: number;
  windowId: string | null;
  windowStartAtMs: number | null;
  windowEndAtMs: number | null;
  cohort: PaperProfitabilityHoldoutCohortSnapshot;
}>;

type MutableWindowResult = {
  phase: "train" | "validation";
  windowId: string | null;
  windowStartAtMs: number | null;
  windowEndAtMs: number | null;
  measurementWindowMs: number | null;
  cohort: PaperProfitabilityHoldoutCohortSnapshot;
  status: "complete" | "positive" | "ineligible";
  reasons: PaperProfitabilityHoldoutReason[];
  netUsdPerDay: ExactDecimalRatio | null;
  netReturnBpsPerDay: ExactDecimalRatio | null;
};

const DECIMAL_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/;
const MAX_DECIMAL_DIGITS = 128;
const TRAIN_NON_POSITIVE_REASONS = new Set<PaperProfitabilityHoldoutReason>([
  "result_not_positive",
  "non_positive_trading_net_usd",
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pushReason(
  reasons: PaperProfitabilityHoldoutReason[],
  reason: PaperProfitabilityHoldoutReason,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function snapshotString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function snapshotNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function snapshotCohort(
  value: unknown,
): PaperProfitabilityHoldoutCohortSnapshot {
  const source = isRecord(value) ? value : null;
  return {
    runId: snapshotString(source?.runId),
    accountId: snapshotString(source?.accountId),
    marketId: snapshotString(source?.marketId),
    configVersion: snapshotNumber(source?.configVersion),
    network: snapshotString(source?.network),
  };
}

function isValidCohort(
  cohort: PaperProfitabilityHoldoutCohortSnapshot,
): boolean {
  return (
    cohort.runId !== null &&
    cohort.runId.trim() !== "" &&
    cohort.accountId !== null &&
    cohort.accountId.trim() !== "" &&
    cohort.marketId !== null &&
    cohort.marketId.trim() !== "" &&
    cohort.configVersion !== null &&
    Number.isSafeInteger(cohort.configVersion) &&
    cohort.configVersion >= 0 &&
    cohort.network !== null &&
    cohort.network.trim() !== ""
  );
}

function cohortsMatch(
  left: PaperProfitabilityHoldoutCohortSnapshot,
  right: PaperProfitabilityHoldoutCohortSnapshot,
): boolean {
  return (
    isValidCohort(left) &&
    isValidCohort(right) &&
    left.runId === right.runId &&
    left.accountId === right.accountId &&
    left.marketId === right.marketId &&
    left.configVersion === right.configVersion &&
    left.network === right.network
  );
}

function snapshotCandidate(input: unknown): CandidateSnapshot {
  const source = isRecord(input) ? input : null;
  const candidateId = snapshotString(source?.candidateId);
  const marketId = snapshotString(source?.marketId);
  const collateralUsd = snapshotString(source?.collateralUsd);
  const cohort = snapshotCohort(source?.cohort);
  const minimumTrainWindows = snapshotNumber(source?.minimumTrainWindows);
  const minimumValidationWindows = snapshotNumber(
    source?.minimumValidationWindows,
  );
  const trainWindows = Array.isArray(source?.trainWindows)
    ? source.trainWindows
    : null;
  const validationWindows = Array.isArray(source?.validationWindows)
    ? source.validationWindows
    : null;
  return {
    malformed:
      source === null ||
      candidateId === null ||
      marketId === null ||
      collateralUsd === null ||
      !isValidCohort(cohort) ||
      minimumTrainWindows === null ||
      minimumValidationWindows === null ||
      trainWindows === null ||
      validationWindows === null,
    candidateId,
    marketId,
    collateralUsd,
    cohort,
    minimumTrainWindows,
    minimumValidationWindows,
    trainWindows,
    validationWindows,
  };
}

function collateralReason(
  value: string | null,
): PaperProfitabilityHoldoutReason | null {
  if (value === null) return "invalid_collateral_usd";
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) return "invalid_collateral_usd";
  const fraction = match[3] ?? "";
  if (match[2]!.length + fraction.length > MAX_DECIMAL_DIGITS) {
    return "invalid_collateral_usd";
  }
  const magnitude = BigInt(`${match[2]}${fraction}`);
  const units = match[1] === "-" ? -magnitude : magnitude;
  return units <= 0n ? "non_positive_collateral_usd" : null;
}

function compareNullableNumber(
  left: number | null,
  right: number | null,
): number {
  if (left === null && right !== null) return -1;
  if (left !== null && right === null) return 1;
  if (left === null || right === null) return 0;
  if (left < right) return -1;
  if (left > right) return 1;
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

function compareIndexedWindows(
  left: IndexedWindow,
  right: IndexedWindow,
): number {
  const start = compareNullableNumber(
    left.windowStartAtMs,
    right.windowStartAtMs,
  );
  if (start !== 0) return start;
  const end = compareNullableNumber(left.windowEndAtMs, right.windowEndAtMs);
  if (end !== 0) return end;
  const id = compareNullableText(left.windowId, right.windowId);
  if (id !== 0) return id;
  return left.inputIndex - right.inputIndex;
}

function indexWindows(windows: readonly unknown[]): IndexedWindow[] {
  return windows
    .map((raw, inputIndex) => {
      const source = isRecord(raw) ? raw : null;
      return {
        raw,
        inputIndex,
        windowId: snapshotString(source?.windowId),
        windowStartAtMs: snapshotNumber(source?.windowStartAtMs),
        windowEndAtMs: snapshotNumber(source?.windowEndAtMs),
        cohort: snapshotCohort(source?.cohort),
      };
    })
    .sort(compareIndexedWindows);
}

function assessSegment(
  phase: "train" | "validation",
  indexed: readonly IndexedWindow[],
  snapshot: CandidateSnapshot,
  minimumWindows: number,
): MutableWindowResult[] {
  const assessment = assessPaperProfitabilityStability({
    candidateId: snapshot.candidateId ?? "",
    marketId: snapshot.marketId ?? "",
    collateralUsd: snapshot.collateralUsd ?? "",
    minimumWindows,
    windows: indexed.map(
      ({ raw }) => raw as PaperProfitabilityStabilityWindow | null,
    ),
  });
  return assessment.windows.map((window, index) => {
    const source = indexed[index]!;
    const sourceRecord = isRecord(source.raw) ? source.raw : null;
    const sourceResult = isRecord(sourceRecord?.result)
      ? sourceRecord.result
      : null;
    const acceptsSignedNonPositiveTraining =
      phase === "train" &&
      sourceResult?.status === "non_positive" &&
      window.reasons.includes("result_not_positive") &&
      window.reasons.includes("non_positive_trading_net_usd") &&
      window.netUsdPerDay !== null &&
      window.netReturnBpsPerDay !== null;
    const reasons = window.reasons.filter(
      (reason) =>
        !acceptsSignedNonPositiveTraining ||
        !TRAIN_NON_POSITIVE_REASONS.has(reason),
    );
    if (!isValidCohort(source.cohort)) {
      pushReason(reasons, "invalid_cohort");
    } else if (!cohortsMatch(source.cohort, snapshot.cohort)) {
      pushReason(reasons, "cohort_mismatch");
    }
    return {
      phase,
      windowId: window.windowId,
      windowStartAtMs: window.windowStartAtMs,
      windowEndAtMs: window.windowEndAtMs,
      measurementWindowMs: window.measurementWindowMs,
      cohort: source.cohort,
      status:
        reasons.length === 0
          ? phase === "train"
            ? "complete"
            : "positive"
          : "ineligible",
      reasons,
      netUsdPerDay: window.netUsdPerDay,
      netReturnBpsPerDay: window.netReturnBpsPerDay,
    };
  });
}

function validBounds(window: MutableWindowResult): boolean {
  return (
    window.windowStartAtMs !== null &&
    Number.isSafeInteger(window.windowStartAtMs) &&
    window.windowStartAtMs >= 0 &&
    window.windowEndAtMs !== null &&
    Number.isSafeInteger(window.windowEndAtMs) &&
    window.windowEndAtMs > window.windowStartAtMs
  );
}

function compareWindowResults(
  left: MutableWindowResult,
  right: MutableWindowResult,
): number {
  const start = compareNullableNumber(
    left.windowStartAtMs,
    right.windowStartAtMs,
  );
  if (start !== 0) return start;
  const end = compareNullableNumber(left.windowEndAtMs, right.windowEndAtMs);
  if (end !== 0) return end;
  return compareNullableText(left.windowId, right.windowId);
}

function markChronology(
  train: MutableWindowResult[],
  validation: MutableWindowResult[],
): void {
  const all = [...train, ...validation]
    .filter(validBounds)
    .sort(compareWindowResults);
  const byId = new Map<string, MutableWindowResult[]>();
  for (const window of all) {
    if (window.windowId !== null && window.windowId.trim() !== "") {
      const matches = byId.get(window.windowId) ?? [];
      matches.push(window);
      byId.set(window.windowId, matches);
    }
  }
  for (const duplicates of byId.values()) {
    if (duplicates.length > 1) {
      for (const window of duplicates) {
        pushReason(window.reasons, "duplicate_window_id");
      }
    }
  }

  let validationSeen = false;
  for (const window of all) {
    if (window.phase === "validation") {
      validationSeen = true;
    } else if (validationSeen) {
      pushReason(window.reasons, "train_after_validation");
    }
  }
  for (let index = 1; index < all.length; index += 1) {
    const previous = all[index - 1]!;
    const current = all[index]!;
    if (current.windowStartAtMs! < previous.windowEndAtMs!) {
      pushReason(previous.reasons, "overlapping_windows");
      pushReason(current.reasons, "overlapping_windows");
    } else if (current.windowStartAtMs! > previous.windowEndAtMs!) {
      pushReason(previous.reasons, "chronological_gap");
      pushReason(current.reasons, "chronological_gap");
    }
  }
  for (const window of all) {
    window.status =
      window.reasons.length === 0
        ? window.phase === "train"
          ? "complete"
          : "positive"
        : "ineligible";
  }
}

function snapshotWindow(
  window: MutableWindowResult,
): PaperProfitabilityHoldoutWindowResult {
  return {
    phase: window.phase,
    windowId: window.windowId,
    windowStartAtMs: window.windowStartAtMs,
    windowEndAtMs: window.windowEndAtMs,
    measurementWindowMs: window.measurementWindowMs,
    cohort: window.cohort,
    status: window.status,
    reasons: window.reasons,
    netUsdPerDay: window.netUsdPerDay,
    netReturnBpsPerDay: window.netReturnBpsPerDay,
  };
}

/**
 * Assesses Paper walk-forward evidence. Training evidence establishes only a
 * chronological pre-holdout sample; it never substitutes for complete,
 * strictly positive validation evidence and cannot authorize execution.
 */
export function assessPaperProfitabilityHoldout(
  input: PaperProfitabilityHoldoutInput | null,
): PaperProfitabilityHoldoutResult {
  const snapshot = snapshotCandidate(input);
  const reasons: PaperProfitabilityHoldoutReason[] = [];
  if (snapshot.malformed) pushReason(reasons, "malformed_candidate");
  if (snapshot.candidateId === null || snapshot.candidateId.trim() === "") {
    pushReason(reasons, "invalid_candidate_id");
  }
  if (snapshot.marketId === null || snapshot.marketId.trim() === "") {
    pushReason(reasons, "invalid_market_id");
  }
  const collateralGap = collateralReason(snapshot.collateralUsd);
  if (collateralGap !== null) pushReason(reasons, collateralGap);
  if (!isValidCohort(snapshot.cohort)) pushReason(reasons, "invalid_cohort");
  if (
    isValidCohort(snapshot.cohort) &&
    snapshot.marketId !== snapshot.cohort.marketId
  ) {
    pushReason(reasons, "cohort_mismatch");
  }

  const trainMinimumIsValid =
    snapshot.minimumTrainWindows !== null &&
    Number.isSafeInteger(snapshot.minimumTrainWindows) &&
    snapshot.minimumTrainWindows > 0;
  if (!trainMinimumIsValid) {
    pushReason(reasons, "invalid_minimum_train_windows");
  }
  const validationMinimumIsValid =
    snapshot.minimumValidationWindows !== null &&
    Number.isSafeInteger(snapshot.minimumValidationWindows) &&
    snapshot.minimumValidationWindows > 0;
  if (!validationMinimumIsValid) {
    pushReason(reasons, "invalid_minimum_validation_windows");
  }
  if (snapshot.trainWindows === null) {
    pushReason(reasons, "malformed_train_windows");
  }
  if (snapshot.validationWindows === null) {
    pushReason(reasons, "malformed_validation_windows");
  }

  const train = assessSegment(
    "train",
    indexWindows(snapshot.trainWindows ?? []),
    snapshot,
    trainMinimumIsValid ? snapshot.minimumTrainWindows! : 1,
  );
  const validation = assessSegment(
    "validation",
    indexWindows(snapshot.validationWindows ?? []),
    snapshot,
    validationMinimumIsValid ? snapshot.minimumValidationWindows! : 1,
  );
  markChronology(train, validation);

  const completeTrain = train.filter(
    (window) => window.status === "complete",
  ).length;
  const positiveValidation = validation.filter(
    (window) => window.status === "positive",
  ).length;
  if (trainMinimumIsValid && completeTrain < snapshot.minimumTrainWindows!) {
    pushReason(reasons, "insufficient_train_windows");
  }
  if (
    validationMinimumIsValid &&
    positiveValidation < snapshot.minimumValidationWindows!
  ) {
    pushReason(reasons, "insufficient_validation_windows");
  }
  for (const window of [...train, ...validation]) {
    for (const reason of window.reasons) pushReason(reasons, reason);
  }

  const validationStability = assessPaperProfitabilityStability({
    candidateId: snapshot.candidateId ?? "",
    marketId: snapshot.marketId ?? "",
    collateralUsd: snapshot.collateralUsd ?? "",
    minimumWindows: validationMinimumIsValid
      ? snapshot.minimumValidationWindows!
      : 1,
    windows: indexWindows(snapshot.validationWindows ?? []).map(
      ({ raw }) => raw as PaperProfitabilityStabilityWindow | null,
    ),
  });

  return {
    candidateId: snapshot.candidateId,
    marketId: snapshot.marketId,
    collateralUsd: snapshot.collateralUsd,
    cohort: snapshot.cohort,
    minimumTrainWindows: snapshot.minimumTrainWindows,
    minimumValidationWindows: snapshot.minimumValidationWindows,
    status: reasons.length === 0 ? "eligible" : "ineligible",
    reasons,
    trainWindows: train.map(snapshotWindow),
    validationWindows: validation.map(snapshotWindow),
    worstValidationWindow: validationStability.worstWindow,
  };
}
