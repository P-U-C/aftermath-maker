import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createEncryptedAgent } from "@puc/aftermath";
import { makerConfigSchema, setupSchema, USDC_COIN_TYPE } from "@puc/core";
import { VENUE_READ_TIMEOUT_MS } from "../src/venue-read.js";
import { appHarness, OWNER, type FakeGateway } from "./helpers/app.js";

const wideConfig = (
  makerAccountId: string | null,
  options: {
    hedgeAccountId?: string | null;
    marketCount?: number;
  } = {},
) =>
  makerConfigSchema.parse({
    mode: "paper",
    rotationMode: "portfolio",
    markets: Array.from({ length: options.marketCount ?? 15 }, (_, index) => ({
      marketId: `0x${(index + 1).toString(16)}`,
      symbol: `M${index + 1}`,
    })),
    maxQuoteAgeMs: 200_000,
    quoteSizeUsd: 10,
    maxLeverage: 1,
    makerAccountId,
    hedge: {
      enabled: Boolean(options.hedgeAccountId),
      accountId: options.hedgeAccountId ?? null,
      thresholdUsd: 1,
      maxOrderUsd: 100,
      maxSlippageBps: 75,
    },
  });

function authorize(
  h: Awaited<ReturnType<typeof appHarness>>,
  accountId: string,
) {
  const tenant = h.store.forTenant(OWNER);
  const owned =
    h.gateway.accounts.find((account) => account.accountId === accountId) ??
    h.gateway.account(accountId, 0);
  tenant.setSetup(
    setupSchema.parse({
      ownerAddress: OWNER,
      accountId,
      accountCapId: owned.accountCapId,
      collateralCoinType: USDC_COIN_TYPE,
    }),
  );
  if (!tenant.getAgent()) {
    const generated = createEncryptedAgent({
      masterKey: randomBytes(32).toString("base64"),
      context: "round10-test",
    });
    tenant.createAgent({ ...generated, encryptionContext: "round10-test" });
  }
  tenant.confirmAgentGrant({
    accountId,
    digest: "test-only-grant",
    agentCapId: `0x${"5".repeat(64)}`,
  });
}

async function start(
  h: Awaited<ReturnType<typeof appHarness>>,
  bundleId: string,
) {
  return h.app.inject({
    method: "POST",
    url: `/api/bundles/${bundleId}/start`,
    headers: h.signedInAs(),
    payload: {},
  });
}

describe("Start route and server-owned readiness", () => {
  it.each([
    {
      stage: "strategy",
      setup: (h: Awaited<ReturnType<typeof appHarness>>) => {
        const tenant = h.store.forTenant(OWNER);
        tenant.setConfig(wideConfig(null, { marketCount: 1 }));
        tenant.confirmWalletLimits();
        const draft = tenant.createAllocatedBundle({
          name: "Draft",
          makerAccountId: null,
          takerAccountId: null,
          mode: "paper",
          strategyId: null,
          markets: [{ marketId: "0x1", symbol: "M1" }],
        });
        tenant.setBundleStatus(draft.id, "stopped");
        return draft.id;
      },
    },
    {
      stage: "accounts",
      setup: (h: Awaited<ReturnType<typeof appHarness>>) => {
        const tenant = h.store.forTenant(OWNER);
        tenant.setConfig(wideConfig(null));
        return tenant.listBundles()[0]!.id;
      },
    },
    {
      stage: "trading-keys",
      setup: (h: Awaited<ReturnType<typeof appHarness>>) => {
        const tenant = h.store.forTenant(OWNER);
        tenant.setConfig(wideConfig("1796"));
        h.gateway.account("1796", 300);
        return tenant.listBundles()[0]!.id;
      },
    },
    {
      stage: "gas",
      setup: (h: Awaited<ReturnType<typeof appHarness>>) => {
        const tenant = h.store.forTenant(OWNER);
        tenant.setConfig(wideConfig("1796"));
        h.gateway.account("1796", 300);
        authorize(h, "1796");
        h.gateway.gasSui = 0;
        return tenant.listBundles()[0]!.id;
      },
    },
    {
      stage: "collateral",
      setup: (h: Awaited<ReturnType<typeof appHarness>>) => {
        const tenant = h.store.forTenant(OWNER);
        tenant.setConfig(wideConfig("1796"));
        h.gateway.account("1796", 0);
        authorize(h, "1796");
        return tenant.listBundles()[0]!.id;
      },
    },
  ])(
    "POST Start rejects the $stage stage without starting or logging a run",
    async ({ stage, setup }) => {
      const h = await appHarness();
      try {
        const id = setup(h);
        const response = await start(h, id);
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe(`bundle-not-ready-${stage}`);
        expect(response.json().error).not.toMatch(
          /Internal server error|reference/i,
        );
        expect(h.store.forTenant(OWNER).getStoredBundle(id)?.status).toBe(
          "stopped",
        );
        const events = h.store.forTenant(OWNER).listEvents(100);
        expect(
          events.filter(
            (event) => event.category === "runtime" && event.action === "start",
          ),
        ).toHaveLength(0);
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              category: "request",
              action: "bundle-start",
              outcome: "rejected",
              detail: expect.objectContaining({
                code: `bundle-not-ready-${stage}`,
                status: 409,
              }),
            }),
          ]),
        );
      } finally {
        await h.close();
      }
    },
  );

  it("re-reads $0 then $300 account state without a restart or cached readiness", async () => {
    const h = await appHarness();
    try {
      h.store.forTenant(OWNER).setConfig(wideConfig("1796"));
      authorize(h, "1796");
      const bundleId = h.store.forTenant(OWNER).listBundles()[0]!.id;
      const headers = h.signedInAs();
      const read = () =>
        h.app.inject({ method: "GET", url: "/api/bundles", headers });
      const first = (await read())
        .json()
        .bundles.find((bundle: any) => bundle.id === bundleId).readiness;
      expect(first.ready).toBe(false);
      expect(first.stages[4]).toMatchObject({
        status: "todo",
        requiredUsd: 300,
        shortfallUsd: 300,
      });
      h.gateway.balance("1796", 300);
      const second = (await read())
        .json()
        .bundles.find((bundle: any) => bundle.id === bundleId).readiness;
      expect(second.stages[4]).toMatchObject({
        status: "done",
        requiredUsd: 300,
        shortfallUsd: 0,
      });
      expect(second.ready).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("lets Paper start below the Live cancel reserve when its own simulation gas is covered", async () => {
    const h = await appHarness();
    try {
      const tenant = h.store.forTenant(OWNER);
      tenant.setConfig(wideConfig("1796", { marketCount: 1 }));
      h.gateway.account("1796", 20);
      h.gateway.gasSui = 0.08;
      authorize(h, "1796");
      const bundleId = tenant.listBundles()[0]!.id;
      const reply = await start(h, bundleId);
      expect(reply.statusCode).toBe(200);
      expect(reply.json().bundle.status).toBe("running");
      expect(
        tenant
          .listEvents(100)
          .filter(
            (event) =>
              event.category === "request" &&
              event.detail?.code === "gas-reserve-low",
          ),
      ).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it("rejects an underfunded hedge account using the shared $100.85 rule", async () => {
    const h = await appHarness();
    try {
      const tenant = h.store.forTenant(OWNER);
      tenant.setConfig(
        wideConfig("1796", { hedgeAccountId: "1802", marketCount: 1 }),
      );
      h.gateway.account("1796", 20);
      h.gateway.account("1802", 0);
      authorize(h, "1796");
      authorize(h, "1802");
      const core = tenant.listBundles()[0]!;
      const response = await start(h, core.id);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: "bundle-not-ready-collateral",
      });
      expect(response.json().error).toContain(
        "Hedge account 1802 needs $100.85 free collateral to place one hedge of up to $100.00 at 1x. It has $0.00.",
      );
    } finally {
      await h.close();
    }
  });

  it("fails closed with typed 503 when an account read rejects or never resolves", async () => {
    const h = await appHarness();
    try {
      h.store
        .forTenant(OWNER)
        .setConfig(wideConfig("1796", { marketCount: 1 }));
      h.gateway.account("1796", 20);
      authorize(h, "1796");
      const bundleId = h.store.forTenant(OWNER).listBundles()[0]!.id;
      h.gateway.reject("listOwnerAccounts");
      const failed = await start(h, bundleId);
      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toMatchObject({
        code: "venue-read-unavailable",
        error:
          "Maker couldn't check account data right now. Try again in a minute.",
      });
      h.gateway.hang("listOwnerAccounts");
      vi.useFakeTimers();
      try {
        const pending = start(h, bundleId);
        await vi.advanceTimersByTimeAsync(VENUE_READ_TIMEOUT_MS + 1);
        const timedOut = await pending;
        expect(timedOut.statusCode).toBe(503);
        expect(timedOut.json().code).toBe("venue-read-unavailable");
        expect(h.store.forTenant(OWNER).getStoredBundle(bundleId)?.status).toBe(
          "stopped",
        );
      } finally {
        vi.useRealTimers();
      }
    } finally {
      await h.close();
    }
  });
});
