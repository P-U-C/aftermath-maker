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
  maxLeverage: number;
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

type MakeMoveVec = {
  type?: string | null;
  elements?: Argument[];
};

type Command = {
  MoveCall?: MoveCall;
  MakeMoveVec?: MakeMoveVec;
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
  "deallocate_free_collateral",
  "set_position_initial_margin_ratio",
  "start_session",
  "try_cancel_orders",
  "place_limit_order",
  "end_session",
  "share",
]);
const CLEARING_HOUSE_ARGUMENT_COUNTS: Record<string, number> = {
  create_market_position: 3,
  deallocate_free_collateral: 6,
  set_position_initial_margin_ratio: 4,
  start_session: 7,
  try_cancel_orders: 4,
  place_limit_order: 8,
  end_session: 5,
  share: 1,
};
const SESSION_AUTHORITY_TYPE =
  "0x4e2df80a5e2fd0392878298c51ce15164222111ccea05504b9291b158f552677::authority::ASSISTANT";
const SESSION_AUTHORITY_CALLS = new Set([
  "create_market_position",
  "deallocate_free_collateral",
  "set_position_initial_margin_ratio",
  "start_session",
  "try_cancel_orders",
  "end_session",
]);
const IFIXED_ONE = 1_000_000_000_000_000_000n;
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

function nestedResultIndex(
  argument: Argument | undefined,
  label: string,
): [number, number] {
  const nested = argument?.NestedResult;
  if (
    !Array.isArray(nested) ||
    nested.length !== 2 ||
    !Number.isInteger(nested[0]) ||
    !Number.isInteger(nested[1])
  ) {
    fail(`${label} must reference a nested command result`);
  }
  return nested;
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

function parseU128(
  snapshot: Snapshot,
  argument: Argument | undefined,
  label: string,
): bigint {
  try {
    return BigInt(bcs.u128().parse(pureBytes(snapshot, argument, label)));
  } catch {
    return fail(`${label} is not a u128`);
  }
}

function parseU256(
  snapshot: Snapshot,
  argument: Argument | undefined,
  label: string,
): bigint {
  try {
    return BigInt(bcs.u256().parse(pureBytes(snapshot, argument, label)));
  } catch {
    return fail(`${label} is not a u256`);
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
  if (typeof argument?.Input === "number") {
    try {
      return bcs
        .vector(bcs.u128())
        .parse(pureBytes(snapshot, argument, label))
        .map(BigInt);
    } catch {
      return fail(`${label} is not a vector<u128>`);
    }
  }

  if (typeof argument?.Result === "number") {
    const vector = snapshot.commands[argument.Result]?.MakeMoveVec;
    if (vector?.type !== "u128" || !Array.isArray(vector.elements)) {
      fail(`${label} is not a verified vector<u128>`);
    }
    return vector.elements.map((element, index) =>
      parseU128(snapshot, element, `${label} element ${index}`),
    );
  }

  return fail(`${label} is not a vector<u128>`);
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

function decimalRatio(value: number): {
  numerator: bigint;
  denominator: bigint;
} {
  if (!Number.isFinite(value) || value < 1 || value > 3) {
    fail("max leverage is outside the configured range");
  }
  const serialized = JSON.stringify(value);
  const match = serialized.match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match) fail("max leverage has an invalid decimal representation");

  const whole = match[1]!;
  const fractional = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  const digits = BigInt(`${whole}${fractional}`);
  const scale = fractional.length - exponent;
  if (scale <= 0) {
    return {
      numerator: digits * 10n ** BigInt(-scale),
      denominator: 1n,
    };
  }
  return { numerator: digits, denominator: 10n ** BigInt(scale) };
}

function expectedInitialMarginRatio(maxLeverage: number): bigint {
  const leverage = decimalRatio(maxLeverage);
  return (IFIXED_ONE * leverage.denominator) / leverage.numerator;
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
  return snapshot.commands.flatMap((command, index) =>
    command.MoveCall ? [{ ...command.MoveCall, index }] : [],
  );
}

function assertMakeMoveVectors(
  snapshot: Snapshot,
  calls: Array<MoveCall & { index: number }>,
): void {
  snapshot.commands.forEach((command, index) => {
    if (command.MoveCall) return;
    const vector = command.MakeMoveVec;
    if (!vector) {
      fail(
        `command ${index} is ${command.$kind ?? "not a MoveCall"}; coin, transfer, publish, and upgrade commands are forbidden`,
      );
    }
    if (vector.type !== "u128" || !Array.isArray(vector.elements)) {
      fail(`MakeMoveVec ${index} is not a vector<u128>`);
    }
    vector.elements.forEach((element, elementIndex) => {
      parseU128(
        snapshot,
        element,
        `MakeMoveVec ${index} element ${elementIndex}`,
      );
    });

    const consumers = calls.flatMap((call) =>
      call.arguments.flatMap((argument, argumentIndex) =>
        argument.Result === index ? [{ call, argumentIndex }] : [],
      ),
    );
    if (
      consumers.length !== 1 ||
      consumers[0]!.call.function !== "try_cancel_orders" ||
      consumers[0]!.argumentIndex !== 3
    ) {
      fail(
        `MakeMoveVec ${index} must be used only as the cancel order-ID vector`,
      );
    }
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
  const deallocations = calls.filter(
    (call) => call.function === "deallocate_free_collateral",
  );
  if (deallocations.length > 1) {
    fail("quote transaction has more than one collateral deallocation");
  }
  const deallocationInputIndexes = new Set(
    deallocations.map((call) =>
      inputIndex(call.arguments[0], "deallocate clearing house"),
    ),
  );
  const seenObjects = new Set<string>();

  snapshot.inputs.forEach((input, index) => {
    const id = objectId(input);
    if (!id) return;
    seenObjects.add(id);
    if (
      isMutableObject(input) &&
      !trustedMutable.has(id) &&
      !deallocationInputIndexes.has(index)
    ) {
      fail(
        `mutable object input ${index} is not the account, an expected market, or the dedicated deallocation clearing house`,
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
        call.arguments.length !== 0 ||
        call.typeArguments.length !== 1
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
    const expectedTypeArguments = SESSION_AUTHORITY_CALLS.has(call.function)
      ? call.typeArguments.length === 2 &&
        call.typeArguments[0] === intent.collateralCoinType &&
        call.typeArguments[1] === SESSION_AUTHORITY_TYPE
      : call.typeArguments.length === 1 &&
        call.typeArguments[0] === intent.collateralCoinType;
    if (
      call.arguments.length !== CLEARING_HOUSE_ARGUMENT_COUNTS[call.function] ||
      !expectedTypeArguments
    ) {
      fail(
        `clearing_house::${call.function} changed arguments or collateral type`,
      );
    }

    if (call.function === "deallocate_free_collateral") {
      const clearingHouseInput = inputIndex(
        call.arguments[0],
        "deallocate clearing house",
      );
      const clearingHouse = snapshot.inputs[clearingHouseInput];
      if (
        !clearingHouse ||
        !objectId(clearingHouse) ||
        !isMutableObject(clearingHouse)
      ) {
        fail("deallocate clearing house must be a mutable object");
      }
      const consumers = calls.flatMap((candidate) =>
        candidate.arguments.flatMap((argument, argumentIndex) =>
          argument.Input === clearingHouseInput
            ? [{ call: candidate, argumentIndex }]
            : [],
        ),
      );
      if (
        consumers.length !== 1 ||
        consumers[0]!.call.index !== call.index ||
        consumers[0]!.argumentIndex !== 0
      ) {
        fail(
          "deallocate clearing house is used outside collateral deallocation",
        );
      }
      if (
        objectForArgument(snapshot, call.arguments[1], "agent cap") !== capId
      ) {
        fail("deallocate_free_collateral uses an unexpected agent capability");
      }
      if (
        objectForArgument(snapshot, call.arguments[2], "account") !== accountId
      ) {
        fail("deallocate_free_collateral uses an unexpected account");
      }
      continue;
    }

    if (
      [
        "create_market_position",
        "set_position_initial_margin_ratio",
        "start_session",
        "try_cancel_orders",
      ].includes(call.function)
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
      if (
        call.function === "set_position_initial_margin_ratio" &&
        parseU256(snapshot, call.arguments[3], "initial margin ratio") !==
          expectedInitialMarginRatio(intent.maxLeverage)
      ) {
        fail("initial margin ratio does not match the configured leverage");
      }
      commandMarket.set(call.index, marketId);
    }
  }

  for (const call of calls.filter(
    (candidate) => candidate.function === "start_session",
  )) {
    const builderIndex = resultIndex(
      call.arguments[5],
      "start_session builder info",
    );
    const builder = calls.find((candidate) => candidate.index === builderIndex);
    if (
      !builder ||
      !(
        (builder.module === "account" &&
          builder.function === "create_integrator_info") ||
        (address(builder.package) === SYSTEM_PACKAGE &&
          builder.module === "option" &&
          builder.function === "none")
      )
    ) {
      fail("start_session builder info is not an approved result");
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
  const marginUpdates = calls.filter(
    (call) => call.function === "set_position_initial_margin_ratio",
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
    )
  ) {
    fail("market-position creation graph does not match placement intent");
  }

  const updatedMarkets = marginUpdates.map((call) =>
    commandMarket.get(call.index),
  );
  if (
    updatedMarkets.length !== createdMarkets.length ||
    updatedMarkets.some(
      (marketId, index) =>
        !marketId ||
        marketId !== createdMarkets[index] ||
        updatedMarkets.indexOf(marketId) !== index,
    )
  ) {
    fail("initial-margin updates do not match created positions");
  }

  if (shares.length !== endings.length) {
    fail("clearing-house shares do not match ended sessions");
  }
  const sharedMarkets = new Set<string>();
  for (const share of shares) {
    const [endIndex, result] = nestedResultIndex(
      share.arguments[0],
      "clearing-house share",
    );
    if (result !== 0) {
      fail("clearing-house share must use the primary ended session result");
    }
    const marketId = commandMarket.get(endIndex);
    const ending = endings.find((call) => call.index === endIndex);
    if (!ending || !marketId || sharedMarkets.has(marketId)) {
      fail("clearing-house share is not attached to a verified ended session");
    }
    sharedMarkets.add(marketId);
  }
  if (
    sharedMarkets.size !== expected.length ||
    expected.some((marketId) => !sharedMarkets.has(marketId))
  ) {
    fail("clearing-house shares do not match placement intent");
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
  assertMakeMoveVectors(snapshot, calls);
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
