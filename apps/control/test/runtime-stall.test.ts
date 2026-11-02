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
