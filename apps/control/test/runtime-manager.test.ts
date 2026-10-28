import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AftermathGateway } from "@puc/aftermath";
import { makerConfigSchema } from "@puc/core";
import { RuntimeManager } from "../src/runtime-manager.js";
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
});
