/**
 * Durable, source-aware contracts for the measured Inventory recycling
 * strategy. Monetary values stay as decimal strings at this boundary: source
 * precision is evidence, and callers must not turn it into binary floats just
 * to persist it.
 */

export type DecimalString = string;

export type Coverage = "complete" | "partial" | "stale" | "unavailable";

export type CounterpartyClass =
  "known_same_parent" | "verified_other_parent" | "unresolved";

export type SourceCheckpoint = {
  source: string;
  network: string;
  cursor: string | null;
  coverage: Coverage;
  observedAtMs: number;
  missingReason: string | null;
};

export type InventoryMarketObservation = {
  marketId: string;
  observedAtMs: number;
  sourceTimestampMs: number | null;
  indexUsd: DecimalString;
  bestBidUsd: DecimalString;
  bestAskUsd: DecimalString;
  depthBid50BpsUsd: DecimalString;
  depthAsk50BpsUsd: DecimalString;
  volume24hUsd: DecimalString;
  openInterestUsd: DecimalString;
  fundingRateRaw: string;
  fundingPeriodMs: number;
  makerFeeRate: DecimalString;
  takerFeeRate: DecimalString;
  sessionOpen: boolean;
  source: string;
  network: string;
  coverage: Coverage;
  raw: unknown;
};

export type AttributedFill = {
  sourceEventKey: string;
  runId: string;
  accountId: string;
  ownerWallet: string;
  marketId: string;
  orderId: string | null;
  txDigest: string;
  eventIndex: number | null;
  timestampMs: number;
  side: "buy" | "sell";
  liquidity: "maker" | "taker";
  sizeBase: DecimalString;
  priceUsd: DecimalString;
  notionalUsd: DecimalString;
  venueFeeUsd: DecimalString;
  builderFeeUsd: DecimalString | null;
  realizedPnlUsd: DecimalString;
  counterpartyClass: CounterpartyClass;
  classificationEvidence: string[];
  source: string;
  network: string;
  coverage: Coverage;
  raw: unknown;
};

export type RewardAllocation = {
  epoch: number;
  ownerWallet: string;
  status: "estimate" | "final_export" | "paid_verified";
  makerRewardUsd: DecimalString;
  takerRewardUsd: DecimalString;
  makerVolumeRebateUsd: DecimalString;
  makerFeeRebateUsd: DecimalString;
  takerFeeRebateUsd: DecimalString;
  referralUsd: DecimalString;
  integratorUsd: DecimalString;
  sourceFetchedAtMs: number;
  source: string;
  network: string;
  coverage: Coverage;
  raw: unknown;
};

/** Parent-cap evidence is deliberately strict: an unseen counterparty is not
 * evidence of independent volume. */
export function classifyCounterparty(inputs: {
  ownerParentCapId: string | null;
  counterpartyParentCapId: string | null;
}): CounterpartyClass {
  if (!inputs.ownerParentCapId || !inputs.counterpartyParentCapId) {
    return "unresolved";
  }
  return inputs.ownerParentCapId === inputs.counterpartyParentCapId
    ? "known_same_parent"
    : "verified_other_parent";
}

/** A canonical on-chain event never needs a heuristic hash. Sources that omit
 * the event index must supply their own stable normalized-event fingerprint. */
export function sourceEventKey(inputs: {
  network: string;
  txDigest: string;
  eventIndex: number | null;
  normalizedEventFingerprint?: string;
}): string {
  if (inputs.eventIndex !== null) {
    if (!Number.isInteger(inputs.eventIndex) || inputs.eventIndex < 0) {
      throw new Error("Event index must be a non-negative integer");
    }
    return `${inputs.network}:${inputs.txDigest}:${inputs.eventIndex}`;
  }
  if (!inputs.normalizedEventFingerprint) {
    throw new Error("Missing normalized event fingerprint");
  }
  return `${inputs.network}:${inputs.txDigest}:hash:${inputs.normalizedEventFingerprint}`;
}

export function isDecimalString(value: string): value is DecimalString {
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}
