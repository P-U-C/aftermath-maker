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
const sessionAuthorityType =
  "0x4e2df80a5e2fd0392878298c51ce15164222111ccea05504b9291b158f552677::authority::ASSISTANT";
const oracleId = `0x${"77".repeat(32)}`;
const size = 48_200_000_000n;
const bidPrice = 21_511_000n;
const askPrice = 21_597_000n;
const bidClientOrderId = 576_460_752_303_423_500n;
const askClientOrderId = 576_460_752_303_423_501n;
const initialMarginRatio = 1_000_000_000_000_000_000n;

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

function nestedResult(command: number, resultIndex: number) {
  return {
    NestedResult: [command, resultIndex] as [number, number],
    $kind: "NestedResult",
  };
}

function moveCall(
  packageAddress: string,
  module: string,
  fn: string,
  args: Array<
    | ReturnType<typeof input>
    | ReturnType<typeof result>
    | ReturnType<typeof nestedResult>
  >,
  typeArguments = [collateralCoinType],
) {
  return {
    MoveCall: {
      package: packageAddress,
      module,
      function: fn,
      typeArguments,
      arguments: args,
    },
    $kind: "MoveCall",
  };
}

function makeMoveVec(elements: ReturnType<typeof input>[]) {
  return {
    MakeMoveVec: { type: "u128", elements },
    $kind: "MakeMoveVec",
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
        pure(bcs.u256().serialize(initialMarginRatio).toBytes()),
      ],
      commands: [
        moveCall(
          packageId,
          "clearing_house",
          "create_market_position",
          [input(2), input(0), input(1)],
          [collateralCoinType, sessionAuthorityType],
        ),
        moveCall(
          packageId,
          "clearing_house",
          "set_position_initial_margin_ratio",
          [input(2), input(0), input(1), input(15)],
          [collateralCoinType, sessionAuthorityType],
        ),
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
        moveCall(
          packageId,
          "clearing_house",
          "start_session",
          [
            input(2),
            input(0),
            input(1),
            input(3),
            input(3),
            result(2),
            input(4),
          ],
          [collateralCoinType, sessionAuthorityType],
        ),
        moveCall(packageId, "clearing_house", "place_limit_order", [
          result(3),
          input(6),
          input(9),
          input(8),
          input(5),
          input(10),
          input(6),
          input(6),
        ]),
        moveCall(packageId, "clearing_house", "place_limit_order", [
          result(3),
          input(7),
          input(9),
          input(11),
          input(5),
          input(12),
          input(6),
          input(6),
        ]),
        moveCall(
          packageId,
          "clearing_house",
          "end_session",
          [result(3), input(0), input(1), input(7), input(6)],
          [collateralCoinType, sessionAuthorityType],
        ),
        moveCall(packageId, "clearing_house", "share", [nestedResult(6, 0)]),
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
  maxLeverage: 1,
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

function quoteWithDeallocationFixture() {
  return mutate(quoteFixture(), (snapshot) => {
    snapshot.commands.unshift(
      moveCall(
        packageId,
        "clearing_house",
        "deallocate_free_collateral",
        [input(2), input(0), input(1), input(3), input(3), input(4)],
        [collateralCoinType, sessionAuthorityType],
      ) as never,
    );
    snapshot.commands[4]!.MoveCall!.arguments[5] = result(3);
    snapshot.commands[5]!.MoveCall!.arguments[0] = result(4);
    snapshot.commands[6]!.MoveCall!.arguments[0] = result(4);
    snapshot.commands[7]!.MoveCall!.arguments[0] = result(4);
    snapshot.commands[8]!.MoveCall!.arguments[0] = nestedResult(7, 0);
  });
}

function currentLiveQuoteFixture() {
  return mutate(quoteFixture(), (snapshot) => {
    snapshot.inputs.push(pure(bcs.u128().serialize(123n).toBytes()));
    snapshot.commands = [
      makeMoveVec([input(16)]),
      moveCall(
        packageId,
        "clearing_house",
        "try_cancel_orders",
        [input(2), input(0), input(1), result(0)],
        [collateralCoinType, sessionAuthorityType],
      ),
      structuredClone(snapshot.commands[0]!),
      structuredClone(snapshot.commands[1]!),
      moveCall("0x1", "option", "none", [], [collateralCoinType]),
      structuredClone(snapshot.commands[3]!),
      structuredClone(snapshot.commands[4]!),
      structuredClone(snapshot.commands[5]!),
      structuredClone(snapshot.commands[6]!),
      structuredClone(snapshot.commands[7]!),
    ] as never;
    snapshot.commands[5]!.MoveCall!.arguments[5] = result(4);
    snapshot.commands[6]!.MoveCall!.arguments[0] = result(5);
    snapshot.commands[7]!.MoveCall!.arguments[0] = result(5);
    snapshot.commands[8]!.MoveCall!.arguments[0] = result(5);
    snapshot.commands[9]!.MoveCall!.arguments[0] = nestedResult(8, 0);
  });
}

const currentLiveQuoteIntent: AgentTransactionIntent = {
  ...quoteIntent,
  builderCode: null,
  orderIdsByMarket: { [marketId]: [123n] },
};

describe("agent transaction intent", () => {
  it("accepts a quote whose command graph matches the exact intent", () => {
    expect(() =>
      assertAgentTransactionIntent(quoteFixture(), quoteIntent),
    ).not.toThrow();
  });

  it("accepts the current deallocation and session graph", () => {
    expect(() =>
      assertAgentTransactionIntent(quoteWithDeallocationFixture(), quoteIntent),
    ).not.toThrow();
  });

  it("accepts the current live cancellation and position graph", () => {
    expect(() =>
      assertAgentTransactionIntent(
        currentLiveQuoteFixture(),
        currentLiveQuoteIntent,
      ),
    ).not.toThrow();
  });

  it("rejects a cancellation vector detached from its cancellation", () => {
    const changed = mutate(currentLiveQuoteFixture(), (snapshot) => {
      snapshot.commands[1]!.MoveCall!.arguments[3] = input(16);
    });
    expect(() =>
      assertAgentTransactionIntent(changed, currentLiveQuoteIntent),
    ).toThrow("MakeMoveVec 0 must be used only");
  });

  it("rejects a cancellation vector with a changed element type", () => {
    const changed = mutate(currentLiveQuoteFixture(), (snapshot) => {
      snapshot.commands[0]!.MakeMoveVec!.type = "u64";
    });
    expect(() =>
      assertAgentTransactionIntent(changed, currentLiveQuoteIntent),
    ).toThrow("MakeMoveVec 0 is not a vector<u128>");
  });

  it("rejects a cancellation vector with unexpected IDs", () => {
    const changed = mutate(currentLiveQuoteFixture(), (snapshot) => {
      snapshot.inputs[16] = pure(bcs.u128().serialize(124n).toBytes());
    });
    expect(() =>
      assertAgentTransactionIntent(changed, currentLiveQuoteIntent),
    ).toThrow("cancel order IDs do not match");
  });

  it("rejects an initial margin ratio outside the configured leverage", () => {
    const changed = mutate(currentLiveQuoteFixture(), (snapshot) => {
      snapshot.inputs[15] = pure(
        bcs
          .u256()
          .serialize(initialMarginRatio - 1n)
          .toBytes(),
      );
    });
    expect(() =>
      assertAgentTransactionIntent(changed, currentLiveQuoteIntent),
    ).toThrow("initial margin ratio does not match");
  });

  it("accepts the exact fractional-leverage margin ratio", () => {
    const changed = mutate(currentLiveQuoteFixture(), (snapshot) => {
      snapshot.inputs[15] = pure(
        bcs.u256().serialize(666_666_666_666_666_666n).toBytes(),
      );
    });
    expect(() =>
      assertAgentTransactionIntent(changed, {
        ...currentLiveQuoteIntent,
        maxLeverage: 1.5,
      }),
    ).not.toThrow();
  });

  it("rejects an untrusted deallocation authority type", () => {
    const changed = mutate(quoteWithDeallocationFixture(), (snapshot) => {
      snapshot.commands[0]!.MoveCall!.typeArguments[1] = `0x${"99".repeat(32)}::authority::ASSISTANT`;
    });
    expect(() => assertAgentTransactionIntent(changed, quoteIntent)).toThrow(
      "deallocate_free_collateral changed arguments or collateral type",
    );
  });

  it("rejects an untrusted initial-margin authority type", () => {
    const changed = mutate(currentLiveQuoteFixture(), (snapshot) => {
      snapshot.commands[3]!.MoveCall!.typeArguments[1] = `0x${"99".repeat(32)}::authority::ASSISTANT`;
    });
    expect(() =>
      assertAgentTransactionIntent(changed, currentLiveQuoteIntent),
    ).toThrow(
      "set_position_initial_margin_ratio changed arguments or collateral type",
    );
  });

  it("rejects a share detached from its ended session", () => {
    const changed = mutate(quoteFixture(), (snapshot) => {
      snapshot.commands[7]!.MoveCall!.arguments[0] = nestedResult(5, 0);
    });
    expect(() => assertAgentTransactionIntent(changed, quoteIntent)).toThrow(
      "clearing-house share is not attached",
    );
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
      snapshot.commands[4]!.MoveCall!.package = `0x${"99".repeat(32)}`;
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
      snapshot.commands.push(structuredClone(snapshot.commands[3]!));
    });
    expect(() => assertAgentTransactionIntent(changed, quoteIntent)).toThrow(
      "market sessions do not match",
    );
  });

  it("rejects a changed collateral type argument", () => {
    const changed = mutate(quoteFixture(), (snapshot) => {
      snapshot.commands[4]!.MoveCall!.typeArguments = [
        `0x${"99".repeat(32)}::coin::COIN`,
      ];
    });
    expect(() => assertAgentTransactionIntent(changed, quoteIntent)).toThrow(
      "collateral type",
    );
  });

  it("rejects an untrusted session authority type", () => {
    const changed = mutate(quoteFixture(), (snapshot) => {
      snapshot.commands[3]!.MoveCall!.typeArguments[1] = `0x${"99".repeat(32)}::authority::ASSISTANT`;
    });
    expect(() => assertAgentTransactionIntent(changed, quoteIntent)).toThrow(
      "start_session changed arguments or collateral type",
    );
  });

  it("rejects an untrusted end-session authority type", () => {
    const changed = mutate(quoteFixture(), (snapshot) => {
      snapshot.commands[6]!.MoveCall!.typeArguments[1] = `0x${"99".repeat(32)}::authority::ASSISTANT`;
    });
    expect(() => assertAgentTransactionIntent(changed, quoteIntent)).toThrow(
      "end_session changed arguments or collateral type",
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
      snapshot.commands.splice(5, 1);
      snapshot.commands[4]!.MoveCall!.arguments[1] = input(7);
      snapshot.commands[4]!.MoveCall!.arguments[3] = input(11);
      snapshot.commands[4]!.MoveCall!.arguments[4] = input(16);
      snapshot.commands[6]!.MoveCall!.arguments[0] = nestedResult(5, 0);
      snapshot.inputs.push(pure(bcs.u64().serialize(1).toBytes()));
    });
    const intent: AgentTransactionIntent = {
      kind: "market",
      sender,
      accountCapId: capId,
      accountObjectId: accountId,
      collateralCoinType,
      maxLeverage: 1,
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
        moveCall(
          packageId,
          "clearing_house",
          "try_cancel_orders",
          [input(2), input(0), input(1), input(16)],
          [collateralCoinType, sessionAuthorityType],
        ),
      ];
    });
    const intent: AgentTransactionIntent = {
      kind: "cancel",
      sender,
      accountCapId: capId,
      accountObjectId: accountId,
      collateralCoinType,
      maxLeverage: 1,
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
