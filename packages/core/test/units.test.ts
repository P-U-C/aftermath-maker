import { describe, expect, it } from "vitest";
import { decimalToBaseUnits } from "../src/units.js";

describe("decimal units", () => {
  it("converts exact USDC amounts without floating point math", () => {
    expect(decimalToBaseUnits("50", 6)).toBe(50_000_000n);
    expect(decimalToBaseUnits("0.01", 6)).toBe(10_000n);
    expect(decimalToBaseUnits("12.345678", 6)).toBe(12_345_678n);
  });

  it("rejects ambiguous or over-precise values", () => {
    for (const value of ["-1", "+1", "01", "1e3", "1,000", "1.0000001", ""]) {
      expect(() => decimalToBaseUnits(value, 6)).toThrow();
    }
  });

  it("validates the decimal scale", () => {
    expect(() => decimalToBaseUnits("1", -1)).toThrow();
    expect(() => decimalToBaseUnits("1", 19)).toThrow();
  });
});
