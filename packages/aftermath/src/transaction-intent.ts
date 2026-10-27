import { bcs } from "@mysten/sui/bcs";
import { fromBase64, normalizeSuiAddress } from "@mysten/sui/utils";

type TransactionLike = {
  getData(): unknown;
};

type BuilderCode = {
  integratorId: number;
  integratorFee: number;
};

type MarketAuthority = {
  marketId: string;
  packageId: string;
};

type CommonIntent = {
  sender: string;
  accountCapId: string;
  accountObjectId: string;
  collateralCoinType: string;
  markets: MarketAuthority[];
  builderCode: BuilderCode | null;
};

export type AgentTransactionIntent =
  | (CommonIntent & {
      kind: "cancel";
      orderIdsByMarket: Record<string, bigint[]>;
    })
  | (CommonIntent & {
      kind: "quote";
      marketId: string;
      size: bigint;
      bidPrice: bigint;
      askPrice: bigint;
      bidClientOrderId: bigint;
      askClientOrderId: bigint;
      orderIdsByMarket?: Record<string, bigint[]>;
    })
  | (CommonIntent & {
      kind: "market";
      orders: Array<{
        marketId: string;
        side: "bid" | "ask";
        size: bigint;
        minPrice?: bigint;
        maxPrice?: bigint;
      }>;
    });

type Argument = {
  Input?: number;
  Result?: number;
  NestedResult?: [number, number];
  $kind?: string;
};

type MoveCall = {
  package: string;
  module: string;
  function: string;
  typeArguments: string[];
  arguments: Argument[];
};

type Input = {
  Object?: {
    SharedObject?: { objectId: string; mutable: boolean };
    ImmOrOwnedObject?: { objectId: string };
    Receiving?: { objectId: string };
    $kind?: string;
  };
  UnresolvedObject?: { objectId: string; mutable?: boolean | null };
  Pure?: { bytes: string };
  $kind?: string;
};

type Command = {
  MoveCall?: MoveCall;
  $kind?: string;
};

type Snapshot = {
  sender?: string | null;
  inputs: Input[];
  commands: Command[];
};

const SYSTEM_PACKAGE = normalizeSuiAddress("0x1");
const ALLOWED_CLEARING_HOUSE_CALLS = new Set([
  "create_market_position",
  "start_session",
  "try_cancel_orders",
  "place_limit_order",
  "end_session",
  "share",
]);
const CLEARING_HOUSE_ARGUMENT_COUNTS: Record<string, number> = {
  create_market_position: 3,
  start_session: 7,
  try_cancel_orders: 4,
  place_limit_order: 8,
  end_session: 5,
  share: 0,
};
const BCS_FEE_SCALE = 1_000_000_000;

function fail(detail: string): never {
  throw new Error(`Transaction intent rejected: ${detail}`);
}

function snapshotOf(tx: TransactionLike): Snapshot {
  const value = tx.getData();
  if (!value || typeof value !== "object") fail("missing transaction data");
  const data = value as Partial<Snapshot>;
  if (!Array.isArray(data.inputs) || !Array.isArray(data.commands)) {
    fail("invalid transaction data");
  }
  return data as Snapshot;
}

function address(value: string): string {
  try {
    return normalizeSuiAddress(value);
  } catch {
    fail(`invalid address ${value}`);
  }
}

function inputIndex(argument: Argument | undefined, label: string): number {
  if (!argument || typeof argument.Input !== "number") {
    fail(`${label} must reference a transaction input`);
  }
  return argument.Input;
}

function resultIndex(argument: Argument | undefined, label: string): number {
  if (!argument || typeof argument.Result !== "number") {
    fail(`${label} must reference a command result`);
  }
  return argument.Result;
}

function pureBytes(
  snapshot: Snapshot,
  argument: Argument | undefined,
  label: string,
): Uint8Array {
  const index = inputIndex(argument, label);
  const bytes = snapshot.inputs[index]?.Pure?.bytes;
  if (typeof bytes !== "string") fail(`${label} must reference pure bytes`);
  return fromBase64(bytes);
}

function parseU64(
  snapshot: Snapshot,
  argument: Argument | undefined,
  label: string,
): bigint {
  try {
    return BigInt(bcs.u64().parse(pureBytes(snapshot, argument, label)));
  } catch {
    return fail(`${label} is not a u64`);
  }
}

function parseOptionalU64(
  snapshot: Snapshot,
  argument: Argument | undefined,
  label: string,
): bigint | null {
  try {
    const value = bcs
      .option(bcs.u64())
      .parse(pureBytes(snapshot, argument, label));
    return value === null ? null : BigInt(value);
  } catch {
    return fail(`${label} is not an option<u64>`);
  }
}

function parseU32(
  snapshot: Snapshot,
  argument: Argument | undefined,
  label: string,
): number {
  try {
    return bcs.u32().parse(pureBytes(snapshot, argument, label));
  } catch {
    return fail(`${label} is not a u32`);
  }
}

function parseBool(
  snapshot: Snapshot,
  argument: Argument | undefined,
  label: string,
): boolean {
  try {
    return bcs.bool().parse(pureBytes(snapshot, argument, label));
  } catch {
    return fail(`${label} is not a bool`);
  }
}

function parseU128Vector(
  snapshot: Snapshot,
  argument: Argument | undefined,
  label: string,
): bigint[] {
  try {
    return bcs
      .vector(bcs.u128())
      .parse(pureBytes(snapshot, argument, label))
      .map(BigInt);
  } catch {
    return fail(`${label} is not a vector<u128>`);
  }
}

function objectId(input: Input | undefined): string | null {
  const raw =
    input?.Object?.SharedObject?.objectId ??
    input?.Object?.ImmOrOwnedObject?.objectId ??
    input?.Object?.Receiving?.objectId ??
    input?.UnresolvedObject?.objectId;
  return typeof raw === "string" ? address(raw) : null;
}

function isMutableObject(input: Input): boolean {
  return (
    input.Object?.SharedObject?.mutable === true ||
    input.UnresolvedObject?.mutable === true
  );
}

function objectForArgument(
  snapshot: Snapshot,
  argument: Argument | undefined,
  label: string,
): string {
  const id = objectId(snapshot.inputs[inputIndex(argument, label)]);
  if (!id) fail(`${label} must reference an object`);
  return id;
}

function sameBigInts(actual: bigint[], expected: bigint[]): boolean {
  const a = [...actual].map(String).sort();
  const b = [...expected].map(String).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function mapByAddress<T extends { marketId: string }>(
  values: T[],
): Map<string, T> {
  return new Map(values.map((value) => [address(value.marketId), value]));
}

function expectedIds(
  values: Record<string, bigint[]> | undefined,
  marketId: string,
): bigint[] {
  if (!values) return [];
  const entry = Object.entries(values).find(
    ([candidate]) => address(candidate) === marketId,
  );
  return entry?.[1] ?? [];
}

function moveCalls(snapshot: Snapshot): Array<MoveCall & { index: number }> {
  return snapshot.commands.map((command, index) => {
    if (!command.MoveCall) {
      fail(
        `command ${index} is ${command.$kind ?? "not a MoveCall"}; coin, transfer, publish, and upgrade commands are forbidden`,
      );
    }
    return { ...command.MoveCall, index };
  });
}

function assertCommonStructure(
  snapshot: Snapshot,
  intent: AgentTransactionIntent,
  calls: Array<MoveCall & { index: number }>,
): {
  markets: Map<string, MarketAuthority>;
  commandMarket: Map<number, string>;
} {
  if (!snapshot.sender || address(snapshot.sender) !== address(intent.sender)) {
    fail("sender does not match the agent signer");
  }

  const markets = mapByAddress(intent.markets);
  if (!markets.size) fail("no trusted markets supplied");
  const packages = new Set(
    intent.markets.map((market) => address(market.packageId)),
  );
  const capId = address(intent.accountCapId);
  const accountId = address(intent.accountObjectId);
  const trustedMutable = new Set([accountId, ...markets.keys()]);
  const seenObjects = new Set<string>();

  snapshot.inputs.forEach((input, index) => {
    const id = objectId(input);
    if (!id) return;
    seenObjects.add(id);
    if (isMutableObject(input) && !trustedMutable.has(id)) {
      fail(
        `mutable object input ${index} is not the account or an expected market`,
      );
    }
  });
  if (!seenObjects.has(capId)) fail("agent capability object is missing");
  if (!seenObjects.has(accountId)) fail("account object is missing");

  const commandMarket = new Map<number, string>();
  for (const call of calls) {
    const packageId = address(call.package);
    if (packageId === SYSTEM_PACKAGE) {
      if (
        call.module !== "option" ||
        call.function !== "none" ||
        call.arguments.length !== 0
      ) {
        fail(`system call ${call.module}::${call.function} is forbidden`);
      }
      continue;
    }
    if (!packages.has(packageId)) {
      fail(`command ${call.index} targets untrusted package ${call.package}`);
    }
    if (call.module === "account") {
      if (
        call.function !== "create_integrator_info" ||
        call.arguments.length !== 2 ||
        call.typeArguments.length !== 0
      ) {
        fail(`account::${call.function} is forbidden or changed shape`);
      }
      continue;
    }
    if (
      call.module !== "clearing_house" ||
      !ALLOWED_CLEARING_HOUSE_CALLS.has(call.function)
    ) {
      fail(`${call.module}::${call.function} is forbidden`);
    }
    if (
      call.arguments.length !== CLEARING_HOUSE_ARGUMENT_COUNTS[call.function] ||
      call.typeArguments.length !== 1 ||
      call.typeArguments[0] !== intent.collateralCoinType
    ) {
      fail(
        `clearing_house::${call.function} changed arguments or collateral type`,
      );
    }

    if (
      ["create_market_position", "start_session", "try_cancel_orders"].includes(
        call.function,
      )
    ) {
      const marketId = objectForArgument(
        snapshot,
        call.arguments[0],
        `${call.function} market`,
      );
      const authority = markets.get(marketId);
      if (!authority) fail(`${call.function} targets an unexpected market`);
      if (address(authority.packageId) !== packageId) {
        fail(`${call.function} package does not match its market`);
      }
      if (
        objectForArgument(snapshot, call.arguments[1], "agent cap") !== capId
      ) {
        fail(`${call.function} uses an unexpected agent capability`);
      }
      if (
        objectForArgument(snapshot, call.arguments[2], "account") !== accountId
      ) {
        fail(`${call.function} uses an unexpected account`);
      }
      commandMarket.set(call.index, marketId);
    }
  }

  for (const call of calls.filter(
    (candidate) => candidate.function === "end_session",
  )) {
    const sessionIndex = resultIndex(call.arguments[0], "ended session");
    const session = calls.find((candidate) => candidate.index === sessionIndex);
    if (!session || session.function !== "start_session") {
      fail("end_session is not attached to a verified session");
    }
    if (
      objectForArgument(
        snapshot,
        call.arguments[1],
        "end_session agent cap",
      ) !== capId ||
      objectForArgument(snapshot, call.arguments[2], "end_session account") !==
        accountId
    ) {
      fail("end_session authority does not match intent");
    }
    const marketId = commandMarket.get(sessionIndex);
    if (!marketId) fail("end_session has no verified market");
    commandMarket.set(call.index, marketId);
  }

  for (const marketId of markets.keys()) {
    if (!seenObjects.has(marketId)) {
      fail(`expected market object ${marketId} is missing`);
    }
  }
  return { markets, commandMarket };
}

function assertBuilder(
  snapshot: Snapshot,
  calls: Array<MoveCall & { index: number }>,
  expected: BuilderCode | null,
): void {
  const builders = calls.filter(
    (call) =>
      call.module === "account" && call.function === "create_integrator_info",
  );
  if (!expected) {
    if (builders.length) fail("unexpected builder fee");
    return;
  }
  if (builders.length !== 1) fail("expected exactly one builder fee");
  const builder = builders[0]!;
  const id = parseU32(snapshot, builder.arguments[0], "integrator ID");
  const fee = parseU32(snapshot, builder.arguments[1], "integrator fee");
  const expectedFee = Math.round(expected.integratorFee * BCS_FEE_SCALE);
  if (id !== expected.integratorId || fee !== expectedFee) {
    fail("builder fee does not match the authorized policy");
  }
}

function marketForSession(
  calls: Array<MoveCall & { index: number }>,
  commandMarket: Map<number, string>,
  place: MoveCall,
): string {
  const sessionIndex = resultIndex(place.arguments[0], "order session");
  const session = calls.find((call) => call.index === sessionIndex);
  if (!session || session.function !== "start_session") {
    fail("order is not attached to a verified market session");
  }
  const marketId = commandMarket.get(sessionIndex);
  if (!marketId) fail("order session has no verified market");
  return marketId;
}

function assertSessionGraph(
  calls: Array<MoveCall & { index: number }>,
  commandMarket: Map<number, string>,
  expectedMarketIds: string[],
): void {
  const expected = expectedMarketIds.map(address).sort();
  const sessions = calls.filter((call) => call.function === "start_session");
  const endings = calls.filter((call) => call.function === "end_session");
  const positions = calls.filter(
    (call) => call.function === "create_market_position",
  );
  const shares = calls.filter((call) => call.function === "share");

  const sessionMarkets = sessions
    .map((call) => commandMarket.get(call.index))
    .filter((value): value is string => Boolean(value))
    .sort();
  if (
    sessions.length !== expected.length ||
    sessionMarkets.length !== expected.length ||
    sessionMarkets.some((marketId, index) => marketId !== expected[index])
  ) {
    fail("market sessions do not match the exact placement intent");
  }
  const endedMarkets = endings
    .map((call) => commandMarket.get(call.index))
    .filter((value): value is string => Boolean(value))
    .sort();
  if (
    endings.length !== expected.length ||
    endedMarkets.some((marketId, index) => marketId !== expected[index])
  ) {
    fail("ended sessions do not match the exact placement intent");
  }

  const createdMarkets = positions.map((call) => commandMarket.get(call.index));
  if (
    createdMarkets.some(
      (marketId, index) =>
        !marketId ||
        !expected.includes(marketId) ||
        createdMarkets.indexOf(marketId) !== index,
    ) ||
    shares.length !== positions.length
  ) {
    fail("market-position creation graph does not match placement intent");
  }
}

function assertCancellations(
  snapshot: Snapshot,
  calls: Array<MoveCall & { index: number }>,
  commandMarket: Map<number, string>,
  orderIdsByMarket: Record<string, bigint[]> | undefined,
): void {
  const cancellations = calls.filter(
    (call) => call.function === "try_cancel_orders",
  );
  const seen = new Set<string>();
  for (const call of cancellations) {
    const marketId = commandMarket.get(call.index);
    if (!marketId) fail("cancellation has no verified market");
    const actual = parseU128Vector(
      snapshot,
      call.arguments[3],
      "cancel order IDs",
    );
    const expected = expectedIds(orderIdsByMarket, marketId);
    if (!sameBigInts(actual, expected)) {
      fail(`cancel order IDs do not match intent for ${marketId}`);
    }
    seen.add(marketId);
  }
  for (const [rawMarketId, ids] of Object.entries(orderIdsByMarket ?? {})) {
    if (ids.length && !seen.has(address(rawMarketId))) {
      fail(`expected order cancellation is missing for ${rawMarketId}`);
    }
  }
}

export function assertAgentTransactionIntent(
  tx: TransactionLike,
  intent: AgentTransactionIntent,
): void {
  const snapshot = snapshotOf(tx);
  const calls = moveCalls(snapshot);
  const { commandMarket } = assertCommonStructure(snapshot, intent, calls);
  assertBuilder(snapshot, calls, intent.builderCode);

  if (intent.kind === "cancel") {
    const forbidden = calls.filter(
      (call) => call.function !== "try_cancel_orders",
    );
    if (forbidden.length) fail("cancel transaction contains another operation");
    assertCancellations(
      snapshot,
      calls,
      commandMarket,
      intent.orderIdsByMarket,
    );
    return;
  }

  assertCancellations(
    snapshot,
    calls,
    commandMarket,
    intent.kind === "quote" ? intent.orderIdsByMarket : undefined,
  );
  const placements = calls.filter(
    (call) => call.function === "place_limit_order",
  );
  assertSessionGraph(
    calls,
    commandMarket,
    intent.kind === "quote"
      ? [intent.marketId]
      : intent.orders.map((order) => order.marketId),
  );

  if (intent.kind === "quote") {
    if (placements.length !== 2) {
      fail("quote transaction must place exactly two orders");
    }
    const expected = [
      {
        side: false,
        size: intent.size,
        price: intent.bidPrice,
        clientOrderId: intent.bidClientOrderId,
      },
      {
        side: true,
        size: intent.size,
        price: intent.askPrice,
        clientOrderId: intent.askClientOrderId,
      },
    ];
    placements.forEach((place, index) => {
      if (
        marketForSession(calls, commandMarket, place) !==
        address(intent.marketId)
      ) {
        fail("quote order uses an unexpected market session");
      }
      const order = expected[index]!;
      if (
        parseBool(snapshot, place.arguments[1], "quote side") !== order.side
      ) {
        fail("quote side does not match intent");
      }
      if (parseU64(snapshot, place.arguments[2], "quote size") !== order.size) {
        fail("quote size does not match intent");
      }
      if (
        parseU64(snapshot, place.arguments[3], "quote price") !== order.price
      ) {
        fail("quote price does not match intent");
      }
      if (parseU64(snapshot, place.arguments[4], "quote order type") !== 2n) {
        fail("quote is not post-only");
      }
      if (
        parseOptionalU64(
          snapshot,
          place.arguments[5],
          "quote client order ID",
        ) !== order.clientOrderId
      ) {
        fail("quote client order ID does not match intent");
      }
    });
    return;
  }

  if (placements.length !== intent.orders.length) {
    fail("market transaction order count does not match intent");
  }
  const expectedByMarket = mapByAddress(intent.orders);
  const seen = new Set<string>();
  for (const place of placements) {
    const marketId = marketForSession(calls, commandMarket, place);
    const order = expectedByMarket.get(marketId);
    if (!order || seen.has(marketId)) {
      fail("market order uses an unexpected or duplicate market session");
    }
    seen.add(marketId);
    const side = parseBool(snapshot, place.arguments[1], "market side");
    if (side !== (order.side === "ask")) {
      fail("market side does not match intent");
    }
    if (parseU64(snapshot, place.arguments[2], "market size") !== order.size) {
      fail("market size does not match intent");
    }
    const price = parseU64(snapshot, place.arguments[3], "market limit price");
    if (order.minPrice !== undefined && price < order.minPrice) {
      fail("market limit price is below the requested slippage floor");
    }
    if (order.maxPrice !== undefined && price > order.maxPrice) {
      fail("market limit price is above the requested slippage ceiling");
    }
    if (parseU64(snapshot, place.arguments[4], "market order type") !== 1n) {
      fail("market order is not fill-or-kill");
    }
  }
}

type SimulationEnvelope = {
  $kind?: string;
  Transaction?: {
    balanceChanges?: Array<{
      coinType?: string;
      address?: string;
      amount?: string;
    }>;
  };
};

const SUI_COIN_TYPE =
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

export function assertAgentSimulationEffects(
  simulation: unknown,
  signerAddress: string,
): void {
  const envelope = simulation as SimulationEnvelope;
  if (envelope.$kind !== "Transaction" || !envelope.Transaction) {
    fail("simulation did not produce successful effects");
  }
  for (const change of envelope.Transaction.balanceChanges ?? []) {
    if (
      change.coinType !== SUI_COIN_TYPE ||
      typeof change.address !== "string" ||
      address(change.address) !== address(signerAddress)
    ) {
      fail("simulation changes a non-gas balance or another address");
    }
  }
}
