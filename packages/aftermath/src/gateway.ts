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
import { Transaction } from "@mysten/sui/transactions";
import {
  assertBuilderFeePolicy,
  type BuilderFeePolicy,
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
  openInterestBase: number;
  openInterestUsd: number;
  openInterestUtilizationPct: number | null;
  maxOpenInterestBase: number;
  fundingRate: number;
  makerFee: number;
  volume24hUsd: number | null;
  priceChange24hPct: number | null;
};

export type PositionSnapshot = {
  marketId: string;
  inventoryUsd: number;
  unrealizedPnlUsd: number;
  makerOrderIds: bigint[];
  hasPosition: boolean;
};

export type PortfolioSnapshot = {
  equityUsd: number;
  grossExposureUsd: number;
  unrealizedPnlUsd: number;
  positions: PositionSnapshot[];
};

export type AccountSnapshot = PositionSnapshot & {
  equityUsd: number;
  openOrderIds: bigint[];
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
  builderCode?: BuilderFeePolicy;
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
    ...(inputs.builderCode ? { builderCode: inputs.builderCode } : {}),
    shouldAbortOnMissingId: false,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function decodeIntegratorId(bytes: Uint8Array): number {
  if (bytes.byteLength !== 4) {
    throw new Error("Integrator ID must be a four-byte u32");
  }
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(0, true);
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
    const marketIds = rawMarkets.map((market) => market.marketId);
    const [{ markets }, statsResult] = await Promise.all([
      perps.getMarkets({ marketIds }),
      perps
        .getMarkets24hrStats({ marketIds })
        .catch(() => ({ marketsStats: [] })),
    ]);

    return markets.map((market, index) => {
      const openInterestBase = Math.abs(market.marketState.openInterest);
      const maxOpenInterestBase = market.marketParams.maxOpenInterest;
      const stats = statsResult.marketsStats[index];
      return {
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
        openInterestBase,
        openInterestUsd: openInterestBase * market.indexPrice,
        openInterestUtilizationPct:
          maxOpenInterestBase > 0
            ? (openInterestBase / maxOpenInterestBase) * 100
            : null,
        maxOpenInterestBase,
        fundingRate: market.estimatedFundingRate(),
        makerFee: market.marketParams.makerFee,
        volume24hUsd: stats?.volumeUsd ?? null,
        priceChange24hPct: stats?.priceChangePercentage ?? null,
      };
    });
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

  async buildCreateAccountTransaction(inputs: {
    ownerAddress: string;
    collateralCoinType: string;
  }): Promise<string> {
    const { tx } = await this.sdk.Perpetuals().getCreateAccountTx({
      walletAddress: inputs.ownerAddress,
      collateralCoinType: inputs.collateralCoinType,
    });
    tx.setSender(inputs.ownerAddress);
    return tx.toJSON();
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

  async getAgentPortfolioSnapshot(inputs: {
    setup: Setup;
    agentAddress: string;
    marketIds: string[];
  }): Promise<PortfolioSnapshot> {
    const cap = await this.findAccountCap({
      walletAddress: inputs.agentAddress,
      accountId: inputs.setup.accountId,
      collateralCoinType: inputs.setup.collateralCoinType,
      requireAgent: true,
    });
    const { account } = await this.sdk.Perpetuals().getAccount({
      accountCap: cap,
      marketIds: inputs.marketIds,
    });
    const positions = inputs.marketIds.map((marketId) => {
      const position = account.account.positions.find(
        (candidate) => candidate.marketId === marketId,
      );
      const makerOrderIds =
        position?.pendingOrders
          .filter(
            (order) =>
              order.clientOrderId === MAKER_BID_CLIENT_ORDER_ID ||
              order.clientOrderId === MAKER_ASK_CLIENT_ORDER_ID,
          )
          .map((order) => order.orderId) ?? [];
      return {
        marketId,
        inventoryUsd: position?.quoteAssetNotionalAmount ?? 0,
        unrealizedPnlUsd:
          (position?.unrealizedPnlUsd ?? 0) +
          (position?.unrealizedFundingsUsd ?? 0),
        makerOrderIds,
        hasPosition: Boolean(position && position.baseAssetAmount !== 0),
      };
    });

    return {
      equityUsd: account.account.totalEquityUsd,
      grossExposureUsd: positions.reduce(
        (sum, position) => sum + Math.abs(position.inventoryUsd),
        0,
      ),
      unrealizedPnlUsd: positions.reduce(
        (sum, position) => sum + position.unrealizedPnlUsd,
        0,
      ),
      positions,
    };
  }

  async getAgentAccountSnapshot(inputs: {
    setup: Setup;
    agentAddress: string;
    marketId: string;
  }): Promise<AccountSnapshot> {
    const portfolio = await this.getAgentPortfolioSnapshot({
      setup: inputs.setup,
      agentAddress: inputs.agentAddress,
      marketIds: [inputs.marketId],
    });
    const position = portfolio.positions[0]!;
    return {
      ...position,
      equityUsd: portfolio.equityUsd,
      openOrderIds: position.makerOrderIds,
    };
  }

  async buildGrantAgentTransaction(inputs: {
    setup: Setup;
    agentAddress: string;
    gasMist: bigint;
    builderCode: BuilderFeePolicy | null;
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
    let { tx } = await account.getGrantAgentWalletTx({
      recipientAddress: inputs.agentAddress,
    });
    if (inputs.builderCode) {
      ({ tx } = await this.sdk
        .Perpetuals()
        .getCreateBuilderCodeIntegratorConfigTx({
          accountId: BigInt(inputs.setup.accountId),
          integratorId: inputs.builderCode.integratorId,
          maxIntegratorFee: inputs.builderCode.integratorFee,
          tx,
        }));
    }
    const [gasCoin] = tx.splitCoins(tx.gas, [inputs.gasMist]);
    tx.transferObjects([gasCoin], inputs.agentAddress);
    tx.setSender(inputs.setup.ownerAddress);
    return tx.toJSON();
  }

  async verifyAgentGrant(inputs: {
    setup: Setup;
    agentAddress: string;
    builderCode: BuilderFeePolicy | null;
  }): Promise<{ agentCapId: string }> {
    const cap = await this.findAccountCap({
      walletAddress: inputs.agentAddress,
      accountId: inputs.setup.accountId,
      collateralCoinType: inputs.setup.collateralCoinType,
      requireAgent: true,
    });
    if (inputs.builderCode) {
      const approval = await this.sdk
        .Perpetuals()
        .getBuilderCodeIntegratorConfig({
          accountId: BigInt(inputs.setup.accountId),
          integratorId: inputs.builderCode.integratorId,
        });
      if (
        !approval.exists ||
        approval.maxIntegratorFee === undefined ||
        approval.maxIntegratorFee + Number.EPSILON <
          inputs.builderCode.integratorFee
      ) {
        throw new Error("Builder-code approval was not confirmed on-chain");
      }
    }
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

  async buildIntegratorRegistrationTransaction(ownerAddress: string): Promise<{
    transaction: string;
    expectedIntegratorId: number;
  }> {
    const response = await fetch(
      "https://aftermath.finance/api/perpetuals/builder-codes/transactions/create-integrator-registration",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    const body = (await response.json()) as {
      txKind?: string;
      error?: string;
    };
    if (!response.ok || !body.txKind) {
      throw new Error(
        body.error ?? "Aftermath did not build the registration transaction",
      );
    }
    const tx = Transaction.fromKind(body.txKind);
    tx.setSender(ownerAddress);
    const simulation = await this.client.simulateTransaction({
      transaction: tx,
      include: { commandResults: true },
    });
    if (simulation.$kind === "FailedTransaction") {
      throw new Error(
        simulation.FailedTransaction.status.error?.message ??
          "Integrator registration simulation failed",
      );
    }
    const bytes = simulation.commandResults?.[0]?.returnValues[0]?.bcs;
    if (!bytes) {
      throw new Error("Aftermath did not return the next integrator ID");
    }
    const expectedIntegratorId = decodeIntegratorId(bytes);
    return {
      transaction: await tx.toJSON(),
      expectedIntegratorId,
    };
  }

  async confirmIntegratorRegistration(inputs: {
    digest: string;
    ownerAddress: string;
    expectedIntegratorId: number;
  }): Promise<{ integratorId: number; integratorAddress: string }> {
    const result = await this.client.waitForTransaction({
      digest: inputs.digest,
      timeout: 60_000,
      include: { transaction: true },
    });
    if (result.$kind === "FailedTransaction") {
      throw new Error(
        result.FailedTransaction.status.error?.message ??
          "Integrator registration failed",
      );
    }
    if (
      result.Transaction.transaction?.sender?.toLowerCase() !==
      inputs.ownerAddress.toLowerCase()
    ) {
      throw new Error("Integrator registration was signed by another wallet");
    }

    for (
      let integratorId = inputs.expectedIntegratorId;
      integratorId <= inputs.expectedIntegratorId + 32;
      integratorId += 1
    ) {
      const response = await fetch(
        "https://aftermath.finance/api/perpetuals/builder-codes/integrator-registration",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ integratorId }),
        },
      );
      if (!response.ok) continue;
      const body = (await response.json()) as {
        integratorAddress?: string;
      };
      if (
        body.integratorAddress?.toLowerCase() ===
        inputs.ownerAddress.toLowerCase()
      ) {
        return { integratorId, integratorAddress: body.integratorAddress };
      }
    }

    throw new Error(
      "Registration succeeded, but its integrator ID could not be verified",
    );
  }

  async cancelMakerOrders(inputs: {
    setup: Setup;
    marketIds: string[];
    signer: Ed25519Keypair;
    config: MakerConfig;
  }): Promise<ExecutionReceipt | null> {
    const signerAddress = inputs.signer.toSuiAddress();
    const cap = await this.findAccountCap({
      walletAddress: signerAddress,
      accountId: inputs.setup.accountId,
      collateralCoinType: inputs.setup.collateralCoinType,
      requireAgent: true,
    });
    const { account } = await this.sdk.Perpetuals().getAccount({
      accountCap: cap,
      marketIds: inputs.marketIds,
    });
    const marketIdsToData: Record<
      string,
      { orderIds: bigint[]; collateralChange: number }
    > = {};

    for (const position of account.account.positions) {
      const orderIds = position.pendingOrders
        .filter(
          (order) =>
            order.clientOrderId === MAKER_BID_CLIENT_ORDER_ID ||
            order.clientOrderId === MAKER_ASK_CLIENT_ORDER_ID,
        )
        .map((order) => order.orderId);
      if (orderIds.length) {
        marketIdsToData[position.marketId] = {
          orderIds,
          collateralChange: 0,
        };
      }
    }

    if (!Object.keys(marketIdsToData).length) return null;

    const { tx } = await account.getCancelOrdersTx({ marketIdsToData });
    tx.setSender(signerAddress);
    await this.inspectTransaction({ tx, config: inputs.config });
    const result = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer: inputs.signer,
      include: { effects: true, events: true },
    });
    return {
      digest: transactionDigest(result),
      endpoint: this.endpoint,
    };
  }

  private async inspectTransaction(inputs: {
    tx: Transaction;
    config: MakerConfig;
  }): Promise<void> {
    inputs.tx.setGasBudget(BigInt(inputs.config.maxGasMist));

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
    builderCode: BuilderFeePolicy | null;
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
      marketIds: [inputs.quote.marketId],
    });
    const market = await this.getMarket(inputs.quote.marketId);
    const position = account.account.positions.find(
      (candidate) => candidate.marketId === inputs.quote.marketId,
    );

    const size = market.roundToValidSizeBigInt({
      size: inputs.quote.sizeBase,
      floor: true,
    });
    if (size <= 0n) {
      throw new Error("Quote size is below the market lot size");
    }

    const request = buildQuoteReplacementRequest({
      marketId: inputs.quote.marketId,
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
      ...(inputs.builderCode ? { builderCode: inputs.builderCode } : {}),
    });

    if (!inputs.shouldContinue()) {
      throw new Error("Live execution cancelled before transaction build");
    }
    assertBuilderFeePolicy(request, inputs.builderCode);
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
