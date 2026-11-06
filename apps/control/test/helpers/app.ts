import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transaction } from "@mysten/sui/transactions";
import {
  serializeOwnerTransactionIntent,
  type AftermathGateway,
  type OwnerAccountSummary,
  type OwnerTransactionIntent,
} from "@puc/aftermath";
import { USDC_COIN_TYPE } from "@puc/core";
import { WalletAuth } from "../../src/auth.js";
import { RuntimeManager } from "../../src/runtime-manager.js";
import { buildServer, envSchema } from "../../src/server-app.js";
import { Store } from "../../src/store.js";

export const OWNER = `0x${"1".repeat(64)}`;
export const AGENT = `0x${"2".repeat(64)}`;
export const CONTROL_TEST_TOKEN = "offline-route-test-control-token";
const PACKAGE = `0x${"a".repeat(64)}`;
const REGISTRY = `0x${"b".repeat(64)}`;

export function tempStore(): Store {
  return new Store(
    join(mkdtempSync(join(tmpdir(), "maker-route-")), "maker.db"),
  );
}

export function signedInAs(store: Store, owner = OWNER) {
  const token = randomBytes(32).toString("base64url");
  store.createSession({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    ownerAddress: owner,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    chainCheckedAt: new Date().toISOString(),
  });
  return {
    authorization: `Bearer ${token}`,
    "x-maker-session": token,
    "x-control-token": CONTROL_TEST_TOKEN,
  };
}

type FakeResponse<T> = T | Promise<T>;
type FakeHandler = (...args: any[]) => FakeResponse<unknown>;

/** No RPC transport, signing, transaction execution or production service. */
export class FakeGateway {
  readonly endpoint = "fake://offline-venue";
  readonly endpointHealth = [
    {
      url: "fake://offline-venue",
      preferred: true,
      ok: true,
      chainIdentifier: "test",
      latencyMs: 0,
      error: null,
    },
  ];
  accounts: OwnerAccountSummary[] = [];
  gasSui = 2;
  portfolio: unknown = null;
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  private readonly handlers = new Map<string, FakeHandler>();

  account(
    accountId: string,
    freeUsd: number,
    options: {
      openMakerOrderCount?: number;
      withdrawableCollateralUsd?: number;
      availableCollateral?: number;
      collateralPrice?: number;
    } = {},
  ) {
    const summary: OwnerAccountSummary = {
      accountId,
      accountCapId: `0x${Number(accountId).toString(16).padStart(64, "0")}`,
      collateralCoinType: USDC_COIN_TYPE,
      equityUsd: freeUsd,
      availableCollateralUsd: freeUsd,
      availableCollateral: options.availableCollateral,
      collateralPrice: options.collateralPrice,
      allocatedCollateralUsd: 0,
      freeMarginUsd: freeUsd,
      positionCount: 0,
      withdrawableCollateralUsd: options.withdrawableCollateralUsd ?? freeUsd,
      openMakerOrderCount: options.openMakerOrderCount ?? 0,
    };
    this.accounts = [
      ...this.accounts.filter((entry) => entry.accountId !== accountId),
      summary,
    ];
    return summary;
  }

  balance(accountId: string, freeUsd: number) {
    const existing = this.accounts.find(
      (entry) => entry.accountId === accountId,
    );
    if (!existing) return this.account(accountId, freeUsd);
    existing.availableCollateralUsd = freeUsd;
    existing.withdrawableCollateralUsd = freeUsd;
    return existing;
  }

  when(method: string, handler: FakeHandler) {
    this.handlers.set(method, handler);
  }

  clear(method: string) {
    this.handlers.delete(method);
  }

  reject(method: string, message = "Venue read failed") {
    this.when(method, async () => {
      throw new Error(message);
    });
  }

  hang(method: string) {
    this.when(method, () => new Promise<never>(() => {}));
  }

  private async invoke<T>(
    method: string,
    args: unknown[],
    fallback: () => FakeResponse<T>,
  ): Promise<T> {
    this.calls.push({ method, args });
    const handler = this.handlers.get(method);
    return (handler ? await handler(...args) : await fallback()) as T;
  }

  asGateway(): AftermathGateway {
    return new Proxy(this, {
      get: (target, key, receiver) => {
        const value = Reflect.get(target, key, receiver);
        if (typeof value === "function") return value.bind(target);
        if (value !== undefined || typeof key !== "string" || key === "then")
          return value;
        return (...args: unknown[]) =>
          target.invoke(key, args, () => {
            throw new Error(`FakeGateway.${key} has no configured response`);
          });
      },
    }) as unknown as AftermathGateway;
  }

  async listOwnerAccounts(inputs: unknown): Promise<OwnerAccountSummary[]> {
    return this.invoke("listOwnerAccounts", [inputs], () =>
      structuredClone(this.accounts),
    );
  }

  async getTradingKeyGasSui(address: string): Promise<number> {
    return this.invoke("getTradingKeyGasSui", [address], () => this.gasSui);
  }

  async getOrderbook(marketId: string): Promise<any> {
    return this.invoke("getOrderbook", [marketId], () => ({
      market: {
        metadata: { symbol: "NEAR" },
        indexPrice: 10,
        marketState: { openInterest: 1_000 },
        marketParams: { maxOpenInterest: 10_000 },
        estimatedFundingRate: () => 0.0001,
        tickSize: () => 0.01,
      },
      orderbook: {
        bestBidPrice: 9.99,
        bestAskPrice: 10.01,
        bids: [],
        asks: [],
      },
    }));
  }

  async getAgentPortfolioSnapshot(inputs: {
    setup: { accountId: string };
    marketIds: string[];
  }): Promise<any> {
    return this.invoke("getAgentPortfolioSnapshot", [inputs], () => {
      if (this.portfolio) return this.portfolio;
      const available =
        this.accounts.find(
          (account) => account.accountId === inputs.setup.accountId,
        )?.availableCollateralUsd ?? 0;
      return {
        markedAt: new Date().toISOString(),
        equityUsd: available,
        availableCollateralUsd: available,
        allocatedCollateralUsd: 0,
        freeMarginUsd: available,
        withdrawableCollateralUsd: available,
        grossExposureUsd: 0,
        unrealizedPnlUsd: 0,
        gasSui: this.gasSui,
        positions: inputs.marketIds.map((marketId) => ({
          marketId,
          baseAssetAmount: 0,
          pendingOrderCount: 0,
          inventoryUsd: 0,
          unrealizedPnlUsd: 0,
          collateralUsd: 0,
          freeMarginUsd: 0,
          makerOrderIds: [],
          hasPosition: false,
          marginRatio: null,
          liquidationDistanceBps: null,
        })),
      };
    });
  }

  async simulateQuote(inputs: unknown) {
    return this.invoke("simulateQuote", [inputs], () => ({
      endpoint: this.endpoint,
      gasUsedMist: 0,
    }));
  }

  private async prepare(
    kind: OwnerTransactionIntent["kind"],
    inputs: any,
    deposits?: Array<{ accountId: string; amount: bigint }>,
  ) {
    const ownerAddress: string = inputs.ownerAddress;
    const tx = new Transaction();
    tx.setSender(ownerAddress);
    const common = {
      sender: ownerAddress,
      protocolPackageId: PACKAGE,
      registryObjectId: REGISTRY,
      collateralCoinType: inputs.collateralCoinType ?? USDC_COIN_TYPE,
    };
    let intent: OwnerTransactionIntent;
    if (kind === "deposit" || kind === "deposit-batch") {
      const lines = deposits ?? [
        { accountId: inputs.accountId, amount: inputs.amount },
      ];
      const entries = lines.map((line) => {
        const account = this.accounts.find(
          (entry) => entry.accountId === line.accountId,
        );
        if (!account) throw new Error("Fake account not found");
        const accountObjectId = `0x${(Number(line.accountId) + 10_000).toString(16).padStart(64, "0")}`;
        const funds = tx.moveCall({
          target: "0x2::coin::redeem_funds",
          typeArguments: [common.collateralCoinType],
          arguments: [
            tx.withdrawal({
              amount: line.amount,
              type: common.collateralCoinType,
            }),
          ],
        });
        tx.moveCall({
          target: `${PACKAGE}::account::deposit_collateral`,
          typeArguments: [common.collateralCoinType],
          arguments: [
            tx.object(accountObjectId),
            tx.object(account.accountCapId),
            tx.object(REGISTRY),
            funds,
          ],
        });
        return {
          accountCapId: account.accountCapId,
          accountObjectId,
          allowedMarketIds: [],
          amount: line.amount,
        };
      });
      intent =
        kind === "deposit"
          ? { ...common, kind, ...entries[0]! }
          : { ...common, kind, deposits: entries };
    } else if (kind === "withdraw") {
      const account = this.accounts.find(
        (entry) => entry.accountId === inputs.accountId,
      );
      if (!account) throw new Error("Fake account not found");
      const accountObjectId = `0x${(Number(inputs.accountId) + 10_000).toString(16).padStart(64, "0")}`;
      const withdrawn = tx.moveCall({
        target: `${PACKAGE}::account::withdraw_collateral`,
        typeArguments: [common.collateralCoinType],
        arguments: [
          tx.object(accountObjectId),
          tx.object(account.accountCapId),
          tx.object(REGISTRY),
          tx.pure.u64(inputs.amount),
        ],
      });
      tx.transferObjects([withdrawn], tx.pure.address(ownerAddress));
      intent = {
        ...common,
        kind,
        amount: inputs.amount,
        recipient: ownerAddress,
        accountCapId: account.accountCapId,
        accountObjectId,
        allowedMarketIds: [],
      };
    } else if (kind === "gas-top-up") {
      const account = this.accounts.find(
        (entry) => entry.accountId === inputs.accountId,
      );
      if (!account) throw new Error("Fake account not found");
      const [coin] = tx.splitCoins(tx.gas, [inputs.gasMist]);
      tx.transferObjects([coin], inputs.agentAddress);
      intent = {
        ...common,
        kind,
        accountCapId: account.accountCapId,
        accountObjectId: `0x${(Number(inputs.accountId) + 10_000).toString(16).padStart(64, "0")}`,
        allowedMarketIds: [],
        agentAddress: inputs.agentAddress,
        gasMist: inputs.gasMist,
      };
    } else {
      throw new Error(`Fake owner transaction kind ${kind} not configured`);
    }
    return {
      transaction: await tx.toJSON(),
      intent: serializeOwnerTransactionIntent(intent),
    };
  }

  async buildDepositCollateralTransaction(inputs: any) {
    return this.invoke("buildDepositCollateralTransaction", [inputs], () =>
      this.prepare("deposit", inputs),
    );
  }
  async buildDepositCollateralBatchTransaction(inputs: any) {
    return this.invoke("buildDepositCollateralBatchTransaction", [inputs], () =>
      this.prepare("deposit-batch", inputs, inputs.deposits),
    );
  }
  async buildWithdrawCollateralTransaction(inputs: any) {
    return this.invoke("buildWithdrawCollateralTransaction", [inputs], () =>
      this.prepare("withdraw", inputs),
    );
  }
  async buildTopUpAgentGasTransaction(inputs: any) {
    return this.invoke("buildTopUpAgentGasTransaction", [inputs], () =>
      this.prepare("gas-top-up", inputs),
    );
  }

  async buildGrantAgentTransaction(inputs: any) {
    return this.invoke("buildGrantAgentTransaction", [inputs], async () => {
      const tx = new Transaction();
      tx.setSender(inputs.setup.ownerAddress);
      return {
        transaction: await tx.toJSON(),
        intent: JSON.stringify({ kind: "grant-agent" }),
      };
    });
  }
}

export async function appHarness(
  options: {
    allowlistConfigured?: boolean;
    allowlistRead?: () => Promise<boolean>;
    verificationClient?: import("@mysten/sui/grpc").SuiGrpcClient;
    env?: Record<string, string>;
  } = {},
) {
  const store = tempStore();
  const gateway = new FakeGateway();
  const runtimeManager = new RuntimeManager(
    store,
    { liveEnabled: false, mainnetAllowed: false, builderCode: () => null },
    {},
    async () => gateway.asGateway(),
  );
  await runtimeManager.initialize();
  const allowlist = {
    configured: options.allowlistConfigured ?? true,
    isAllowed: options.allowlistRead ?? (async () => true),
  };
  const auth = new WalletAuth(
    store,
    allowlist as never,
    "http://localhost:8788",
    false,
    12,
    30_000,
    undefined,
    CONTROL_TEST_TOKEN,
    options.verificationClient,
  );
  const env = envSchema.parse({
    NODE_ENV: "test",
    CONTROL_TOKEN: CONTROL_TEST_TOKEN,
    ...options.env,
  });
  const app = await buildServer({
    env,
    store,
    runtimeManager,
    auth,
    allowlist: allowlist as never,
  });
  return {
    app,
    store,
    gateway,
    runtimeManager,
    auth,
    signedInAs: (owner = OWNER) => signedInAs(store, owner),
    close: async () => {
      await runtimeManager.stopAll();
      runtimeManager.close();
      await app.close();
      store.close();
    },
  };
}
