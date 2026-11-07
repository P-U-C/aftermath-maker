import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { describe, expect, it } from "vitest";
import { makerConfigSchema, setupSchema } from "@puc/core";
import {
  runLiveCanary,
  type LiveCanaryState,
  type LiveCanaryStateStore,
} from "../src/live-canary.js";

const makerSetup = setupSchema.parse({
  ownerAddress: `0x${"1".repeat(64)}`,
  accountId: "1958",
  accountCapId: `0x${"2".repeat(64)}`,
});
const hedgeSetup = setupSchema.parse({
  ownerAddress: `0x${"1".repeat(64)}`,
  accountId: "1957",
  accountCapId: `0x${"3".repeat(64)}`,
});
const marketId = `0x${"4".repeat(64)}`;

function memoryState(): LiveCanaryStateStore & {
  value: LiveCanaryState | null;
} {
  return {
    value: null,
    async read() {
      return this.value;
    },
    async write(state) {
      this.value = structuredClone(state);
    },
  };
}

function createGateway() {
  const calls: string[] = [];
  let makerInventory = 0;
  let hedgeInventory = 0;
  let makerPending = 0;
  let hedgePending = 0;
  let cancelClears = true;
  const portfolio = (accountId: string) => ({
    markedAt: "2026-11-07T00:00:00.000Z",
    equityUsd: 12.5,
    availableCollateralUsd: 12.5,
    allocatedCollateralUsd: 0,
    freeMarginUsd: 12.5,
    withdrawableCollateralUsd: 12.5,
    grossExposureUsd: Math.abs(
      accountId === makerSetup.accountId ? makerInventory : hedgeInventory,
    ),
    unrealizedPnlUsd: 0,
    gasSui: 1,
    positions: [
      {
        marketId,
        baseAssetAmount:
          accountId === makerSetup.accountId ? makerInventory : hedgeInventory,
        pendingOrderCount:
          accountId === makerSetup.accountId ? makerPending : hedgePending,
        inventoryUsd:
          accountId === makerSetup.accountId ? makerInventory : hedgeInventory,
        unrealizedPnlUsd: 0,
        collateralUsd: 0,
        freeMarginUsd: 12.5,
        makerOrderIds: [],
        hasPosition: Boolean(
          accountId === makerSetup.accountId ? makerInventory : hedgeInventory,
        ),
      },
    ],
  });
  const gateway = {
    endpoint: "fixture",
    endpointHealth: [],
    getOrderbook: async () => ({
      market: { indexPrice: 10, tickSize: () => 0.01 },
      orderbook: { bestBidPrice: 9.99, bestAskPrice: 10.01 },
    }),
    getTradingKeyGasSui: async () => 1,
    getAgentPortfolioSnapshot: async (inputs: {
      setup: { accountId: string };
    }) => portfolio(inputs.setup.accountId),
    simulateQuote: async () => {
      calls.push("simulate");
      return { endpoint: "fixture", gasUsedMist: 1 };
    },
    executeQuote: async () => {
      calls.push("quote");
      makerPending = 2;
      return {
        digest: "quote",
        endpoint: "fixture",
        gasUsedMist: 1,
        postedOrderIds: ["1", "2"],
      };
    },
    cancelMakerOrders: async () => {
      calls.push("cancel");
      if (cancelClears) makerPending = 0;
      return {
        digest: "cancel",
        endpoint: "fixture",
        gasUsedMist: 1,
        postedOrderIds: [],
      };
    },
    executeHedge: async (inputs: { deltaUsd: number }) => {
      calls.push(`hedge:${inputs.deltaUsd}`);
      hedgeInventory -= inputs.deltaUsd;
      return {
        digest: "hedge",
        endpoint: "fixture",
        gasUsedMist: 1,
        postedOrderIds: [],
        side: "ask" as const,
        requestedNotionalUsd: Math.abs(inputs.deltaUsd),
      };
    },
    flattenPositions: async (inputs: { setup: { accountId: string } }) => {
      calls.push(`flatten:${inputs.setup.accountId}`);
      if (inputs.setup.accountId === makerSetup.accountId) makerInventory = 0;
      else hedgeInventory = 0;
      return null;
    },
  };
  return {
    gateway,
    calls,
    simulateFill() {
      makerInventory = 5;
    },
    blockCancellation() {
      cancelClears = false;
    },
    allowCancellation() {
      cancelClears = true;
    },
  };
}

function canaryConfig() {
  return {
    network: "mainnet" as const,
    makerSetup,
    hedgeSetup,
    marketId,
    maxQuoteUsd: 5,
    observationWindowMs: 0,
    settlementWindowMs: 5_000,
    pollMs: 5_000,
    flatConfirmReads: 3,
    builderCode: { integratorId: 15, integratorFee: 0.0001 },
    config: makerConfigSchema.parse({
      mode: "live",
      rotationMode: "single-slot",
      markets: [{ marketId, symbol: "NEAR" }],
      makerAccountId: makerSetup.accountId,
      quoteSizeUsd: 5,
      maxInventoryUsd: 5,
      maxGrossExposureUsd: 5,
      maxGasMist: 1,
      hedge: {
        enabled: true,
        accountId: hedgeSetup.accountId,
        thresholdUsd: 5,
        maxOrderUsd: 5,
        maxSlippageBps: 75,
      },
    }),
  };
}

function inputs(
  gateway: ReturnType<typeof createGateway>["gateway"],
  state: LiveCanaryStateStore,
  execute = true,
) {
  return {
    config: canaryConfig(),
    secrets: {
      agentAddress: Ed25519Keypair.generate().toSuiAddress(),
      signer: Ed25519Keypair.generate(),
    },
    execute,
    dependencies: {
      gateway: gateway as never,
      state,
      sleep: async () => undefined,
      now: () => new Date("2026-11-07T00:00:00.000Z"),
    },
  };
}

describe("live canary", () => {
  it("simulates without signing or broadcasting unless explicitly executed", async () => {
    const fixture = createGateway();
    const state = memoryState();

    const result = await runLiveCanary(inputs(fixture.gateway, state, false));

    expect(result.outcome).toBe("dry-run");
    expect(fixture.calls).toEqual(["simulate"]);
    expect(state.value?.phase).toBe("preflighted");
  });

  it("cancels before a filled quote is hedged, then flattens both accounts", async () => {
    const fixture = createGateway();
    const state = memoryState();
    const runInputs = inputs(fixture.gateway, state);
    let filled = false;
    runInputs.dependencies.sleep = async () => {
      if (!filled) {
        fixture.simulateFill();
        filled = true;
      }
    };

    const result = await runLiveCanary(runInputs);

    expect(result.outcome).toBe("filled-and-flat");
    expect(fixture.calls).toEqual([
      "simulate",
      "quote",
      "cancel",
      "hedge:5",
      `flatten:${makerSetup.accountId}`,
      `flatten:${hedgeSetup.accountId}`,
    ]);
    expect(state.value?.phase).toBe("complete");
    expect(state.value?.hedgeDigest).toBe("hedge");
  });

  it("treats an interrupted quote submission as unknown and cancels instead of requoting", async () => {
    const fixture = createGateway();
    const state = memoryState();
    const dryRun = await runLiveCanary(inputs(fixture.gateway, state, false));
    state.value = { ...dryRun.state, phase: "quoted", quoteDigest: null };

    const recovered = await runLiveCanary(inputs(fixture.gateway, state));

    expect(recovered.outcome).toBe("no-fill");
    expect(fixture.calls).toEqual([
      "simulate",
      "cancel",
      `flatten:${makerSetup.accountId}`,
      `flatten:${hedgeSetup.accountId}`,
    ]);
  });

  it("persists a cancellation uncertainty and resumes recovery before any new quote", async () => {
    const fixture = createGateway();
    fixture.blockCancellation();
    const state = memoryState();

    await expect(runLiveCanary(inputs(fixture.gateway, state))).rejects.toThrow(
      "cancellation could not be confirmed",
    );
    expect(state.value?.phase).toBe("recovery-required");
    expect(fixture.calls).toEqual(["simulate", "quote", "cancel"]);

    fixture.allowCancellation();
    const recovered = await runLiveCanary(inputs(fixture.gateway, state));

    expect(recovered.outcome).toBe("no-fill");
    expect(fixture.calls).toEqual([
      "simulate",
      "quote",
      "cancel",
      "cancel",
      `flatten:${makerSetup.accountId}`,
      `flatten:${hedgeSetup.accountId}`,
    ]);
  });
});
