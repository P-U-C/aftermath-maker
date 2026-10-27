import { describe, expect, it } from "vitest";
import { executionGasUsedMist, postedOrderIds } from "../src/gateway.js";

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
});
