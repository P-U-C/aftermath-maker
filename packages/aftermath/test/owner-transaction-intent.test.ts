import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { describe, expect, it } from "vitest";
import {
  assertOwnerSimulationEffects,
  assertOwnerTransactionIntent,
  deserializeOwnerTransactionIntent,
  serializeOwnerTransactionIntent,
  type OwnerTransactionIntent,
} from "../src/owner-transaction-intent.js";

const owner = `0x${"11".repeat(32)}`;
const capId = `0x${"22".repeat(32)}`;
const accountId = `0x${"33".repeat(32)}`;
const marketId = `0x${"44".repeat(32)}`;
const registryId = `0x${"55".repeat(32)}`;
const packageId = `0x${"66".repeat(32)}`;
const collateralCoinType = `0x${"77".repeat(32)}::usdc::USDC`;
const amount = 1_000n;

function pure(bytes: Uint8Array) {
  return { Pure: { bytes: toBase64(bytes) }, $kind: "Pure" };
}

function pureAddress(value: string) {
  return pure(Uint8Array.from(Buffer.from(value.slice(2), "hex")));
}

function shared(objectId: string, mutable: boolean) {
  return {
    Object: {
      SharedObject: { objectId, initialSharedVersion: "1", mutable },
      $kind: "SharedObject",
    },
    $kind: "Object",
  };
}

function input(index: number) {
  return { Input: index, $kind: "Input" };
}

function result(index: number) {
  return { Result: index, $kind: "Result" };
}

function protocolCall(
  fn: string,
  args: Array<ReturnType<typeof input> | ReturnType<typeof result>>,
) {
  return {
    MoveCall: {
      package: packageId,
      module:
        fn === "deallocate_free_collateral" ? "clearing_house" : "account",
      function: fn,
      typeArguments: [collateralCoinType],
      arguments: args,
    },
    $kind: "MoveCall",
  };
}

function withdrawFixture() {
  return {
    getData: () => ({
      version: 2,
      sender: owner,
      inputs: [
        shared(capId, false),
        shared(accountId, true),
        shared(marketId, true),
        shared(`0x${"88".repeat(32)}`, false),
        shared("0x6", false),
        shared(registryId, false),
        pure(bcs.u64().serialize(amount).toBytes()),
        pureAddress(owner),
      ],
      commands: [
        protocolCall("deallocate_free_collateral", [
          input(2),
          input(0),
          input(1),
          input(3),
          input(3),
          input(4),
        ]),
        protocolCall("withdraw_collateral", [
          input(1),
          input(0),
          input(5),
          input(6),
        ]),
        {
          TransferObjects: {
            objects: [result(1)],
            address: input(7),
          },
          $kind: "TransferObjects",
        },
      ],
    }),
  };
}

const intent: OwnerTransactionIntent = {
  kind: "withdraw",
  sender: owner,
  protocolPackageId: packageId,
  registryObjectId: registryId,
  collateralCoinType,
  accountCapId: capId,
  accountObjectId: accountId,
  allowedMarketIds: [marketId],
  amount,
  recipient: owner,
};

function mutate(
  callback: (
    snapshot: ReturnType<ReturnType<typeof withdrawFixture>["getData"]>,
  ) => void,
) {
  const snapshot = structuredClone(withdrawFixture().getData());
  callback(snapshot);
  return { getData: () => snapshot };
}

describe("owner transaction intent", () => {
  it("binds two account capabilities to their own redeemed amounts in one batch", () => {
    const secondCap = `0x${"ab".repeat(32)}`;
    const secondAccount = `0x${"cd".repeat(32)}`;
    const batch: OwnerTransactionIntent = {
      kind: "deposit-batch",
      sender: owner,
      protocolPackageId: packageId,
      registryObjectId: registryId,
      collateralCoinType,
      deposits: [
        {
          accountCapId: capId,
          accountObjectId: accountId,
          allowedMarketIds: [],
          amount: 1_000n,
        },
        {
          accountCapId: secondCap,
          accountObjectId: secondAccount,
          allowedMarketIds: [],
          amount: 2_000n,
        },
      ],
    };
    const funds = (amount: string) => ({
      FundsWithdrawal: {
        reservation: { MaxAmountU64: amount },
        typeArg: { Balance: collateralCoinType },
        withdrawFrom: { Sender: true },
      },
    });
    const redeem = (index: number) => ({
      MoveCall: {
        package: "0x2",
        module: "coin",
        function: "redeem_funds",
        typeArguments: [collateralCoinType],
        arguments: [input(index)],
      },
    });
    const snapshot = {
      sender: owner,
      inputs: [
        shared(capId, false),
        shared(accountId, true),
        shared(secondCap, false),
        shared(secondAccount, true),
        shared(registryId, false),
        funds("1000"),
        funds("2000"),
      ],
      commands: [
        redeem(5),
        protocolCall("deposit_collateral", [
          input(1),
          input(0),
          input(4),
          result(0),
        ]),
        redeem(6),
        protocolCall("deposit_collateral", [
          input(3),
          input(2),
          input(4),
          result(2),
        ]),
      ],
    };
    expect(() =>
      assertOwnerTransactionIntent({ getData: () => snapshot }, batch),
    ).not.toThrow();
    expect(
      deserializeOwnerTransactionIntent(serializeOwnerTransactionIntent(batch)),
    ).toEqual(batch);
    const swapped = structuredClone(snapshot);
    swapped.commands[3]!.MoveCall!.arguments[3] = result(0);
    expect(() =>
      assertOwnerTransactionIntent({ getData: () => swapped }, batch),
    ).toThrow("own redeemed owner funds");
    const mismatched = structuredClone(snapshot);
    mismatched.inputs[6] = funds("2001");
    expect(() =>
      assertOwnerTransactionIntent({ getData: () => mismatched }, batch),
    ).toThrow("amount");
    const differentAccount = structuredClone(snapshot);
    differentAccount.commands[3]!.MoveCall!.arguments[1] = input(0);
    expect(() =>
      assertOwnerTransactionIntent({ getData: () => differentAccount }, batch),
    ).toThrow("capability");
    expect(() =>
      assertOwnerSimulationEffects(
        {
          $kind: "Transaction",
          Transaction: {
            balanceChanges: [
              {
                coinType: collateralCoinType,
                address: owner,
                amount: "-3000",
              },
            ],
          },
        },
        batch,
      ),
    ).not.toThrow();
    expect(() =>
      assertOwnerSimulationEffects(
        {
          $kind: "Transaction",
          Transaction: {
            balanceChanges: [
              {
                coinType: collateralCoinType,
                address: owner,
                amount: "-2000",
              },
            ],
          },
        },
        batch,
      ),
    ).toThrow("collateral change");
  });

  it("accepts exactly one owner gas top-up and rejects recipient or amount substitution", () => {
    const recipient = `0x${"99".repeat(32)}`;
    const intent: OwnerTransactionIntent = {
      kind: "gas-top-up",
      sender: owner,
      protocolPackageId: packageId,
      registryObjectId: registryId,
      collateralCoinType,
      accountCapId: capId,
      accountObjectId: accountId,
      allowedMarketIds: [],
      agentAddress: recipient,
      gasMist: 250_000_000n,
    };
    const tx = new Transaction();
    tx.setSender(owner);
    const [coin] = tx.splitCoins(tx.gas, [250_000_000n]);
    tx.transferObjects([coin], recipient);
    expect(() => assertOwnerTransactionIntent(tx, intent)).not.toThrow();
    expect(
      deserializeOwnerTransactionIntent(
        serializeOwnerTransactionIntent(intent),
      ),
    ).toEqual(intent);
    expect(() =>
      assertOwnerTransactionIntent(tx, { ...intent, agentAddress: owner }),
    ).toThrow("recipient");
    expect(() =>
      assertOwnerTransactionIntent(tx, { ...intent, gasMist: 500_000_000n }),
    ).toThrow("amount");
  });
  it("round-trips bigint fields through the browser-safe response", () => {
    const intent: OwnerTransactionIntent = {
      kind: "grant-agent",
      sender: owner,
      protocolPackageId: packageId,
      registryObjectId: registryId,
      collateralCoinType,
      accountCapId: capId,
      accountObjectId: accountId,
      allowedMarketIds: [marketId],
      agentAddress: owner,
      gasMist: 100_000_000n,
      builderCode: { integratorId: 16, integratorFee: 0.0001 },
    };

    const serialized = serializeOwnerTransactionIntent(intent);
    expect(serialized.kind === "grant-agent" && serialized.gasMist).toBe(
      "100000000",
    );
    expect(deserializeOwnerTransactionIntent(serialized)).toEqual(intent);
  });

  it("accepts an exact withdrawal to the authenticated owner", () => {
    expect(() =>
      assertOwnerTransactionIntent(withdrawFixture(), intent),
    ).not.toThrow();
  });

  it("rejects a changed withdrawal amount", () => {
    const changed = mutate((snapshot) => {
      snapshot.inputs[6] = pure(
        bcs
          .u64()
          .serialize(amount + 1n)
          .toBytes(),
      );
    });
    expect(() => assertOwnerTransactionIntent(changed, intent)).toThrow(
      "withdraw amount",
    );
  });

  it("rejects a changed withdrawal recipient", () => {
    const changed = mutate((snapshot) => {
      snapshot.inputs[7] = pureAddress(`0x${"99".repeat(32)}`);
    });
    expect(() => assertOwnerTransactionIntent(changed, intent)).toThrow(
      "recipient",
    );
  });

  it("rejects an added SUI transfer", () => {
    const changed = mutate((snapshot) => {
      snapshot.commands.push({
        TransferObjects: {
          objects: [{ GasCoin: true, $kind: "GasCoin" }],
          address: input(7),
        },
        $kind: "TransferObjects",
      } as never);
    });
    expect(() => assertOwnerTransactionIntent(changed, intent)).toThrow(
      "command set changed",
    );
  });

  it("requires the simulated withdrawal balance to match exactly", () => {
    const simulation = {
      $kind: "Transaction",
      Transaction: {
        balanceChanges: [
          {
            coinType:
              "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
            address: owner,
            amount: "-100",
          },
          {
            coinType: collateralCoinType,
            address: owner,
            amount: amount.toString(),
          },
        ],
      },
    };
    expect(() =>
      assertOwnerSimulationEffects(simulation, intent),
    ).not.toThrow();
    simulation.Transaction.balanceChanges[1]!.amount = (amount + 1n).toString();
    expect(() => assertOwnerSimulationEffects(simulation, intent)).toThrow(
      "collateral change",
    );
  });

  it("rejects a withdrawal through another package", () => {
    const changed = mutate((snapshot) => {
      snapshot.commands[1]!.MoveCall!.package = `0x${"aa".repeat(32)}`;
    });
    expect(() => assertOwnerTransactionIntent(changed, intent)).toThrow(
      "expected account::withdraw_collateral",
    );
  });
});
