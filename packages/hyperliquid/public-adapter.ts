/**
 * Pure parser for recorded public Hyperliquid HIP-3 responses.
 * It deliberately has no transport, credentials, or execution surface.
 */
export type PublicHip3Observation =
  | {
      status: "available";
      market: string;
      observedAtMs: number;
      book: {
        timestampMs: number;
        bestBid: BookLevel;
        bestAsk: BookLevel;
      };
      mark: PricePoint;
      oracle: PricePoint;
      fundingHistory: FundingPoint[];
    }
  | { status: "unavailable"; reason: UnavailableReason };

export type UnavailableReason = "missing-field" | "malformed-field" | "stale";

type BookLevel = { price: string; size: string; orderCount: number };
type PricePoint = { timestampMs: number; price: string };
type FundingPoint = { timestampMs: number; rate: string };
type RecordValue = Record<string, unknown>;
type ParseResult<T> =
  { kind: "value"; value: T } | { kind: "missing" } | { kind: "malformed" };

const decimalPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Parses a capture made from `l2Book`, `metaAndAssetCtxs`, and
 * `fundingHistory`. Asset contexts do not carry their own timestamps, so the
 * capture's `observedAtMs` is their timestamp. The book and newest funding
 * response must independently be within `maxAgeMs` of that capture.
 */
export function parsePublicHip3Observation(
  input: unknown,
  options: { maxAgeMs: number },
): PublicHip3Observation {
  if (!isRecord(input) || !isPositiveSafeInteger(options.maxAgeMs)) {
    return unavailable("malformed-field");
  }

  const market = requiredHip3Market(input, "market");
  const observedAtMs = requiredTimestamp(input, "observedAtMs");
  const book = requiredObject(input, "book");
  const metaAndAssetCtxs = requiredArray(input, "metaAndAssetCtxs");
  const fundingHistory = requiredArray(input, "fundingHistory");
  const required = [
    market,
    observedAtMs,
    book,
    metaAndAssetCtxs,
    fundingHistory,
  ];
  if (
    market.kind !== "value" ||
    observedAtMs.kind !== "value" ||
    book.kind !== "value" ||
    metaAndAssetCtxs.kind !== "value" ||
    fundingHistory.kind !== "value"
  ) {
    return unavailable(firstProblem(required) ?? "malformed-field");
  }

  const parsedBook = parseBook(book.value, market.value, observedAtMs.value);
  const parsedAssetContext = parseAssetContext(
    metaAndAssetCtxs.value,
    market.value,
    observedAtMs.value,
  );
  const parsedFunding = parseFundingHistory(
    fundingHistory.value,
    market.value,
    observedAtMs.value,
  );
  const parsed = [parsedBook, parsedAssetContext, parsedFunding];
  if (
    parsedBook.kind !== "value" ||
    parsedAssetContext.kind !== "value" ||
    parsedFunding.kind !== "value"
  ) {
    return unavailable(firstProblem(parsed) ?? "malformed-field");
  }

  if (
    [parsedBook.value.timestampMs, parsedFunding.value[0].timestampMs].some(
      (timestampMs) => observedAtMs.value - timestampMs > options.maxAgeMs,
    )
  ) {
    return unavailable("stale");
  }

  return {
    status: "available",
    market: market.value,
    observedAtMs: observedAtMs.value,
    book: parsedBook.value,
    mark: {
      timestampMs: observedAtMs.value,
      price: parsedAssetContext.value.mark,
    },
    oracle: {
      timestampMs: observedAtMs.value,
      price: parsedAssetContext.value.oracle,
    },
    fundingHistory: parsedFunding.value,
  };
}

function parseBook(
  value: RecordValue,
  market: string,
  observedAtMs: number,
): ParseResult<{
  timestampMs: number;
  bestBid: BookLevel;
  bestAsk: BookLevel;
}> {
  const coin = requiredString(value, "coin");
  const timestampMs = requiredTimestamp(value, "time");
  const levels = requiredArray(value, "levels");
  if (
    coin.kind !== "value" ||
    timestampMs.kind !== "value" ||
    levels.kind !== "value"
  ) {
    return failed(
      firstProblem([coin, timestampMs, levels]) ?? "malformed-field",
    );
  }
  if (coin.value !== market || timestampMs.value > observedAtMs) {
    return failed("malformed-field");
  }
  if (
    levels.value.length !== 2 ||
    !Array.isArray(levels.value[0]) ||
    !Array.isArray(levels.value[1])
  ) {
    return failed("malformed-field");
  }

  const bestBid = parseBookLevel(levels.value[0][0]);
  const bestAsk = parseBookLevel(levels.value[1][0]);
  if (bestBid.kind !== "value" || bestAsk.kind !== "value") {
    return failed(firstProblem([bestBid, bestAsk]) ?? "malformed-field");
  }
  if (Number(bestBid.value.price) >= Number(bestAsk.value.price)) {
    return failed("malformed-field");
  }

  return {
    kind: "value",
    value: {
      timestampMs: timestampMs.value,
      bestBid: bestBid.value,
      bestAsk: bestAsk.value,
    },
  };
}

function parseAssetContext(
  value: unknown[],
  market: string,
  observedAtMs: number,
): ParseResult<{ mark: string; oracle: string }> {
  if (value.length !== 2 || !isRecord(value[0]) || !Array.isArray(value[1])) {
    return failed("malformed-field");
  }
  const universe = requiredArray(value[0], "universe");
  if (universe.kind !== "value")
    return failed(
      universe.kind === "missing" ? "missing-field" : "malformed-field",
    );
  if (universe.value.length !== value[1].length)
    return failed("malformed-field");

  const marketIndex = universe.value.findIndex(
    (asset) => isRecord(asset) && asset.name === market,
  );
  if (marketIndex < 0 || !isRecord(value[1][marketIndex])) {
    return failed("malformed-field");
  }
  const context = value[1][marketIndex];
  const mark = requiredDecimal(context, "markPx", true);
  const oracle = requiredDecimal(context, "oraclePx", true);
  if (mark.kind !== "value" || oracle.kind !== "value") {
    return failed(firstProblem([mark, oracle]) ?? "malformed-field");
  }

  // The public asset-context response is captured at observedAtMs; it does not
  // expose a per-context timestamp, unlike the book and funding responses.
  if (!isPositiveSafeInteger(observedAtMs)) return failed("malformed-field");
  return { kind: "value", value: { mark: mark.value, oracle: oracle.value } };
}

function parseFundingHistory(
  value: unknown[],
  market: string,
  observedAtMs: number,
): ParseResult<FundingPoint[]> {
  if (value.length === 0) return failed("malformed-field");
  const points: FundingPoint[] = [];
  let previousTimestampMs = Number.POSITIVE_INFINITY;
  for (const entry of value) {
    if (!isRecord(entry)) return failed("malformed-field");
    const coin = requiredString(entry, "coin");
    const timestampMs = requiredTimestamp(entry, "time");
    const rate = requiredDecimal(entry, "fundingRate", false);
    if (
      coin.kind !== "value" ||
      timestampMs.kind !== "value" ||
      rate.kind !== "value"
    ) {
      return failed(
        firstProblem([coin, timestampMs, rate]) ?? "malformed-field",
      );
    }
    if (
      coin.value !== market ||
      timestampMs.value > observedAtMs ||
      timestampMs.value >= previousTimestampMs
    ) {
      return failed("malformed-field");
    }
    points.push({ timestampMs: timestampMs.value, rate: rate.value });
    previousTimestampMs = timestampMs.value;
  }
  return { kind: "value", value: points };
}

function parseBookLevel(value: unknown): ParseResult<BookLevel> {
  if (!isRecord(value)) return failed("malformed-field");
  const price = requiredDecimal(value, "px", true);
  const size = requiredDecimal(value, "sz", true);
  const orderCount = requiredPositiveInteger(value, "n");
  if (
    price.kind !== "value" ||
    size.kind !== "value" ||
    orderCount.kind !== "value"
  ) {
    return failed(firstProblem([price, size, orderCount]) ?? "malformed-field");
  }
  return {
    kind: "value",
    value: {
      price: price.value,
      size: size.value,
      orderCount: orderCount.value,
    },
  };
}

function requiredObject(
  value: RecordValue,
  key: string,
): ParseResult<RecordValue> {
  return required(value, key, isRecord);
}

function requiredArray(
  value: RecordValue,
  key: string,
): ParseResult<unknown[]> {
  return required(value, key, Array.isArray);
}

function requiredString(value: RecordValue, key: string): ParseResult<string> {
  return required(
    value,
    key,
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );
}

function requiredHip3Market(
  value: RecordValue,
  key: string,
): ParseResult<string> {
  return required(value, key, (candidate): candidate is string => {
    if (typeof candidate !== "string") return false;
    const [dex, asset, ...extra] = candidate.split(":");
    return dex.length > 0 && asset.length > 0 && extra.length === 0;
  });
}

function requiredTimestamp(
  value: RecordValue,
  key: string,
): ParseResult<number> {
  return required(value, key, isPositiveSafeInteger);
}

function requiredPositiveInteger(
  value: RecordValue,
  key: string,
): ParseResult<number> {
  return required(value, key, isPositiveSafeInteger);
}

function requiredDecimal(
  value: RecordValue,
  key: string,
  mustBePositive: boolean,
): ParseResult<string> {
  return required(value, key, (candidate): candidate is string => {
    if (typeof candidate !== "string" || !decimalPattern.test(candidate)) {
      return false;
    }
    const numeric = Number(candidate);
    return Number.isFinite(numeric) && (mustBePositive ? numeric > 0 : true);
  });
}

function required<T>(
  value: RecordValue,
  key: string,
  valid: (candidate: unknown) => candidate is T,
): ParseResult<T> {
  if (!(key in value) || value[key] === undefined) return { kind: "missing" };
  return valid(value[key])
    ? { kind: "value", value: value[key] }
    : { kind: "malformed" };
}

function firstProblem(
  results: ParseResult<unknown>[],
): UnavailableReason | undefined {
  if (results.some((result) => result.kind === "missing")) {
    return "missing-field";
  }
  if (results.some((result) => result.kind === "malformed")) {
    return "malformed-field";
  }
  return undefined;
}

function unavailable(reason: UnavailableReason): PublicHip3Observation {
  return { status: "unavailable", reason };
}

function failed(reason: UnavailableReason): ParseResult<never> {
  return reason === "missing-field"
    ? { kind: "missing" }
    : { kind: "malformed" };
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
