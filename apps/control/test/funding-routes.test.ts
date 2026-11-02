import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createEncryptedAgent,
  deserializeOwnerTransactionIntent,
} from "@puc/aftermath";
import { makerConfigSchema, setupSchema, USDC_COIN_TYPE } from "@puc/core";
import { appHarness, OWNER } from "./helpers/app.js";

const configFor = (makerAccountId: string) =>
  makerConfigSchema.parse({
    mode: "paper",
    markets: [{ marketId: "0x1", symbol: "NEAR" }],
    makerAccountId,
    hedge: {
      enabled: false,
      accountId: null,
      thresholdUsd: 1,
      maxOrderUsd: 100,
      maxSlippageBps: 75,
    },
  });

describe("funding routes stay owner-signed and account-scoped", () => {
  it("prepares single and two-account deposits while Core is running, without stopping it", async () => {
    const h = await appHarness();
    try {
      const tenant = h.store.forTenant(OWNER);
      tenant.setConfig(configFor("1796"));
      const core = tenant.listBundles()[0]!;
      tenant.setBundleStatus(core.id, "running");
      h.gateway.account("1796", 0);
      h.gateway.account("1802", 0);
      const headers = h.signedInAs();
      const single = await h.app.inject({
        method: "POST",
        url: "/api/accounts/deposit-transaction",
        headers,
        payload: { accountId: "1796", amountUsdc: "300.00" },
      });
      expect(single.statusCode).toBe(200);
      const one = deserializeOwnerTransactionIntent(single.json().intent);
      expect(one).toMatchObject({
        kind: "deposit",
        sender: OWNER,
        amount: 300_000_000n,
        accountCapId: h.gateway.accounts[0]?.accountCapId,
      });
      expect(single.json().transaction).toEqual(expect.any(String));

      const batch = await h.app.inject({
        method: "POST",
        url: "/api/accounts/deposit-transaction",
        headers,
        payload: {
          deposits: [
            { accountId: "1796", amountUsdc: "300.00" },
            { accountId: "1802", amountUsdc: "100.85" },
          ],
        },
      });
      expect(batch.statusCode).toBe(200);
      const both = deserializeOwnerTransactionIntent(batch.json().intent);
      expect(both).toMatchObject({
        kind: "deposit-batch",
        sender: OWNER,
        deposits: [
          {
            amount: 300_000_000n,
            accountCapId: h.gateway.accounts[0]?.accountCapId,
          },
          {
            amount: 100_850_000n,
            accountCapId: h.gateway.accounts[1]?.accountCapId,
          },
        ],
      });
      expect(batch.json().transaction).toEqual(expect.any(String));
      expect(tenant.getStoredBundle(core.id)?.status).toBe("running");
      expect(
        tenant
          .listEvents(100)
          .filter(
            (event) =>
              event.category === "runtime" &&
              ["start", "stop", "pause"].includes(event.action),
          ),
      ).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it("blocks only an account in use, then permits withdrawal after its bundle pauses and respects withdrawable funds", async () => {
    const h = await appHarness();
    try {
      const tenant = h.store.forTenant(OWNER);
      tenant.setConfig(configFor("1796"));
      const core = tenant.listBundles()[0]!;
      tenant.setBundleStatus(core.id, "running");
      h.gateway.account("1796", 100);
      h.gateway.account("1802", 25);
      const headers = h.signedInAs();
      const request = (accountId: string, amountUsdc: string) =>
        h.app.inject({
          method: "POST",
          url: "/api/accounts/withdraw-transaction",
          headers,
          payload: { accountId, amountUsdc },
        });
      const blocked = await request("1796", "10.00");
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json()).toMatchObject({
        code: "account-in-use",
        error: "Pause Core before you withdraw from account 1796.",
      });
      expect(
        tenant
          .listEvents(100)
          .some(
            (event) =>
              event.category === "request" &&
              event.action === "account-withdraw" &&
              event.outcome === "rejected" &&
              event.detail.code === "account-in-use",
          ),
      ).toBe(true);
      const unrelated = await request("1802", "1.00");
      expect(unrelated.statusCode).toBe(200);
      expect(
        deserializeOwnerTransactionIntent(unrelated.json().intent),
      ).toMatchObject({
        kind: "withdraw",
        recipient: OWNER,
        sender: OWNER,
        amount: 1_000_000n,
      });
      const pause = await h.app.inject({
        method: "POST",
        url: `/api/bundles/${core.id}/pause`,
        headers,
        payload: {},
      });
      expect(pause.statusCode).toBe(200);
      expect(tenant.getStoredBundle(core.id)?.status).toBe("paused");
      const allowed = await request("1796", "10.00");
      expect(allowed.statusCode).toBe(200);
      expect(
        deserializeOwnerTransactionIntent(allowed.json().intent),
      ).toMatchObject({
        kind: "withdraw",
        recipient: OWNER,
        amount: 10_000_000n,
      });
      const over = await request("1796", "101.00");
      expect(over.statusCode).toBe(409);
      expect(over.json()).toMatchObject({
        code: "withdraw-exceeds-available",
        error:
          "Account 1796 has $100.00 withdrawable now. Enter a smaller amount.",
      });
    } finally {
      await h.close();
    }
  });

  it("returns a trading-key gas transfer and typed 4xx for both invalid boundaries", async () => {
    const h = await appHarness();
    try {
      const tenant = h.store.forTenant(OWNER);
      const accountId = "1796";
      tenant.setSetup(
        setupSchema.parse({
          ownerAddress: OWNER,
          accountId,
          accountCapId: h.gateway.account(accountId, 100).accountCapId,
          collateralCoinType: USDC_COIN_TYPE,
        }),
      );
      const masterKey = randomBytes(32).toString("base64");
      const agent = createEncryptedAgent({
        masterKey,
        context: "round10-test",
      });
      tenant.createAgent({ ...agent, encryptionContext: "round10-test" });
      tenant.confirmAgentGrant({
        accountId,
        digest: "test-grant",
        agentCapId: "0x1234",
      });
      const headers = h.signedInAs();
      const prepare = (gasMist: string) =>
        h.app.inject({
          method: "POST",
          url: "/api/setup/gas-transaction",
          headers,
          payload: { accountId, gasMist },
        });
      const valid = await prepare("250000000");
      expect(valid.statusCode).toBe(200);
      expect(valid.json().transaction).toEqual(expect.any(String));
      expect(
        deserializeOwnerTransactionIntent(valid.json().intent),
      ).toMatchObject({
        kind: "gas-top-up",
        sender: OWNER,
        agentAddress: agent.address,
        gasMist: 250_000_000n,
      });
      for (const amount of ["0", "-10000000", "10000000001"]) {
        const response = await prepare(amount);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          code: "gas-amount-invalid",
          error: "Enter between 0.01 and 10 SUI to top up a trading key.",
        });
      }
    } finally {
      await h.close();
    }
  });
});
