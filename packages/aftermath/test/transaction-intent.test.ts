import { bcs } from "@mysten/sui/bcs";
import { toBase64 } from "@mysten/sui/utils";
import { describe, expect, it } from "vitest";
import {
  assertAgentSimulationEffects,
  assertAgentTransactionIntent,
  type AgentTransactionIntent,
} from "../src/transaction-intent.js";

const sender = `0x${"11".repeat(32)}`;
const capId = `0x${"22".repeat(32)}`;
const accountId = `0x${"33".repeat(32)}`;
const marketId = `0x${"44".repeat(32)}`;
const packageId = `0x${"55".repeat(32)}`;
const collateralCoinType = `0x${"66".repeat(32)}::usdc::USDC`;
const oracleId = `0x${"77".repeat(32)}`;
const size = 48_200_000_000n;
const bidPrice = 21_511_000n;
const askPrice = 21_597_000n;
const bidClientOrderId = 576_460_752_303_423_500n;
const askClientOrderId = 576_460_752_303_423_501n;

function pure(bytes: Uint8Array) {
  return { Pure: { bytes: toBase64(bytes) }, $kind: "Pure" };
}

function shared(objectId: string, mutable: boolean) {
  return {
    Object: {
      SharedObject: {
        objectId,
        initialSharedVersion: "1",
        mutable,
      },
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

function moveCall(
  packageAddress: string,
  module: string,
  fn: string,
  args: ReturnType<typeof input | typeof result>[],
) {
  return {
    MoveCall: {
      package: packageAddress,
      module,
      function: fn,
      typeArguments: [collateralCoinType],
      arguments: args,
    },
    $kind: "MoveCall",
  };
}

function quoteFixture() {
  return {
    getData: () => ({
      version: 2,
      sender,
      expiration: null,
      gasData: { budget: null, price: null, owner: null, payment: null },
      inputs: [
        shared(capId, false),
        shared(accountId, true),
        shared(marketId, true),
        shared(oracleId, false),
        shared("0x6", false),
        pure(bcs.u64().serialize(2).toBytes()),
        pure(bcs.bool().serialize(false).toBytes()),
        pure(bcs.bool().serialize(true).toBytes()),
        pure(bcs.u64().serialize(bidPrice).toBytes()),
        pure(bcs.u64().serialize(size).toBytes()),
        pure(bcs.option(bcs.u64()).serialize(bidClientOrderId).toBytes()),
        pure(bcs.u64().serialize(askPrice).toBytes()),
        pure(bcs.option(bcs.u64()).serialize(askClientOrderId).toBytes()),
        pure(bcs.u32().serialize(7).toBytes()),
        pure(bcs.u32().serialize(100_000).toBytes()),
      ],
      commands: [
        moveCall(packageId, "clearing_house", "create_market_position", [
          input(2),
          input(0),
          input(1),
        ]),
        {
          MoveCall: {
            package: packageId,
            module: "account",
            function: "create_integrator_info",
            typeArguments: [],
            arguments: [input(13), input(14)],
          },
          $kind: "MoveCall",
        },
        moveCall(packageId, "clearing_house", "start_session", [
          input(2),
          input(0),
          input(1),
          input(3),
          input(3),
          result(1),
          input(4),
        ]),
        moveCall(packageId, "clearing_house", "place_limit_order", [
          result(2),
          input(6),
          input(9),
          input(8),
          input(5),
          input(10),
          input(6),
          input(6),
        ]),
        moveCall(packageId, "clearing_house", "place_limit_order", [
          result(2),
          input(7),
          input(9),
          input(11),
          input(5),
          input(12),
          input(6),
          input(6),
        ]),
        moveCall(packageId, "clearing_house", "end_session", [
          result(2),
          input(0),
          input(1),
          input(7),
          input(6),
        ]),
        moveCall(packageId, "clearing_house", "share", []),
      ],
    }),
  };
}

const quoteIntent: AgentTransactionIntent = {
  kind: "quote",
  sender,
  accountCapId: capId,
  accountObjectId: accountId,
  collateralCoinType,
  markets: [{ marketId, packageId }],
  builderCode: { integratorId: 7, integratorFee: 0.0001 },
  marketId,
  size,
  bidPrice,
  askPrice,
  bidClientOrderId,
  askClientOrderId,
};

function mutate(
  fixture: ReturnType<typeof quoteFixture>,
  callback: (snapshot: ReturnType<typeof fixture.getData>) => void,
) {
  const snapshot = structuredClone(fixture.getData());
  callback(snapshot);
  return { getData: () => snapshot };
}

describe("agent transaction intent", () => {
  it("accepts a quote whose command graph matches the exact intent", () => {
    expect(() =>
      assertAgentTransactionIntent(quoteFixture(), quoteIntent),
    ).not.toThrow();
  });

  it("rejects a returned transaction with a moved quote price", () => {
    const changed = mutate(quoteFixture(), (snapshot) => {
      snapshot.inputs[8] = pure(
        bcs
          .u64()
          .serialize(bidPrice - 1_000n)
          .toBytes(),
      );
    });
    expect(() => assertAgentTransactionIntent(changed, quoteIntent)).toThrow(
      "quote price does not match intent",
    );
  });

  it("rejects an extra transfer even when the expected values remain present", () => {
    const changed = mutate(quoteFixture(), (snapshot) => {
      snapshot.commands.push({
        TransferObjects: { objects: [result(0)], address: input(0) },
        $kind: "TransferObjects",
      } as never);
    });
    expect(() => assertAgentTransactionIntent(changed, quoteIntent)).toThrow(
      "transfer",
    );
  });

  it("rejects a call to an untrusted package", () => {
    const changed = mutate(quoteFixture(), (snapshot) => {
      snapshot.commands[3]!.MoveCall!.package = `0x${"99".repeat(32)}`;
    });
    expect(() => assertAgentTransactionIntent(changed, quoteIntent)).toThrow(
      "untrusted package",
    );
  });

  it("rejects an unexpected mutable object", () => {
    const changed = mutate(quoteFixture(), (snapshot) => {
      snapshot.inputs.push(shared(`0x${"88".repeat(32)}`, true));
    });
    expect(() => assertAgentTransactionIntent(changed, quoteIntent)).toThrow(
      "mutable object",
    );
  });

  it("rejects an extra allowed session call in the returned graph", () => {
    const changed = mutate(quoteFixture(), (snapshot) => {
      snapshot.commands.push(structuredClone(snapshot.commands[2]!));
    });
    expect(() => assertAgentTransactionIntent(changed, quoteIntent)).toThrow(
      "market sessions do not match",
    );
  });

  it("rejects a changed collateral type argument", () => {
    const changed = mutate(quoteFixture(), (snapshot) => {
      snapshot.commands[3]!.MoveCall!.typeArguments = [
        `0x${"99".repeat(32)}::coin::COIN`,
      ];
    });
    expect(() => assertAgentTransactionIntent(changed, quoteIntent)).toThrow(
      "collateral type",
    );
  });

  it("rejects a builder fee changed by the API", () => {
    const changed = mutate(quoteFixture(), (snapshot) => {
      snapshot.inputs[14] = pure(bcs.u32().serialize(100_001).toBytes());
    });
    expect(() => assertAgentTransactionIntent(changed, quoteIntent)).toThrow(
      "builder fee does not match",
    );
  });

  it("rejects a market order outside its slippage bound", () => {
    const fixture = mutate(quoteFixture(), (snapshot) => {
      snapshot.commands.splice(4, 1);
      snapshot.commands[3]!.MoveCall!.arguments[1] = input(7);
      snapshot.commands[3]!.MoveCall!.arguments[3] = input(11);
      snapshot.commands[3]!.MoveCall!.arguments[4] = input(15);
      snapshot.inputs.push(pure(bcs.u64().serialize(1).toBytes()));
    });
    const intent: AgentTransactionIntent = {
      kind: "market",
      sender,
      accountCapId: capId,
      accountObjectId: accountId,
      collateralCoinType,
      markets: [{ marketId, packageId }],
      builderCode: { integratorId: 7, integratorFee: 0.0001 },
      orders: [
        {
          marketId,
          side: "ask",
          size,
          minPrice: askPrice + 1n,
        },
      ],
    };
    expect(() => assertAgentTransactionIntent(fixture, intent)).toThrow(
      "slippage floor",
    );
  });

  it("rejects simulated balance changes beyond signer gas", () => {
    const simulation = {
      $kind: "Transaction",
      Transaction: {
        balanceChanges: [
          {
            coinType:
              "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
            address: sender,
            amount: "-1000",
          },
        ],
      },
    };
    expect(() =>
      assertAgentSimulationEffects(simulation, sender),
    ).not.toThrow();
    simulation.Transaction.balanceChanges.push({
      coinType: collateralCoinType,
      address: sender,
      amount: "-1",
    });
    expect(() => assertAgentSimulationEffects(simulation, sender)).toThrow(
      "non-gas balance",
    );
  });

  it("validates the exact cancellation IDs", () => {
    const ids = [123n, 456n];
    const fixture = mutate(quoteFixture(), (snapshot) => {
      snapshot.inputs.push(
        pure(bcs.vector(bcs.u128()).serialize(ids).toBytes()),
      );
      snapshot.commands = [
        moveCall(packageId, "clearing_house", "try_cancel_orders", [
          input(2),
          input(0),
          input(1),
          input(15),
        ]),
      ];
    });
    const intent: AgentTransactionIntent = {
      kind: "cancel",
      sender,
      accountCapId: capId,
      accountObjectId: accountId,
      collateralCoinType,
      markets: [{ marketId, packageId }],
      builderCode: null,
      orderIdsByMarket: { [marketId]: ids },
    };
    expect(() => assertAgentTransactionIntent(fixture, intent)).not.toThrow();

    expect(() =>
      assertAgentTransactionIntent(fixture, {
        ...intent,
        orderIdsByMarket: { [marketId]: [123n] },
      }),
    ).toThrow("cancel order IDs do not match");
  });
});
