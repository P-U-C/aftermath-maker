/**
 * Pure, read-only contracts for the first cross-venue funding experiment.
 *
 * This module intentionally has no Live mode and no venue client. Adapters may
 * supply observations to it, but execution stays outside this boundary. Every
 * amount is a base-10 decimal string and arithmetic uses fixed-point bigint so
 * an order boundary never depends on binary floating point.
 */

export type FundingVenue = "AFTERMATH" | "HYPERLIQUID";
export type FundingRunMode = "OBSERVE" | "PAPER";
export type FundingPairStatus = "RESEARCH" | "REVIEWED";
export type FundingReason =
  | "PAIR_UNREVIEWED"
  | "UNSUPPORTED_CONTRACT"
  | "STALE_DATA"
  | "INVALID_FUNDING_PERIOD"
  | "POST_ONLY_INVALID"
  | "LOT_MISMATCH"
  | "BELOW_MINIMUM"
  | "INSUFFICIENT_ENTRY_DEPTH"
  | "INSUFFICIENT_EXIT_DEPTH"
  | "NET_EDGE_NONPOSITIVE"
  | "PARTIAL_HEDGE"
  | "RECOVERY_REQUIRED";

export type Decimal = string;

const SCALE_DIGITS = 18n;
const SCALE = 10n ** SCALE_DIGITS;
const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function units(value: Decimal): bigint {
  if (!DECIMAL.test(value)) throw new Error(`Invalid decimal: ${value}`);
  const negative = value.startsWith("-");
  const [rawWhole, fraction = ""] = (negative ? value.slice(1) : value).split(
    ".",
  );
  const whole = rawWhole ?? "0";
  if (fraction.length > Number(SCALE_DIGITS)) {
    throw new Error(`Decimal supports at most ${SCALE_DIGITS} fraction digits`);
  }
  const result =
    BigInt(whole) * SCALE + BigInt(fraction.padEnd(Number(SCALE_DIGITS), "0"));
  return negative ? -result : result;
}

function decimal(value: bigint): Decimal {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / SCALE;
  const fraction = (absolute % SCALE)
    .toString()
    .padStart(Number(SCALE_DIGITS), "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function add(left: bigint, right: bigint) {
  return left + right;
}

function subtract(left: bigint, right: bigint) {
  return left - right;
}

function multiply(left: bigint, right: bigint) {
  return (left * right) / SCALE;
}

function divide(left: bigint, right: bigint) {
  if (right === 0n) throw new Error("Cannot divide by zero");
  return (left * SCALE) / right;
}

function nonNegative(value: Decimal, field: string): bigint {
  const result = units(value);
  if (result < 0n) throw new Error(`${field} must be non-negative`);
  return result;
}

function positive(value: Decimal, field: string): bigint {
  const result = units(value);
  if (result <= 0n) throw new Error(`${field} must be positive`);
  return result;
}

function minimum(left: bigint, right: bigint) {
  return left < right ? left : right;
}

function isLotAligned(base: bigint, market: FundingMarketSpec) {
  const multiplier = positive(market.contractMultiplier, "contractMultiplier");
  const lot = positive(market.lotSize, "lotSize");
  const contracts = divide(base, multiplier);
  return (
    multiply(contracts, multiplier) === base &&
    multiply(divide(contracts, lot), lot) === contracts
  );
}

export type FundingMarketSpec = {
  venue: FundingVenue;
  instrumentId: string;
  underlying: "BTC" | "ETH";
  contractKind: "LINEAR_USDC" | "UNSUPPORTED";
  collateral: "USDC" | "UNSUPPORTED";
  contractMultiplier: Decimal;
  lotSize: Decimal;
  minOrderNotionalUsd: Decimal;
};

/** A mapping may only become executable after its exact instrument facts are reviewed. */
export type FundingPairMapping = {
  id: string;
  status: FundingPairStatus;
  reviewedAtMs: number | null;
  aftermath: FundingMarketSpec;
  hyperliquid: FundingMarketSpec;
};

/** ETH/BTC are research candidates only until a reviewer supplies exact venue metadata. */
export const fundingResearchPairs = ["ETH", "BTC"] as const;

export function validateFundingPair(
  mapping: FundingPairMapping,
): FundingReason[] {
  const reasons: FundingReason[] = [];
  if (mapping.status !== "REVIEWED" || mapping.reviewedAtMs === null) {
    reasons.push("PAIR_UNREVIEWED");
  }
  const markets = [mapping.aftermath, mapping.hyperliquid];
  if (
    markets.some(
      (market) =>
        market.contractKind !== "LINEAR_USDC" ||
        market.collateral !== "USDC" ||
        units(market.contractMultiplier) <= 0n ||
        units(market.lotSize) <= 0n ||
        units(market.minOrderNotionalUsd) <= 0n,
    ) ||
    mapping.aftermath.underlying !== mapping.hyperliquid.underlying
  ) {
    reasons.push("UNSUPPORTED_CONTRACT");
  }
  return reasons;
}

export type FundingObservation = {
  venue: FundingVenue;
  instrumentId: string;
  /** Signed decimal: positive means longs pay shorts. */
  rate: Decimal;
  /** The source rate covers this many hours. HL hourly observations use "1". */
  ratePeriodHours: Decimal;
  measuredAtMs: number;
  validUntilMs: number;
  kind: "estimate" | "historical" | "realized";
  source: string;
};

export function normalizeFundingHourly(
  observation: FundingObservation,
): Decimal {
  const period = positive(observation.ratePeriodHours, "ratePeriodHours");
  return decimal(divide(units(observation.rate), period));
}

export type FundingBookLevel = { priceUsd: Decimal; base: Decimal };
export type BookSnapshot = {
  venue: FundingVenue;
  instrumentId: string;
  asOfMs: number;
  bids: readonly FundingBookLevel[];
  asks: readonly FundingBookLevel[];
};

export type ExecutableBook = {
  base: Decimal;
  notionalUsd: Decimal;
  vwapUsd: Decimal | null;
  complete: boolean;
};

/** Consumes the book in price order. A buy consumes asks; a sell consumes bids. */
export function executableBook(
  book: BookSnapshot,
  side: "buy" | "sell",
  requestedBase: Decimal,
): ExecutableBook {
  const requested = positive(requestedBase, "requestedBase");
  const levels = side === "buy" ? book.asks : book.bids;
  let remaining = requested;
  let filled = 0n;
  let notional = 0n;
  for (const level of levels) {
    const base = nonNegative(level.base, "book base");
    const price = positive(level.priceUsd, "book price");
    const take = minimum(remaining, base);
    if (take === 0n) continue;
    filled = add(filled, take);
    notional = add(notional, multiply(take, price));
    remaining = subtract(remaining, take);
    if (remaining === 0n) break;
  }
  return {
    base: decimal(filled),
    notionalUsd: decimal(notional),
    vwapUsd: filled === 0n ? null : decimal(divide(notional, filled)),
    complete: remaining === 0n,
  };
}

export type FundingFeeSchedule = {
  /** Signed bps costs; a negative maker fee is a fill credit. */
  afMakerBps: Decimal;
  afTakerBps: Decimal;
  afBuilderBps: Decimal;
  hlTakerBps: Decimal;
  fixedCostsUsd: Decimal;
};

export type FundingScannerInput = {
  nowMs: number;
  mapping: FundingPairMapping;
  base: Decimal;
  horizonHours: Decimal;
  maxBookAgeMs: number;
  afOracleUsd: Decimal;
  hlOracleUsd: Decimal;
  /** Proposed AF post-only ask. It must sit strictly above the current best bid. */
  afPostOnlyAskUsd: Decimal;
  afFunding: FundingObservation;
  hlFunding: FundingObservation;
  afEntryBook: BookSnapshot;
  hlEntryBook: BookSnapshot;
  afExitBook: BookSnapshot;
  hlExitBook: BookSnapshot;
  fees: FundingFeeSchedule;
};

export type FundingOpportunity = {
  mappingId: string;
  base: Decimal;
  hourlyFundingUsd: Decimal | null;
  pricePnlUsd: Decimal | null;
  feesUsd: Decimal | null;
  netUsd: Decimal | null;
  eligible: boolean;
  reasons: FundingReason[];
};

function bookIsStale(book: BookSnapshot, nowMs: number, maxAgeMs: number) {
  return nowMs - book.asOfMs > maxAgeMs || book.asOfMs > nowMs;
}

function fee(notional: bigint, bps: Decimal) {
  return divide(multiply(notional, units(bps)), units("10000"));
}

/** Signed USD fee: a negative bps rate is a maker credit, not recurring yield. */
export function fundingFeeUsd(notionalUsd: Decimal, bps: Decimal): Decimal {
  return decimal(fee(nonNegative(notionalUsd, "notionalUsd"), bps));
}

function bestBid(book: BookSnapshot) {
  return book.bids.reduce<bigint | null>((best, level) => {
    const price = positive(level.priceUsd, "book price");
    return best === null || price > best ? price : best;
  }, null);
}

/**
 * Computes the AF-short / HL-long economic edge. It is pure and read-only:
 * callers must supply every price, fee, and funding observation explicitly.
 */
export function scanFundingOpportunity(
  input: FundingScannerInput,
): FundingOpportunity {
  const reasons = validateFundingPair(input.mapping);
  const base = positive(input.base, "base");
  const horizon = positive(input.horizonHours, "horizonHours");
  const books = [
    input.afEntryBook,
    input.hlEntryBook,
    input.afExitBook,
    input.hlExitBook,
  ];
  if (
    books.some((book) => bookIsStale(book, input.nowMs, input.maxBookAgeMs))
  ) {
    reasons.push("STALE_DATA");
  }
  if (
    input.afFunding.validUntilMs < input.nowMs ||
    input.hlFunding.validUntilMs < input.nowMs
  ) {
    reasons.push("STALE_DATA");
  }
  let afHourly: bigint;
  let hlHourly: bigint;
  try {
    afHourly = units(normalizeFundingHourly(input.afFunding));
    hlHourly = units(normalizeFundingHourly(input.hlFunding));
  } catch {
    reasons.push("INVALID_FUNDING_PERIOD");
    return {
      mappingId: input.mapping.id,
      base: decimal(base),
      hourlyFundingUsd: null,
      pricePnlUsd: null,
      feesUsd: null,
      netUsd: null,
      eligible: false,
      reasons: [...new Set(reasons)],
    };
  }
  const afPostOnlyAsk = positive(input.afPostOnlyAskUsd, "afPostOnlyAskUsd");
  if (
    !isLotAligned(base, input.mapping.aftermath) ||
    !isLotAligned(base, input.mapping.hyperliquid)
  ) {
    reasons.push("LOT_MISMATCH");
  }
  const afBestBid = bestBid(input.afEntryBook);
  if (afBestBid === null || afPostOnlyAsk <= afBestBid)
    reasons.push("POST_ONLY_INVALID");
  const afEntryNotional = multiply(base, afPostOnlyAsk);
  const hlEntry = executableBook(input.hlEntryBook, "buy", input.base);
  const afExit = executableBook(input.afExitBook, "buy", input.base);
  const hlExit = executableBook(input.hlExitBook, "sell", input.base);
  if (!hlEntry.complete) reasons.push("INSUFFICIENT_ENTRY_DEPTH");
  if (!afExit.complete || !hlExit.complete)
    reasons.push("INSUFFICIENT_EXIT_DEPTH");
  const afMinimumNotional = units(input.mapping.aftermath.minOrderNotionalUsd);
  const hlMinimumNotional = units(
    input.mapping.hyperliquid.minOrderNotionalUsd,
  );
  if (
    afEntryNotional < afMinimumNotional ||
    units(hlEntry.notionalUsd) < hlMinimumNotional ||
    units(afExit.notionalUsd) < afMinimumNotional ||
    units(hlExit.notionalUsd) < hlMinimumNotional
  ) {
    reasons.push("BELOW_MINIMUM");
  }
  if (reasons.length) {
    return {
      mappingId: input.mapping.id,
      base: decimal(base),
      hourlyFundingUsd: null,
      pricePnlUsd: null,
      feesUsd: null,
      netUsd: null,
      eligible: false,
      reasons: [...new Set(reasons)],
    };
  }
  const afFundingIncome = multiply(
    multiply(base, units(input.afOracleUsd)),
    afHourly,
  );
  const hlFundingIncome = -multiply(
    multiply(base, units(input.hlOracleUsd)),
    hlHourly,
  );
  const hourlyFunding = add(afFundingIncome, hlFundingIncome);
  const pricePnl = multiply(
    base,
    add(
      subtract(afPostOnlyAsk, units(afExit.vwapUsd!)),
      subtract(units(hlExit.vwapUsd!), units(hlEntry.vwapUsd!)),
    ),
  );
  const feeCost = add(
    add(
      add(
        fee(afEntryNotional, input.fees.afMakerBps),
        fee(afEntryNotional, input.fees.afBuilderBps),
      ),
      fee(units(hlEntry.notionalUsd), input.fees.hlTakerBps),
    ),
    add(
      add(
        fee(units(afExit.notionalUsd), input.fees.afTakerBps),
        fee(units(afExit.notionalUsd), input.fees.afBuilderBps),
      ),
      fee(units(hlExit.notionalUsd), input.fees.hlTakerBps),
    ),
  );
  const net = subtract(
    add(add(pricePnl, multiply(hourlyFunding, horizon)), -feeCost),
    units(input.fees.fixedCostsUsd),
  );
  if (net <= 0n) reasons.push("NET_EDGE_NONPOSITIVE");
  return {
    mappingId: input.mapping.id,
    base: decimal(base),
    hourlyFundingUsd: decimal(hourlyFunding),
    pricePnlUsd: decimal(pricePnl),
    feesUsd: decimal(add(feeCost, units(input.fees.fixedCostsUsd))),
    netUsd: decimal(net),
    eligible: reasons.length === 0,
    reasons,
  };
}

export type PaperTrade = {
  type: "trade";
  id: string;
  atMs: number;
  /** An aggressive buyer consumes AF asks, an aggressive seller consumes AF bids. */
  aggressor: "buy" | "sell";
  priceUsd: Decimal;
  base: Decimal;
};

export type PaperCancel = {
  type: "cancel-confirmed";
  id: string;
  atMs: number;
};
export type PaperReplayEvent = PaperTrade | PaperCancel;

export type PaperQuote = {
  side: "sell";
  limitPriceUsd: Decimal;
  base: Decimal;
  queueAheadBase: Decimal;
  maxHedgePriceUsd: Decimal;
};

export type PaperReplayCheckpoint = {
  quoteRemainingBase: Decimal;
  queueAheadBase: Decimal;
  afFilledBase: Decimal;
  hlHedgedBase: Decimal;
  quoteOpen: boolean;
  state: "AF_QUOTING" | "HEDGE_PENDING" | "HEDGED_HOLD" | "RECOVERY_REQUIRED";
  appliedEventIds: string[];
};

export type PaperReplayResult = PaperReplayCheckpoint & {
  events: Array<{
    type: "af-fill" | "hl-hedge" | "cancel";
    sourceId: string;
    base: Decimal;
  }>;
  residualBase: Decimal;
};

function initialCheckpoint(quote: PaperQuote): PaperReplayCheckpoint {
  return {
    quoteRemainingBase: quote.base,
    queueAheadBase: quote.queueAheadBase,
    afFilledBase: "0",
    hlHedgedBase: "0",
    quoteOpen: true,
    state: "AF_QUOTING",
    appliedEventIds: [],
  };
}

/**
 * Deterministic AF post-only replay. Touching a quote does nothing: an
 * independently observed aggressive trade must first consume queue ahead.
 * A supplied HL book is consumed for every confirmed AF partial fill.
 */
export function replayFundingPaper(inputs: {
  mode: FundingRunMode;
  quote: PaperQuote;
  hedgeBook: BookSnapshot;
  events: readonly PaperReplayEvent[];
  checkpoint?: PaperReplayCheckpoint;
}): PaperReplayResult {
  if (inputs.mode !== "PAPER")
    throw new Error("Funding replay only supports PAPER mode");
  const checkpoint = structuredClone(
    inputs.checkpoint ?? initialCheckpoint(inputs.quote),
  );
  const seen = new Set(checkpoint.appliedEventIds);
  const output: PaperReplayResult["events"] = [];
  const ordered = [...inputs.events].sort(
    (left, right) => left.atMs - right.atMs || left.id.localeCompare(right.id),
  );
  let remaining = units(checkpoint.quoteRemainingBase);
  let queueAhead = units(checkpoint.queueAheadBase);
  let afFilled = units(checkpoint.afFilledBase);
  let hlHedged = units(checkpoint.hlHedgedBase);
  let quoteOpen = checkpoint.quoteOpen;
  let state = checkpoint.state;
  for (const event of ordered) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (event.type === "cancel-confirmed") {
      quoteOpen = false;
      output.push({ type: "cancel", sourceId: event.id, base: "0" });
      continue;
    }
    if (
      !quoteOpen ||
      event.aggressor !== "buy" ||
      units(event.priceUsd) < units(inputs.quote.limitPriceUsd)
    )
      continue;
    let consumed = nonNegative(event.base, "trade base");
    const queueConsumed = minimum(queueAhead, consumed);
    queueAhead = subtract(queueAhead, queueConsumed);
    consumed = subtract(consumed, queueConsumed);
    const fill = minimum(remaining, consumed);
    if (fill === 0n) continue;
    remaining = subtract(remaining, fill);
    afFilled = add(afFilled, fill);
    state = "HEDGE_PENDING";
    output.push({ type: "af-fill", sourceId: event.id, base: decimal(fill) });
    const hedge = executableBook(
      {
        ...inputs.hedgeBook,
        asks: inputs.hedgeBook.asks.filter(
          (level) =>
            units(level.priceUsd) <= units(inputs.quote.maxHedgePriceUsd),
        ),
      },
      "buy",
      decimal(fill),
    );
    const hedgeBase = units(hedge.base);
    const hedgePriceOk =
      hedge.vwapUsd !== null &&
      units(hedge.vwapUsd) <= units(inputs.quote.maxHedgePriceUsd);
    if (hedgeBase > 0n && hedgePriceOk) {
      hlHedged = add(hlHedged, hedgeBase);
      output.push({ type: "hl-hedge", sourceId: event.id, base: hedge.base });
    }
    if (hedgeBase !== fill || !hedgePriceOk) state = "RECOVERY_REQUIRED";
  }
  const residual = subtract(afFilled, hlHedged);
  if (
    state !== "RECOVERY_REQUIRED" &&
    residual === 0n &&
    afFilled > 0n &&
    !quoteOpen
  ) {
    state = "HEDGED_HOLD";
  }
  return {
    quoteRemainingBase: decimal(remaining),
    queueAheadBase: decimal(queueAhead),
    afFilledBase: decimal(afFilled),
    hlHedgedBase: decimal(hlHedged),
    quoteOpen,
    state,
    appliedEventIds: [...seen].sort(),
    events: output,
    residualBase: decimal(residual),
  };
}
