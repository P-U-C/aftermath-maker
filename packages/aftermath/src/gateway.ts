import {
  Aftermath,
  PerpetualsOrderSide,
  PerpetualsOrderType,
  type PerpetualsAccountCap,
  type PerpetualsMarket,
  type SdkPerpetualsCancelAndPlaceOrdersInputs,
} from "aftermath-ts-sdk";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import {
  assertNoBuilderFee,
  type MakerConfig,
  type QuoteIntent,
  type Setup,
} from "@puc/core";

export type MarketSummary = {
  id: string;
  symbol: string;
  displayName: string;
  indexPrice: number;
  collateralPrice: number;
  collateralCoinType: string;
  tickSize: number;
  lotSize: number;
};

export type AccountSnapshot = {
  equityUsd: number;
  inventoryUsd: number;
  unrealizedPnlUsd: number;
  openOrderIds: bigint[];
  hasPosition: boolean;
};

export type EndpointHealth = {
  url: string;
  preferred: boolean;
  ok: boolean;
  chainIdentifier: string | null;
  latencyMs: number;
  error: string | null;
};

export type ExecutionReceipt = {
  digest: string;
  endpoint: string;
};

const PUBLIC_MAINNET_GRPC = "https://fullnode.mainnet.sui.io:443";

export const MAKER_BID_CLIENT_ORDER_ID = 0x5055434d4b520001n;
export const MAKER_ASK_CLIENT_ORDER_ID = 0x5055434d4b520002n;

export function buildQuoteReplacementRequest(inputs: {
  marketId: string;
  bidPrice: bigint;
  askPrice: bigint;
  size: bigint;
  leverage: number;
  hasPosition: boolean;
}): SdkPerpetualsCancelAndPlaceOrdersInputs {
  return {
    marketId: inputs.marketId,
    orderIdsToCancel: [],
    clientOrderIdsToCancel: [
      MAKER_BID_CLIENT_ORDER_ID,
      MAKER_ASK_CLIENT_ORDER_ID,
    ],
    ordersToPlace: [
      {
        side: PerpetualsOrderSide.Bid,
        price: inputs.bidPrice,
        size: inputs.size,
        clientOrderId: MAKER_BID_CLIENT_ORDER_ID,
      },
      {
        side: PerpetualsOrderSide.Ask,
        price: inputs.askPrice,
        size: inputs.size,
        clientOrderId: MAKER_ASK_CLIENT_ORDER_ID,
      },
    ],
    orderType: PerpetualsOrderType.PostOnly,
    reduceOnly: false,
    leverage: inputs.leverage,
    hasPosition: inputs.hasPosition,
    shouldAbortOnMissingId: false,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function transactionDigest(result: unknown): string {
  if (!result || typeof result !== "object") {
    throw new Error("Sui returned an invalid execution result");
  }
  const record = result as Record<string, unknown>;
  if (record.$kind === "FailedTransaction") {
    const failed = record.FailedTransaction as
      { status?: { error?: { message?: string } } } | undefined;
    throw new Error(
      failed?.status?.error?.message ?? "Sui transaction execution failed",
    );
  }
  const tx = record.Transaction as { digest?: string } | undefined;
  if (!tx?.digest) throw new Error("Sui result did not include a digest");
  return tx.digest;
}

export class AftermathGateway {
  private constructor(
    private readonly sdk: Aftermath,
    private readonly client: SuiGrpcClient,
    public readonly endpoint: string,
    public readonly endpointHealth: EndpointHealth[],
  ) {}

  static async create(
    inputs: {
      preferredEndpoint?: string;
      fallbackEndpoint?: string;
    } = {},
  ): Promise<AftermathGateway> {
    const candidates = [
      inputs.preferredEndpoint,
      inputs.fallbackEndpoint ?? PUBLIC_MAINNET_GRPC,
    ].filter((value, index, all): value is string =>
      Boolean(value && all.indexOf(value) === index),
    );

    const health: EndpointHealth[] = [];
    let active:
      | { url: string; client: SuiGrpcClient; chainIdentifier: string }
      | undefined;

    for (const [index, url] of candidates.entries()) {
      const started = Date.now();
      const client = new SuiGrpcClient({
        network: "mainnet",
        baseUrl: url,
      });
      try {
        const response = await client.getChainIdentifier();
        health.push({
          url,
          preferred: index === 0 && Boolean(inputs.preferredEndpoint),
          ok: true,
          chainIdentifier: response.chainIdentifier,
          latencyMs: Date.now() - started,
          error: null,
        });
        active ??= {
          url,
          client,
          chainIdentifier: response.chainIdentifier,
        };
      } catch (error) {
        health.push({
          url,
          preferred: index === 0 && Boolean(inputs.preferredEndpoint),
          ok: false,
          chainIdentifier: null,
          latencyMs: Date.now() - started,
          error: errorMessage(error),
        });
      }
    }

    if (!active) {
      throw new Error(
        `No healthy Sui endpoint: ${health.map((item) => item.error).join("; ")}`,
      );
    }

    const sdk = await Aftermath.create({
      network: "MAINNET",
      fullnodeUrl: active.url,
    });
    return new AftermathGateway(sdk, active.client, active.url, health);
  }

  async listMarkets(collateralCoinType: string): Promise<MarketSummary[]> {
    const perps = this.sdk.Perpetuals();
    const { markets: rawMarkets } = await perps.getAllMarkets({
      collateralCoinType,
    });
    const { markets } = await perps.getMarkets({
      marketIds: rawMarkets.map((market) => market.marketId),
    });
    return markets.map((market) => ({
      id: market.marketId,
      symbol: market.metadata?.symbol ?? market.marketId.slice(0, 10),
      displayName:
        market.metadata?.displayName ??
        market.metadata?.symbol ??
        "Unnamed market",
      indexPrice: market.indexPrice,
      collateralPrice: market.collateralPrice,
      collateralCoinType: market.collateralCoinType,
      tickSize: market.tickSize(),
      lotSize: market.lotSize(),
    }));
  }

  async getMarket(marketId: string): Promise<PerpetualsMarket> {
    const { market } = await this.sdk.Perpetuals().getMarket({ marketId });
    if (!market) throw new Error(`Market ${marketId} was not found`);
    return market;
  }

  async getOrderbook(marketId: string) {
    const market = await this.getMarket(marketId);
    const { orderbook } = await market.getOrderbook();
    return { market, orderbook };
  }

  async getOwnedAccountCaps(inputs: {
    walletAddress: string;
    collateralCoinType?: string;
  }): Promise<PerpetualsAccountCap[]> {
    const result = await this.sdk.Perpetuals().getOwnedAccountCaps({
      walletAddress: inputs.walletAddress,
      ...(inputs.collateralCoinType
        ? { collateralCoinTypes: [inputs.collateralCoinType] }
        : {}),
    });
    return result.accountCaps;
  }

  private async findAccountCap(inputs: {
    walletAddress: string;
    accountId: string;
    collateralCoinType: string;
    requireAgent?: boolean;
  }): Promise<PerpetualsAccountCap> {
    const caps = await this.getOwnedAccountCaps({
      walletAddress: inputs.walletAddress,
      collateralCoinType: inputs.collateralCoinType,
    });
    const cap = caps.find(
      (candidate) =>
        candidate.accountId.toString() === inputs.accountId &&
        (inputs.requireAgent === undefined ||
          candidate.isAgent === inputs.requireAgent),
    );
    if (!cap) {
      throw new Error(
        `No matching ${inputs.requireAgent ? "agent" : "admin"} account capability found`,
      );
    }
    return cap;
  }

  async getAgentAccountSnapshot(inputs: {
    setup: Setup;
    agentAddress: string;
    marketId: string;
  }): Promise<AccountSnapshot> {
    const cap = await this.findAccountCap({
      walletAddress: inputs.agentAddress,
      accountId: inputs.setup.accountId,
      collateralCoinType: inputs.setup.collateralCoinType,
      requireAgent: true,
    });
    const { account } = await this.sdk
      .Perpetuals()
      .getAccount({ accountCap: cap, marketIds: [inputs.marketId] });
    const position = account.account.positions.find(
      (candidate) => candidate.marketId === inputs.marketId,
    );

    return {
      equityUsd: account.account.totalEquityUsd,
      inventoryUsd: position?.quoteAssetNotionalAmount ?? 0,
      unrealizedPnlUsd:
        (position?.unrealizedPnlUsd ?? 0) +
        (position?.unrealizedFundingsUsd ?? 0),
      openOrderIds: position?.pendingOrders.map((order) => order.orderId) ?? [],
      hasPosition: Boolean(position && position.baseAssetAmount !== 0),
    };
  }

  async buildGrantAgentTransaction(inputs: {
    setup: Setup;
    agentAddress: string;
    gasMist: bigint;
  }): Promise<string> {
    const cap = await this.findAccountCap({
      walletAddress: inputs.setup.ownerAddress,
      accountId: inputs.setup.accountId,
      collateralCoinType: inputs.setup.collateralCoinType,
      requireAgent: false,
    });
    if (cap.objectId !== inputs.setup.accountCapId) {
      throw new Error("Admin account capability does not match setup");
    }
    const { account } = await this.sdk.Perpetuals().getAccount({
      accountCap: cap,
    });
    const { tx } = await account.getGrantAgentWalletTx({
      recipientAddress: inputs.agentAddress,
    });
    const [gasCoin] = tx.splitCoins(tx.gas, [inputs.gasMist]);
    tx.transferObjects([gasCoin], inputs.agentAddress);
    tx.setSender(inputs.setup.ownerAddress);
    return tx.toJSON();
  }

  async verifyAgentGrant(inputs: {
    setup: Setup;
    agentAddress: string;
  }): Promise<{ agentCapId: string }> {
    const cap = await this.findAccountCap({
      walletAddress: inputs.agentAddress,
      accountId: inputs.setup.accountId,
      collateralCoinType: inputs.setup.collateralCoinType,
      requireAgent: true,
    });
    return { agentCapId: cap.objectId };
  }

  async buildRevokeAgentTransaction(inputs: {
    setup: Setup;
    agentCapId: string;
  }): Promise<string> {
    const cap = await this.findAccountCap({
      walletAddress: inputs.setup.ownerAddress,
      accountId: inputs.setup.accountId,
      collateralCoinType: inputs.setup.collateralCoinType,
      requireAgent: false,
    });
    const { account } = await this.sdk.Perpetuals().getAccount({
      accountCap: cap,
    });
    const { tx } = await account.getRevokeAgentWalletTx({
      accountCapId: inputs.agentCapId,
    });
    tx.setSender(inputs.setup.ownerAddress);
    return tx.toJSON();
  }

  async inspectIntegrator(inputs: { accountId: string; integratorId: number }) {
    const result = await this.sdk.Perpetuals().getBuilderCodeIntegratorConfig({
      accountId: BigInt(inputs.accountId),
      integratorId: inputs.integratorId,
    });
    return {
      accountId: inputs.accountId,
      integratorId: inputs.integratorId,
      exists: result.exists,
      maxIntegratorFee: result.exists ? result.maxIntegratorFee : null,
      evidence: "Aftermath builder-codes/integrator-config",
      checkedAt: new Date().toISOString(),
    };
  }

  private async inspectTransaction(inputs: {
    tx: Transaction;
    config: MakerConfig;
  }): Promise<void> {
    inputs.tx.setGasBudget(BigInt(inputs.config.maxGasMist));
    const serialized = await inputs.tx.toJSON();
    assertNoBuilderFee(JSON.parse(serialized));

    const simulation = await this.client.simulateTransaction({
      transaction: inputs.tx,
      include: {
        effects: true,
        balanceChanges: true,
      },
    });
    if (simulation.$kind === "FailedTransaction") {
      throw new Error(
        simulation.FailedTransaction.status.error?.message ??
          "Transaction simulation failed",
      );
    }
  }

  async executeQuote(inputs: {
    setup: Setup;
    config: MakerConfig;
    quote: QuoteIntent;
    signer: Ed25519Keypair;
    shouldContinue: () => boolean;
  }): Promise<ExecutionReceipt> {
    const signerAddress = inputs.signer.toSuiAddress();
    const cap = await this.findAccountCap({
      walletAddress: signerAddress,
      accountId: inputs.setup.accountId,
      collateralCoinType: inputs.setup.collateralCoinType,
      requireAgent: true,
    });
    const perps = this.sdk.Perpetuals();
    const { account } = await perps.getAccount({
      accountCap: cap,
      marketIds: [inputs.config.marketId],
    });
    const market = await this.getMarket(inputs.config.marketId);
    const position = account.account.positions.find(
      (candidate) => candidate.marketId === inputs.config.marketId,
    );

    const size = market.roundToValidSizeBigInt({
      size: inputs.quote.sizeBase,
      floor: true,
    });
    if (size <= 0n) {
      throw new Error("Quote size is below the market lot size");
    }

    const request = buildQuoteReplacementRequest({
      marketId: inputs.config.marketId,
      bidPrice: market.roundToValidPriceBigInt({
        price: inputs.quote.bidPrice,
        floor: true,
      }),
      askPrice: market.roundToValidPriceBigInt({
        price: inputs.quote.askPrice,
        ceil: true,
      }),
      size,
      leverage: inputs.config.maxLeverage,
      hasPosition: Boolean(position && position.baseAssetAmount !== 0),
    });

    if (!inputs.shouldContinue()) {
      throw new Error("Live execution cancelled before transaction build");
    }
    assertNoBuilderFee(request);
    const { tx } = await account.getCancelAndPlaceOrdersTx(request);
    tx.setSender(signerAddress);
    await this.inspectTransaction({ tx, config: inputs.config });
    if (!inputs.shouldContinue()) {
      throw new Error("Live execution cancelled before signing");
    }

    const result = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer: inputs.signer,
      include: {
        effects: true,
        events: true,
        balanceChanges: true,
      },
    });

    return {
      digest: transactionDigest(result),
      endpoint: this.endpoint,
    };
  }
}
