import { describe, expect, it } from "vitest";
import { OWNER, appHarness } from "./helpers/app.js";

describe("Inventory recycling evidence route", () => {
  it("returns tenant-scoped Paper markouts and policy decisions without rewards as P&L", async () => {
    const h = await appHarness();
    const tenant = h.store.forTenant(OWNER);
    tenant.recordInventoryPaperMarkouts([
      {
        sourceEventKey: "paper:runtime:quote-1:60000",
        runId: "runtime",
        orderKey: "quote-1",
        marketId: "0xmarket",
        fillAtMs: 1_000,
        fillPriceUsd: "10",
        side: "ask",
        baseAssetAmount: "2",
        horizonMs: 60_000,
        referenceUsd: "9.5",
        observedAtMs: 61_000,
        markoutUsd: "1",
        source: "fixture-index",
        network: "paper",
        coverage: "complete",
        raw: {},
      },
    ]);
    tenant.recordInventoryQuoteDecision({
      decisionKey: "paper:runtime:market:1000:quote",
      runId: "runtime",
      marketId: "0xmarket",
      observedAtMs: 1_000,
      action: "quote",
      reason: "fixed_policy",
      policy: "fixed",
      coverage: "complete",
      detail: { sizeUsd: 10 },
    });

    const response = await h.app.inject({
      method: "GET",
      url: "/api/inventory-recycling?runId=runtime",
      headers: h.signedInAs(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      paperMarkouts: [{ horizonMs: 60_000, markoutUsd: "1" }],
      quoteDecisions: [{ action: "quote", policy: "fixed" }],
      rewards: [],
    });
    await h.close();
  });
});
