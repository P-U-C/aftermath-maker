/**
 * Validates recorded Aftermath Atomic market and preview responses. This is
 * deliberately an offline normalizer: it never fetches, builds, signs, or
 * submits anything. The published REST contract does not provide a concrete
 * Atomic gas reserve or a unit-safe open-interest conversion, so this module
 * never represents a basket as executable.
 */
export type AtomicMarketUnsignedInteger = number | string;

export type AtomicMarketCapabilityInput = {
  intendedMarkets: Array<{
    marketId: string;
    side: 0 | 1;
    size: AtomicMarketUnsignedInteger;
    notionalUsd: number;
  }>;
  snapshot: unknown;
  nowMs: AtomicMarketUnsignedInteger;
  maxSnapshotAgeMs: AtomicMarketUnsignedInteger;
  /** A recorded per-execution reservation, if a later evidence source has one. */
  gasReserveReceipt?: unknown;
};

export type AtomicMarketConstraint = {
  marketId: string;
  makerFee: number;
  takerFee: number;
  priorityTakerFee: number | null;
  marginRatioInitial: number;
  marginRatioMaintenance: number;
  minOrderUsdValue: number;
  lotSize: string;
  tickSize: string;
  maxPendingOrders: string;
  maxOpenInterest: number;
  maxOpenInterestThreshold: number;
  maxOpenInterestPositionPercent: number;
  /** Preserved, never compared with maxOpenInterest without unit evidence. */
  openInterest: number;
};

export type AtomicMarketCapabilityResult = {
  kind: "unavailable";
  reason:
    | "invalid-input"
    | "invalid-intended-markets"
    | "malformed-snapshot"
    | "future-snapshot"
    | "stale-snapshot"
    | "duplicate-market-snapshot"
    | "missing-market-snapshot"
    | "malformed-market-snapshot"
    | "invalid-order-lot"
    | "minimum-order-not-met"
    | "preview-unavailable"
    | "preview-order-mismatch"
    | "partial-or-posted-preview"
    | "gas-reserve-unavailable"
    | "oi-unit-semantics-unavailable";
  constraints: AtomicMarketConstraint[];
};

type RecordValue = Record<string, unknown>;

function unavailable(
  reason: AtomicMarketCapabilityResult["reason"],
  constraints: AtomicMarketConstraint[] = [],
): AtomicMarketCapabilityResult {
  return { kind: "unavailable", reason, constraints };
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

  return BigInt(value.endsWith("n") ? value.slice(0, -1) : value);
}

function canonicalUnsignedInteger(value: unknown): string | undefined {
  const parsed = parseUnsignedInteger(value);
  return parsed === undefined ? undefined : `${parsed}n`;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function fraction(value: unknown, positive = false): value is number {
  return (
    finiteNumber(value) && (positive ? value > 0 : value >= 0) && value < 1
  );
}

function positiveFiniteNumber(value: unknown): value is number {
  return finiteNumber(value) && value > 0;
}

function nonNegativeFiniteNumber(value: unknown): value is number {
  return finiteNumber(value) && value >= 0;
}

function nonNegativeUnsignedInteger(value: unknown): boolean {
  return parseUnsignedInteger(value) !== undefined;
}

function validIntendedMarkets(
  intendedMarkets: AtomicMarketCapabilityInput["intendedMarkets"],
): boolean {
  if (intendedMarkets.length === 0) return false;

  const seen = new Set<string>();
  return intendedMarkets.every((order) => {
    const size = parseUnsignedInteger(order.size);
    if (
      !nonEmptyString(order.marketId) ||
      seen.has(order.marketId) ||
      (order.side !== 0 && order.side !== 1) ||
      size === undefined ||
      size <= 0n ||
      !positiveFiniteNumber(order.notionalUsd)
    ) {
      return false;
    }
    seen.add(order.marketId);
    return true;
  });
}

function normalizeMarket(value: unknown): AtomicMarketConstraint | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.packageId) ||
    !nonEmptyString(value.objectId) ||
    !nonEmptyString(value.collateralCoinType) ||
    !positiveFiniteNumber(value.collateralPrice) ||
    !positiveFiniteNumber(value.indexPrice) ||
    !finiteNumber(value.estimatedFundingRate) ||
    !nonNegativeUnsignedInteger(value.nextFundingTimestampMs)
  ) {
    return undefined;
  }
  if (!isRecord(value.marketParams) || !isRecord(value.marketState))
    return undefined;

  const params = value.marketParams;
  const state = value.marketState;
  const lotSize = canonicalUnsignedInteger(params.lotSize);
  const tickSize = canonicalUnsignedInteger(params.tickSize);
  const maxPendingOrders = canonicalUnsignedInteger(params.maxPendingOrders);

  if (
    !nonEmptyString(params.baseAssetSymbol) ||
    !nonNegativeUnsignedInteger(params.basePriceFeedId) ||
    !nonNegativeUnsignedInteger(params.collateralPriceFeedId) ||
    !nonNegativeUnsignedInteger(params.fundingFrequencyMs) ||
    !nonNegativeUnsignedInteger(params.fundingPeriodMs) ||
    !nonNegativeUnsignedInteger(params.premiumTwapFrequencyMs) ||
    !nonNegativeUnsignedInteger(params.premiumTwapPeriodMs) ||
    !nonNegativeUnsignedInteger(params.spreadTwapFrequencyMs) ||
    !nonNegativeUnsignedInteger(params.spreadTwapPeriodMs) ||
    !fraction(params.makerFee) ||
    !fraction(params.takerFee) ||
    (params.priorityTakerFee !== null && !fraction(params.priorityTakerFee)) ||
    !fraction(params.liquidationFee) ||
    !fraction(params.insuranceFundFee) ||
    !fraction(params.marginRatioInitial, true) ||
    !fraction(params.marginRatioMaintenance, true) ||
    params.marginRatioMaintenance > params.marginRatioInitial ||
    !positiveFiniteNumber(params.minOrderUsdValue) ||
    lotSize === undefined ||
    BigInt(lotSize.slice(0, -1)) <= 0n ||
    tickSize === undefined ||
    BigInt(tickSize.slice(0, -1)) <= 0n ||
    maxPendingOrders === undefined ||
    BigInt(maxPendingOrders.slice(0, -1)) <= 0n ||
    !positiveFiniteNumber(params.scalingFactor) ||
    !nonNegativeUnsignedInteger(params.baseOracleTolerance) ||
    !nonNegativeUnsignedInteger(params.collateralOracleTolerance) ||
    !positiveFiniteNumber(params.maxOpenInterest) ||
    !nonNegativeFiniteNumber(params.maxOpenInterestThreshold) ||
    !fraction(params.maxOpenInterestPositionPercent, true) ||
    !finiteNumber(state.cumFundingRateLong) ||
    !finiteNumber(state.cumFundingRateShort) ||
    !nonNegativeUnsignedInteger(state.fundingLastUpdateTimestamp) ||
    !finiteNumber(state.premiumTwap) ||
    !nonNegativeUnsignedInteger(state.premiumTwapLastUpdateTimestamp) ||
    !finiteNumber(state.spreadTwap) ||
    !nonNegativeUnsignedInteger(state.spreadTwapLastUpdateTimestamp) ||
    !nonNegativeFiniteNumber(state.openInterest) ||
    !nonNegativeFiniteNumber(state.feesAccrued)
  ) {
    return undefined;
  }

  return {
    marketId: value.objectId,
    makerFee: params.makerFee,
    takerFee: params.takerFee,
    priorityTakerFee: params.priorityTakerFee,
    marginRatioInitial: params.marginRatioInitial,
    marginRatioMaintenance: params.marginRatioMaintenance,
    minOrderUsdValue: params.minOrderUsdValue,
    lotSize,
    tickSize,
    maxPendingOrders,
    maxOpenInterest: params.maxOpenInterest,
    maxOpenInterestThreshold: params.maxOpenInterestThreshold,
    maxOpenInterestPositionPercent: params.maxOpenInterestPositionPercent,
    openInterest: state.openInterest,
  };
}

function validUpdatedPosition(value: unknown, marketId: string): boolean {
  if (
    !isRecord(value) ||
    value.marketId !== marketId ||
    !Array.isArray(value.pendingOrders)
  ) {
    return false;
  }

  if (
    !value.pendingOrders.every(
      (order) =>
        isRecord(order) &&
        nonNegativeUnsignedInteger(order.orderId) &&
        (order.side === 0 || order.side === 1) &&
        nonNegativeUnsignedInteger(order.currentSize) &&
        nonNegativeUnsignedInteger(order.initialSize) &&
        (order.clientOrderId === undefined ||
          order.clientOrderId === null ||
          nonNegativeUnsignedInteger(order.clientOrderId)),
    )
  ) {
    return false;
  }

  return [
    value.collateral,
    value.baseAssetAmount,
    value.quoteAssetNotionalAmount,
    value.cumFundingRateLong,
    value.cumFundingRateShort,
    value.asksQuantity,
    value.bidsQuantity,
    value.leverage,
    value.collateralUsd,
    value.marginRatio,
    value.freeMarginUsd,
    value.freeCollateral,
    value.unrealizedFundingsUsd,
    value.unrealizedPnlUsd,
    value.entryPrice,
    value.liquidationPrice,
  ].every(finiteNumber);
}

function previewMatches(
  preview: unknown,
  intendedMarkets: AtomicMarketCapabilityInput["intendedMarkets"],
  constraintsByMarket: Map<string, AtomicMarketConstraint>,
): AtomicMarketCapabilityResult["reason"] | undefined {
  if (
    !isRecord(preview) ||
    !isRecord(preview.request) ||
    !isRecord(preview.response) ||
    Object.hasOwn(preview, "error")
  ) {
    return "preview-unavailable";
  }
  const { request, response } = preview;
  if (
    !Array.isArray(request.orders) ||
    !Array.isArray(response.orders) ||
    typeof request.reduceOnly !== "boolean" ||
    !finiteNumber(response.collateralChange) ||
    request.orders.length !== intendedMarkets.length ||
    response.orders.length !== intendedMarkets.length
  ) {
    return "preview-unavailable";
  }

  let perOrderCollateralChange = 0;
  for (const [index, intended] of intendedMarkets.entries()) {
    const requestOrder = request.orders[index];
    const responseOrder = response.orders[index];
    if (!isRecord(requestOrder) || !isRecord(responseOrder)) {
      return "preview-unavailable";
    }
    if (
      requestOrder.marketId !== intended.marketId ||
      requestOrder.side !== intended.side ||
      parseUnsignedInteger(requestOrder.size) !==
        parseUnsignedInteger(intended.size) ||
      responseOrder.marketId !== intended.marketId
    ) {
      return "preview-order-mismatch";
    }

    const filledSize = parseUnsignedInteger(responseOrder.filledSize);
    const postedSize = parseUnsignedInteger(responseOrder.postedSize);
    if (
      filledSize === undefined ||
      filledSize !== parseUnsignedInteger(intended.size) ||
      postedSize === undefined ||
      postedSize !== 0n
    ) {
      return "partial-or-posted-preview";
    }
    if (
      !validUpdatedPosition(responseOrder.updatedPosition, intended.marketId) ||
      !nonNegativeFiniteNumber(responseOrder.priceSlippage) ||
      !nonNegativeFiniteNumber(responseOrder.percentSlippage) ||
      !positiveFiniteNumber(responseOrder.filledSizeUsd) ||
      !finiteNumber(responseOrder.postedSizeUsd) ||
      responseOrder.postedSizeUsd !== 0 ||
      !finiteNumber(responseOrder.collateralChange) ||
      !positiveFiniteNumber(responseOrder.executionPrice) ||
      typeof responseOrder.hasPosition !== "boolean" ||
      typeof responseOrder.cancelSlTp !== "boolean"
    ) {
      return "preview-unavailable";
    }
    const constraint = constraintsByMarket.get(intended.marketId);
    if (
      !constraint ||
      responseOrder.filledSizeUsd < constraint.minOrderUsdValue
    ) {
      return "minimum-order-not-met";
    }
    perOrderCollateralChange += responseOrder.collateralChange;
    if (!Number.isFinite(perOrderCollateralChange))
      return "preview-unavailable";
  }

  if (perOrderCollateralChange !== response.collateralChange) {
    return "preview-unavailable";
  }

  return undefined;
}

function hasRecordedGasReserve(value: unknown, capturedAtMs: bigint): boolean {
  if (!isRecord(value) || !nonEmptyString(value.receiptId)) return false;
  const reservedMist = parseUnsignedInteger(value.reservedMist);
  return (
    reservedMist !== undefined &&
    reservedMist > 0n &&
    parseUnsignedInteger(value.capturedAtMs) === capturedAtMs
  );
}

/**
 * Normalizes only complete recorded constraints. A returned record is always
 * unavailable: the public market contract has no verifiable gas-reserve or
 * open-interest-unit evidence, and neither may be inferred from REST data.
 */
export function normalizeAtomicMarketCapability(
  input: AtomicMarketCapabilityInput,
): AtomicMarketCapabilityResult {
  const nowMs = parseUnsignedInteger(input.nowMs);
  const maxSnapshotAgeMs = parseUnsignedInteger(input.maxSnapshotAgeMs);
  if (nowMs === undefined || maxSnapshotAgeMs === undefined) {
    return unavailable("invalid-input");
  }
  if (!validIntendedMarkets(input.intendedMarkets)) {
    return unavailable("invalid-intended-markets");
  }
  if (!isRecord(input.snapshot) || !Array.isArray(input.snapshot.markets)) {
    return unavailable("malformed-snapshot");
  }
  const capturedAtMs = parseUnsignedInteger(input.snapshot.capturedAtMs);
  if (capturedAtMs === undefined) return unavailable("malformed-snapshot");
  if (capturedAtMs > nowMs) return unavailable("future-snapshot");
  if (nowMs - capturedAtMs > maxSnapshotAgeMs) {
    return unavailable("stale-snapshot");
  }

  const constraintsByMarket = new Map<string, AtomicMarketConstraint>();
  for (const market of input.snapshot.markets) {
    if (!isRecord(market) || !nonEmptyString(market.objectId)) {
      return unavailable("malformed-market-snapshot");
    }
    if (constraintsByMarket.has(market.objectId)) {
      return unavailable("duplicate-market-snapshot");
    }
    const normalized = normalizeMarket(market);
    if (!normalized) return unavailable("malformed-market-snapshot");
    constraintsByMarket.set(normalized.marketId, normalized);
  }

  const constraints: AtomicMarketConstraint[] = [];
  for (const intended of input.intendedMarkets) {
    const constraint = constraintsByMarket.get(intended.marketId);
    if (!constraint) return unavailable("missing-market-snapshot");
    const size = parseUnsignedInteger(intended.size)!;
    const lotSize = BigInt(constraint.lotSize.slice(0, -1));
    if (size % lotSize !== 0n) return unavailable("invalid-order-lot");
    constraints.push(constraint);
  }

  const previewReason = previewMatches(
    input.snapshot.atomicPreview,
    input.intendedMarkets,
    constraintsByMarket,
  );
  if (previewReason) return unavailable(previewReason, constraints);
  if (!hasRecordedGasReserve(input.gasReserveReceipt, capturedAtMs)) {
    return unavailable("gas-reserve-unavailable", constraints);
  }

  return unavailable("oi-unit-semantics-unavailable", constraints);
}
