import { describe, expect, it } from "vitest";

import {
  formatEventTimestamp,
  formatExactMoney,
  formatMoney,
  formatPrice,
  formatSignedMoney,
  formatTimestamp,
  moneyTone,
} from "../lib/format";

describe("money formatting", () => {
  it("renders hero amounts to two decimals and keeps their exact tooltip value", () => {
    expect(formatMoney(-0.01541)).toBe("−$0.01541");
    expect(formatExactMoney(-0.01541)).toBe("−$0.01541");
  });

  it("normalizes negative zero and leaves zero neutral", () => {
    expect(formatMoney(-0.000001)).toBe("−$0.000001");
    expect(formatSignedMoney(-0)).toBe("$0.00");
    expect(moneyTone(-0)).toBe("neutral");
    expect(moneyTone(0)).toBe("neutral");
  });

  it("uses a true minus for losses", () => {
    expect(formatMoney(-12.5)).toBe("−$12.50");
    expect(formatSignedMoney(-12.5)).toBe("−$12.50");
    expect(formatSignedMoney(12.5)).toBe("+$12.50");
  });

  it("keeps table values to four decimals below one cent", () => {
    expect(formatMoney(0.004321, { table: true })).toBe("$0.004321");
    expect(formatMoney(-0.0008, { table: true })).toBe("−$0.0008");
    expect(formatMoney(0.123456, { table: true })).toBe("$0.1235");
  });

  it("returns a placeholder for unavailable money", () => {
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(Number.NaN)).toBe("—");
  });
});

describe("price formatting", () => {
  it("uses the market tick for BTC prices", () => {
    expect(formatPrice(68_432.14, 0.1)).toBe("68,432.1");
    expect(formatPrice(68_432.14, 0.01)).toBe("68,432.14");
  });

  it("supports sub-cent market ticks", () => {
    expect(formatPrice(0.0213931, 0.000001)).toBe("0.021393");
  });
});

describe("timestamp formatting", () => {
  const now = Date.UTC(2026, 9, 27, 14, 30, 0);

  it("uses relative seconds under one minute", () => {
    expect(formatTimestamp(new Date(now - 42_000).toISOString(), now)).toBe(
      "42 s ago",
    );
  });

  it("uses clock time after one minute", () => {
    expect(formatTimestamp(new Date(now - 61_000).toISOString(), now)).toBe(
      "2:28 PM",
    );
  });

  it("formats a complete control-log timestamp", () => {
    expect(formatEventTimestamp("2026-10-27T00:08:00.000Z")).toBe(
      "Oct 27, 12:08 AM",
    );
  });

  it("labels missing and invalid timestamps as waiting", () => {
    expect(formatTimestamp(null, now)).toBe("Waiting");
    expect(formatTimestamp("not-a-date", now)).toBe("Waiting");
    expect(formatEventTimestamp(null)).toBe("Waiting");
  });
});
