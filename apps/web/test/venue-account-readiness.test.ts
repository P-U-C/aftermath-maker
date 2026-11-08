import { describe, expect, it } from "vitest";

import { venueAccountReadiness } from "../lib/venue-account-readiness";

describe("venue account readiness copy", () => {
  it("does not ask a ready Paper account for a trading key", () => {
    expect(
      venueAccountReadiness({
        mode: "paper",
        authorized: false,
        shortfallUsd: 0,
        gasSui: null,
        readiness: {
          ready: true,
          stages: [
            { id: "strategy", status: "done", detail: "1 market selected" },
            { id: "accounts", status: "done", detail: "1 assigned" },
            {
              id: "tradingKeys",
              status: "done",
              detail: "Not required for Paper estimates",
            },
            {
              id: "gas",
              status: "done",
              detail: "Not required for Paper estimates",
            },
            { id: "collateral", status: "done", detail: "Funded" },
          ],
        },
      }),
    ).toEqual({
      stage: "Paper ready",
      ready: true,
      tradingKey: "not-needed-paper",
      needsGas: false,
    });
  });

  it("keeps the key and gas requirements for Live", () => {
    expect(
      venueAccountReadiness({
        mode: "live",
        authorized: false,
        shortfallUsd: 0,
        gasSui: 0,
        readiness: null,
      }),
    ).toMatchObject({ stage: "Needs trading key", tradingKey: "required" });
  });

  it("does not offer to duplicate a key delegated to another Maker control", () => {
    expect(
      venueAccountReadiness({
        mode: "live",
        authorized: false,
        existingTradingKeyCount: 4,
        shortfallUsd: 0,
        gasSui: null,
        readiness: null,
      }),
    ).toMatchObject({
      stage: "Existing key not connected",
      tradingKey: "existing-other-control",
      ready: false,
    });
  });
});
