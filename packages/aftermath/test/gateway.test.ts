import { describe, expect, it } from "vitest";
import {
  AccountFillHistoryCache,
  assertIntegratorRegistrationIntent,
  executionGasUsedMist,
  explainTransactionFailure,
  isPostOnlyWouldMatch,
  markPositionInventoryUsd,
  postedOrderIds,
  selectGasPaymentCoins,
  totalSuiBalance,
} from "../src/gateway.js";

const result = {
  $kind: "Transaction",
  Transaction: {
    digest: "tx-digest",
    effects: {
      gasUsed: {
        computationCost: "100",
        storageCost: "50",
        storageRebate: "20",
        nonRefundableStorageFee: "5",
      },
    },
    events: [
      {
        eventType: "0x1::perpetuals::PostedOrder",
        json: { order_id: "41" },
      },
      {
        eventType: "0x1::perpetuals::Unrelated",
        json: { order_id: "ignored" },
      },
      {
        eventType: "0x1::perpetuals::PostedOrder",
        json: { orderId: 42 },
      },
    ],
  },
};

describe("gateway execution evidence", () => {
  it("calculates paid gas net of the storage rebate", () => {
    expect(executionGasUsedMist(result)).toBe(130);
  });

  it("counts coin objects and address balance in gas readiness", () => {
    expect(totalSuiBalance({ balance: "3167713058" })).toBe(3.167713058);
  });

  it("marks signed position inventory from current index price", () => {
    expect(markPositionInventoryUsd(2.5, 4)).toBe(10);
    expect(markPositionInventoryUsd(-2.5, 4)).toBe(-10);
    expect(() => markPositionInventoryUsd(2.5, 0)).toThrow(
      "positive current index",
    );
  });

  it("selects explicit gas objects and refuses an underfunded payment", () => {
    const coins = [
      { objectId: "small", version: "1", digest: "a", balance: "20" },
      { objectId: "large", version: "2", digest: "b", balance: "80" },
    ];
    expect(selectGasPaymentCoins(coins, 70n)).toEqual([
      { objectId: "large", version: "2", digest: "b" },
    ]);
    expect(() => selectGasPaymentCoins(coins, 101n)).toThrow(
      "100 MIST across gas coins",
    );
  });

  it("pins the exact builder-registration command before wallet signing", () => {
    const owner = `0x${"1".repeat(64)}`;
    const registration = {
      getData: () => ({
        sender: owner,
        inputs: [
          {
            Object: {
              SharedObject: {
                objectId:
                  "0xda0bd7a60182efd662b70e0de99218bbd2b6c4bbe9de23c0bb5a87ec52b37c37",
                mutable: true,
              },
            },
          },
        ],
        commands: [
          {
            MoveCall: {
              package:
                "0x3ec740df8428aa9c93aaef7f8cc1542ac3194fd014826b51bfe245346d64efc7",
              module: "registry",
              function: "register_integrator",
              typeArguments: [],
              arguments: [{ Input: 0 }],
            },
          },
        ],
      }),
    };
    expect(() =>
      assertIntegratorRegistrationIntent(registration, owner),
    ).not.toThrow();

    const changed = structuredClone(registration.getData());
    changed.commands[0]!.MoveCall.function = "withdraw";
    expect(() =>
      assertIntegratorRegistrationIntent({ getData: () => changed }, owner),
    ).toThrow("pinned Aftermath registry intent");
  });

  it("extracts only order IDs emitted by posted-order events", () => {
    expect(postedOrderIds(result)).toEqual(["41", "42"]);
  });

  it("rejects failed transaction envelopes", () => {
    const failed = {
      $kind: "FailedTransaction",
      FailedTransaction: {
        status: { error: { message: "Move abort" } },
      },
    };
    expect(() => executionGasUsedMist(failed)).toThrow("Move abort");
  });

  it("explains the thin-book market-order slippage abort", () => {
    const venueError =
      "MoveAbort in 5th command, abort code: 46, in '0x1::clearing_house::execute_limit_order'";
    expect(explainTransactionFailure(venueError)).toContain(
      "could not execute within the configured slippage cap",
    );
    expect(explainTransactionFailure(venueError)).toContain(venueError);
    expect(explainTransactionFailure("another failure")).toBe(
      "another failure",
    );
  });

  it("classifies a post-only crossing race as retryable", () => {
    const venueError =
      "MoveAbort in 8th command, abort code: 47, in '0x1::clearing_house::execute_limit_order'";
    expect(isPostOnlyWouldMatch(venueError)).toBe(true);
    expect(explainTransactionFailure(venueError)).toContain(
      "retrying from a fresh observation",
    );
    expect(isPostOnlyWouldMatch("abort code: 47 in another module")).toBe(
      false,
    );
  });
});

type TestHistoryOrder = {
  id: string;
  timestamp: number;
};

const historyOrder = (id: string, timestamp: number): TestHistoryOrder => ({
  id,
  timestamp,
});

describe("account fill history cache", () => {
  it("reads only the fresh page on a repeated account history request", async () => {
    const cache = new AccountFillHistoryCache<TestHistoryOrder>();
    let latest = {
      orders: [historyOrder("fill-6", 6_000), historyOrder("fill-5", 5_000)],
      nextBeforeTimestampCursor: 4_000,
    };
    const olderPages = new Map([
      [
        4_000,
        {
          orders: [
            historyOrder("fill-4", 4_000),
            historyOrder("fill-3", 3_000),
          ],
          nextBeforeTimestampCursor: 2_000,
        },
      ],
      [
        2_000,
        {
          orders: [
            historyOrder("fill-2", 2_000),
            historyOrder("fill-1", 1_000),
          ],
          nextBeforeTimestampCursor: undefined,
        },
      ],
    ]);
    const pageCalls: Array<number | undefined> = [];
    const fetchPage = async (inputs: {
      beforeTimestampCursor?: number;
      limit: number;
    }) => {
      pageCalls.push(inputs.beforeTimestampCursor);
      const page =
        inputs.beforeTimestampCursor === undefined
          ? latest
          : olderPages.get(inputs.beforeTimestampCursor);
      if (!page) throw new Error("unexpected history cursor");
      return page;
    };

    const first = await cache.get({
      accountKey: "account-a",
      pageSize: 2,
      orderKey: (order) => order.id,
      fetchPage,
    });
    expect(pageCalls).toEqual([undefined, 4_000, 2_000]);
    expect(first.orders.map((order) => order.id)).toEqual([
      "fill-6",
      "fill-5",
      "fill-4",
      "fill-3",
      "fill-2",
      "fill-1",
    ]);

    latest = {
      orders: [historyOrder("fill-7", 7_000), historyOrder("fill-6", 6_000)],
      nextBeforeTimestampCursor: 5_000,
    };
    pageCalls.length = 0;
    const repeated = await cache.get({
      accountKey: "account-a",
      pageSize: 2,
      orderKey: (order) => order.id,
      fetchPage,
    });

    expect(pageCalls).toEqual([undefined]);
    expect(repeated.historyComplete).toBe(true);
    expect(repeated.orders.map((order) => order.id)).toEqual([
      "fill-7",
      "fill-6",
      "fill-5",
      "fill-4",
      "fill-3",
      "fill-2",
      "fill-1",
    ]);
  });

  it("continues from the stored cursor when a request expands its time window", async () => {
    const cache = new AccountFillHistoryCache<TestHistoryOrder>();
    const pages = new Map<
      number | undefined,
      {
        orders: TestHistoryOrder[];
        nextBeforeTimestampCursor: number | undefined;
      }
    >([
      [
        undefined,
        {
          orders: [
            historyOrder("fill-6", 6_000),
            historyOrder("fill-5", 5_000),
          ],
          nextBeforeTimestampCursor: 4_000,
        },
      ],
      [
        4_000,
        {
          orders: [
            historyOrder("fill-4", 4_000),
            historyOrder("fill-3", 3_000),
          ],
          nextBeforeTimestampCursor: 2_000,
        },
      ],
      [
        2_000,
        {
          orders: [
            historyOrder("fill-2", 2_000),
            historyOrder("fill-1", 1_000),
          ],
          nextBeforeTimestampCursor: undefined,
        },
      ],
    ]);
    const pageCalls: Array<number | undefined> = [];
    const fetchPage = async (inputs: {
      beforeTimestampCursor?: number;
      limit: number;
    }) => {
      pageCalls.push(inputs.beforeTimestampCursor);
      const page = pages.get(inputs.beforeTimestampCursor);
      if (!page) throw new Error("unexpected history cursor");
      return page;
    };

    const recent = await cache.get({
      accountKey: "account-a",
      pageSize: 2,
      sinceMs: 4_500_000,
      orderKey: (order) => order.id,
      fetchPage,
    });
    expect(pageCalls).toEqual([undefined, 4_000]);
    expect(recent.orders.map((order) => order.id)).toEqual([
      "fill-6",
      "fill-5",
    ]);

    pageCalls.length = 0;
    const expanded = await cache.get({
      accountKey: "account-a",
      pageSize: 2,
      sinceMs: 1_500_000,
      orderKey: (order) => order.id,
      fetchPage,
    });
    expect(pageCalls).toEqual([undefined, 2_000]);
    expect(expanded.historyComplete).toBe(true);
    expect(expanded.orders.map((order) => order.id)).toEqual([
      "fill-6",
      "fill-5",
      "fill-4",
      "fill-3",
      "fill-2",
    ]);
  });
});
