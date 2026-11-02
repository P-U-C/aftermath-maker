import { bcs } from "@mysten/sui/bcs";
import { fromBase64, normalizeSuiAddress, toHex } from "@mysten/sui/utils";

type TransactionLike = { getData(): unknown };
type BuilderCode = { integratorId: number; integratorFee: number };

type OwnerCommon = {
  sender: string;
  protocolPackageId: string;
  registryObjectId: string;
  collateralCoinType: string;
};

type AccountCommon = OwnerCommon & {
  accountCapId: string;
  accountObjectId: string;
  allowedMarketIds: string[];
};

export type OwnerTransactionIntent =
  | (OwnerCommon & { kind: "create-account" })
  | (AccountCommon & { kind: "deposit"; amount: bigint })
  | (AccountCommon & {
      kind: "withdraw";
      amount: bigint;
      recipient: string;
    })
  | (AccountCommon & {
      kind: "gas-top-up";
      agentAddress: string;
      gasMist: bigint;
    })
  | (AccountCommon & {
      kind: "grant-agent";
      agentAddress: string;
      gasMist: bigint;
      builderCode: BuilderCode | null;
    })
  | (AccountCommon & {
      kind: "revoke-agent";
      agentCapId: string;
      builderCode: BuilderCode | null;
    });

type Argument = {
  GasCoin?: true;
  Input?: number;
  Result?: number;
  NestedResult?: [number, number];
  $kind?: string;
};

type Input = {
  Object?: {
    SharedObject?: { objectId: string; mutable: boolean };
    ImmOrOwnedObject?: { objectId: string };
    Receiving?: { objectId: string };
  };
  UnresolvedObject?: { objectId: string; mutable?: boolean | null };
  Pure?: { bytes: string };
  FundsWithdrawal?: {
    reservation?: { MaxAmountU64?: string };
    typeArg?: { Balance?: string };
    withdrawFrom?: { Sender?: true };
  };
};

type MoveCall = {
  package: string;
  module: string;
  function: string;
  typeArguments: string[];
  arguments: Argument[];
};

type Command = {
  MoveCall?: MoveCall;
  TransferObjects?: { objects: Argument[]; address: Argument };
  SplitCoins?: { coin: Argument; amounts: Argument[] };
  $kind?: string;
};

type Snapshot = {
  sender?: string | null;
  inputs: Input[];
  commands: Command[];
};

const SUI_FRAMEWORK = normalizeSuiAddress("0x2");
const FEE_SCALE = 1_000_000_000;

function fail(detail: string): never {
  throw new Error(`Owner transaction intent rejected: ${detail}`);
}

function address(value: string): string {
  try {
    return normalizeSuiAddress(value);
  } catch {
    return fail(`invalid address ${value}`);
  }
}

function snapshotOf(tx: TransactionLike): Snapshot {
  const value = tx.getData();
  if (!value || typeof value !== "object") fail("missing transaction data");
  const snapshot = value as Partial<Snapshot>;
  if (!Array.isArray(snapshot.inputs) || !Array.isArray(snapshot.commands)) {
    fail("invalid transaction data");
  }
  return snapshot as Snapshot;
}

function inputIndex(argument: Argument | undefined, label: string): number {
  if (!argument || typeof argument.Input !== "number") {
    fail(`${label} must reference an input`);
  }
  return argument.Input;
}

function pureBytes(
  snapshot: Snapshot,
  argument: Argument | undefined,
  label: string,
): Uint8Array {
  const bytes = snapshot.inputs[inputIndex(argument, label)]?.Pure?.bytes;
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

function parseAddress(
  snapshot: Snapshot,
  argument: Argument | undefined,
  label: string,
): string {
  const bytes = pureBytes(snapshot, argument, label);
  if (bytes.length !== 32) fail(`${label} is not a Sui address`);
  return address(`0x${toHex(bytes)}`);
}

function objectId(input: Input | undefined): string | null {
  const raw =
    input?.Object?.SharedObject?.objectId ??
    input?.Object?.ImmOrOwnedObject?.objectId ??
    input?.Object?.Receiving?.objectId ??
    input?.UnresolvedObject?.objectId;
  return typeof raw === "string" ? address(raw) : null;
}

function mutable(input: Input): boolean {
  return (
    input.Object?.SharedObject?.mutable === true ||
    input.UnresolvedObject?.mutable === true
  );
}

function objectFor(
  snapshot: Snapshot,
  argument: Argument | undefined,
  label: string,
): string {
  const id = objectId(snapshot.inputs[inputIndex(argument, label)]);
  if (!id) fail(`${label} must reference an object`);
  return id;
}

function calls(snapshot: Snapshot): Array<MoveCall & { index: number }> {
  return snapshot.commands.flatMap((command, index) =>
    command.MoveCall ? [{ ...command.MoveCall, index }] : [],
  );
}

function assertProtocolCall(
  call: MoveCall,
  intent: OwnerTransactionIntent,
  expectedModule: string,
  expectedFunction: string,
): void {
  if (
    address(call.package) !== address(intent.protocolPackageId) ||
    call.module !== expectedModule ||
    call.function !== expectedFunction
  ) {
    fail(
      `expected ${expectedModule}::${expectedFunction}, received ${call.module}::${call.function}`,
    );
  }
  if (
    call.typeArguments.length &&
    call.typeArguments[0] !== intent.collateralCoinType
  ) {
    fail("collateral coin type does not match intent");
  }
}

function assertAccountArguments(
  snapshot: Snapshot,
  call: MoveCall,
  intent: AccountCommon,
): void {
  if (
    objectFor(snapshot, call.arguments[0], "account") !==
    address(intent.accountObjectId)
  ) {
    fail("account object does not match intent");
  }
  if (
    objectFor(snapshot, call.arguments[1], "admin capability") !==
    address(intent.accountCapId)
  ) {
    fail("admin capability does not match intent");
  }
  if (
    objectFor(snapshot, call.arguments[2], "registry") !==
    address(intent.registryObjectId)
  ) {
    fail("registry does not match intent");
  }
}

function assertObjects(
  snapshot: Snapshot,
  intent: OwnerTransactionIntent,
): void {
  const trustedMutable = new Set([address(intent.registryObjectId)]);
  if (intent.kind !== "create-account") {
    trustedMutable.add(address(intent.accountObjectId));
    intent.allowedMarketIds.forEach((id) => trustedMutable.add(address(id)));
  }
  snapshot.inputs.forEach((input, index) => {
    const id = objectId(input);
    if (id && mutable(input) && !trustedMutable.has(id)) {
      fail(`mutable object input ${index} is not authorized`);
    }
  });
}

function assertSystemCall(call: MoveCall, module: string, fn: string): void {
  if (
    address(call.package) !== SUI_FRAMEWORK ||
    call.module !== module ||
    call.function !== fn
  ) {
    fail(`unexpected framework call ${call.module}::${call.function}`);
  }
}

function assertCreate(
  snapshot: Snapshot,
  intent: Extract<OwnerTransactionIntent, { kind: "create-account" }>,
): void {
  if (snapshot.commands.length !== 3)
    fail("create-account command count changed");
  const txCalls = calls(snapshot);
  if (txCalls.length !== 3) fail("create-account contains a non-Move command");
  assertProtocolCall(
    txCalls[0]!,
    intent,
    "account",
    "create_and_share_account",
  );
  if (
    objectFor(snapshot, txCalls[0]!.arguments[0], "registry") !==
    address(intent.registryObjectId)
  ) {
    fail("create-account registry does not match intent");
  }
  assertSystemCall(txCalls[1]!, "party", "single_owner");
  if (
    parseAddress(snapshot, txCalls[1]!.arguments[0], "account owner") !==
    address(intent.sender)
  ) {
    fail("new account capability recipient does not match owner");
  }
  assertSystemCall(txCalls[2]!, "transfer", "public_party_transfer");
}

function assertDeposit(
  snapshot: Snapshot,
  intent: Extract<OwnerTransactionIntent, { kind: "deposit" }>,
): void {
  if (snapshot.commands.some((command) => !command.MoveCall)) {
    fail("deposit contains a transfer, coin mutation, publish, or upgrade");
  }
  const txCalls = calls(snapshot);
  const redeem = txCalls.filter(
    (call) => call.module === "coin" && call.function === "redeem_funds",
  );
  const deposit = txCalls.filter(
    (call) =>
      call.module === "account" && call.function === "deposit_collateral",
  );
  const deallocations = txCalls.filter(
    (call) =>
      call.module === "clearing_house" &&
      call.function === "deallocate_free_collateral",
  );
  if (
    txCalls.length !== 2 + deallocations.length ||
    redeem.length !== 1 ||
    deposit.length !== 1
  ) {
    fail("deposit command set changed");
  }
  assertSystemCall(redeem[0]!, "coin", "redeem_funds");
  const withdrawalInput =
    snapshot.inputs[inputIndex(redeem[0]!.arguments[0], "deposit funds")]
      ?.FundsWithdrawal;
  if (
    withdrawalInput?.reservation?.MaxAmountU64 !== intent.amount.toString() ||
    withdrawalInput.typeArg?.Balance !== intent.collateralCoinType ||
    withdrawalInput.withdrawFrom?.Sender !== true
  ) {
    fail("deposit funds withdrawal does not match amount, coin, and sender");
  }
  for (const call of deallocations) {
    assertProtocolCall(
      call,
      intent,
      "clearing_house",
      "deallocate_free_collateral",
    );
    const marketId = objectFor(snapshot, call.arguments[0], "market");
    if (!intent.allowedMarketIds.map(address).includes(marketId)) {
      fail("deposit touches an unexpected market");
    }
    if (
      objectFor(snapshot, call.arguments[1], "admin capability") !==
        address(intent.accountCapId) ||
      objectFor(snapshot, call.arguments[2], "account") !==
        address(intent.accountObjectId)
    ) {
      fail("deposit deallocation authority does not match intent");
    }
  }
  assertProtocolCall(deposit[0]!, intent, "account", "deposit_collateral");
  assertAccountArguments(snapshot, deposit[0]!, intent);
}

function assertWithdraw(
  snapshot: Snapshot,
  intent: Extract<OwnerTransactionIntent, { kind: "withdraw" }>,
): void {
  const transfers = snapshot.commands
    .map((command, index) => ({ command, index }))
    .filter(({ command }) => command.TransferObjects);
  const txCalls = calls(snapshot);
  const withdraw = txCalls.filter(
    (call) =>
      call.module === "account" && call.function === "withdraw_collateral",
  );
  const deallocations = txCalls.filter(
    (call) =>
      call.module === "clearing_house" &&
      call.function === "deallocate_free_collateral",
  );
  if (
    transfers.length !== 1 ||
    withdraw.length !== 1 ||
    snapshot.commands.length !== txCalls.length + 1 ||
    txCalls.length !== deallocations.length + 1
  ) {
    fail("withdraw command set changed");
  }
  for (const call of deallocations) {
    assertProtocolCall(
      call,
      intent,
      "clearing_house",
      "deallocate_free_collateral",
    );
    const marketId = objectFor(snapshot, call.arguments[0], "market");
    if (!intent.allowedMarketIds.map(address).includes(marketId)) {
      fail("withdraw touches an unexpected market");
    }
  }
  const withdrawCall = withdraw[0]!;
  assertProtocolCall(withdrawCall, intent, "account", "withdraw_collateral");
  assertAccountArguments(snapshot, withdrawCall, intent);
  if (
    parseU64(snapshot, withdrawCall.arguments[3], "withdraw amount") !==
    intent.amount
  ) {
    fail("withdraw amount does not match intent");
  }
  const transfer = transfers[0]!.command.TransferObjects!;
  if (
    transfer.objects.length !== 1 ||
    transfer.objects[0]?.Result !== withdrawCall.index ||
    parseAddress(snapshot, transfer.address, "withdraw recipient") !==
      address(intent.recipient)
  ) {
    fail("withdraw result or recipient does not match intent");
  }
}

function assertBuilderConfig(
  snapshot: Snapshot,
  call: MoveCall,
  intent: AccountCommon,
  expected: BuilderCode,
): void {
  assertAccountArguments(snapshot, call, intent);
  if (
    parseU32(snapshot, call.arguments[3], "integrator ID") !==
      expected.integratorId ||
    parseU32(snapshot, call.arguments[4], "integrator fee") !==
      Math.round(expected.integratorFee * FEE_SCALE)
  ) {
    fail("builder policy does not match intent");
  }
}

function assertGrant(
  snapshot: Snapshot,
  intent: Extract<OwnerTransactionIntent, { kind: "grant-agent" }>,
): void {
  const txCalls = calls(snapshot);
  const grant = txCalls.filter(
    (call) =>
      call.module === "account" &&
      call.function === "new_assistant_account_cap",
  );
  const party = txCalls.filter(
    (call) => call.module === "party" && call.function === "single_owner",
  );
  const partyTransfer = txCalls.filter(
    (call) =>
      call.module === "transfer" && call.function === "public_party_transfer",
  );
  const builder = txCalls.filter(
    (call) =>
      call.module === "account" && call.function === "add_integrator_config",
  );
  const splits = snapshot.commands
    .map((command, index) => ({ command, index }))
    .filter(({ command }) => command.SplitCoins);
  const transfers = snapshot.commands.filter(
    (command) => command.TransferObjects,
  );
  const expectedCalls = intent.builderCode ? 4 : 3;
  if (
    txCalls.length !== expectedCalls ||
    grant.length !== 1 ||
    party.length !== 1 ||
    partyTransfer.length !== 1 ||
    builder.length !== (intent.builderCode ? 1 : 0) ||
    splits.length !== 1 ||
    transfers.length !== 1 ||
    snapshot.commands.length !== txCalls.length + 2
  ) {
    fail("grant-agent command set changed");
  }
  assertProtocolCall(grant[0]!, intent, "account", "new_assistant_account_cap");
  assertAccountArguments(snapshot, grant[0]!, intent);
  assertSystemCall(party[0]!, "party", "single_owner");
  if (
    parseAddress(
      snapshot,
      party[0]!.arguments[0],
      "agent capability recipient",
    ) !== address(intent.agentAddress)
  ) {
    fail("agent capability recipient does not match intent");
  }
  assertSystemCall(partyTransfer[0]!, "transfer", "public_party_transfer");
  if (intent.builderCode) {
    assertProtocolCall(builder[0]!, intent, "account", "add_integrator_config");
    assertBuilderConfig(snapshot, builder[0]!, intent, intent.builderCode);
  }
  const split = splits[0]!.command.SplitCoins!;
  if (
    split.coin.GasCoin !== true ||
    split.amounts.length !== 1 ||
    parseU64(snapshot, split.amounts[0], "agent gas grant") !== intent.gasMist
  ) {
    fail("agent gas grant does not match intent");
  }
  const transfer = transfers[0]!.TransferObjects!;
  if (
    transfer.objects.length !== 1 ||
    transfer.objects[0]?.NestedResult?.[0] !== splits[0]!.index ||
    parseAddress(snapshot, transfer.address, "agent gas recipient") !==
      address(intent.agentAddress)
  ) {
    fail("agent gas transfer does not match intent");
  }
}

function assertGasTopUp(
  snapshot: Snapshot,
  intent: Extract<OwnerTransactionIntent, { kind: "gas-top-up" }>,
): void {
  if (snapshot.commands.length !== 2)
    fail("gas top-up must contain exactly two commands");
  const split = snapshot.commands[0]?.SplitCoins;
  const transfer = snapshot.commands[1]?.TransferObjects;
  if (
    !split ||
    !transfer ||
    split.coin.GasCoin !== true ||
    split.amounts.length !== 1 ||
    parseU64(snapshot, split.amounts[0], "gas top-up") !== intent.gasMist
  ) {
    fail("gas top-up must split the exact owner gas amount");
  }
  if (
    transfer.objects.length !== 1 ||
    transfer.objects[0]?.NestedResult?.[0] !== 0 ||
    transfer.objects[0]?.NestedResult?.[1] !== 0 ||
    parseAddress(snapshot, transfer.address, "gas top-up recipient") !==
      address(intent.agentAddress)
  ) {
    fail("gas top-up recipient or amount does not match intent");
  }
}

function assertRevoke(
  snapshot: Snapshot,
  intent: Extract<OwnerTransactionIntent, { kind: "revoke-agent" }>,
): void {
  if (snapshot.commands.some((command) => !command.MoveCall)) {
    fail("revoke-agent contains a transfer or coin mutation");
  }
  const txCalls = calls(snapshot);
  const revoke = txCalls.filter(
    (call) =>
      call.module === "account" &&
      call.function === "revoke_assistant_account_cap",
  );
  const builder = txCalls.filter(
    (call) =>
      call.module === "account" && call.function === "remove_integrator_config",
  );
  if (
    revoke.length !== 1 ||
    builder.length !== (intent.builderCode ? 1 : 0) ||
    txCalls.length !== 1 + builder.length
  ) {
    fail("revoke-agent command set changed");
  }
  assertProtocolCall(
    revoke[0]!,
    intent,
    "account",
    "revoke_assistant_account_cap",
  );
  assertAccountArguments(snapshot, revoke[0]!, intent);
  if (
    parseAddress(snapshot, revoke[0]!.arguments[3], "agent capability ID") !==
    address(intent.agentCapId)
  ) {
    fail("revoked agent capability does not match intent");
  }
  if (intent.builderCode) {
    assertProtocolCall(
      builder[0]!,
      intent,
      "account",
      "remove_integrator_config",
    );
    assertAccountArguments(snapshot, builder[0]!, intent);
    if (
      parseU32(snapshot, builder[0]!.arguments[3], "integrator ID") !==
      intent.builderCode.integratorId
    ) {
      fail("removed builder policy does not match intent");
    }
  }
}

export function assertOwnerTransactionIntent(
  tx: TransactionLike,
  intent: OwnerTransactionIntent,
): void {
  const snapshot = snapshotOf(tx);
  if (!snapshot.sender || address(snapshot.sender) !== address(intent.sender)) {
    fail("sender does not match the authenticated owner");
  }
  assertObjects(snapshot, intent);
  if (intent.kind === "create-account") return assertCreate(snapshot, intent);
  if (intent.kind === "deposit") return assertDeposit(snapshot, intent);
  if (intent.kind === "withdraw") return assertWithdraw(snapshot, intent);
  if (intent.kind === "grant-agent") return assertGrant(snapshot, intent);
  if (intent.kind === "gas-top-up") return assertGasTopUp(snapshot, intent);
  return assertRevoke(snapshot, intent);
}

export type SerializedOwnerTransactionIntent =
  | Extract<OwnerTransactionIntent, { kind: "create-account" }>
  | (Omit<Extract<OwnerTransactionIntent, { kind: "deposit" }>, "amount"> & {
      amount: string;
    })
  | (Omit<Extract<OwnerTransactionIntent, { kind: "withdraw" }>, "amount"> & {
      amount: string;
    })
  | (Omit<
      Extract<OwnerTransactionIntent, { kind: "grant-agent" }>,
      "gasMist"
    > & {
      gasMist: string;
    })
  | (Omit<
      Extract<OwnerTransactionIntent, { kind: "gas-top-up" }>,
      "gasMist"
    > & { gasMist: string })
  | Extract<OwnerTransactionIntent, { kind: "revoke-agent" }>;

export type PreparedOwnerTransaction = {
  transaction: string;
  intent: SerializedOwnerTransactionIntent;
};

export function serializeOwnerTransactionIntent(
  intent: OwnerTransactionIntent,
): SerializedOwnerTransactionIntent {
  if (intent.kind === "deposit" || intent.kind === "withdraw") {
    return { ...intent, amount: intent.amount.toString() };
  }
  if (intent.kind === "grant-agent" || intent.kind === "gas-top-up") {
    return { ...intent, gasMist: intent.gasMist.toString() };
  }
  return intent;
}

export function deserializeOwnerTransactionIntent(
  intent: SerializedOwnerTransactionIntent,
): OwnerTransactionIntent {
  if (intent.kind === "deposit" || intent.kind === "withdraw") {
    return { ...intent, amount: BigInt(intent.amount) };
  }
  if (intent.kind === "grant-agent" || intent.kind === "gas-top-up") {
    return { ...intent, gasMist: BigInt(intent.gasMist) };
  }
  return intent;
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

export function assertOwnerSimulationEffects(
  simulation: unknown,
  intent: OwnerTransactionIntent,
): void {
  const envelope = simulation as SimulationEnvelope;
  if (envelope.$kind !== "Transaction" || !envelope.Transaction) {
    fail("simulation did not produce successful effects");
  }
  const changes = envelope.Transaction.balanceChanges ?? [];
  const collateralChanges = changes.filter(
    (change) => change.coinType === intent.collateralCoinType,
  );
  const otherCoins = changes.filter(
    (change) =>
      change.coinType !== intent.collateralCoinType &&
      change.coinType !== SUI_COIN_TYPE,
  );
  if (otherCoins.length) fail("simulation changes an unexpected coin");

  if (intent.kind === "deposit" || intent.kind === "withdraw") {
    const expectedAddress =
      intent.kind === "deposit"
        ? address(intent.sender)
        : address(intent.recipient);
    const expectedAmount =
      intent.kind === "deposit" ? -intent.amount : intent.amount;
    if (
      collateralChanges.length !== 1 ||
      typeof collateralChanges[0]!.address !== "string" ||
      address(collateralChanges[0]!.address!) !== expectedAddress ||
      BigInt(collateralChanges[0]!.amount ?? "0") !== expectedAmount
    ) {
      fail("simulated collateral change does not match intent");
    }
  } else if (collateralChanges.length) {
    fail("simulation changes collateral for a non-collateral operation");
  }

  const suiChanges = changes.filter(
    (change) => change.coinType === SUI_COIN_TYPE,
  );
  if (intent.kind === "grant-agent" || intent.kind === "gas-top-up") {
    let ownerDelta = 0n;
    let agentDelta = 0n;
    for (const change of suiChanges) {
      if (typeof change.address !== "string") fail("SUI change has no address");
      const target = address(change.address);
      const amount = BigInt(change.amount ?? "0");
      if (target === address(intent.sender)) ownerDelta += amount;
      else if (target === address(intent.agentAddress)) agentDelta += amount;
      else fail("simulation transfers SUI to an unexpected address");
    }
    if (agentDelta !== intent.gasMist || ownerDelta >= -intent.gasMist) {
      fail("simulated agent gas grant does not match intent");
    }
    return;
  }

  for (const change of suiChanges) {
    if (
      typeof change.address !== "string" ||
      address(change.address) !== address(intent.sender)
    ) {
      fail("simulation changes SUI for another address");
    }
  }
}
