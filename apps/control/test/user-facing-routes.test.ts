import { createHmac, randomBytes } from "node:crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  getZkLoginSignature,
  toZkLoginPublicIdentifier,
} from "@mysten/sui/zklogin";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createEncryptedAgent } from "@puc/aftermath";
import { makerConfigSchema, setupSchema, USDC_COIN_TYPE } from "@puc/core";
import { appHarness, OWNER } from "./helpers/app.js";
import { UserFacingError } from "../src/http-error.js";

type Harness = Awaited<ReturnType<typeof appHarness>>;
type Request = {
  method: "GET" | "POST" | "PATCH" | "PUT";
  url: string;
  payload?: unknown;
};
type Case = {
  code: string;
  status: number;
  copy: string;
  prepare: (h: Harness) => Request | Promise<Request>;
  public?: boolean;
  harness?: () => Promise<Harness>;
};
const config = makerConfigSchema.parse({
  mode: "paper",
  markets: [{ marketId: "0x1", symbol: "NEAR" }],
  maxInventoryUsd: 20,
  maxGrossExposureUsd: 50,
});
function seed(h: Harness) {
  const tenant = h.store.forTenant(OWNER);
  tenant.setConfig(config);
  return {
    tenant,
    core: tenant.listBundles()[0]!,
    strategy: tenant.listStrategies()[0]!,
  };
}
function authorize(h: Harness, accountId = "1796") {
  const tenant = h.store.forTenant(OWNER);
  const account =
    h.gateway.accounts.find((entry) => entry.accountId === accountId) ??
    h.gateway.account(accountId, 100);
  tenant.setSetup(
    setupSchema.parse({
      ownerAddress: OWNER,
      accountId,
      accountCapId: account.accountCapId,
      collateralCoinType: USDC_COIN_TYPE,
    }),
  );
  if (!tenant.getAgent()) {
    const agent = createEncryptedAgent({
      masterKey: randomBytes(32).toString("base64"),
      context: "round10-route-test",
    });
    tenant.createAgent({ ...agent, encryptionContext: "round10-route-test" });
  }
  tenant.confirmAgentGrant({
    accountId,
    digest: "test-only",
    agentCapId: `0x${"5".repeat(64)}`,
  });
}
const strategyBody = (
  saved: ReturnType<
    ReturnType<Harness["store"]["forTenant"]>["listStrategies"]
  >[number],
) => ({
  name: saved.name,
  config: saved.config,
  marketRule: saved.marketRule,
  markets: saved.markets,
});

async function validWalletVerification(h: Harness): Promise<Request> {
  const signer = new Ed25519Keypair();
  const address = signer.toSuiAddress();
  const challenge = h.auth.begin(address);
  const { signature } = await signer.signPersonalMessage(
    new TextEncoder().encode(challenge.message),
  );
  return {
    method: "POST",
    url: "/api/auth/verify",
    payload: {
      challengeId: challenge.challengeId,
      message: challenge.message,
      address,
      signature,
    },
  };
}

function zkLoginVerification(h: Harness): Request {
  const issuer = "https://accounts.google.com";
  const address = toZkLoginPublicIdentifier(1n, issuer, {
    legacyAddress: false,
  }).toSuiAddress();
  const challenge = h.auth.begin(address);
  const signature = getZkLoginSignature({
    inputs: {
      proofPoints: { a: [], b: [], c: [] },
      issBase64Details: {
        value: Buffer.from(`"iss":"${issuer}",`).toString("base64url"),
        indexMod4: 0,
      },
      headerBase64: "",
      addressSeed: "1",
    },
    maxEpoch: 99,
    userSignature: new Uint8Array([1, 2]),
  });
  return {
    method: "POST",
    url: "/api/auth/verify",
    payload: {
      challengeId: challenge.challengeId,
      message: challenge.message,
      address,
      signature,
    },
  };
}

const cases: Case[] = [
  {
    code: "strategy-name-taken",
    status: 409,
    copy: "Another strategy already uses this name. Choose a different name.",
    prepare: (h) => {
      const { strategy } = seed(h);
      return {
        method: "POST",
        url: "/api/strategies",
        payload: strategyBody(strategy),
      };
    },
  },
  {
    code: "strategy-in-use",
    status: 409,
    copy: "This strategy is used by a bundle. Detach it in Bundles before deleting it.",
    prepare: (h) => {
      const { strategy } = seed(h);
      return {
        method: "POST",
        url: `/api/strategies/${strategy.id}/archive`,
        payload: {},
      };
    },
  },
  {
    code: "strategy-not-found",
    status: 404,
    copy: "This strategy is no longer available. Choose a strategy in Strategy.",
    prepare: () => ({ method: "GET", url: "/api/strategies/not-a-strategy" }),
  },
  {
    code: "strategy-version-conflict",
    status: 409,
    copy: "Strategy changed elsewhere; refresh before saving. Compare your draft with the latest version.",
    prepare: (h) => {
      const { strategy } = seed(h);
      return {
        method: "PATCH",
        url: `/api/strategies/${strategy.id}`,
        payload: {
          ...strategyBody(strategy),
          expectedVersion: strategy.version + 1,
        },
      };
    },
  },
  {
    code: "bundle-not-found",
    status: 404,
    copy: "This bundle is no longer available. Refresh Bundles and choose an active bundle.",
    prepare: () => ({ method: "GET", url: "/api/bundles/not-a-bundle/config" }),
  },
  {
    code: "bundle-not-ready-strategy",
    status: 409,
    copy: "Attach a strategy in Bundles before starting Draft.",
    prepare: (h) => {
      const { tenant } = seed(h);
      tenant.confirmWalletLimits();
      const draft = tenant.createAllocatedBundle({
        name: "Draft",
        makerAccountId: null,
        takerAccountId: null,
        mode: "paper",
        strategyId: null,
        markets: config.markets,
      });
      return {
        method: "POST",
        url: `/api/bundles/${draft.id}/start`,
        payload: {},
      };
    },
  },
  {
    code: "bundle-not-ready-accounts",
    status: 409,
    copy: "Assign accounts before starting Core.",
    prepare: (h) => {
      const { core } = seed(h);
      return {
        method: "POST",
        url: `/api/bundles/${core.id}/start`,
        payload: {},
      };
    },
  },
  {
    code: "bundle-not-ready-trading-keys",
    status: 409,
    copy: "Authorize trading key before starting Core.",
    prepare: (h) => {
      h.store.forTenant(OWNER).setConfig({ ...config, makerAccountId: "1796" });
      h.gateway.account("1796", 100);
      const core = h.store.forTenant(OWNER).listBundles()[0]!;
      return {
        method: "POST",
        url: `/api/bundles/${core.id}/start`,
        payload: {},
      };
    },
  },
  {
    code: "bundle-not-ready-gas",
    status: 409,
    copy: "Add gas to Core's trading key before starting it.",
    prepare: (h) => {
      h.store.forTenant(OWNER).setConfig({ ...config, makerAccountId: "1796" });
      authorize(h);
      h.gateway.gasSui = 0;
      const core = h.store.forTenant(OWNER).listBundles()[0]!;
      return {
        method: "POST",
        url: `/api/bundles/${core.id}/start`,
        payload: {},
      };
    },
  },
  {
    code: "bundle-not-ready-collateral",
    status: 409,
    copy: "Deposit $20.00 to account 1796 before starting Core.",
    prepare: (h) => {
      h.store.forTenant(OWNER).setConfig({ ...config, makerAccountId: "1796" });
      h.gateway.account("1796", 0);
      authorize(h);
      const core = h.store.forTenant(OWNER).listBundles()[0]!;
      return {
        method: "POST",
        url: `/api/bundles/${core.id}/start`,
        payload: {},
      };
    },
  },
  {
    code: "venue-read-unavailable",
    status: 503,
    copy: "Maker couldn't check account data right now. Try again in a minute.",
    prepare: (h) => {
      h.store.forTenant(OWNER).setConfig({ ...config, makerAccountId: "1796" });
      authorize(h);
      h.gateway.reject("listOwnerAccounts");
      const core = h.store.forTenant(OWNER).listBundles()[0]!;
      return {
        method: "POST",
        url: `/api/bundles/${core.id}/start`,
        payload: {},
      };
    },
  },
  {
    code: "live-unavailable",
    status: 409,
    copy: "Live mode is unavailable. Keep this bundle in Paper until the operator enables Live.",
    prepare: () => ({
      method: "POST",
      url: "/api/config",
      payload: { ...config, mode: "live" },
    }),
  },
  {
    code: "live-confirmation-required",
    status: 409,
    copy: "Confirm that Maker will trade real funds before switching to Live.",
    prepare: (h) => {
      const { core } = seed(h);
      return {
        method: "POST",
        url: `/api/bundles/${core.id}/mode`,
        payload: { mode: "live", confirmed: false },
      };
    },
  },
  {
    code: "live-signer-missing",
    status: 409,
    copy: "The control signing key is unavailable.",
    harness: () =>
      appHarness({
        env: { LIVE_TRADING_ENABLED: "true", ALLOW_MAINNET: "true" },
      }),
    prepare: (h) => {
      const { core } = seed(h);
      return {
        method: "POST",
        url: `/api/bundles/${core.id}/mode`,
        payload: { mode: "live", confirmed: true },
      };
    },
  },
  {
    code: "mode-requires-stopped",
    status: 409,
    copy: "Stop this bundle before changing its mode.",
    prepare: (h) => {
      const { tenant, core } = seed(h);
      tenant.setBundleStatus(core.id, "running");
      return {
        method: "POST",
        url: `/api/bundles/${core.id}/mode`,
        payload: { mode: "paper", confirmed: true },
      };
    },
  },
  {
    code: "mode-required",
    status: 400,
    copy: "Choose Paper or Live mode before saving.",
    prepare: () => ({
      method: "POST",
      url: "/api/config",
      payload: { ...config, mode: "observe" },
    }),
  },
  {
    code: "account-not-authorized",
    status: 409,
    copy: "Authorize the selected Maker account in Venues before continuing.",
    prepare: () => ({
      method: "POST",
      url: "/api/config",
      payload: { ...config, makerAccountId: "1796" },
    }),
  },
  {
    code: "account-in-use",
    status: 409,
    copy: "Pause Core before you withdraw from account 1796.",
    prepare: (h) => {
      const { tenant, core } = seed(h);
      tenant.setBundleStatus(core.id, "running");
      h.gateway.account("1796", 100);
      tenant.setConfig({ ...config, makerAccountId: "1796" });
      return {
        method: "POST",
        url: "/api/accounts/withdraw-transaction",
        payload: { accountId: "1796", amountUsdc: "1.00" },
      };
    },
  },
  {
    code: "withdraw-exceeds-available",
    status: 409,
    copy: "Account 1796 has $20.00 withdrawable now. Enter a smaller amount.",
    prepare: (h) => {
      h.gateway.account("1796", 20);
      return {
        method: "POST",
        url: "/api/accounts/withdraw-transaction",
        payload: { accountId: "1796", amountUsdc: "21.00" },
      };
    },
  },
  {
    code: "account-not-found",
    status: 404,
    copy: "Choose an account owned by this wallet in Venues.",
    prepare: () => ({
      method: "POST",
      url: "/api/accounts/withdraw-transaction",
      payload: { accountId: "1796", amountUsdc: "1.00" },
    }),
  },
  {
    code: "needs-trading-key",
    status: 409,
    copy: "Authorize a trading key for this account in Venues before adding gas.",
    prepare: () => ({
      method: "POST",
      url: "/api/setup/gas-transaction",
      payload: { accountId: "1796", gasMist: "250000000" },
    }),
  },
  {
    code: "gas-amount-invalid",
    status: 400,
    copy: "Enter between 0.01 and 10 SUI to top up a trading key.",
    prepare: () => ({
      method: "POST",
      url: "/api/setup/gas-transaction",
      payload: { accountId: "1796", gasMist: "0" },
    }),
  },
  {
    code: "deposit-amount-invalid",
    status: 400,
    copy: "Enter a positive amount for each account.",
    prepare: () => ({
      method: "POST",
      url: "/api/accounts/deposit-transaction",
      payload: { deposits: [{ accountId: "1796", amountUsdc: "0" }] },
    }),
  },
  {
    code: "account-required",
    status: 400,
    copy: "Select an authorized Maker account in Venues before creating this bundle.",
    prepare: (h) => {
      const { strategy } = seed(h);
      return {
        method: "POST",
        url: "/api/bundles",
        payload: {
          name: "Pilot",
          makerAccountId: null,
          takerAccountId: null,
          mode: "paper",
          strategyId: strategy.id,
        },
      };
    },
  },
  {
    code: "hedge-account-required",
    status: 400,
    copy: "Authorize a separate hedge account in Venues before creating this bundle.",
    prepare: (h) => {
      const { tenant, strategy } = seed(h);
      const hedged = tenant.createStrategy({
        name: "Hedged",
        config: {
          ...strategy.config,
          hedge: { ...strategy.config.hedge, enabled: true, maxOrderUsd: 100 },
        },
        marketRule: strategy.marketRule,
        markets: strategy.markets,
      });
      return {
        method: "POST",
        url: "/api/bundles",
        payload: {
          name: "Pilot",
          makerAccountId: "1796",
          takerAccountId: null,
          mode: "paper",
          strategyId: hedged.id,
        },
      };
    },
  },
  {
    code: "bundle-name-invalid",
    status: 400,
    copy: "Use a bundle name between 1 and 80 characters.",
    prepare: (h) => {
      seed(h);
      return {
        method: "POST",
        url: "/api/bundles",
        payload: { name: "Core", config },
      };
    },
  },
  {
    code: "core-required",
    status: 409,
    copy: "Configure Core in Bundles before creating another bundle.",
    prepare: () => ({
      method: "POST",
      url: "/api/bundles",
      payload: { name: "Pilot", config },
    }),
  },
  {
    code: "account-setup-required",
    status: 409,
    copy: "Provision this account in Venues before continuing.",
    prepare: () => ({
      method: "POST",
      url: "/api/setup/grant-transaction",
      payload: { accountId: "1796" },
    }),
  },
  {
    code: "builder-registration-required",
    status: 409,
    copy: "Venue fee registration is not complete. Ask the operator to complete setup before continuing.",
    prepare: (h) => {
      authorize(h);
      return {
        method: "POST",
        url: "/api/setup/grant-transaction",
        payload: { accountId: "1796" },
      };
    },
  },
  {
    code: "bundle-name-taken",
    status: 409,
    copy: "A bundle already uses that name. Choose a different bundle name.",
    prepare: (h) => {
      const { tenant } = seed(h);
      tenant.confirmWalletLimits();
      tenant.createBundle({ name: "Pilot", config });
      return {
        method: "POST",
        url: "/api/bundles",
        payload: {
          name: "Pilot",
          makerAccountId: null,
          takerAccountId: null,
          mode: "paper",
          strategyId: null,
          markets: config.markets,
        },
      };
    },
  },
  {
    code: "bundle-limit",
    status: 409,
    copy: "A wallet can have at most four active bundles. Archive an unused bundle before creating another.",
    prepare: (h) => {
      const { tenant } = seed(h);
      tenant.confirmWalletLimits();
      for (let index = 1; index <= 3; index += 1)
        tenant.createBundle({
          name: `Paper ${index}`,
          config: {
            ...config,
            markets: [{ marketId: `0x${index + 1}`, symbol: `P${index}` }],
          },
        });
      return {
        method: "POST",
        url: "/api/bundles",
        payload: { name: "Fifth", config },
      };
    },
  },
  {
    code: "bundle-version-conflict",
    status: 409,
    copy: "Bundle changed elsewhere; refresh before saving. Compare your changes with the current bundle.",
    prepare: (h) => {
      const { core } = seed(h);
      return {
        method: "PATCH",
        url: `/api/bundles/${core.id}`,
        payload: {
          mode: "paper",
          expectedUpdatedAt: "2025-01-01T00:00:00.000Z",
        },
      };
    },
  },
  {
    code: "wallet-limits-unconfirmed",
    status: 409,
    copy: "Confirm wallet limits in Bundles before creating a second bundle.",
    prepare: (h) => {
      const { strategy } = seed(h);
      authorize(h);
      return {
        method: "POST",
        url: "/api/bundles",
        payload: {
          name: "Pilot",
          makerAccountId: "1796",
          takerAccountId: null,
          mode: "paper",
          strategyId: strategy.id,
        },
      };
    },
  },
  {
    code: "wallet-limit",
    status: 409,
    copy: "Gross exposure limit exceeds this wallet's confirmed envelope. Raise the wallet limit in Bundles or lower the strategy limit.",
    prepare: (h) => {
      const { tenant } = seed(h);
      tenant.confirmWalletLimits();
      return {
        method: "POST",
        url: "/api/bundles",
        payload: {
          name: "Pilot",
          config: {
            ...config,
            maxGrossExposureUsd: config.maxGrossExposureUsd + 1,
          },
        },
      };
    },
  },
  {
    code: "needs-markets",
    status: 400,
    copy: "Choose a strategy with at least one market before creating this bundle.",
    prepare: () => ({
      method: "POST",
      url: "/api/bundles",
      payload: {
        name: "Pilot",
        makerAccountId: null,
        takerAccountId: null,
        mode: "paper",
        strategyId: null,
      },
    }),
  },
  {
    code: "live-core-only",
    status: 409,
    copy: "Only Core can use Live mode. Switch this bundle to Paper.",
    prepare: (h) => {
      const { tenant } = seed(h);
      tenant.confirmWalletLimits();
      const other = tenant.createBundle({ name: "Pilot", config });
      return {
        method: "POST",
        url: `/api/bundles/${other.id}/config`,
        payload: { config: { ...config, mode: "live" } },
      };
    },
  },
  {
    code: "account-role-taken",
    status: 409,
    copy: "This account is already assigned to a bundle. Select an unused account in Bundles.",
    prepare: (h) => {
      const { tenant, strategy } = seed(h);
      tenant.confirmWalletLimits();
      authorize(h);
      tenant.setConfig({ ...config, makerAccountId: "1796" });
      return {
        method: "POST",
        url: "/api/bundles",
        payload: {
          name: "Pilot",
          makerAccountId: "1796",
          takerAccountId: null,
          mode: "paper",
          strategyId: strategy.id,
        },
      };
    },
  },
  {
    code: "wallet-limits-required",
    status: 409,
    copy: "Set Core wallet limits in Bundles before creating this bundle.",
    prepare: (h) => {
      const tenant = h.store.forTenant(OWNER);
      const source = { ...config, makerAccountId: "1796" };
      const configSource = {
        collateralCoinType: source.collateralCoinType,
        rotationMode: source.rotationMode,
        strategyObjective: source.strategyObjective,
        strategyProfile: source.strategyProfile,
        hedge: {
          enabled: false,
          thresholdUsd: 1,
          maxOrderUsd: 100,
          maxSlippageBps: 75,
        },
        quoteSizeUsd: source.quoteSizeUsd,
        spreadBps: source.spreadBps,
        refreshMs: source.refreshMs,
        marketDwellMs: source.marketDwellMs,
        requoteThresholdBps: source.requoteThresholdBps,
        maxRestingMs: source.maxRestingMs,
        autoRebalanceEnabled: source.autoRebalanceEnabled,
        rebalanceGrossExposureUsd: source.rebalanceGrossExposureUsd,
        maxQuoteAgeMs: source.maxQuoteAgeMs,
        maxInventoryUsd: source.maxInventoryUsd,
        inventoryTargetUsd: source.inventoryTargetUsd,
        maxGrossExposureUsd: source.maxGrossExposureUsd,
        maxUnrealizedLossUsd: source.maxUnrealizedLossUsd,
        maxRunDrawdownUsd: source.maxRunDrawdownUsd,
        maxBookDivergenceBps: source.maxBookDivergenceBps,
        maxLeverage: source.maxLeverage,
        maxGasMist: source.maxGasMist,
        staleBookMs: source.staleBookMs,
        inventorySkewBps: source.inventorySkewBps,
      };
      const saved = tenant.createStrategy({
        name: "Independent",
        config: configSource,
        marketRule: { kind: "preferred-list", marketIds: ["0x1"] },
        markets: config.markets,
      });
      authorize(h);
      return {
        method: "POST",
        url: "/api/bundles",
        payload: {
          name: "Pilot",
          makerAccountId: "1796",
          takerAccountId: null,
          mode: "paper",
          strategyId: saved.id,
        },
      };
    },
  },
  {
    code: "bundles-rolled-back",
    status: 409,
    copy: "Bundles rolled back. Refresh Bundles before continuing.",
    prepare: (h) => {
      const { tenant } = seed(h);
      const db = (
        h.store as unknown as {
          db: {
            prepare: (sql: string) => { run: (...values: string[]) => unknown };
          };
        }
      ).db;
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO bundle_legacy_backups
        (owner_address, legacy_config_value, legacy_config_updated_at, legacy_status, backed_up_at, rolled_back_at)
        VALUES (?, ?, ?, 'stopped', ?, ?)
        ON CONFLICT(owner_address) DO UPDATE SET rolled_back_at = excluded.rolled_back_at`,
      ).run(OWNER, JSON.stringify(config), now, now, now);
      return { method: "GET", url: "/api/bundles" };
    },
  },
  {
    code: "signature-invalid",
    status: 401,
    copy: "Your wallet's signature didn't verify. Sign again.",
    public: true,
    prepare: (h) => {
      const challenge = h.auth.begin(OWNER);
      return {
        method: "POST",
        url: "/api/auth/verify",
        payload: {
          challengeId: challenge.challengeId,
          message: challenge.message,
          address: OWNER,
          signature: "a".repeat(80),
        },
      };
    },
  },
  {
    code: "signature-check-unavailable",
    status: 503,
    copy: "Maker couldn't check your wallet's signature right now. Try again in a minute.",
    public: true,
    harness: () =>
      appHarness({
        verificationClient: {
          core: {
            verifyZkLoginSignature: async () => {
              throw new Error("test-only RPC unavailable");
            },
          },
        } as unknown as SuiGrpcClient,
      }),
    prepare: zkLoginVerification,
  },
  {
    code: "access-list-not-configured",
    status: 503,
    copy: "The access list isn't set up yet. The operator needs to finish setup.",
    public: true,
    harness: () => appHarness({ allowlistConfigured: false }),
    prepare: validWalletVerification,
  },
  {
    code: "access-list-unavailable",
    status: 503,
    copy: "Maker couldn't check the access list right now. Try again in a minute.",
    public: true,
    harness: () =>
      appHarness({
        allowlistRead: async () => {
          throw new (await import("../src/http-error.js")).UserFacingError(
            "access-list-unavailable",
            "Maker couldn't check the access list right now. Try again in a minute.",
            undefined,
            503,
          );
        },
      }),
    prepare: validWalletVerification,
  },
  {
    code: "access-check-expired",
    status: 410,
    copy: "That check expired. Sign again to request access.",
    public: true,
    prepare: () => {
      const payload = `v1.${Buffer.from(
        JSON.stringify({
          address: OWNER,
          expiresAt: Date.now() - 1,
        }),
      ).toString("base64url")}`;
      const signature = createHmac("sha256", "offline-route-test-control-token")
        .update(payload)
        .digest("base64url");
      return {
        method: "POST",
        url: "/api/access-requests",
        payload: {
          accessRequestToken: `${payload}.${signature}`,
          twitterHandle: "@testmaker",
        },
      };
    },
  },
  {
    code: "access-request-limit",
    status: 429,
    copy: "You've sent 3 requests this hour. Try again later.",
    public: true,
    prepare: async (h) => {
      const headers = h.signedInAs();
      for (let index = 0; index < 3; index += 1)
        await h.app.inject({
          method: "POST",
          url: "/api/access-requests",
          headers,
          payload: {
            accessRequestToken: "invalid",
            twitterHandle: "@testmaker",
          },
        });
      return {
        method: "POST",
        url: "/api/access-requests",
        payload: { accessRequestToken: "invalid", twitterHandle: "@testmaker" },
      };
    },
  },
  {
    code: "orders-open",
    status: 409,
    copy: "Cancel 1 open Maker order before revoking the trading key.",
    prepare: (h) => {
      authorize(h);
      h.gateway.when("listMarkets", async () => [{ id: "0x1" }]);
      h.gateway.portfolio = {
        positions: [{ makerOrderIds: ["test-only-order"] }],
      };
      return {
        method: "POST",
        url: "/api/setup/revoke-transaction",
        payload: { accountId: "1796" },
      };
    },
  },
  {
    code: "shared-strategy",
    status: 409,
    copy: "This bundle uses a shared strategy. Edit it in Strategy instead.",
    prepare: (h) => {
      const { tenant, strategy } = seed(h);
      tenant.confirmWalletLimits();
      const pilot = tenant.createAllocatedBundle({
        name: "Pilot",
        makerAccountId: null,
        takerAccountId: null,
        mode: "paper",
        strategyId: strategy.id,
        markets: config.markets,
      });
      return {
        method: "POST",
        url: `/api/bundles/${pilot.id}/config`,
        payload: { config },
      };
    },
  },
  {
    code: "strategy-conflict",
    status: 409,
    copy: "Strategy changed elsewhere",
    prepare: (h) => {
      const { strategy } = seed(h);
      const original = h.store.forTenant.bind(h.store);
      h.store.forTenant = ((owner: string) => {
        const tenant = original(owner);
        tenant.updateStrategy = (() => {
          throw new Error("Strategy changed elsewhere");
        }) as typeof tenant.updateStrategy;
        return tenant;
      }) as typeof h.store.forTenant;
      return {
        method: "PATCH",
        url: `/api/strategies/${strategy.id}`,
        payload: {
          ...strategyBody(strategy),
          expectedVersion: strategy.version,
        },
      };
    },
  },
  {
    code: "bundle-precondition",
    status: 409,
    copy: "A bundle already uses that name",
    prepare: (h) => {
      seed(h);
      const original = h.store.forTenant.bind(h.store);
      h.store.forTenant = ((owner: string) => {
        const tenant = original(owner);
        tenant.createAllocatedBundle = (() => {
          throw new Error("A bundle already uses that name");
        }) as typeof tenant.createAllocatedBundle;
        return tenant;
      }) as typeof h.store.forTenant;
      return {
        method: "POST",
        url: "/api/bundles",
        payload: {
          name: "Pilot",
          makerAccountId: null,
          takerAccountId: null,
          mode: "paper",
          strategyId: null,
          markets: config.markets,
        },
      };
    },
  },
  {
    code: "trial-already-running",
    status: 409,
    copy: "A Paper test run is already in progress. Wait for it to finish before trying again.",
    prepare: (h) => {
      const tenant = h.store.forTenant(OWNER);
      tenant.setConfig({ ...config, makerAccountId: "1796" });
      authorize(h);
      const core = tenant.listBundles()[0]!;
      (
        h.runtimeManager as unknown as { paperTrials: Map<string, unknown> }
      ).paperTrials.set(
        `${OWNER}:${core.id}:paper-trial`,
        h.runtimeManager.getBundle(OWNER, core.id),
      );
      return {
        method: "POST",
        url: "/api/runtime/paper-trial",
        payload: { cadenceMs: 2_000 },
      };
    },
  },
];

describe("owner-facing error responses and audit records at real HTTP routes", () => {
  it.each(cases)(
    "$code responds with its exact source copy and owner audit event",
    async (scenario) => {
      const h = scenario.harness
        ? await scenario.harness()
        : await appHarness();
      try {
        const request = await scenario.prepare(h);
        const response = await h.app.inject({
          ...request,
          headers: h.signedInAs(),
        });
        expect(response.statusCode, scenario.code).toBe(scenario.status);
        const body = response.json();
        expect(body.code, scenario.code).toBe(scenario.code);
        expect(body.error, scenario.code).toBe(scenario.copy);
        expect(body.error).not.toContain("Internal server error");
        if (scenario.status < 500) expect(body).not.toHaveProperty("requestId");
        else expect(body.requestId).toEqual(expect.any(String));
        const ownerEvents = h.store.forTenant(OWNER).listEvents(100);
        if (
          scenario.status === 401 ||
          scenario.status === 403 ||
          scenario.public
        ) {
          expect(
            ownerEvents.filter((event) => event.category === "request"),
          ).toHaveLength(0);
        } else {
          expect(ownerEvents).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                category: "request",
                outcome: scenario.status >= 500 ? "error" : "rejected",
                detail: expect.objectContaining({
                  status: scenario.status,
                  code: scenario.code,
                  message: scenario.copy,
                  reference: expect.any(String),
                }),
              }),
            ]),
          );
        }
      } finally {
        await h.close();
      }
    },
  );
});

describe("bundle mode route", () => {
  it("switches a ready stopped Core to Live without starting or signing", async () => {
    const h = await appHarness({
      env: {
        LIVE_TRADING_ENABLED: "true",
        ALLOW_MAINNET: "true",
        MAKER_MASTER_KEY: "test-only-not-a-production-key",
      },
    });
    try {
      const { tenant } = seed(h);
      h.gateway.account("1796", 100);
      authorize(h);
      tenant.setConfig({ ...config, makerAccountId: "1796" });
      const core = tenant.listBundles()[0]!;
      const response = await h.app.inject({
        method: "POST",
        url: `/api/bundles/${core.id}/mode`,
        payload: { mode: "live", confirmed: true },
        headers: h.signedInAs(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().bundle.mode).toBe("live");
      expect(tenant.getStoredBundle(core.id)?.status).toBe("stopped");
      expect(
        tenant
          .listEvents(20)
          .some(
            (event) =>
              event.category === "bundles" &&
              event.action === "mode.update" &&
              event.outcome === "success",
          ),
      ).toBe(true);
      expect(
        h.gateway.calls.some((call) => call.method.includes("place")),
      ).toBe(false);
    } finally {
      await h.close();
    }
  });
});

// The complete AST guard is filled from every runtime/controller source file.
// Codes truly unreachable through HTTP have separately documented direct tests below.
export const notReachableOverHttp: ReadonlyArray<{
  code: string;
  reason: string;
  exercise: (h: Harness) => Promise<unknown> | unknown;
}> = [
  {
    code: "account-owner-mismatch",
    reason:
      "Setup routes check the signed owner before TenantStore.setSetup can see a different owner.",
    exercise: (h) =>
      h.store.forTenant(OWNER).setSetup(
        setupSchema.parse({
          ownerAddress: `0x${"2".repeat(64)}`,
          accountId: "1796",
          accountCapId: "0x1234",
          collateralCoinType: USDC_COIN_TYPE,
        }),
      ),
  },
  {
    code: "accounts-not-distinct",
    reason:
      "HTTP MakerConfig validation rejects a shared account before the store's defensive assignment guard.",
    exercise: (h) => {
      const { tenant } = seed(h);
      tenant.confirmWalletLimits();
      return tenant.createBundle({
        name: "Pilot",
        config: {
          ...config,
          makerAccountId: "1796",
          hedge: { ...config.hedge, enabled: true, accountId: "1796" },
        },
      });
    },
  },
  {
    code: "bundle-archived",
    reason:
      "Public routes resolve active bundles first and return bundle-not-found for archived IDs.",
    exercise: (h) => {
      const { core } = seed(h);
      return (
        h.runtimeManager as unknown as {
          assertStartAllowed: (owner: string, bundle: typeof core) => void;
        }
      ).assertStartAllowed(OWNER, {
        ...core,
        archivedAt: new Date().toISOString(),
      });
    },
  },
  {
    code: "core-not-found",
    reason:
      "Core ID lookup and bundle row are synchronous; this guard covers a disappearing legacy row between reads.",
    exercise: (h) => {
      seed(h);
      const original = h.store.forTenant.bind(h.store);
      h.store.forTenant = ((owner: string) => {
        const tenant = original(owner);
        tenant.getStoredBundle = (() => null) as typeof tenant.getStoredBundle;
        return tenant;
      }) as typeof h.store.forTenant;
      return h.runtimeManager.runPaperTrial({
        ownerAddress: OWNER,
        cadenceMs: 2_000,
      });
    },
  },
  {
    code: "gas-reserve-low",
    reason:
      "Live gates remain disabled; the Live reserve guard is unit-tested without starting Live or broadcasting.",
    exercise: (h) => {
      const tenant = h.store.forTenant(OWNER);
      tenant.setConfig({ ...config, mode: "live", maxGasMist: 50_000_000 });
      const core = tenant.listBundles()[0]!;
      const runtime = h.runtimeManager.getBundle(OWNER, core.id);
      (
        runtime as unknown as {
          snapshotValue: {
            balances: { gasSui: number | null };
            agentAddress: string | null;
          };
        }
      ).snapshotValue.balances.gasSui = 0.08;
      return (
        h.runtimeManager as unknown as {
          assertStartGasReserve: (
            owner: string,
            bundle: typeof core,
            runtime: typeof runtime,
          ) => void;
        }
      ).assertStartGasReserve(OWNER, core, runtime);
    },
  },
  {
    code: "market-taken",
    reason:
      "Only Core can run Live; a second Live overlap can only exist in a disposable legacy/DB corruption fixture.",
    exercise: (h) => {
      const { tenant, core, strategy } = seed(h);
      tenant.confirmWalletLimits();
      const other = tenant.createAllocatedBundle({
        name: "Pilot",
        makerAccountId: null,
        takerAccountId: null,
        mode: "paper",
        strategyId: strategy.id,
        markets: config.markets,
      });
      const db = (
        h.store as unknown as {
          db: {
            prepare: (sql: string) => { run: (...args: string[]) => unknown };
          };
        }
      ).db;
      db.prepare("UPDATE bundles SET mode = 'live' WHERE id IN (?, ?)").run(
        core.id,
        other.id,
      );
      tenant.setBundleStatus(core.id, "running");
      tenant.assertBundleMarketsAvailableToStart(other.id);
    },
  },
  {
    code: "markets-on-strategy",
    reason:
      "Bundle PATCH does not accept markets; only internal allocation calls can submit that field.",
    exercise: (h) => {
      const { tenant, core } = seed(h);
      tenant.updateBundleAllocation({
        bundleId: core.id,
        markets: config.markets,
      });
    },
  },
  {
    code: "needs-strategy",
    reason:
      "Public Start returns bundle-not-ready-strategy first; the store retains an independent legacy guard.",
    exercise: (h) => {
      const { tenant } = seed(h);
      tenant.confirmWalletLimits();
      const draft = tenant.createAllocatedBundle({
        name: "Draft",
        makerAccountId: null,
        takerAccountId: null,
        mode: "paper",
        strategyId: null,
        markets: config.markets,
      });
      tenant.assertBundleMarketsAvailableToStart(draft.id);
    },
  },
  {
    code: "strategy-name-invalid",
    reason:
      "Route schemas trim and reject empty/overlong names before the store's duplicate validation.",
    exercise: (h) => {
      const { tenant, strategy } = seed(h);
      tenant.createStrategy({ ...strategyBody(strategy), name: " " });
    },
  },
];

describe("typed error-code drift guard", () => {
  it.each(notReachableOverHttp)(
    "$code is exercised directly because $reason",
    async ({ code, exercise }) => {
      const h = await appHarness();
      try {
        let caught: unknown = null;
        try {
          await exercise(h);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(UserFacingError);
        expect((caught as UserFacingError).code).toBe(code);
      } finally {
        await h.close();
      }
    },
  );
  it("has a route scenario or a directly tested unreachable reason for every literal code", () => {
    const root = join(import.meta.dirname, "../src");
    const found = new Set<string>();
    for (const file of readdirSync(root).filter((name) =>
      name.endsWith(".ts"),
    )) {
      const source = ts.createSourceFile(
        file,
        readFileSync(join(root, file), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node) => {
        if (
          ts.isNewExpression(node) &&
          node.expression.getText(source) === "UserFacingError" &&
          node.arguments?.[0] &&
          ts.isStringLiteral(node.arguments[0])
        )
          found.add(node.arguments[0].text);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    const covered = new Set([
      ...cases.map((entry) => entry.code),
      ...notReachableOverHttp.map((entry) => entry.code),
    ]);
    expect([...found].filter((code) => !covered.has(code)).sort()).toEqual([]);
    expect(cases.length + notReachableOverHttp.length).toBe(found.size);
  });
});
