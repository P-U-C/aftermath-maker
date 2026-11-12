/**
 * Pure selector for recorded HIP-4 settlement evidence.
 *
 * It neither fetches evidence nor creates an execution surface. A caller must
 * supply both a complete capture and an explicit market/as-of boundary. The
 * fixture schema uses canonical Unix-millisecond timestamps and requires a
 * completed observation window plus independently pinned source and rules.
 */
export type Hip4SettlementSelection =
  | {
      status: "available";
      market: Hip4MarketIdentity;
      observedAtMs: number;
      observationWindow: { startMs: number; endMs: number };
      settlement: {
        source: PinnedSettlementSource;
        rules: PinnedSettlementRules;
        expiryMs: number;
      };
    }
  | { status: "unavailable"; reason: Hip4SettlementUnavailableReason };

export type Hip4SettlementUnavailableReason =
  | "missing-field"
  | "malformed-field"
  | "market-mismatch"
  | "future-observation"
  | "expired"
  | "unpinned-settlement";

export type Hip4MarketIdentity = {
  venue: "hyperliquid";
  kind: "hip4";
  name: string;
  assetId: number;
};

type PinnedSettlementSource = {
  id: string;
  uri: string;
  pinnedDigest: string;
};

type PinnedSettlementRules = {
  version: string;
  pinnedDigest: string;
  text: string;
};

type RecordValue = Record<string, unknown>;
type ParseResult<T> =
  | { kind: "value"; value: T }
  | { kind: "missing" }
  | { kind: "malformed" }
  | { kind: "unpinned" };
type ParseProblem = Exclude<ParseResult<never>["kind"], "value">;

const canonicalUnixMillisecondsMinimum = 1_000_000_000_000;
const sha256DigestPattern = /^sha256:[a-f0-9]{64}$/;

/**
 * Selects a recorded settlement only when it exactly matches the requested
 * HIP-4 market and remains valid at the caller-provided as-of boundary.
 */
export function selectRecordedHip4Settlement(
  input: unknown,
  request: unknown,
): Hip4SettlementSelection {
  const parsedRequest = parseRequest(request);
  if (parsedRequest.kind !== "value") return unavailable(parsedRequest.kind);
  if (!isRecord(input)) return unavailable("malformed");

  const market = requiredMarket(input, "market");
  const observedAtMs = requiredCanonicalTimestamp(input, "observedAtMs");
  const observationWindow = requiredObject(input, "observationWindow");
  const settlement = requiredObject(input, "settlement");
  const requiredFields = [market, observedAtMs, observationWindow, settlement];
  if (
    market.kind !== "value" ||
    observedAtMs.kind !== "value" ||
    observationWindow.kind !== "value" ||
    settlement.kind !== "value"
  ) {
    return unavailable(firstProblem(requiredFields) ?? "malformed");
  }

  if (!sameMarket(market.value, parsedRequest.value.market)) {
    return unavailable("market-mismatch");
  }

  const window = parseObservationWindow(observationWindow.value);
  const parsedSettlement = parseSettlement(settlement.value);
  const parsed = [window, parsedSettlement];
  if (window.kind !== "value" || parsedSettlement.kind !== "value") {
    return unavailable(firstProblem(parsed) ?? "malformed");
  }

  if (
    observedAtMs.value > parsedRequest.value.asOfMs ||
    window.value.startMs > parsedRequest.value.asOfMs ||
    window.value.endMs > parsedRequest.value.asOfMs
  ) {
    return unavailable("future-observation");
  }
  if (
    window.value.endMs !== observedAtMs.value ||
    window.value.startMs >= window.value.endMs
  ) {
    return unavailable("malformed");
  }
  if (parsedSettlement.value.expiryMs <= parsedRequest.value.asOfMs) {
    return unavailable("expired");
  }

  return {
    status: "available",
    market: market.value,
    observedAtMs: observedAtMs.value,
    observationWindow: window.value,
    settlement: parsedSettlement.value,
  };
}

function parseRequest(
  value: unknown,
): ParseResult<{ market: Hip4MarketIdentity; asOfMs: number }> {
  if (!isRecord(value)) return failed("malformed");
  const market = requiredMarket(value, "market");
  const asOfMs = requiredCanonicalTimestamp(value, "asOfMs");
  if (market.kind !== "value" || asOfMs.kind !== "value") {
    return failed(firstProblem([market, asOfMs]) ?? "malformed");
  }
  return {
    kind: "value",
    value: { market: market.value, asOfMs: asOfMs.value },
  };
}

function parseObservationWindow(
  value: RecordValue,
): ParseResult<{ startMs: number; endMs: number }> {
  const startMs = requiredCanonicalTimestamp(value, "startMs");
  const endMs = requiredCanonicalTimestamp(value, "endMs");
  if (startMs.kind !== "value" || endMs.kind !== "value") {
    return failed(firstProblem([startMs, endMs]) ?? "malformed");
  }
  return {
    kind: "value",
    value: { startMs: startMs.value, endMs: endMs.value },
  };
}

function parseSettlement(value: RecordValue): ParseResult<{
  source: PinnedSettlementSource;
  rules: PinnedSettlementRules;
  expiryMs: number;
}> {
  const source = requiredObject(value, "source");
  const rules = requiredObject(value, "rules");
  const expiryMs = requiredCanonicalTimestamp(value, "expiryMs");
  if (
    source.kind !== "value" ||
    rules.kind !== "value" ||
    expiryMs.kind !== "value"
  ) {
    return failed(firstProblem([source, rules, expiryMs]) ?? "malformed");
  }

  const parsedSource = parsePinnedSource(source.value);
  const parsedRules = parsePinnedRules(rules.value);
  if (parsedSource.kind !== "value" || parsedRules.kind !== "value") {
    return failed(firstProblem([parsedSource, parsedRules]) ?? "malformed");
  }
  return {
    kind: "value",
    value: {
      source: parsedSource.value,
      rules: parsedRules.value,
      expiryMs: expiryMs.value,
    },
  };
}

function parsePinnedSource(
  value: RecordValue,
): ParseResult<PinnedSettlementSource> {
  const id = requiredString(value, "id");
  const uri = requiredString(value, "uri");
  const pinnedDigest = requiredPin(value, "pinnedDigest");
  if (
    id.kind !== "value" ||
    uri.kind !== "value" ||
    pinnedDigest.kind !== "value"
  ) {
    return failed(firstProblem([id, uri, pinnedDigest]) ?? "malformed");
  }
  if (!sha256DigestPattern.test(pinnedDigest.value)) {
    return failed("unpinned");
  }
  return {
    kind: "value",
    value: { id: id.value, uri: uri.value, pinnedDigest: pinnedDigest.value },
  };
}

function parsePinnedRules(
  value: RecordValue,
): ParseResult<PinnedSettlementRules> {
  const version = requiredString(value, "version");
  const pinnedDigest = requiredPin(value, "pinnedDigest");
  const text = requiredString(value, "text");
  if (
    version.kind !== "value" ||
    pinnedDigest.kind !== "value" ||
    text.kind !== "value"
  ) {
    return failed(firstProblem([version, pinnedDigest, text]) ?? "malformed");
  }
  if (!sha256DigestPattern.test(pinnedDigest.value)) {
    return failed("unpinned");
  }
  return {
    kind: "value",
    value: {
      version: version.value,
      pinnedDigest: pinnedDigest.value,
      text: text.value,
    },
  };
}

function requiredMarket(
  value: RecordValue,
  key: string,
): ParseResult<Hip4MarketIdentity> {
  const market = requiredObject(value, key);
  if (market.kind !== "value") return market;
  const venue = requiredLiteral(market.value, "venue", "hyperliquid");
  const kind = requiredLiteral(market.value, "kind", "hip4");
  const name = requiredString(market.value, "name");
  const assetId = requiredPositiveInteger(market.value, "assetId");
  if (
    venue.kind !== "value" ||
    kind.kind !== "value" ||
    name.kind !== "value" ||
    assetId.kind !== "value"
  ) {
    return failed(firstProblem([venue, kind, name, assetId]) ?? "malformed");
  }
  return {
    kind: "value",
    value: {
      venue: venue.value,
      kind: kind.value,
      name: name.value,
      assetId: assetId.value,
    },
  };
}

function requiredObject(
  value: RecordValue,
  key: string,
): ParseResult<RecordValue> {
  return required(value, key, isRecord);
}

function requiredString(value: RecordValue, key: string): ParseResult<string> {
  return required(
    value,
    key,
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );
}

function requiredPin(value: RecordValue, key: string): ParseResult<string> {
  return required(
    value,
    key,
    (candidate): candidate is string => typeof candidate === "string",
  );
}

function requiredLiteral<T extends string>(
  value: RecordValue,
  key: string,
  expected: T,
): ParseResult<T> {
  return required(
    value,
    key,
    (candidate): candidate is T => candidate === expected,
  );
}

function requiredPositiveInteger(
  value: RecordValue,
  key: string,
): ParseResult<number> {
  return required(value, key, isPositiveSafeInteger);
}

function requiredCanonicalTimestamp(
  value: RecordValue,
  key: string,
): ParseResult<number> {
  return required(
    value,
    key,
    (candidate): candidate is number =>
      isPositiveSafeInteger(candidate) &&
      candidate >= canonicalUnixMillisecondsMinimum,
  );
}

function required<T>(
  value: RecordValue,
  key: string,
  predicate: (candidate: unknown) => candidate is T,
): ParseResult<T> {
  if (!(key in value) || value[key] === undefined) return { kind: "missing" };
  return predicate(value[key])
    ? { kind: "value", value: value[key] }
    : { kind: "malformed" };
}

function sameMarket(a: Hip4MarketIdentity, b: Hip4MarketIdentity): boolean {
  return (
    a.venue === b.venue &&
    a.kind === b.kind &&
    a.name === b.name &&
    a.assetId === b.assetId
  );
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function firstProblem(
  values: ParseResult<unknown>[],
): ParseProblem | undefined {
  return values.find((value) => value.kind !== "value")?.kind as
    ParseProblem | undefined;
}

function failed(kind: ParseProblem): ParseResult<never> {
  return { kind };
}

function unavailable(
  kind: ParseProblem | "market-mismatch" | "future-observation" | "expired",
): Hip4SettlementSelection {
  if (
    kind === "market-mismatch" ||
    kind === "future-observation" ||
    kind === "expired"
  ) {
    return { status: "unavailable", reason: kind };
  }
  if (kind === "unpinned")
    return { status: "unavailable", reason: "unpinned-settlement" };
  return { status: "unavailable", reason: `${kind}-field` };
}
