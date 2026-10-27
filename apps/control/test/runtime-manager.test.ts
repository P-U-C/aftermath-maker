import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AftermathGateway } from "@puc/aftermath";
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
