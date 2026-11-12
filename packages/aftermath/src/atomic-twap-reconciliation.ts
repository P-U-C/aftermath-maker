/**
 * The immutable portion of an Atomic-TWAP leg returned by Aftermath's
 * `twap-order-datas` endpoint. Unsigned integer fields accept exact decimal
 * strings as returned by the provider, never lossy JavaScript numbers. This
 * module validates recorded JSON only and never constructs a provider request
 * or transaction.
 */
export type AtomicTwapUnsignedInteger = number | string;

export type AtomicTwapOrderDefinition = {
  marketId: string;
  side: 0 | 1;
  size: AtomicTwapUnsignedInteger;
  reduceOnly: boolean;
  chunksAmount: AtomicTwapUnsignedInteger;
  executionGapMs: AtomicTwapUnsignedInteger;
  executionTimeUncertaintyMs: AtomicTwapUnsignedInteger;
  firstRunExpireTimestamp?: AtomicTwapUnsignedInteger;
  expireTimestamp?: AtomicTwapUnsignedInteger;
  timeForRetryMs: AtomicTwapUnsignedInteger;
  amountUncertaintyBps: AtomicTwapUnsignedInteger;
  maxOneExecutionAmountBps: AtomicTwapUnsignedInteger;
  smallTailMergeThresholdBps: AtomicTwapUnsignedInteger;
  maxSlippageBps: AtomicTwapUnsignedInteger;
};

export type AtomicTwapExpectedBasket = {
  basketId: string;
  legs: Array<{
    twapOrderObjectId: string;
    details: AtomicTwapOrderDefinition;
  }>;
};

export type AtomicTwapReconciliationInput = {
  expected: AtomicTwapExpectedBasket;
  snapshot: unknown;
  /** Caller-supplied clock; this module never reads system time. */
  nowMs: number;
  maxSnapshotAgeMs: number;
};

export type AtomicTwapReconciliationResult =
  | {
      kind: "trusted";
      basketId: string;
      orderState: "cancelled" | "completed";
      legs: Array<{
        twapOrderObjectId: string;
        processedAmount: string;
        scheduledAmount: string;
      }>;
    }
  | { kind: "unavailable"; reason: string };

type RecordValue = Record<string, unknown>;

function unavailable(reason: string): AtomicTwapReconciliationResult {
  return { kind: "unavailable", reason };
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseUnsignedInteger(value: unknown): bigint | undefined {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Number.isFinite(value) &&
    value >= 0
  ) {
    return BigInt(value);
  }

  if (typeof value !== "string" || !/^(0|[1-9]\d*)n?$/.test(value)) {
    return undefined;
  }

  const parsed = BigInt(value.endsWith("n") ? value.slice(0, -1) : value);
  return parsed;
}

function nonNegativeInteger(
  value: unknown,
): value is AtomicTwapUnsignedInteger {
  return parseUnsignedInteger(value) !== undefined;
}

function positiveInteger(value: unknown): value is AtomicTwapUnsignedInteger {
  const parsed = parseUnsignedInteger(value);
  return parsed !== undefined && parsed > 0n;
}

function isTerminalState(value: unknown): value is "cancelled" | "completed" {
  return value === "cancelled" || value === "completed";
}

function optionalTimestampMatches(
  actual: unknown,
  expected: AtomicTwapUnsignedInteger | undefined,
): boolean {
  if (expected === undefined) return actual === undefined || actual === null;
  const parsedExpected = parseUnsignedInteger(expected);
  return (
    parsedExpected !== undefined &&
    parseUnsignedInteger(actual) === parsedExpected
  );
}

function validDefinition(
  definition: AtomicTwapOrderDefinition,
): definition is AtomicTwapOrderDefinition {
  return (
    nonEmptyString(definition.marketId) &&
    (definition.side === 0 || definition.side === 1) &&
    positiveInteger(definition.size) &&
    typeof definition.reduceOnly === "boolean" &&
    positiveInteger(definition.chunksAmount) &&
    nonNegativeInteger(definition.executionGapMs) &&
    nonNegativeInteger(definition.executionTimeUncertaintyMs) &&
    (definition.firstRunExpireTimestamp === undefined ||
      nonNegativeInteger(definition.firstRunExpireTimestamp)) &&
    (definition.expireTimestamp === undefined ||
      nonNegativeInteger(definition.expireTimestamp)) &&
    nonNegativeInteger(definition.timeForRetryMs) &&
    nonNegativeInteger(definition.amountUncertaintyBps) &&
    nonNegativeInteger(definition.maxOneExecutionAmountBps) &&
    nonNegativeInteger(definition.smallTailMergeThresholdBps) &&
    nonNegativeInteger(definition.maxSlippageBps)
  );
}

function matchesDefinition(
  value: unknown,
  expected: AtomicTwapOrderDefinition,
): boolean {
  if (!isRecord(value) || !validDefinition(expected)) return false;

  return (
    value.marketId === expected.marketId &&
    value.side === expected.side &&
    parseUnsignedInteger(value.size) === parseUnsignedInteger(expected.size) &&
    value.reduceOnly === expected.reduceOnly &&
    parseUnsignedInteger(value.chunksAmount) ===
      parseUnsignedInteger(expected.chunksAmount) &&
    parseUnsignedInteger(value.executionGapMs) ===
      parseUnsignedInteger(expected.executionGapMs) &&
    parseUnsignedInteger(value.executionTimeUncertaintyMs) ===
      parseUnsignedInteger(expected.executionTimeUncertaintyMs) &&
    optionalTimestampMatches(
      value.firstRunExpireTimestamp,
      expected.firstRunExpireTimestamp,
    ) &&
    optionalTimestampMatches(value.expireTimestamp, expected.expireTimestamp) &&
    parseUnsignedInteger(value.timeForRetryMs) ===
      parseUnsignedInteger(expected.timeForRetryMs) &&
    parseUnsignedInteger(value.amountUncertaintyBps) ===
      parseUnsignedInteger(expected.amountUncertaintyBps) &&
    parseUnsignedInteger(value.maxOneExecutionAmountBps) ===
      parseUnsignedInteger(expected.maxOneExecutionAmountBps) &&
    parseUnsignedInteger(value.smallTailMergeThresholdBps) ===
      parseUnsignedInteger(expected.smallTailMergeThresholdBps) &&
    parseUnsignedInteger(value.maxSlippageBps) ===
      parseUnsignedInteger(expected.maxSlippageBps)
  );
}

function readSnapshot(
  snapshot: unknown,
): { capturedAtMs: bigint; twapOrderDatas: RecordValue[] } | undefined {
  if (!isRecord(snapshot)) {
    return undefined;
  }
  const capturedAtMs = parseUnsignedInteger(snapshot.capturedAtMs);
  if (capturedAtMs === undefined) return undefined;
  if (!Array.isArray(snapshot.twapOrderDatas)) return undefined;
  if (!snapshot.twapOrderDatas.every(isRecord)) return undefined;
  return {
    capturedAtMs,
    twapOrderDatas: snapshot.twapOrderDatas,
  };
}

/**
 * Normalizes a recorded Atomic-TWAP read response only when it is complete,
 * fresh and internally consistent. Any uncertainty leaves the basket held.
 */
export function normalizeAtomicTwapSnapshot(
  input: AtomicTwapReconciliationInput,
): AtomicTwapReconciliationResult {
  if (
    !nonNegativeInteger(input.nowMs) ||
    !nonNegativeInteger(input.maxSnapshotAgeMs) ||
    !nonEmptyString(input.expected.basketId) ||
    input.expected.legs.length === 0
  ) {
    return unavailable("invalid reconciliation input");
  }

  const expectedByOrderId = new Map<string, AtomicTwapOrderDefinition>();
  for (const leg of input.expected.legs) {
    if (
      !nonEmptyString(leg.twapOrderObjectId) ||
      !validDefinition(leg.details) ||
      expectedByOrderId.has(leg.twapOrderObjectId)
    ) {
      return unavailable("invalid expected basket");
    }
    expectedByOrderId.set(leg.twapOrderObjectId, leg.details);
  }

  const parsed = readSnapshot(input.snapshot);
  if (!parsed) return unavailable("malformed provider snapshot");
  const nowMs = BigInt(input.nowMs);
  const maxSnapshotAgeMs = BigInt(input.maxSnapshotAgeMs);
  if (parsed.capturedAtMs > nowMs) {
    return unavailable("provider snapshot is from the future");
  }
  if (nowMs - parsed.capturedAtMs > maxSnapshotAgeMs) {
    return unavailable("provider snapshot is stale");
  }

  const recordsByOrderId = new Map<string, RecordValue[]>();
  for (const record of parsed.twapOrderDatas) {
    const orderId = record.twapOrderObjectId;
    if (record.basketId === input.expected.basketId) {
      if (!nonEmptyString(orderId) || !expectedByOrderId.has(orderId)) {
        return unavailable("provider basket includes an unexpected leg");
      }
    }
    if (!nonEmptyString(orderId) || !expectedByOrderId.has(orderId)) continue;
    recordsByOrderId.set(orderId, [
      ...(recordsByOrderId.get(orderId) ?? []),
      record,
    ]);
  }

  const trustedLegs: Array<{
    twapOrderObjectId: string;
    processedAmount: string;
    scheduledAmount: string;
  }> = [];
  let terminalState: "cancelled" | "completed" | undefined;

  for (const leg of input.expected.legs) {
    const matches = recordsByOrderId.get(leg.twapOrderObjectId);
    if (matches?.length !== 1) {
      return unavailable("expected basket leg is missing or duplicated");
    }

    const record = matches[0]!;
    if (record.basketId !== input.expected.basketId) {
      return unavailable("provider basket identity does not match");
    }
    if (!matchesDefinition(record.details, leg.details)) {
      return unavailable("provider order definition does not match");
    }
    const processedAmount = parseUnsignedInteger(record.processedAmount);
    const scheduledAmount = parseUnsignedInteger(record.scheduledAmount);
    const lastExecutionTimestampMs = parseUnsignedInteger(
      record.lastExecutionTimestampMs,
    );
    const orderCreationTimestampMs = parseUnsignedInteger(
      record.orderCreationTimestampMs,
    );
    if (
      processedAmount === undefined ||
      scheduledAmount === undefined ||
      lastExecutionTimestampMs === undefined ||
      orderCreationTimestampMs === undefined ||
      lastExecutionTimestampMs < orderCreationTimestampMs ||
      lastExecutionTimestampMs > parsed.capturedAtMs ||
      orderCreationTimestampMs > parsed.capturedAtMs
    ) {
      return unavailable("provider amounts or timestamps are invalid");
    }
    if (record.lastError !== undefined && record.lastError !== null) {
      return unavailable("provider reported an unresolved order error");
    }
    if (
      record.nextRetryTimestamp !== undefined &&
      record.nextRetryTimestamp !== null
    ) {
      return unavailable("provider reported a pending retry");
    }
    if (record.retryAttempt !== undefined && record.retryAttempt !== null) {
      return unavailable("provider reported a retry attempt");
    }
    if (record.retryLimit !== undefined && record.retryLimit !== null) {
      return unavailable("provider reported a retry limit");
    }
    if (!isTerminalState(record.orderState)) {
      return unavailable("provider order is not terminal");
    }
    if (terminalState && terminalState !== record.orderState) {
      return unavailable("provider terminal states disagree");
    }
    terminalState = record.orderState;

    const terminalAmountsAreConsistent =
      record.orderState === "completed"
        ? processedAmount === parseUnsignedInteger(leg.details.size) &&
          scheduledAmount === 0n
        : processedAmount === 0n && scheduledAmount === 0n;
    if (!terminalAmountsAreConsistent) {
      return unavailable("provider terminal amounts are inconsistent");
    }
    trustedLegs.push({
      twapOrderObjectId: leg.twapOrderObjectId,
      processedAmount: `${processedAmount}n`,
      scheduledAmount: `${scheduledAmount}n`,
    });
  }

  if (!terminalState) return unavailable("provider returned no basket legs");
  return {
    kind: "trusted",
    basketId: input.expected.basketId,
    orderState: terminalState,
    legs: trustedLegs,
  };
}
