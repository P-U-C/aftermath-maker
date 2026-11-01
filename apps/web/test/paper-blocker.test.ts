import { describe, expect, it } from "vitest";
import { formatPaperBlocker, relativeAccountRead } from "../lib/paper-blocker";

describe("Paper blocker copy", () => {
  it("shows the same structured collateral estimate and both fixes without exposing an ISO time", () => {
    const rendered = formatPaperBlocker(
      {
        code: "collateral",
        message: "fallback",
        accountId: "1757",
        availableUsd: 0,
        requiredUsd: 100,
        concurrentMarkets: 5,
        quoteSizeUsd: 10,
        leverage: 1,
        observedAt: "2026-11-01T12:00:00.000Z",
      },
      Date.parse("2026-11-01T12:05:00.000Z"),
    );
    expect(rendered.sentence).toBe(
      "Paper is waiting on account 1757. It has $0.00 free collateral, and quoting 5 markets at $10.00 a side needs $100.00. Deposit at least $100.00, or quote one market at a time (needs $20.00).",
    );
    expect(rendered).toMatchObject({
      checked: "Checked 5 min ago",
      destination: "venues",
      rotation: true,
    });
    expect(rendered.sentence).not.toContain("2026-");
  });
  it("does not suggest rotation for a one-market strategy and provides the gas key", () => {
    const collateral = formatPaperBlocker({
      code: "collateral",
      message: "fallback",
      accountId: "42",
      availableUsd: 0,
      requiredUsd: 20,
      concurrentMarkets: 1,
      quoteSizeUsd: 10,
      leverage: 1,
    });
    expect(collateral.rotation).toBe(false);
    expect(collateral.sentence).not.toContain("one market at a time");
    const gas = formatPaperBlocker({
      code: "gas",
      message: "fallback",
      accountId: "42",
      requiredGasSui: 0.15,
      agentAddress: "0xtest",
    });
    expect(gas).toMatchObject({
      sentence:
        "Paper is waiting on gas. The trading key for account 42 needs 0.15 SUI to simulate.",
      copyAddress: "0xtest",
    });
    expect(relativeAccountRead("invalid")).toBeNull();
  });
});
