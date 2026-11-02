import { describe, expect, it } from "vitest";
import { assertCollateralWithdrawalAllowed } from "../src/collateral-guard.js";

const base = {
  accountId: "1796",
  amountUsdc: "10.00",
  withdrawableCollateralUsd: 100,
  openMakerOrderCount: 0,
  bundles: [
    {
      name: "Bundy",
      status: "paused",
      makerAccountId: "1796",
      takerAccountId: null,
    },
  ],
};

describe("owner account withdrawal precondition", () => {
  it("blocks the bundle using the account while running, including a Taker role", () => {
    expect(() =>
      assertCollateralWithdrawalAllowed({
        ...base,
        bundles: [{ ...base.bundles[0]!, status: "running" }],
      }),
    ).toThrow("Pause Bundy before you withdraw from account 1796.");
    expect(() =>
      assertCollateralWithdrawalAllowed({
        ...base,
        bundles: [
          {
            name: "Bundy",
            status: "running",
            makerAccountId: "other",
            takerAccountId: "1796",
          },
        ],
      }),
    ).toThrow("Pause Bundy");
  });
  it("permits a paused account without orders and rejects residual Maker orders", () => {
    expect(() => assertCollateralWithdrawalAllowed(base)).not.toThrow();
    expect(() =>
      assertCollateralWithdrawalAllowed({ ...base, openMakerOrderCount: 1 }),
    ).toThrow("Cancel open Maker orders");
  });
  it("does not let an amount exceed the venue's withdrawable collateral", () => {
    expect(() =>
      assertCollateralWithdrawalAllowed({ ...base, amountUsdc: "101.00" }),
    ).toThrow("$100.00 withdrawable");
    expect(() =>
      assertCollateralWithdrawalAllowed({ ...base, amountUsdc: "100.00" }),
    ).not.toThrow();
  });
  it("permits another bundle to run when it does not use the withdrawing account", () => {
    expect(() =>
      assertCollateralWithdrawalAllowed({
        ...base,
        bundles: [
          {
            name: "Other",
            status: "running",
            makerAccountId: "42",
            takerAccountId: "43",
          },
        ],
      }),
    ).not.toThrow();
  });
});
