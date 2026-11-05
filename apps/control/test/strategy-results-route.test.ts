import { describe, expect, it } from "vitest";
import { makerConfigSchema } from "@puc/core";
import { appHarness, OWNER } from "./helpers/app.js";

describe("strategy results", () => {
  it("reports the Paper trading result with fees, priced gas and named gaps", async () => {
    const h = await appHarness();
    const tenant = h.store.forTenant(OWNER);
    tenant.setConfig(
      makerConfigSchema.parse({
        mode: "paper",
        markets: [{ marketId: "0x1", symbol: "NEAR" }],
      }),
    );
    const core = tenant.listBundles().find((bundle) => bundle.name === "Core")!;
    h.gateway.when("listMarkets", async () => [
      {
        id: "0x1",
        symbol: "NEAR",
        indexPrice: 2.2,
        makerFee: -0.0001,
        takerFee: 0.0005,
      },
    ]);

    // A $10 bid at 2 fills when the book trades through it; a reduce-only
    // close then sells that $10 at the 2.2 best bid.
    tenant.recordPaperQuote({
      trialId: "runtime",
      marketId: "0x1",
      symbol: "NEAR",
      bidPrice: 2,
      askPrice: 2.4,
      sizeUsd: 10,
      sides: "bid",
    });
    expect(
      tenant.matchPaperOrders({
        trialId: "runtime",
        marketId: "0x1",
        bestBid: 1.9,
        bestAsk: 1.95,
      }),
    ).toHaveLength(1);
    tenant.closePaperMarket({
      trialId: "runtime",
      marketId: "0x1",
      bestBid: 2.2,
      bestAsk: 2.25,
    });
    // Two simulated quote transactions: one priced, one from before prices.
    for (const suiUsd of [3, null])
      tenant.logExecution({
        mode: "paper",
        marketId: "0x1",
        bidPrice: 2,
        askPrice: 2.4,
        sizeUsd: 10,
        outcome: "dry-run",
        gasUsedMist: 2_000_000,
        suiUsd,
      });

    const response = await h.app.inject({
      method: "GET",
      url: `/api/strategies/${core.strategyId}/results`,
      headers: h.signedInAs(),
    });
    expect(response.statusCode).toBe(200);
    const { paper, live } = response.json().results;
    // Maker rebate on the quote, taker fee on the close; no builder code.
    expect(paper.executionFeesUsd).toBeCloseTo(-0.001 + 0.005, 9);
    expect(paper.builderFeesUsd).toBe(0);
    expect(paper.gasUsd).toBeCloseTo(0.006, 9);
    expect(paper.fundingUsd).toBeNull();
    // Bought 5 at 2; sold $10 at 2.2 (4.545 base), the rest marked at 2.2.
    const pricePnl = paper.realizedPricePnlUsd + paper.unrealizedPricePnlUsd;
    expect(pricePnl).toBeCloseTo(1, 9);
    expect(paper.tradingNetUsd).toBeCloseTo(1 - 0.004 - 0.006, 9);
    expect(paper.gaps).toEqual([
      "Funding isn't simulated in Paper yet.",
      "Gas for Paper hedges and closes isn't estimated.",
      "1 transaction has no SUI price, so its gas isn't counted.",
    ]);
    expect(live).toMatchObject({ fills: 0, tradingNetUsd: 0, gaps: [] });
    await h.close();
  });
});
