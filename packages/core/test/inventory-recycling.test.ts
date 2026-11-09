import { describe, expect, it } from "vitest";
import {
  classifyCounterparty,
  isDecimalString,
  sourceEventKey,
} from "../src/inventory-recycling.js";

describe("Inventory recycling accounting contracts", () => {
  it("does not call an unobserved counterparty independent", () => {
    expect(
      classifyCounterparty({
        ownerParentCapId: "0xowner",
        counterpartyParentCapId: null,
      }),
    ).toBe("unresolved");
    expect(
      classifyCounterparty({
        ownerParentCapId: "0xowner",
        counterpartyParentCapId: "0xowner",
      }),
    ).toBe("known_same_parent");
    expect(
      classifyCounterparty({
        ownerParentCapId: "0xowner",
        counterpartyParentCapId: "0xother",
      }),
    ).toBe("verified_other_parent");
  });

  it("uses the source event index before a normalized-event fingerprint", () => {
    expect(
      sourceEventKey({
        network: "mainnet",
        txDigest: "0xdigest",
        eventIndex: 2,
      }),
    ).toBe("mainnet:0xdigest:2");
    expect(
      sourceEventKey({
        network: "mainnet",
        txDigest: "0xdigest",
        eventIndex: null,
        normalizedEventFingerprint: "f00d",
      }),
    ).toBe("mainnet:0xdigest:hash:f00d");
  });

  it("preserves signed decimal evidence without accepting exponent notation", () => {
    expect(isDecimalString("-0.0001")).toBe(true);
    expect(isDecimalString("3891.58")).toBe(true);
    expect(isDecimalString("1e-4")).toBe(false);
  });
});
