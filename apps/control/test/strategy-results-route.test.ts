import { afterEach, describe, expect, it, vi } from "vitest";
import { makerConfigSchema } from "@puc/core";
import { appHarness, OWNER } from "./helpers/app.js";

describe("strategy results", () => {
  afterEach(() => vi.useRealTimers());

  it("reports fixed-horizon Live evidence from persisted fills and observations without treating missing data as zero", async () => {
    const fillAtMs = 1_700_000_000_000;
    const asOfMs = fillAtMs + 3_600_000;
    const seed = async (includeFiveMinuteReference: boolean) => {
      vi.setSystemTime(fillAtMs - 1_000);
      const h = await appHarness();
      const tenant = h.store.forTenant(OWNER);
      tenant.setConfig(
        makerConfigSchema.parse({
          mode: "paper",
          makerAccountId: "42",
          markets: [{ marketId: "0x1", symbol: "NEAR" }],
        }),
      );
      const core = tenant
        .listBundles()
        .find((bundle) => bundle.name === "Core")!;
      tenant.recordAttributedFills([
        {
          sourceEventKey: "mainnet:fill-1:0",
          runId: "live-run-1",
          configVersion: 1,
          accountId: "42",
          ownerWallet: OWNER,
          marketId: "0x1",
          orderId: "fill-1",
          txDigest: "fill-1",
          eventIndex: 0,
          timestampMs: fillAtMs,
          side: "buy",
          liquidity: "maker",
          sizeBase: "2",
          priceUsd: "100",
          notionalUsd: "200",
          venueFeeUsd: "-0.01",
          builderFeeUsd: "0.02",
          realizedPnlUsd: "0",
          counterpartyClass: "unresolved",
          classificationEvidence: ["fixture"],
          source: "fixture-live-fills",
          network: "mainnet",
          coverage: "complete",
          raw: { fixture: true },
        },
      ]);
      for (const [horizonMs, indexUsd] of [
        [60_000, "101"],
        [300_000, "102"],
        [1_800_000, "103"],
        [3_600_000, "104"],
      ] as const) {
        if (horizonMs === 300_000 && !includeFiveMinuteReference) continue;
        tenant.recordMarketObservation({
          marketId: "0x1",
          observedAtMs: fillAtMs + horizonMs,
          sourceTimestampMs: fillAtMs + horizonMs,
          indexUsd,
          bestBidUsd: indexUsd,
          bestAskUsd: indexUsd,
          depthBid50BpsUsd: "10",
          depthAsk50BpsUsd: "10",
          volume24hUsd: "1000",
          openInterestUsd: "1000",
          fundingRateRaw: "0",
          fundingPeriodMs: 0,
          makerFeeRate: "-0.00005",
          takerFeeRate: "0.0002",
          sessionOpen: true,
          source: "fixture-live-market",
          network: "mainnet",
          coverage: "complete",
          raw: { fixture: true },
        });
      }
      tenant.recordInventoryLedgerEffects([
        {
          sourceEventKey: "mainnet:funding-1",
          runId: "live-run-1",
          configVersion: 1,
          accountId: "42",
          marketId: "0x1",
          timestampMs: fillAtMs + 60_000,
          kind: "funding",
          fundingUsd: "1.25",
          gasUsedMist: null,
          gasUsd: null,
          externalTransferUsd: null,
          source: "fixture-live-funding",
          network: "mainnet",
          coverage: "complete",
          raw: { fixture: true },
        },
      ]);
      vi.setSystemTime(fillAtMs + 1);
      tenant.logExecution({
        mode: "live",
        marketId: "0x1",
        bidPrice: 100,
        askPrice: 101,
        sizeUsd: 200,
        outcome: "confirmed",
        gasUsedMist: 2_000_000,
        suiUsd: 3,
      });
      vi.setSystemTime(asOfMs);
      return { h, core };
    };

    vi.useFakeTimers();
    const complete = await seed(true);
    const completeResponse = await complete.h.app.inject({
      method: "GET",
      url: `/api/strategies/${complete.core.strategyId}/results`,
      headers: complete.h.signedInAs(),
    });
    expect(completeResponse.statusCode).toBe(200);
    expect(completeResponse.json().results.liveEvidence).toMatchObject({
      asOfMs,
      fundingUsd: 1.25,
      gasUsd: 0.006,
      netFundingAfterGasUsd: 1.244,
      gaps: [],
      fills: [
        {
          fillId: "mainnet:fill-1:0",
          markouts: [
            { horizonMs: 60_000, coverage: "complete", markoutUsd: 2 },
            { horizonMs: 300_000, coverage: "complete", markoutUsd: 4 },
            { horizonMs: 1_800_000, coverage: "complete", markoutUsd: 6 },
            { horizonMs: 3_600_000, coverage: "complete", markoutUsd: 8 },
          ],
        },
      ],
    });
    await complete.h.close();

    const missing = await seed(false);
    const missingResponse = await missing.h.app.inject({
      method: "GET",
      url: `/api/strategies/${missing.core.strategyId}/results`,
      headers: missing.h.signedInAs(),
    });
    expect(missingResponse.statusCode).toBe(200);
    const missingEvidence = missingResponse.json().results.liveEvidence;
    expect(missingEvidence.fills[0].markouts[1]).toMatchObject({
      horizonMs: 300_000,
      markoutUsd: null,
      coverage: "unavailable",
      reason: "reference arrived after freshness window",
    });
    expect(missingEvidence.gaps).toContain(
      "Live markout for fill mainnet:fill-1:0 at 300000ms is unavailable: reference arrived after freshness window.",
    );
    await missing.h.close();
  });

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
        // This is deliberately different from the terms passed at fill time:
        // results must not reprice historical Paper activity from this read.
        makerFee: 0.01,
        takerFee: 0.02,
      },
    ]);

    // A $10 bid at 2 fills when the book trades through it; its reduce-only
    // close sells the exact 5 base at the 2.2 best bid ($11 notional).
    tenant.recordPaperQuote({
      trialId: "runtime",
      marketId: "0x1",
      symbol: "NEAR",
      bidPrice: 2,
      askPrice: 2.4,
      sizeUsd: 10,
      sides: "bid",
    });
    const [makerFill] = tenant.matchPaperOrders({
      trialId: "runtime",
      marketId: "0x1",
      bestBid: 1.9,
      bestAsk: 1.95,
      makerFeeRate: -0.0001,
      builderFeeRate: 0.0002,
    });
    expect(makerFill).toBeDefined();
    tenant.closePaperMarket({
      trialId: "runtime",
      marketId: "0x1",
      bestBid: 2.2,
      bestAsk: 2.25,
      takerFeeRate: 0.0005,
    });
    tenant.recordInventoryPaperMarkouts(
      [
        [60_000, "0.05"],
        [300_000, "0.25"],
        [1_800_000, "0.5"],
        [3_600_000, "0.75"],
      ].map(([horizonMs, markoutUsd]) => ({
        sourceEventKey: `paper:runtime:${makerFill!.orderKey}:${horizonMs}`,
        runId: "runtime",
        orderKey: makerFill!.orderKey,
        marketId: "0x1",
        fillAtMs: Date.parse(makerFill!.occurredAt),
        fillPriceUsd: "2",
        side: "bid" as const,
        baseAssetAmount: "5",
        horizonMs,
        referenceUsd: "2.05",
        observedAtMs: Date.parse(makerFill!.occurredAt) + horizonMs,
        markoutUsd,
        source: "fixture-index",
        network: "paper",
        coverage: "complete" as const,
        raw: { fixture: true },
      })),
    );
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
    const { paper, paperEvidence, live } = response.json().results;
    // Fee terms are frozen at the simulated fill. Changing a market's current
    // schedule must never rewrite an older Paper result.
    expect(paper.executionFeesUsd).toBeCloseTo(-0.001 + 0.0055, 9);
    expect(paper.builderFeesUsd).toBeCloseTo(0.002, 9);
    expect(paper.gasUsd).toBeCloseTo(0.006, 9);
    expect(paper.fundingUsd).toBeNull();
    // Bought 5 at 2 and sold the exact 5 base at 2.2.
    const pricePnl = paper.realizedPricePnlUsd + paper.unrealizedPricePnlUsd;
    expect(pricePnl).toBeCloseTo(1, 9);
    expect(paper.tradingNetUsd).toBeCloseTo(1 - 0.0045 - 0.002 - 0.006, 9);
    expect(paper.gaps).toEqual([
      "Funding isn't simulated in Paper yet.",
      "Gas for Paper hedges and closes isn't estimated.",
      "1 transaction has no SUI price, so its gas isn't counted.",
    ]);
    expect(live).toMatchObject({ fills: 0, tradingNetUsd: 0, gaps: [] });
    expect(paperEvidence).toEqual([
      expect.objectContaining({
        marketId: "0x1",
        symbol: "NEAR",
        fills: 2,
        makerFills: 1,
        knownFeesUsd: 0.0065,
        feeTermsMissing: 0,
        markout5mUsd: 0.25,
        markout5mMeasuredFills: 1,
        markouts: [
          expect.objectContaining({
            horizonMs: 60_000,
            totalUsd: 0.05,
            measuredFills: 1,
            averageBps: 50,
          }),
          expect.objectContaining({
            horizonMs: 300_000,
            totalUsd: 0.25,
            measuredFills: 1,
            averageBps: 250,
          }),
          expect.objectContaining({
            horizonMs: 1_800_000,
            totalUsd: 0.5,
            measuredFills: 1,
            averageBps: 500,
          }),
          expect.objectContaining({
            horizonMs: 3_600_000,
            totalUsd: 0.75,
            measuredFills: 1,
            averageBps: 750,
          }),
        ],
        adverseSelection: expect.objectContaining({
          state: "collecting",
          measuredFills: 1,
          unavailableFills: 0,
        }),
      }),
    ]);
    await h.close();
  });
});
