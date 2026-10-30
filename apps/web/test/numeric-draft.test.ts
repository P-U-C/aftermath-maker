import { describe, expect, it } from "vitest";
import { parseNumericDraft } from "../lib/numeric-draft";

describe("numeric draft input", () => {
  const usd = { label: "Quote size", unit: "USD", min: 0.01, max: 1_000 };
  it("does not convert blank or intermediate entry into zero", () => {
    for (const text of ["", "-", ".", "1e309", "abc"])
      expect(parseNumericDraft(text, usd).value).toBeNull();
    expect(parseNumericDraft("0.01", usd).value).toBe(0.01);
    expect(parseNumericDraft("12.34", usd).value).toBe(12.34);
  });
  it("permits signed inventory and zero only when allowed", () => {
    expect(
      parseNumericDraft("-2.5", {
        label: "Target",
        unit: "USD",
        min: -10_000,
        max: 10_000,
      }).value,
    ).toBe(-2.5);
    expect(parseNumericDraft("0", usd).error).toMatch(/0.01/);
    expect(
      parseNumericDraft("0", {
        label: "Target",
        unit: "USD",
        min: -10_000,
        max: 10_000,
      }).value,
    ).toBe(0);
  });
  it("rejects fractions for counts and non-finite or out-of-range values", () => {
    const count = {
      label: "Markets",
      unit: "markets",
      min: 1,
      max: 64,
      integer: true,
    };
    expect(parseNumericDraft("1.5", count).error).toMatch(/whole number/);
    expect(parseNumericDraft("65", count).error).toMatch(/1–64/);
    expect(parseNumericDraft("Infinity", usd).error).toMatch(/finite/);
  });
});
