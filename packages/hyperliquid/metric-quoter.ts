/**
 * Pure calculator for recorded Metric and Hyperliquid basis quotes.
 *
 * It has no transport, credential, order, signer, or execution surface. A
 * caller supplies a capture and receives a complete fixed-size quote matrix.
 * Missing evidence is represented as an unavailable matrix cell, never as a
 * fabricated zero or an omitted quote.
 */
export const METRIC_QUOTE_SIZES_USD = [1000, 5000, 25000, 50000] as const;

export type MetricQuoteSizeUsd = (typeof METRIC_QUOTE_SIZES_USD)[number];
export type MetricDirection =
  "buy-metric-sell-hyperliquid" | "buy-hyperliquid-sell-metric";
export type MetricUnavailableReason =
  "missing-field" | "missing-result" | "malformed-field" | "reverted" | "stale";

type QuoteSource = {
  timestampMs: number;
  side: "buy" | "sell";
};

type QuoteCosts = {
  metricFeeUsd: number;
  metricGasUsd: number;
  hyperliquidFeeUsd: number;
  hyperliquidGasUsd: number;
  fundingUsd: number;
  totalUsd: number;
};

export type MetricBasisQuote =
  | {
      status: "available";
      direction: MetricDirection;
      sizeUsd: MetricQuoteSizeUsd;
      sources: { metric: QuoteSource; hyperliquid: QuoteSource };
      costs: QuoteCosts;
      grossBasisUsd: number;
      netBasisUsd: number;
    }
  | {
      status: "unavailable";
      direction: MetricDirection;
      sizeUsd: MetricQuoteSizeUsd;
      reason: MetricUnavailableReason;
    };

export type MetricQuoteReport =
  | {
      status: "available";
      market: string;
      observedAtMs: number;
      quotes: MetricBasisQuote[];
    }
  | { status: "unavailable"; reason: MetricUnavailableReason };

type RecordValue = Record<string, unknown>;
type ParseResult<T> =
  { kind: "value"; value: T } | { kind: "missing" } | { kind: "malformed" };
type ParsedCaptureQuote =
  | {
      kind: "success";
      direction: MetricDirection;
      sizeUsd: MetricQuoteSizeUsd;
      inputUsd: number;
      outputUsd: number;
      sources: { metric: QuoteSource; hyperliquid: QuoteSource };
      costs: Omit<QuoteCosts, "totalUsd">;
    }
  | {
      kind: "reverted";
      direction: MetricDirection;
      sizeUsd: MetricQuoteSizeUsd;
    };

const directions: MetricDirection[] = [
  "buy-metric-sell-hyperliquid",
  "buy-hyperliquid-sell-metric",
];

/**
 * Calculates the two recorded basis directions at every supported USD size.
 * Sources must have been captured within maxAgeMs of observedAtMs. Every
 * successful result retains each source side/timestamp and every individual
 * cost before the net basis is calculated.
 */
export function quoteRecordedMetricBasis(
  input: unknown,
  options: { maxAgeMs: number },
): MetricQuoteReport {
  if (!isRecord(input) || !isPositiveSafeInteger(options.maxAgeMs)) {
    return unavailable("malformed-field");
  }

  const market = requiredString(input, "market");
  const observedAtMs = requiredTimestamp(input, "observedAtMs");
  const quotes = requiredArray(input, "quotes");
  const requiredFields = [market, observedAtMs, quotes];
  if (
    market.kind !== "value" ||
    observedAtMs.kind !== "value" ||
    quotes.kind !== "value"
  ) {
    return unavailable(firstProblem(requiredFields) ?? "malformed-field");
  }

  const captureQuotes = new Map<string, ParsedCaptureQuote>();
  for (const quote of quotes.value) {
    const parsed = parseCaptureQuote(quote, observedAtMs.value);
    if (parsed.kind !== "value") {
      return unavailable(
        parsed.kind === "missing" ? "missing-field" : "malformed-field",
      );
    }
    const key = quoteKey(parsed.value.direction, parsed.value.sizeUsd);
    if (captureQuotes.has(key)) return unavailable("malformed-field");
    captureQuotes.set(key, parsed.value);
  }

  return {
    status: "available",
    market: market.value,
    observedAtMs: observedAtMs.value,
    quotes: directions.flatMap((direction) =>
      METRIC_QUOTE_SIZES_USD.map((sizeUsd) => {
        const captured = captureQuotes.get(quoteKey(direction, sizeUsd));
        if (!captured)
          return unavailableQuote(direction, sizeUsd, "missing-result");
        if (captured.kind === "reverted") {
          return unavailableQuote(direction, sizeUsd, "reverted");
        }
        if (
          observedAtMs.value - captured.sources.metric.timestampMs >
            options.maxAgeMs ||
          observedAtMs.value - captured.sources.hyperliquid.timestampMs >
            options.maxAgeMs
        ) {
          return unavailableQuote(direction, sizeUsd, "stale");
        }
        return calculateQuote(captured);
      }),
    ),
  };
}

function parseCaptureQuote(
  value: unknown,
  observedAtMs: number,
): ParseResult<ParsedCaptureQuote> {
  if (!isRecord(value)) return failed("malformed-field");

  const direction = requiredDirection(value, "direction");
  const sizeUsd = requiredQuoteSize(value, "sizeUsd");
  const result = requiredResult(value, "result");
  const identity = [direction, sizeUsd, result];
  if (
    direction.kind !== "value" ||
    sizeUsd.kind !== "value" ||
    result.kind !== "value"
  ) {
    return failed(firstProblem(identity) ?? "malformed-field");
  }
  if (result.value === "reverted") {
    return {
      kind: "value",
      value: {
        kind: "reverted",
        direction: direction.value,
        sizeUsd: sizeUsd.value,
      },
    };
  }

  const inputUsd = requiredPositiveNumber(value, "inputUsd");
  const outputUsd = requiredPositiveNumber(value, "outputUsd");
  const sources = requiredObject(value, "sources");
  const costs = requiredObject(value, "costs");
  const requiredFields = [inputUsd, outputUsd, sources, costs];
  if (
    inputUsd.kind !== "value" ||
    outputUsd.kind !== "value" ||
    sources.kind !== "value" ||
    costs.kind !== "value"
  ) {
    return failed(firstProblem(requiredFields) ?? "malformed-field");
  }
  if (inputUsd.value !== sizeUsd.value) return failed("malformed-field");

  const metric = parseSource(
    sources.value,
    "metric",
    "metric",
    direction.value,
    observedAtMs,
  );
  const hyperliquid = parseSource(
    sources.value,
    "hyperliquid",
    "hyperliquid",
    direction.value,
    observedAtMs,
  );
  const parsedCosts = parseCosts(costs.value);
  const parsed = [metric, hyperliquid, parsedCosts];
  if (
    metric.kind !== "value" ||
    hyperliquid.kind !== "value" ||
    parsedCosts.kind !== "value"
  ) {
    return failed(firstProblem(parsed) ?? "malformed-field");
  }

  return {
    kind: "value",
    value: {
      kind: "success",
      direction: direction.value,
      sizeUsd: sizeUsd.value,
      inputUsd: inputUsd.value,
      outputUsd: outputUsd.value,
      sources: { metric: metric.value, hyperliquid: hyperliquid.value },
      costs: parsedCosts.value,
    },
  };
}

function parseSource(
  sources: RecordValue,
  key: "metric" | "hyperliquid",
  venue: "metric" | "hyperliquid",
  direction: MetricDirection,
  observedAtMs: number,
): ParseResult<QuoteSource> {
  const source = requiredObject(sources, key);
  if (source.kind !== "value") {
    return failed(
      source.kind === "missing" ? "missing-field" : "malformed-field",
    );
  }
  const timestampMs = requiredTimestamp(source.value, "timestampMs");
  const side = requiredSide(source.value, "side");
  if (timestampMs.kind !== "value" || side.kind !== "value") {
    return failed(firstProblem([timestampMs, side]) ?? "malformed-field");
  }
  if (timestampMs.value > observedAtMs) {
    return failed("malformed-field");
  }
  const expectedSide = expectedSideFor(venue, direction);
  if (side.value !== expectedSide) return failed("malformed-field");
  return {
    kind: "value",
    value: { timestampMs: timestampMs.value, side: side.value },
  };
}

function parseCosts(
  value: RecordValue,
): ParseResult<Omit<QuoteCosts, "totalUsd">> {
  const metricFeeUsd = requiredPositiveNumber(value, "metricFeeUsd");
  const metricGasUsd = requiredPositiveNumber(value, "metricGasUsd");
  const hyperliquidFeeUsd = requiredPositiveNumber(value, "hyperliquidFeeUsd");
  const hyperliquidGasUsd = requiredPositiveNumber(value, "hyperliquidGasUsd");
  const fundingUsd = requiredPositiveNumber(value, "fundingUsd");
  const parsed = [
    metricFeeUsd,
    metricGasUsd,
    hyperliquidFeeUsd,
    hyperliquidGasUsd,
    fundingUsd,
  ];
  if (
    metricFeeUsd.kind !== "value" ||
    metricGasUsd.kind !== "value" ||
    hyperliquidFeeUsd.kind !== "value" ||
    hyperliquidGasUsd.kind !== "value" ||
    fundingUsd.kind !== "value"
  ) {
    return failed(firstProblem(parsed) ?? "malformed-field");
  }
  return {
    kind: "value",
    value: {
      metricFeeUsd: metricFeeUsd.value,
      metricGasUsd: metricGasUsd.value,
      hyperliquidFeeUsd: hyperliquidFeeUsd.value,
      hyperliquidGasUsd: hyperliquidGasUsd.value,
      fundingUsd: fundingUsd.value,
    },
  };
}

function calculateQuote(
  captured: Extract<ParsedCaptureQuote, { kind: "success" }>,
): MetricBasisQuote {
  const totalUsd =
    captured.costs.metricFeeUsd +
    captured.costs.metricGasUsd +
    captured.costs.hyperliquidFeeUsd +
    captured.costs.hyperliquidGasUsd +
    captured.costs.fundingUsd;
  const grossBasisUsd = captured.outputUsd - captured.inputUsd;
  const netBasisUsd = grossBasisUsd - totalUsd;
  if (![totalUsd, grossBasisUsd, netBasisUsd].every(Number.isFinite)) {
    return unavailableQuote(
      captured.direction,
      captured.sizeUsd,
      "malformed-field",
    );
  }
  return {
    status: "available",
    direction: captured.direction,
    sizeUsd: captured.sizeUsd,
    sources: captured.sources,
    costs: { ...captured.costs, totalUsd },
    grossBasisUsd,
    netBasisUsd,
  };
}

function expectedSideFor(
  venue: "metric" | "hyperliquid",
  direction: MetricDirection,
): "buy" | "sell" {
  if (direction === "buy-metric-sell-hyperliquid") {
    return venue === "metric" ? "buy" : "sell";
  }
  return venue === "metric" ? "sell" : "buy";
}

function quoteKey(
  direction: MetricDirection,
  sizeUsd: MetricQuoteSizeUsd,
): string {
  return `${direction}:${sizeUsd}`;
}

function unavailableQuote(
  direction: MetricDirection,
  sizeUsd: MetricQuoteSizeUsd,
  reason: MetricUnavailableReason,
): MetricBasisQuote {
  return { status: "unavailable", direction, sizeUsd, reason };
}

function unavailable(reason: MetricUnavailableReason): MetricQuoteReport {
  return { status: "unavailable", reason };
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

function requiredTimestamp(
  value: RecordValue,
  key: string,
): ParseResult<number> {
  return required(value, key, isPositiveSafeInteger);
}

function requiredPositiveNumber(
  value: RecordValue,
  key: string,
): ParseResult<number> {
  return required(value, key, isPositiveFiniteNumber);
}

function requiredDirection(
  value: RecordValue,
  key: string,
): ParseResult<MetricDirection> {
  return required(
    value,
    key,
    (candidate): candidate is MetricDirection =>
      typeof candidate === "string" &&
      directions.includes(candidate as MetricDirection),
  );
}

function requiredQuoteSize(
  value: RecordValue,
  key: string,
): ParseResult<MetricQuoteSizeUsd> {
  return required(
    value,
    key,
    (candidate): candidate is MetricQuoteSizeUsd =>
      typeof candidate === "number" &&
      (METRIC_QUOTE_SIZES_USD as readonly number[]).includes(candidate),
  );
}

function requiredResult(
  value: RecordValue,
  key: string,
): ParseResult<"success" | "reverted"> {
  return required(
    value,
    key,
    (candidate): candidate is "success" | "reverted" =>
      candidate === "success" || candidate === "reverted",
  );
}

function requiredSide(
  value: RecordValue,
  key: string,
): ParseResult<"buy" | "sell"> {
  return required(
    value,
    key,
    (candidate): candidate is "buy" | "sell" =>
      candidate === "buy" || candidate === "sell",
  );
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
): "missing-field" | "malformed-field" | undefined {
  if (results.some((result) => result.kind === "missing"))
    return "missing-field";
  if (results.some((result) => result.kind === "malformed")) {
    return "malformed-field";
  }
  return undefined;
}

function failed(
  reason: "missing-field" | "malformed-field",
): ParseResult<never> {
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

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
