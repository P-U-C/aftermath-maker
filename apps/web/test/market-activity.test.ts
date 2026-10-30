import { describe, expect, it } from "vitest";
import { marketActivity } from "../lib/market-activity";

const now = Date.parse("2026-10-30T12:00:00Z");
const snapshot = {
  running: true,
  market: { id: "0xa" },
  lastCycleAt: "2026-10-30T11:59:58Z",
  lastError: null,
  execution: { lastDecision: "quoted" },
};

describe("bundle and market activity", () => {
  it("never calls a healthy market 'quoting now' without order evidence", () => {
    expect(
      marketActivity({
        mode: "live",
        status: "running",
        marketId: "0xa",
        now,
        snapshot,
      }).label,
    ).toBe("Live · Reading this market");
    expect(
      marketActivity({
        mode: "live",
        status: "running",
        marketId: "0xb",
        now,
        snapshot,
      }).label,
    ).toBe("Live · Assigned; awaiting observation");
  });

  it("distinguishes Paper blocked simulation from successful non-signing dry run", () => {
    expect(
      marketActivity({
        mode: "paper",
        status: "running",
        marketId: "0xa",
        now,
        snapshot: {
          ...snapshot,
          lastError: "Account 1757 has $0.00 available",
        },
      }),
    ).toMatchObject({
      label: "Paper · Reading markets · Simulation blocked",
      error: "Account 1757 has $0.00 available",
    });
    expect(
      marketActivity({
        mode: "paper",
        status: "running",
        marketId: "0xa",
        now,
        snapshot,
      }).label,
    ).toBe("Paper · Dry run succeeded (no real order)");
  });

  it("only marks venue-visible owned orders as confirmed during the current run", () => {
    const observed = {
      ...snapshot,
      startedAt: "2026-10-30T11:50:00Z",
      restingQuoteVerifiedAt: "2026-10-30T11:59:58Z",
      restingQuoteMarketIds: ["0xa"],
    };
    expect(
      marketActivity({
        mode: "live",
        status: "running",
        marketId: "0xa",
        now,
        snapshot: observed,
      }).label,
    ).toBe("Live · Venue reported owned resting order");
    expect(
      marketActivity({
        mode: "live",
        status: "running",
        marketId: "0xb",
        now,
        snapshot: observed,
      }).active,
    ).toBe(false);
    expect(
      marketActivity({
        mode: "live",
        status: "stopped",
        marketId: "0xa",
        now,
        snapshot: observed,
      }).active,
    ).toBe(false);
    expect(
      marketActivity({
        mode: "live",
        status: "running",
        marketId: "0xa",
        now,
        snapshot: {
          ...observed,
          restingQuoteVerifiedAt: "2026-10-30T11:00:00Z",
        },
      }).label,
    ).toBe("Live · Reading this market");
  });

  it("marks historical stopped and stale snapshots as inactive", () => {
    expect(
      marketActivity({
        mode: "live",
        status: "stopped",
        marketId: "0xa",
        now,
        snapshot,
      }).active,
    ).toBe(false);
    expect(
      marketActivity({
        mode: "live",
        status: "running",
        marketId: "0xa",
        now,
        snapshot: { ...snapshot, lastCycleAt: "2026-10-30T11:00:00Z" },
      }).label,
    ).toBe("Live · Stale observation");
    expect(
      marketActivity({
        mode: "paper",
        status: "running",
        marketId: "0xa",
        now,
        snapshot: null,
      }).active,
    ).toBe(false);
  });
});
