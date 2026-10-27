import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertRoundedQuoteOrderValue,
  buildQuoteReplacementRequest,
  createEncryptedAgent,
  decodeIntegratorId,
  decryptSecret,
  encryptSecret,
  isMakerClientOrderId,
  loadAgentKeypair,
  MAKER_ASK_CLIENT_ORDER_ID,
  MAKER_BID_CLIENT_ORDER_ID,
  nextMakerClientOrderIds,
} from "../src/index.js";

describe("maker order isolation", () => {
  it("rejects rounded quotes below the venue minimum before transaction build", () => {
    expect(() =>
      assertRoundedQuoteOrderValue({
        symbol: "MON",
        sizeBase: 47,
        bidPrice: 0.02120932,
        askPrice: 0.02127092,
        minOrderUsdValue: 1,
      }),
    ).toThrow("below the venue's $1.00 minimum");

    expect(() =>
      assertRoundedQuoteOrderValue({
        symbol: "MON",
        sizeBase: 47.6,
        bidPrice: 0.02120932,
        askPrice: 0.02127092,
        minOrderUsdValue: 1,
      }),
    ).not.toThrow();
  });

  it("replaces only orders tagged by this service", () => {
    const request = buildQuoteReplacementRequest({
      marketId: "0x1234",
      bidPrice: 990n,
      askPrice: 1_010n,
      size: 5n,
      leverage: 1,
      hasPosition: false,
    });

    expect(request.orderIdsToCancel).toEqual([]);
    expect(request.clientOrderIdsToCancel).toEqual([
      MAKER_BID_CLIENT_ORDER_ID,
      MAKER_ASK_CLIENT_ORDER_ID,
    ]);
    expect(request.ordersToPlace.map((order) => order.clientOrderId)).toEqual([
      MAKER_BID_CLIENT_ORDER_ID,
      MAKER_ASK_CLIENT_ORDER_ID,
    ]);
    expect(request.builderCode).toBeUndefined();
  });

  it("rotates client IDs within the Maker-owned namespace", () => {
    const first = nextMakerClientOrderIds(1_000);
    const second = nextMakerClientOrderIds(1_001);

    expect(first).not.toEqual(second);
    expect(
      [
        first.bid,
        first.ask,
        second.bid,
        second.ask,
        MAKER_BID_CLIENT_ORDER_ID,
        MAKER_ASK_CLIENT_ORDER_ID,
      ].every(isMakerClientOrderId),
    ).toBe(true);
    expect(isMakerClientOrderId(123n)).toBe(false);
    expect(isMakerClientOrderId(0x5055000000000001n)).toBe(false);
  });

  it("cancels active Maker IDs while placing with a fresh pair", () => {
    const activeClientIds = nextMakerClientOrderIds(1_000);
    const freshClientIds = nextMakerClientOrderIds(2_000);
    const request = buildQuoteReplacementRequest({
      marketId: "0x1234",
      bidPrice: 990n,
      askPrice: 1_010n,
      size: 5n,
      leverage: 1,
      hasPosition: false,
      activeMakerOrderIds: [101n, 202n],
      activeMakerClientOrderIds: [activeClientIds.bid, activeClientIds.ask],
      clientOrderIds: freshClientIds,
    });

    expect(request.orderIdsToCancel).toEqual([101n, 202n]);
    expect(request.clientOrderIdsToCancel).toEqual([
      activeClientIds.bid,
      activeClientIds.ask,
    ]);
    expect(request.ordersToPlace.map((order) => order.clientOrderId)).toEqual([
      freshClientIds.bid,
      freshClientIds.ask,
    ]);
  });

  it("attaches the configured builder code to the whole atomic batch", () => {
    const request = buildQuoteReplacementRequest({
      marketId: "0x1234",
      bidPrice: 990n,
      askPrice: 1_010n,
      size: 5n,
      leverage: 1,
      hasPosition: false,
      builderCode: { integratorId: 7, integratorFee: 0.0001 },
    });

    expect(request.builderCode).toEqual({
      integratorId: 7,
      integratorFee: 0.0001,
    });
  });
});

describe("builder registration", () => {
  it("decodes Aftermath's little-endian u32 registration result", () => {
    expect(decodeIntegratorId(Uint8Array.from([15, 0, 0, 0]))).toBe(15);
    expect(() => decodeIntegratorId(Uint8Array.from([1, 2]))).toThrow(
      "four-byte",
    );
  });
});

describe("encrypted agent keystore", () => {
  const masterKey = randomBytes(32).toString("base64");

  it("round-trips with authenticated context", () => {
    const envelope = encryptSecret("suiprivkey-test", masterKey, "account:42");
    expect(decryptSecret(envelope, masterKey, "account:42")).toBe(
      "suiprivkey-test",
    );
    expect(() => decryptSecret(envelope, masterKey, "account:43")).toThrow();
  });

  it("creates a restorable key without exposing it in the envelope", () => {
    const generated = createEncryptedAgent({
      masterKey,
      context: "account:42",
    });
    const restored = loadAgentKeypair({
      masterKey,
      context: "account:42",
      encryptedSecret: generated.encryptedSecret,
    });
    expect(restored.toSuiAddress()).toBe(generated.address);
    expect(JSON.stringify(generated.encryptedSecret)).not.toContain(
      "suiprivkey",
    );
  });

  it("rejects weak master key material", () => {
    expect(() => encryptSecret("secret", "not-random", "account:42")).toThrow(
      "exactly 32",
    );
  });
});
