import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEncryptedAgent } from "@puc/aftermath";
import { makerConfigSchema, setupSchema, USDC_COIN_TYPE } from "@puc/core";
import { MakerRuntime } from "../src/runtime.js";
import { appHarness, OWNER } from "./helpers/app.js";

async function paperRuntime(
  options: { hedge?: boolean; makerFreeUsd?: number } = {},
) {
  const h = await appHarness();
  const tenant = h.store.forTenant(OWNER);
  const accountId = "1796";
  const account = h.gateway.account(accountId, options.makerFreeUsd ?? 0);
  tenant.setSetup(
    setupSchema.parse({
      ownerAddress: OWNER,
      accountId,
      accountCapId: account.accountCapId,
      collateralCoinType: USDC_COIN_TYPE,
    }),
  );
  const generated = createEncryptedAgent({
    masterKey: randomBytes(32).toString("base64"),
    context: "round10-test",
  });
  tenant.createAgent({ ...generated, encryptionContext: "round10-test" });
  tenant.confirmAgentGrant({
    accountId,
    digest: "test-only",
    agentCapId: `0x${"5".repeat(64)}`,
  });
  if (options.hedge) {
    const hedgeAccount = h.gateway.account("1802", 0);
    tenant.setSetup(
      setupSchema.parse({
        ownerAddress: OWNER,
        accountId: "1802",
        accountCapId: hedgeAccount.accountCapId,
        collateralCoinType: USDC_COIN_TYPE,
      }),
    );
    tenant.confirmAgentGrant({
      accountId: "1802",
      digest: "test-only",
      agentCapId: `0x${"6".repeat(64)}`,
    });
  }
  tenant.setConfig(
    makerConfigSchema.parse({
      mode: "paper",
      makerAccountId: accountId,
      markets: [{ marketId: "0x1", symbol: "NEAR" }],
      refreshMs: 5_000,
      maxQuoteAgeMs: 200_000,
      quoteSizeUsd: 10,
      maxInventoryUsd: 20,
      maxGrossExposureUsd: 400,
      hedge: {
        enabled: options.hedge ?? false,
        accountId: options.hedge ? "1802" : null,
        thresholdUsd: 1,
        maxOrderUsd: 100,
        maxSlippageBps: 75,
      },
    }),
  );
  const core = tenant.listBundles()[0]!;
  const runtime = h.runtimeManager.getBundle(OWNER, core.id);
  return { ...h, tenant, core, runtime };
}

afterEach(() => vi.useRealTimers());

describe("Paper cycle freshness under a stalled venue read", () => {
  it("updates accountReadAt for 1,000 ticks and logs just one blocker per 15-minute window", async () => {
    const h = await paperRuntime();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T01:11:55.000Z"));
    try {
      h.runtime.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.runtime.snapshot.paperBlocker?.code).toBe("collateral");
      expect(h.runtime.snapshot.lastSuccessfulCycleAt).toBeNull();
      const initial = Date.parse(h.runtime.snapshot.accountReadAt ?? "");
      for (let tick = 0; tick < 1_000; tick += 1)
        await vi.advanceTimersByTimeAsync(5_000);
      expect(
        Date.parse(h.runtime.snapshot.accountReadAt ?? ""),
      ).toBeGreaterThan(initial);
      const events = h.tenant
        .listEvents(100)
        .filter(
          (event) =>
            event.category === "paper" &&
            event.action === "simulation" &&
            event.outcome === "blocked",
        );
      expect(events.length).toBe(6);
      for (let index = 1; index < events.length; index += 1)
        expect(
          Math.abs(
            Date.parse(events[index - 1]!.occurredAt) -
              Date.parse(events[index]!.occurredAt),
          ),
        ).toBeGreaterThanOrEqual(15 * 60_000);
    } finally {
      await h.runtime.stop();
      vi.useRealTimers();
      await h.close();
    }
  }, 30_000);

  it("recovers after getAgentPortfolioSnapshot hangs once instead of freezing all later Paper ticks", async () => {
    const h = await paperRuntime();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T01:11:55.000Z"));
    try {
      h.runtime.start();
      await vi.advanceTimersByTimeAsync(1);
      const first = h.runtime.snapshot.accountReadAt!;
      expect(first).toBeTruthy();
      h.gateway.hang("getAgentPortfolioSnapshot");
      await vi.advanceTimersByTimeAsync(5_000);
      h.gateway.clear("getAgentPortfolioSnapshot");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(
        Date.parse(h.runtime.snapshot.accountReadAt ?? ""),
      ).toBeGreaterThan(Date.parse(first));
      expect(h.runtime.snapshot.running).toBe(true);
    } finally {
      const stopping = h.runtime.stop();
      await vi.advanceTimersByTimeAsync(5_001);
      await stopping;
      h.runtimeManager.close();
      await h.app.close();
      h.store.close();
      vi.useRealTimers();
    }
  });

  it("abandons a Paper cycle at its deadline and rejects a late result without stopping the bundle", async () => {
    const h = await paperRuntime();
    h.gateway.balance("1796", 300);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T01:11:55.000Z"));
    let release!: (value: { accepted: boolean; reason: null }) => void;
    const blockedAdmission = new Promise<{ accepted: boolean; reason: null }>(
      (resolve) => {
        release = resolve;
      },
    );
    let hanging = true;
    const runtime = new MakerRuntime(
      h.store.forBundle(OWNER, h.core.id),
      h.gateway.asGateway(),
      {
        liveEnabled: false,
        mainnetAllowed: false,
        builderCode: () => null,
        admitBundleProposal: () =>
          hanging ? blockedAdmission : { accepted: true, reason: null },
      },
    );
    try {
      runtime.start();
      await vi.advanceTimersByTimeAsync(1);
      const first = runtime.snapshot.accountReadAt;
      await vi.advanceTimersByTimeAsync(60_001);
      expect(runtime.snapshot.running).toBe(true);
      expect(
        h.tenant
          .listEvents(100)
          .filter(
            (event) =>
              event.category === "runtime" &&
              event.action === "cycle" &&
              event.outcome === "timeout",
          ),
      ).toHaveLength(1);
      hanging = false;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(Date.parse(runtime.snapshot.accountReadAt ?? "")).toBeGreaterThan(
        Date.parse(first ?? ""),
      );
      const settledCycle = runtime.snapshot.cycle;
      release({ accepted: true, reason: null });
      await vi.advanceTimersByTimeAsync(1);
      expect(runtime.snapshot.cycle).toBe(settledCycle);
      expect(
        h.tenant
          .listEvents(100)
          .filter(
            (event) =>
              event.category === "runtime" &&
              event.action === "cycle" &&
              event.outcome === "timeout",
          ),
      ).toHaveLength(1);
    } finally {
      await runtime.stop();
      vi.useRealTimers();
      await h.close();
    }
  });

  it("clears a blocked running Paper bundle within one refresh after its balance rises", async () => {
    const h = await paperRuntime();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T01:11:55.000Z"));
    try {
      h.runtime.start();
      await vi.advanceTimersByTimeAsync(1);
      const first = h.runtime.snapshot.accountReadAt;
      expect(h.runtime.snapshot.paperBlocker?.code).toBe("collateral");
      h.gateway.balance("1796", 300);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.runtime.snapshot.paperBlocker).toBeNull();
      expect(
        Date.parse(h.runtime.snapshot.accountReadAt ?? ""),
      ).toBeGreaterThan(Date.parse(first ?? ""));
      expect(
        h.tenant
          .listEvents(100)
          .filter(
            (event) =>
              event.category === "paper" &&
              event.action === "simulation" &&
              event.outcome === "cleared",
          ),
      ).toHaveLength(1);
      expect(h.runtime.snapshot.running).toBe(true);
    } finally {
      await h.runtime.stop();
      vi.useRealTimers();
      await h.close();
    }
  });

  it("keeps fair-value skips visible while surfacing the bundle collateral blocker", async () => {
    const h = await paperRuntime();
    h.tenant.setConfig(
      makerConfigSchema.parse({
        ...h.tenant.getConfig()!,
        markets: [
          { marketId: "0x1", symbol: "NEAR" },
          { marketId: "0x2", symbol: "DRAM" },
        ],
      }),
    );
    h.gateway.when("getOrderbook", (marketId: string) => ({
      market: {
        metadata: { symbol: marketId === "0x1" ? "NEAR" : "DRAM" },
        indexPrice: 10,
        marketState: { openInterest: 1_000 },
        marketParams: { maxOpenInterest: 10_000 },
        estimatedFundingRate: () => 0.0001,
        tickSize: () => 0.01,
      },
      orderbook: {
        bestBidPrice: 9,
        bestAskPrice: 9.1,
        bids: [],
        asks: [],
      },
    }));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T01:11:55.000Z"));
    try {
      h.runtime.start();
      await vi.advanceTimersByTimeAsync(5_001);

      expect(h.runtime.snapshot.paperBlocker).toMatchObject({
        code: "collateral",
      });
      expect(h.runtime.snapshot.markets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "0x1",
            skip: expect.objectContaining({ code: "fair-value" }),
          }),
          expect.objectContaining({
            id: "0x2",
            skip: expect.objectContaining({ code: "fair-value" }),
          }),
        ]),
      );
    } finally {
      await h.runtime.stop();
      vi.useRealTimers();
      await h.close();
    }
  });

  it("reduces filled inventory at the gross cap, waits on flat markets, then resumes both sides", async () => {
    const h = await paperRuntime({ makerFreeUsd: 300 });
    const markets = Array.from({ length: 15 }, (_, index) => ({
      marketId: `0x${(index + 1).toString(16)}`,
      symbol: `M${index + 1}`,
    }));
    h.tenant.setConfig(
      makerConfigSchema.parse({
        ...h.tenant.getConfig()!,
        markets,
        maxGrossExposureUsd: 150,
        maxInventoryUsd: 20,
        quoteSizeUsd: 10,
      }),
    );
    for (const market of markets.slice(0, 4)) {
      h.tenant.recordPaperQuote({
        trialId: "runtime",
        marketId: market.marketId,
        symbol: market.symbol,
        bidPrice: 10,
        askPrice: 11,
        sizeUsd: 10,
        sides: "bid",
      });
      h.tenant.matchPaperOrders({
        trialId: "runtime",
        marketId: market.marketId,
        bestBid: 9.9,
        bestAsk: 9.8,
      });
    }
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T01:11:55.000Z"));
    try {
      h.runtime.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.runtime.snapshot.quote).toMatchObject({
        sides: "ask",
        sizeUsd: 10,
      });
      expect(h.runtime.snapshot.markets[0]?.error).toBe(
        "Reducing: quoting the ask to bring inventory from $10.00 back to $0.00.",
      );

      // After the four filled markets have each had a chance to post their
      // reducing ask, the next flat market remains unquoted at the cap.
      await vi.advanceTimersByTimeAsync(4 * 5_000);
      expect(
        h.gateway.calls.filter((call) => call.method === "simulateQuote"),
      ).toHaveLength(4);

      for (const market of markets.slice(0, 4)) {
        h.tenant.matchPaperOrders({
          trialId: "runtime",
          marketId: market.marketId,
          bestBid: 20,
          bestAsk: 20.1,
        });
      }
      await h.runtime.cycle({ executeLive: true });
      expect(h.runtime.snapshot.quote).toMatchObject({ sides: "both" });
      const blocked = h.tenant
        .listEvents(100)
        .filter(
          (event) =>
            event.category === "paper" &&
            event.action === "simulation" &&
            event.outcome === "blocked",
        );
      expect(blocked).toHaveLength(1);
      expect(blocked[0]?.detail.marketId).toBeUndefined();
    } finally {
      await h.runtime.stop();
      vi.useRealTimers();
      await h.close();
    }
  });

  it("replays filled Volume loops across markets and closes both accounts before each rotation", async () => {
    const h = await paperRuntime({ hedge: true, makerFreeUsd: 300 });
    h.gateway.balance("1802", 300);
    h.tenant.setConfig(
      makerConfigSchema.parse({
        ...h.tenant.getConfig()!,
        strategyObjective: "volume",
        rotationMode: "single-slot",
        marketDwellMs: 5 * 60_000,
        flattenOnRotate: true,
        quoteSizeUsd: 10,
        maxGrossExposureUsd: 400,
        hedge: {
          enabled: true,
          accountId: "1802",
          thresholdUsd: 10,
          maxOrderUsd: 10,
          maxSlippageBps: 75,
        },
        markets: [
          { marketId: "0x1", symbol: "ONE" },
          { marketId: "0x2", symbol: "TWO" },
          { marketId: "0x3", symbol: "THREE" },
        ],
      }),
    );
    let crossedMarketId: string | null = null;
    let rejectedMarketId: string | null = null;
    h.gateway.when("getOrderbook", async (marketId: string) => {
      if (rejectedMarketId === marketId) {
        throw new Error("temporary fixture orderbook outage");
      }
      return {
        market: {
          metadata: {
            symbol:
              marketId === "0x1" ? "ONE" : marketId === "0x2" ? "TWO" : "THREE",
          },
          indexPrice: 10,
          marketState: { openInterest: 1_000 },
          marketParams: { maxOpenInterest: 10_000 },
          estimatedFundingRate: () => 0.0001,
          tickSize: () => 0.01,
        },
        // The ask trades through the existing bid but remains above the best
        // bid, so it is a valid two-sided book. The runtime must create the
        // opposite-account hedge itself; this test never writes a fill.
        orderbook:
          crossedMarketId === marketId
            ? { bestBidPrice: 9.96, bestAskPrice: 9.97, bids: [], asks: [] }
            : {
                bestBidPrice: 9.99,
                bestAskPrice: 10.01,
                bids: [],
                asks: [],
              },
      };
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T01:11:55.000Z"));
    try {
      h.runtime.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.runtime.snapshot.market.id).toBe("0x1");

      crossedMarketId = "0x1";
      await vi.advanceTimersByTimeAsync(5_000);
      crossedMarketId = null;
      // The close-leg book can fail after a maker fill.  It must not pause
      // Paper, free the paired inventory, or start the next market early.
      rejectedMarketId = "0x1";
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await h.runtime.cycle({ executeLive: true });
      expect(h.runtime.snapshot.running).toBe(true);
      expect(h.tenant.getPaperState("runtime").positions).toHaveLength(2);
      expect(
        h.tenant
          .listEvents(100)
          .some(
            (event) =>
              event.category === "runtime" &&
              event.action === "cycle" &&
              event.outcome === "retry",
          ),
      ).toBe(true);
      rejectedMarketId = null;
      await h.runtime.cycle({ executeLive: true });
      const state = h.tenant.getPaperState("runtime");
      expect(state.positions).toEqual([]);
      expect(h.tenant.listPaperFills({ trialId: "runtime" })).toHaveLength(4);
      expect(h.runtime.snapshot.market.id).toBe("0x2");

      // TWO is deliberately no-fill.  THREE is the second filled loop: this
      // proves a prior flat rotation cannot strand the state machine.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await h.runtime.cycle({ executeLive: true });
      expect(h.runtime.snapshot.market.id).toBe("0x3");
      crossedMarketId = "0x3";
      await vi.advanceTimersByTimeAsync(5_000);
      crossedMarketId = null;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await h.runtime.cycle({ executeLive: true });
      expect(h.tenant.getPaperState("runtime").positions).toEqual([]);
      const fills = h.tenant.listPaperFills({ trialId: "runtime" });
      expect(fills).toHaveLength(8);
      expect(fills.reduce((total, fill) => total + fill.sizeUsd, 0)).toBe(80);
      expect(h.runtime.snapshot.market.id).toBe("0x1");
      expect(
        h.tenant
          .listEvents(100)
          .filter((event) => event.action === "volume-close"),
      ).toHaveLength(2);
    } finally {
      await h.runtime.stop();
      vi.useRealTimers();
      await h.close();
    }
  });

  it("Paper uses the same $100.85 hedge floor as Start and clears when funded", async () => {
    const h = await paperRuntime({ hedge: true, makerFreeUsd: 20 });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T01:11:55.000Z"));
    try {
      h.runtime.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.runtime.snapshot.paperBlocker).toMatchObject({
        code: "hedge-collateral",
        accountId: "1802",
        requiredUsd: expect.any(Number),
        message:
          "Hedge account 1802 needs $100.85 free collateral to place one hedge of up to $100.00 at 1x. It has $0.00.",
      });
      expect(h.runtime.snapshot.paperBlocker?.requiredUsd).toBeCloseTo(
        100.85,
        7,
      );
      h.gateway.balance("1802", 100.85);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.runtime.snapshot.paperBlocker).toBeNull();
      expect(
        h.tenant
          .listEvents(100)
          .filter(
            (event) =>
              event.category === "paper" &&
              event.action === "simulation" &&
              event.outcome === "cleared",
          ),
      ).toHaveLength(1);
    } finally {
      await h.runtime.stop();
      vi.useRealTimers();
      await h.close();
    }
  });

  it("Stop clears a blocked Paper card and its market error", async () => {
    const h = await paperRuntime();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T01:11:55.000Z"));
    try {
      h.runtime.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.runtime.snapshot.paperBlocker).not.toBeNull();
      await h.runtime.stop();
      expect(h.runtime.snapshot.running).toBe(false);
      expect(h.runtime.snapshot.paperBlocker).toBeNull();
      expect(
        h.runtime.snapshot.markets.every((market) => market.error === null),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
      await h.close();
    }
  });

  it("discarded late portfolio results cannot restore a blocker after Stop", async () => {
    const h = await paperRuntime();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T01:11:55.000Z"));
    try {
      h.runtime.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.runtime.snapshot.paperBlocker).not.toBeNull();
      let release!: (portfolio: unknown) => void;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      h.gateway.when("getAgentPortfolioSnapshot", () => pending);
      await vi.advanceTimersByTimeAsync(5_000);
      const stopping = h.runtime.stop();
      await vi.advanceTimersByTimeAsync(5_001);
      await stopping;
      release({
        markedAt: new Date().toISOString(),
        equityUsd: 0,
        availableCollateralUsd: 0,
        allocatedCollateralUsd: 0,
        freeMarginUsd: 0,
        withdrawableCollateralUsd: 0,
        grossExposureUsd: 0,
        unrealizedPnlUsd: 0,
        gasSui: 2,
        positions: [],
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(h.runtime.snapshot.paperBlocker).toBeNull();
      expect(h.runtime.snapshot.running).toBe(false);
    } finally {
      vi.useRealTimers();
      await h.close();
    }
  });
});
