import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildQuoteReplacementRequest,
  createEncryptedAgent,
  decodeIntegratorId,
  decryptSecret,
  encryptSecret,
  loadAgentKeypair,
  MAKER_ASK_CLIENT_ORDER_ID,
  MAKER_BID_CLIENT_ORDER_ID,
} from "../src/index.js";

describe("maker order isolation", () => {
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
