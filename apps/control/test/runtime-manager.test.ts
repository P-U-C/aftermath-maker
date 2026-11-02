import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AftermathGateway } from "@puc/aftermath";
import { makerConfigSchema } from "@puc/core";
import { RuntimeManager } from "../src/runtime-manager.js";
import { MakerRuntime } from "../src/runtime.js";
import { Store } from "../src/store.js";

function gateway(endpoint: string): AftermathGateway {
  return {
    endpoint,
    endpointHealth: [
      {
        url: endpoint,
        preferred: true,
        ok: true,
        chainIdentifier: "mainnet",
        latencyMs: 1,
        error: null,
      },
    ],
  } as unknown as AftermathGateway;
}

function storeHarness() {
  const directory = join(
    process.env.TMPDIR ?? "/tmp",
    `aftermath-maker-manager-${randomBytes(8).toString("hex")}`,
  );
  mkdirSync(directory, { recursive: true });
  return new Store(join(directory, "maker.db"));
}

describe("runtime endpoint management", () => {
  it("re-probes endpoints after startup and adopts a recovered preferred endpoint", async () => {
    const store = storeHarness();
    const factory = vi
      .fn()
      .mockResolvedValueOnce(gateway("https://fallback.example"))
      .mockResolvedValueOnce(gateway("https://preferred.example"));
    const manager = new RuntimeManager(
      store,
      {} as never,
      {
        preferredEndpoint: "https://preferred.example",
        fallbackEndpoint: "https://fallback.example",
      },
      factory,
    );

    await manager.initialize();
    expect(manager.activeEndpoint).toBe("https://fallback.example");
    await manager.refreshEndpoints();
    expect(manager.activeEndpoint).toBe("https://preferred.example");
    expect(factory).toHaveBeenCalledTimes(2);

    manager.close();
    store.close();
  });

  it("keys Core runtime state by owner and bundle while sharing one gateway", async () => {
    const store = storeHarness();
    const ownerAddress = `0x${"1".repeat(64)}`;
    const tenant = store.forTenant(ownerAddress);
    tenant.setConfig(
      makerConfigSchema.parse({
        markets: [{ marketId: "0x1001", symbol: "ONE" }],
      }),
    );
    const coreId = tenant.listBundles()[0]!.id;
    const sharedGateway = gateway("https://shared.example");
    const factory = vi.fn().mockResolvedValue(sharedGateway);
    const manager = new RuntimeManager(store, {} as never, {}, factory);

    await manager.initialize();
    const runtime = manager.get(ownerAddress);
    expect(manager.get(ownerAddress)).toBe(runtime);
    expect(runtime.requireGateway()).toBe(sharedGateway);
    const keys = (manager as unknown as { runtimes: Map<string, unknown> })
      .runtimes;
    expect(keys.has(`${ownerAddress}:${coreId}`)).toBe(true);
    expect(await manager.stopAll()).toEqual([{ ownerAddress, stopped: true }]);

    manager.close();
    store.close();
  });

  it("keeps a bundle without a strategy paused and refuses Start", () => {
    const store = storeHarness();
    const ownerAddress = `0x${"f".repeat(64)}`;
    const tenant = store.forTenant(ownerAddress);
    const bundle = tenant.createAllocatedBundle({
      name: "Draft",
      makerAccountId: null,
      takerAccountId: null,
      mode: "observe",
      markets: [{ marketId: "0xf001", symbol: "DRAFT" }],
      strategyId: null,
    });
    const manager = new RuntimeManager(store, {} as never, {});

    expect(bundle).toMatchObject({ status: "paused", needsStrategy: true });
    expect(() => manager.startBundle(ownerAddress, bundle.id)).toThrow(
      "Attach a strategy",
    );

    manager.close();
    store.close();
  });

  it("reports aggregate use from running bundles before wallet limits change", async () => {
    const store = storeHarness();
    const ownerAddress = `0x${"2".repeat(64)}`;
    const tenant = store.forTenant(ownerAddress);
    const core = makerConfigSchema.parse({
      markets: [{ marketId: "0x2001", symbol: "CORE" }],
    });
    tenant.setConfig(core);
    tenant.confirmWalletLimits();
    const paper = tenant.createBundle({
      name: "Paper",
      config: makerConfigSchema.parse({
        ...core,
        markets: [{ marketId: "0x2002", symbol: "PAPER" }],
        mode: "paper",
      }),
    });
    const coreBundle = tenant
      .listBundles()
      .find((bundle) => bundle.name === "Core")!;
    const manager = new RuntimeManager(
      store,
      {} as never,
      {},
      vi.fn().mockResolvedValue(gateway("https://shared.example")),
    );
    await manager.initialize();
    const runtimeValues = (bundleId: string) =>
      manager.getBundle(ownerAddress, bundleId) as unknown as {
        snapshotValue: {
          portfolio: { grossExposureUsd: number; unrealizedPnlUsd: number };
          balances: { inventoryUsd: number };
          risk: { runDrawdownUsd: number | null };
        };
      };
    const coreRuntime = runtimeValues(coreBundle.id).snapshotValue;
    coreRuntime.portfolio.grossExposureUsd = 12;
    coreRuntime.portfolio.unrealizedPnlUsd = -3;
    coreRuntime.balances.inventoryUsd = -4;
    coreRuntime.risk.runDrawdownUsd = 2;
    const paperRuntime = runtimeValues(paper.id).snapshotValue;
    paperRuntime.portfolio.grossExposureUsd = -5;
    paperRuntime.portfolio.unrealizedPnlUsd = 1;
    paperRuntime.balances.inventoryUsd = 6;
    paperRuntime.risk.runDrawdownUsd = 1;
    tenant.setBundleStatus(coreBundle.id, "running");
    tenant.setBundleStatus(paper.id, "running");

    expect(manager.runningWalletUsage(ownerAddress)).toEqual({
      grossExposureUsd: 17,
      inventoryUsd: 10,
      unrealizedLossUsd: 3,
      runDrawdownUsd: 3,
    });
    manager.close();
    store.close();
  });

  it("starts a second Paper bundle with the same market", async () => {
    const store = storeHarness();
    const ownerAddress = `0x${"6".repeat(64)}`;
    const tenant = store.forTenant(ownerAddress);
    const core = makerConfigSchema.parse({
      markets: [{ marketId: "0x6001", symbol: "NEAR" }],
    });
    tenant.setConfig(core);
    tenant.confirmWalletLimits();
    const duplicate = tenant.createBundle({
      name: "Rewards",
      config: makerConfigSchema.parse({
        ...core,
        mode: "paper",
        makerAccountId: "3",
        hedge: { ...core.hedge, accountId: "4" },
      }),
    });
    const coreBundle = tenant
      .listBundles()
      .find((bundle) => bundle.name === "Core")!;
    tenant.setBundleStatus(coreBundle.id, "running");
    const manager = new RuntimeManager(
      store,
      {} as never,
      {},
      async () =>
        ({
          ...gateway("https://local.test"),
          getOrderbook: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            throw new Error("Deliberately unavailable local test book");
          },
        }) as unknown as AftermathGateway,
    );
    await manager.initialize();
    // No network, signing, broadcast or mainnet Live gate is involved.
    const started = manager.startBundle(ownerAddress, duplicate.id);
    expect(started.bundle.status).toBe("running");
    expect(started.bundle.marketIds).toContain("0x6001");
    await manager.pauseBundle(ownerAddress, duplicate.id);
    manager.close();
    store.close();
  });

  it("still rejects a second running Live overlap in a test-only legacy state", () => {
    const store = storeHarness();
    const owner = `0x${"7".repeat(64)}`;
    const tenant = store.forTenant(owner);
    const config = makerConfigSchema.parse({
      markets: [{ marketId: "0x7001", symbol: "NEAR" }],
    });
    tenant.setConfig(config);
    tenant.confirmWalletLimits();
    const core = tenant.listBundles().find((bundle) => bundle.name === "Core")!;
    const other = tenant.createBundle({
      name: "Rewards",
      config: makerConfigSchema.parse({
        ...config,
        makerAccountId: "3",
        hedge: { ...config.hedge, accountId: "4" },
      }),
    });
    // Live is Core-only in the public API. Seed an impossible legacy collision
    // in a disposable test database to exercise the future fail-closed guard.
    const testDb = (
      store as unknown as {
        db: {
          prepare: (sql: string) => { run: (...args: string[]) => unknown };
        };
      }
    ).db;
    testDb
      .prepare("UPDATE bundles SET mode = 'live' WHERE id IN (?, ?)")
      .run(core.id, other.id);
    tenant.setBundleStatus(core.id, "running");
    expect(() => tenant.assertBundleMarketsAvailableToStart(other.id)).toThrow(
      "NEAR is already quoted live by Core. Only one Live bundle can quote a market.",
    );
    store.close();
  });

  it("does not start a paused bundle outside an edited wallet envelope", async () => {
    const store = storeHarness();
    const ownerAddress = `0x${"5".repeat(64)}`;
    const tenant = store.forTenant(ownerAddress);
    tenant.setConfig(
      makerConfigSchema.parse({
        markets: [{ marketId: "0x5001", symbol: "CORE" }],
        maxRunDrawdownUsd: 100,
        maxInventoryUsd: 100,
        maxGrossExposureUsd: 100,
        maxUnrealizedLossUsd: 100,
      }),
    );
    const core = tenant.listBundles()[0]!;
    tenant.updateWalletLimits({
      maxRunDrawdownUsd: 90,
      maxInventoryUsd: 90,
      maxGrossExposureUsd: 90,
      maxUnrealizedLossUsd: 90,
      usage: {
        runDrawdownUsd: 0,
        inventoryUsd: 0,
        grossExposureUsd: 0,
        unrealizedLossUsd: 0,
      },
    });
    const manager = new RuntimeManager(
      store,
      {} as never,
      {},
      vi.fn().mockResolvedValue(gateway("https://shared.example")),
    );
    await manager.initialize();

    expect(() => manager.startBundle(ownerAddress, core.id)).toThrow(
      "exceeds this wallet's confirmed envelope",
    );
    expect(tenant.getStoredBundle(core.id)?.status).toBe("stopped");
    manager.close();
    store.close();
  });

  it("keeps the last healthy gateway when a later probe fails", async () => {
    const store = storeHarness();
    const factory = vi
      .fn()
      .mockResolvedValueOnce(gateway("https://healthy.example"))
      .mockRejectedValueOnce(new Error("all endpoints unavailable"));
    const manager = new RuntimeManager(store, {} as never, {}, factory);

    await manager.initialize();
    await manager.refreshEndpoints();

    expect(manager.activeEndpoint).toBe("https://healthy.example");
    expect(manager.error).toBe("all endpoints unavailable");
    manager.close();
    store.close();
  });

  it("keeps bundle failures isolated and Stop all available while one bundle is in error", async () => {
    const store = storeHarness();
    const ownerAddress = `0x${"3".repeat(64)}`;
    const tenant = store.forTenant(ownerAddress);
    const core = makerConfigSchema.parse({
      markets: [{ marketId: "0x3001", symbol: "CORE" }],
      maxRunDrawdownUsd: 100,
      maxInventoryUsd: 100,
      maxGrossExposureUsd: 100,
      maxUnrealizedLossUsd: 100,
    });
    tenant.setConfig(core);
    tenant.confirmWalletLimits();
    const paper = tenant.createBundle({
      name: "Paper",
      config: makerConfigSchema.parse({
        ...core,
        markets: [{ marketId: "0x3002", symbol: "PAPER" }],
        mode: "paper",
      }),
    });
    const sharedGateway = gateway("https://shared.example");
    const manager = new RuntimeManager(
      store,
      {
        liveEnabled: false,
        mainnetAllowed: false,
        builderCode: () => null,
      },
      {},
      vi.fn().mockResolvedValue(sharedGateway),
    );

    await manager.initialize();
    const paperRuntime = manager.getBundle(ownerAddress, paper.id);
    paperRuntime.start();
    await paperRuntime.cycle();
    expect(tenant.getStoredBundle(paper.id)).toMatchObject({
      status: "error",
      lastError: expect.stringContaining("paused"),
    });

    const coreId = tenant
      .listBundles()
      .find((bundle) => bundle.name === "Core")!.id;
    tenant.setBundleStatus(coreId, "running");
    expect(await manager.stopTenant(ownerAddress)).toBe(true);
    expect(tenant.getStoredBundle(paper.id)?.status).toBe("stopped");
    expect(tenant.getStoredBundle(coreId)?.status).toBe("stopped");
    manager.close();
    store.close();
  });

  it("starts Paper below the Live cancellation reserve with one simulation budget", async () => {
    const store = storeHarness();
    const ownerAddress = `0x${"4".repeat(64)}`;
    const tenant = store.forTenant(ownerAddress);
    const core = makerConfigSchema.parse({
      markets: [{ marketId: "0x4001", symbol: "CORE" }],
    });
    tenant.setConfig(core);
    tenant.confirmWalletLimits();
    const paper = tenant.createBundle({
      name: "Paper",
      config: makerConfigSchema.parse({
        ...core,
        markets: [{ marketId: "0x4002", symbol: "PAPER" }],
        mode: "paper",
      }),
    });
    const sharedGateway = gateway("https://shared.example");
    const manager = new RuntimeManager(
      store,
      {
        liveEnabled: false,
        mainnetAllowed: false,
        builderCode: () => null,
      },
      {},
      vi.fn().mockResolvedValue(sharedGateway),
    );
    await manager.initialize();
    const coreBundle = tenant
      .listBundles()
      .find((bundle) => bundle.name === "Core")!;
    const coreRuntime = manager.getBundle(ownerAddress, coreBundle.id);
    (
      coreRuntime as unknown as {
        snapshotValue: { balances: { gasSui: number | null } };
      }
    ).snapshotValue.balances.gasSui = 0.1;
    tenant.setBundleStatus(coreBundle.id, "running");
    // Isolate admission from the mock gateway's intentionally absent quote RPC.
    const paperRuntime = manager.getBundle(ownerAddress, paper.id);
    vi.spyOn(paperRuntime, "start").mockImplementation(() => {});

    expect(manager.startBundle(ownerAddress, paper.id).bundle.status).toBe(
      "running",
    );
    const trial = vi
      .spyOn(MakerRuntime.prototype, "runPaperTrial")
      .mockResolvedValue({} as never);
    try {
      await expect(
        manager.runPaperTrial({ ownerAddress, cadenceMs: 2000 }),
      ).resolves.toBeDefined();
      expect(trial).toHaveBeenCalledTimes(1);
    } finally {
      trial.mockRestore();
      manager.close();
      store.close();
    }
  });

  it("uses one simulation budget for a stopped Live-configured Core Paper trial", async () => {
    const store = storeHarness();
    const owner = `0x${"b".repeat(64)}`;
    const tenant = store.forTenant(owner);
    tenant.setConfig(
      makerConfigSchema.parse({
        mode: "live",
        maxGasMist: 50_000_000,
        markets: [{ marketId: "0xb001", symbol: "CORE" }],
      }),
    );
    const core = tenant.listBundles()[0]!;
    const manager = new RuntimeManager(
      store,
      {} as never,
      {},
      vi.fn().mockResolvedValue(gateway("https://test.example")),
    );
    await manager.initialize();
    const runtime = manager.getBundle(owner, core.id) as unknown as {
      snapshotValue: { balances: { gasSui: number | null } };
    };
    runtime.snapshotValue.balances.gasSui = 0.08;
    const trial = vi
      .spyOn(MakerRuntime.prototype, "runPaperTrial")
      .mockResolvedValue({} as never);
    try {
      await expect(
        manager.runPaperTrial({ ownerAddress: owner, cadenceMs: 2000 }),
      ).resolves.toBeDefined();
      expect(trial).toHaveBeenCalledTimes(1);
    } finally {
      trial.mockRestore();
      manager.close();
      store.close();
    }
  });

  it("requires the unchanged cancellation reserve for Live and names the trading key", async () => {
    const store = storeHarness();
    const owner = `0x${"8".repeat(64)}`;
    const agent = `0x${"9".repeat(64)}`;
    const tenant = store.forTenant(owner);
    tenant.setConfig(
      makerConfigSchema.parse({
        mode: "live",
        maxGasMist: 50_000_000,
        markets: [{ marketId: "0x8001", symbol: "CORE" }],
      }),
    );
    const core = tenant.listBundles()[0]!;
    const manager = new RuntimeManager(
      store,
      {} as never,
      {},
      vi.fn().mockResolvedValue(gateway("https://test.example")),
    );
    await manager.initialize();
    const runtime = manager.getBundle(owner, core.id) as unknown as {
      snapshotValue: {
        agentAddress: string | null;
        balances: { gasSui: number | null };
      };
    };
    runtime.snapshotValue.agentAddress = agent;
    runtime.snapshotValue.balances.gasSui = 0.08;
    expect(() =>
      (
        manager as unknown as {
          assertStartGasReserve: (
            owner: string,
            bundle: typeof core,
            runtime: unknown,
          ) => void;
        }
      ).assertStartGasReserve(owner, core, runtime),
    ).toThrowError(
      expect.objectContaining({
        code: "gas-reserve-low",
        fix: { kind: "copy", value: agent },
        message: expect.stringContaining(
          "0.08 SUI for gas and needs at least 0.25 SUI",
        ),
      }),
    );
    manager.close();
    store.close();
  });

  it("reserves for the running Live bundle, not the new Paper bundle", async () => {
    const store = storeHarness();
    const owner = `0x${"a".repeat(64)}`;
    const tenant = store.forTenant(owner);
    const coreConfig = makerConfigSchema.parse({
      mode: "live",
      maxGasMist: 50_000_000,
      markets: [{ marketId: "0xa001", symbol: "CORE" }],
    });
    tenant.setConfig(coreConfig);
    tenant.confirmWalletLimits();
    const core = tenant.listBundles()[0]!;
    const paper = tenant.createBundle({
      name: "Paper",
      config: makerConfigSchema.parse({
        ...coreConfig,
        mode: "paper",
        markets: [{ marketId: "0xa002", symbol: "PAPER" }],
      }),
    });
    tenant.setBundleStatus(core.id, "running");
    const manager = new RuntimeManager(
      store,
      {} as never,
      {},
      vi.fn().mockResolvedValue(gateway("https://test.example")),
    );
    await manager.initialize();
    const coreRuntime = manager.getBundle(owner, core.id) as unknown as {
      snapshotValue: { balances: { gasSui: number | null } };
    };
    const paperRuntime = manager.getBundle(owner, paper.id) as unknown as {
      snapshotValue: { balances: { gasSui: number | null } };
    };
    coreRuntime.snapshotValue.balances.gasSui = 0.3;
    paperRuntime.snapshotValue.balances.gasSui = 0.3;
    expect(() =>
      (
        manager as unknown as {
          assertStartGasReserve: (
            owner: string,
            bundle: typeof paper,
            runtime: unknown,
          ) => void;
        }
      ).assertStartGasReserve(owner, paper, paperRuntime),
    ).not.toThrow();
    manager.close();
    store.close();
  });

  it("does not count retained order attribution as a cancellation reserve", async () => {
    const store = storeHarness();
    const ownerAddress = `0x${"7".repeat(64)}`;
    const tenant = store.forTenant(ownerAddress);
    const config = makerConfigSchema.parse({
      markets: [{ marketId: "0x7001", symbol: "CORE" }],
      maxGasMist: 50_000_000,
      rotationMode: "single-slot",
    });
    tenant.setConfig(config);
    tenant.trackMakerOrders({
      accountId: "7",
      marketId: "0x7001",
      quoteDigest: "history",
      orderIds: Array.from({ length: 100 }, (_, index) => `old-${index}`),
    });
    const core = tenant.listBundles()[0]!;
    const manager = new RuntimeManager(
      store,
      {} as never,
      {},
      vi.fn().mockResolvedValue(gateway("https://shared.example")),
    );
    await manager.initialize();
    const runtime = manager.getBundle(ownerAddress, core.id) as unknown as {
      snapshotValue: { balances: { gasSui: number | null } };
    };
    runtime.snapshotValue.balances.gasSui = 0.3;

    expect(() =>
      (
        manager as unknown as {
          assertStartGasReserve: (
            owner: string,
            bundle: typeof core,
            candidateRuntime: unknown,
          ) => void;
        }
      ).assertStartGasReserve(ownerAddress, core, runtime),
    ).not.toThrow();

    manager.close();
    store.close();
  });
});
