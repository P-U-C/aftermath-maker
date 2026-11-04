import { describe, expect, it } from "vitest";
import { USDC_COIN_TYPE } from "@puc/core";
import { OWNER, appHarness } from "./helpers/app.js";

const OTHER_OWNER = `0x${"2".repeat(64)}`;

describe("reward-share routes", () => {
  it("aggregates selected owner accounts, saves only that tenant's model, and rejects another tenant's account", async () => {
    const h = await appHarness();
    h.gateway.when("listOwnerAccounts", (inputs: { walletAddress: string }) => [
      {
        accountId: inputs.walletAddress === OWNER ? "101" : "202",
        accountCapId: `0x${"3".repeat(64)}`,
        collateralCoinType: USDC_COIN_TYPE,
        equityUsd: 100,
        availableCollateralUsd: 100,
        allocatedCollateralUsd: 0,
        freeMarginUsd: 100,
        positionCount: 0,
        withdrawableCollateralUsd: 100,
        openMakerOrderCount: 0,
      },
    ]);
    h.gateway.when("getRewardShareSnapshot", (inputs: { accountIds: string[] }) => ({
      asOf: "2026-11-03T18:00:00.000Z",
      epochEnd: "2026-11-08T05:00:00.000Z",
      poolUsd: 70_000,
      rewardMarketCount: 65,
      markets: [
        { marketId: "0x1", symbol: "ALPHA", totalVolumeUsd: 100_000, ownTakerVolumeUsd: inputs.accountIds.length * 1_000, last24h: { externalVolumeUsd: 24_000, observedHours: 24 }, previous48h: { externalVolumeUsd: 48_000, observedHours: 48 }, cost: { takerFeeBps: 2, fillSizeUsd: 100 } },
      ],
      flags: [],
      incomplete: false,
      reconciliation: { takerRewardsUsd: 12, refundRate: null, error: null },
    }));

    const saved = await h.app.inject({
      method: "PUT",
      url: "/api/rewards/share/settings",
      headers: h.signedInAs(OWNER),
      payload: { selectedAccountIds: ["101"], poolUsd: 80_000, volumeRewardFraction: 1, incrementUsd: 1_000, fillSizeUsd: 100, forecast: "none", scenario: "cross-market", rewardMarketCount: 65, extraCostBps: 0, fixedCostUsd: 0 },
    });
    expect(saved.statusCode).toBe(200);

    const own = await h.app.inject({ method: "GET", url: "/api/rewards/share?volumeBudgetUsd=2000", headers: h.signedInAs(OWNER) });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ settings: { selectedAccountIds: ["101"], poolUsd: 80_000, scenario: "cross-market" }, rankings: [{ symbol: "ALPHA" }], allocation: { requestedVolumeBudgetUsd: 2000 } });
    expect(h.gateway.calls.find((call) => call.method === "getRewardShareSnapshot")?.args[0]).toMatchObject({ accountIds: ["101"] });

    const forbidden = await h.app.inject({ method: "GET", url: "/api/rewards/share?accountIds=101", headers: h.signedInAs(OTHER_OWNER) });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ error: "Selected account does not belong to the connected wallet" });
    expect(h.store.forTenant(OTHER_OWNER).getRewardShareSettings()).toBeNull();
    await h.close();
  });
});
