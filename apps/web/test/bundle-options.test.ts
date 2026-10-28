import { describe, expect, it } from "vitest";

import {
  availableBundleAccounts,
  availableBundleMarkets,
  selectedActiveBundleId,
} from "../lib/bundle-options";

const bundles = [
  {
    id: "core",
    name: "Core",
    makerAccountId: "maker-1",
    takerAccountId: "taker-1",
    marketIds: ["MON"],
    archivedAt: null,
  },
  {
    id: "rewards",
    name: "Rewards",
    makerAccountId: "maker-2",
    takerAccountId: "taker-2",
    marketIds: ["ETH"],
    archivedAt: null,
  },
  {
    id: "old",
    name: "Old desk",
    makerAccountId: "maker-3",
    takerAccountId: null,
    marketIds: ["BTC"],
    archivedAt: "2026-10-28T12:00:00.000Z",
  },
];

describe("bundle creation options", () => {
  it("offers only roles and markets that are not held by an active bundle", () => {
    expect(
      availableBundleAccounts(
        [
          { accountId: "maker-1" },
          { accountId: "taker-1" },
          { accountId: "maker-2" },
          { accountId: "maker-3" },
          { accountId: "reserve" },
        ],
        bundles,
      ).map((account) => account.accountId),
    ).toEqual(["maker-3", "reserve"]);
    expect(
      availableBundleMarkets(
        [{ id: "MON" }, { id: "ETH" }, { id: "BTC" }, { id: "HYPE" }],
        bundles,
      ).map((market) => market.id),
    ).toEqual(["BTC", "HYPE"]);
  });

  it("does not let the selected Maker account become the Taker", () => {
    expect(
      availableBundleAccounts(
        [{ accountId: "maker-3" }, { accountId: "reserve" }],
        bundles,
        "reserve",
      ).map((account) => account.accountId),
    ).toEqual(["maker-3"]);
  });
});

describe("bundle selection after lifecycle changes", () => {
  it("falls back to active Core when the selected bundle was archived", () => {
    expect(selectedActiveBundleId(bundles, "rewards")).toBe("rewards");
    expect(
      selectedActiveBundleId(
        bundles.map((bundle) =>
          bundle.id === "rewards"
            ? { ...bundle, archivedAt: "2026-10-28T12:00:00.000Z" }
            : bundle,
        ),
        "rewards",
      ),
    ).toBe("core");
  });
});
