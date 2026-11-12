import { createHash } from "node:crypto";

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
  payload: string;
  pinnedDigest: string;
};

type PinnedSettlementRules = {
  version: string;
  payload: string;
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

type ApprovedSettlementPin = {
  readonly market: Hip4MarketIdentity;
  readonly source: {
    readonly id: string;
    readonly uri: string;
    readonly pinnedDigest: string;
  };
  readonly rules: {
    readonly version: string;
    readonly pinnedDigest: string;
  };
};

// This policy is module-local on purpose: callers cannot self-attest a pin.
const approvedSettlementPins: readonly ApprovedSettlementPin[] = Object.freeze([
  Object.freeze({
    market: Object.freeze({
      venue: "hyperliquid",
      kind: "hip4",
      name: "xyz:TEST-2025-01-31",
      assetId: 1042,
    }),
    source: Object.freeze({
      id: "recorded-index-snapshot",
      uri: "https://evidence.example.invalid/hip4/xyz-test-2025-01-31.json",
      pinnedDigest:
        "sha256:7a51983006f34501f60839b46b1674e7e6e6941bca32390ce3fbcba8ffbd29e4",
    }),
    rules: Object.freeze({
      version: "hip4-settlement-v1",
      pinnedDigest:
        "sha256:21459e1d357328f5e5207afda1e5d77394f0fefe6c9401f59fe39893eecc89ec",
    }),
  }),
]);

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
  if (window.kind !== "value") {
    return unavailable(window.kind);
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
  const parsedSettlement = parseSettlement(
    settlement.value,
    market.value,
    observedAtMs.value,
    window.value,
  );
  if (parsedSettlement.kind !== "value") {
    return unavailable(parsedSettlement.kind);
  }
  if (!matchesApprovedPin(market.value, parsedSettlement.value)) {
    return unavailable("unpinned");
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

function parseSettlement(
  value: RecordValue,
  market: Hip4MarketIdentity,
  observedAtMs: number,
  observationWindow: { startMs: number; endMs: number },
): ParseResult<{
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

  const parsedSource = parsePinnedSource(
    source.value,
    market,
    observedAtMs,
    observationWindow,
  );
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
  market: Hip4MarketIdentity,
  observedAtMs: number,
  observationWindow: { startMs: number; endMs: number },
): ParseResult<PinnedSettlementSource> {
  const id = requiredString(value, "id");
  const uri = requiredString(value, "uri");
  const payload = requiredString(value, "payload");
  const pinnedDigest = requiredPin(value, "pinnedDigest");
  if (
    id.kind !== "value" ||
    uri.kind !== "value" ||
    payload.kind !== "value" ||
    pinnedDigest.kind !== "value"
  ) {
    return failed(
      firstProblem([id, uri, payload, pinnedDigest]) ?? "malformed",
    );
  }
  const expectedPayload = canonicalSourcePayload(
    market,
    observedAtMs,
    observationWindow,
    { id: id.value, uri: uri.value },
  );
  if (
    payload.value !== expectedPayload ||
    pinnedDigest.value !== sha256Digest(payload.value)
  ) {
    return failed("unpinned");
  }
  return {
    kind: "value",
    value: {
      id: id.value,
      uri: uri.value,
      payload: payload.value,
      pinnedDigest: pinnedDigest.value,
    },
  };
}

function parsePinnedRules(
  value: RecordValue,
): ParseResult<PinnedSettlementRules> {
  const version = requiredString(value, "version");
  const payload = requiredString(value, "payload");
  const pinnedDigest = requiredPin(value, "pinnedDigest");
  const text = requiredString(value, "text");
  if (
    version.kind !== "value" ||
    payload.kind !== "value" ||
    pinnedDigest.kind !== "value" ||
    text.kind !== "value"
  ) {
    return failed(
      firstProblem([version, payload, pinnedDigest, text]) ?? "malformed",
    );
  }
  if (
    payload.value !== canonicalRulesPayload(version.value, text.value) ||
    pinnedDigest.value !== sha256Digest(payload.value)
  ) {
    return failed("unpinned");
  }
  return {
    kind: "value",
    value: {
      version: version.value,
      payload: payload.value,
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

function canonicalSourcePayload(
  market: Hip4MarketIdentity,
  observedAtMs: number,
  observationWindow: { startMs: number; endMs: number },
  source: { id: string; uri: string },
): string {
  return JSON.stringify({ market, observedAtMs, observationWindow, source });
}

function canonicalRulesPayload(version: string, text: string): string {
  return JSON.stringify({ version, text });
}

function sha256Digest(payload: string): string {
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

function matchesApprovedPin(
  market: Hip4MarketIdentity,
  settlement: {
    source: PinnedSettlementSource;
    rules: PinnedSettlementRules;
  },
): boolean {
  return approvedSettlementPins.some(
    (approved) =>
      sameMarket(approved.market, market) &&
      approved.source.id === settlement.source.id &&
      approved.source.uri === settlement.source.uri &&
      approved.source.pinnedDigest === settlement.source.pinnedDigest &&
      approved.rules.version === settlement.rules.version &&
      approved.rules.pinnedDigest === settlement.rules.pinnedDigest,
  );
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
