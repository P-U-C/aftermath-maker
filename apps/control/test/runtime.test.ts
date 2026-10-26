import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEncryptedAgent } from "@puc/aftermath";
import { makerConfigSchema, setupSchema } from "@puc/core";
import { MakerRuntime } from "../src/runtime.js";
import { Store } from "../src/store.js";

function createHarness() {
  const directory = join(
    process.env.TMPDIR ?? "/tmp",
    `aftermath-maker-${randomBytes(8).toString("hex")}`,
  );
  mkdirSync(directory, { recursive: true });
  const databaseStore = new Store(join(directory, "maker.db"));
  const masterKey = randomBytes(32).toString("base64");
  const setup = setupSchema.parse({
    ownerAddress: `0x${"1".repeat(64)}`,
    accountId: "42",
    accountCapId: "0x1234",
  });
  const store = databaseStore.forTenant(setup.ownerAddress);
  const config = makerConfigSchema.parse({
    marketId: "0x5678",
    symbol: "SUI",
    mode: "live",
  });
  const agent = createEncryptedAgent({
    masterKey,
    context: "account:42",
  });

  store.setSetup(setup);
  store.setConfig(config);
  store.createAgent(agent);
  store.confirmAgentGrant({
    digest: "A".repeat(32),
    agentCapId: "0x9876",
  });

  let executionCount = 0;
  const gateway = {
    getOrderbook: async () => ({
      market: {
        metadata: { symbol: "SUI" },
        indexPrice: 10,
      },
      orderbook: {
        bestBidPrice: 9.99,
        bestAskPrice: 10.01,
      },
    }),
    getAgentAccountSnapshot: async () => ({
      equityUsd: 100,
      inventoryUsd: 0,
      unrealizedPnlUsd: 0,
      openOrderIds: [],
      hasPosition: false,
    }),
    executeQuote: async (inputs: { shouldContinue: () => boolean }) => {
      if (!inputs.shouldContinue()) throw new Error("cancelled");
      executionCount += 1;
      return { digest: "digest", endpoint: "test" };
    },
  };

  const runtime = new MakerRuntime(store, gateway as never, {
    masterKey,
    liveEnabled: true,
    mainnetAllowed: true,
    builderCode: () => null,
  });

  return {
    runtime,
    store: databaseStore,
    gateway,
    executions: () => executionCount,
    setExecutions: (value: number) => {
      executionCount = value;
    },
  };
}

describe("runtime execution boundaries", () => {
  it("keeps a manual live-mode refresh read-only", async () => {
    const harness = createHarness();

    await harness.runtime.cycle();

    expect(harness.runtime.snapshot.quote).not.toBeNull();
    expect(harness.executions()).toBe(0);
    harness.store.close();
  });

  it("invalidates an in-flight cycle before signing when stopped", async () => {
    const harness = createHarness();
    let entered!: () => void;
    let release!: () => void;
    const atExecution = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const continueExecution = new Promise<void>((resolve) => {
      release = resolve;
    });

    harness.gateway.executeQuote = async (inputs: {
      shouldContinue: () => boolean;
    }) => {
      entered();
      await continueExecution;
      if (!inputs.shouldContinue()) throw new Error("cancelled");
      harness.setExecutions(harness.executions() + 1);
      return { digest: "digest", endpoint: "test" };
    };

    harness.runtime.start();
    await atExecution;
    const stopping = harness.runtime.stop();
    release();
    await stopping;

    expect(harness.executions()).toBe(0);
    expect(harness.runtime.snapshot.running).toBe(false);
    expect(harness.runtime.snapshot.lastError).toBeNull();
    harness.store.close();
  });
});
