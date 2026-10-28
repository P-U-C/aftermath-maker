import { AftermathGateway, type EndpointHealth } from "@puc/aftermath";
import type { Store } from "./store.js";
import { MakerRuntime, type RuntimeOptions } from "./runtime.js";

type GatewayOptions = {
  preferredEndpoint?: string;
  fallbackEndpoint?: string;
};

type GatewayFactory = (options: GatewayOptions) => Promise<AftermathGateway>;

const ENDPOINT_REPROBE_MS = 5 * 60_000;

export class RuntimeManager {
  private gateway: AftermathGateway | null = null;
  private gatewayError: string | null = null;
  private readonly runtimes = new Map<string, MakerRuntime>();
  private endpointTimer: NodeJS.Timeout | null = null;
  private refreshPromise: Promise<void> | null = null;

  constructor(
    private readonly store: Store,
    private readonly runtimeOptions: RuntimeOptions,
    private readonly gatewayOptions: GatewayOptions,
    private readonly gatewayFactory: GatewayFactory = AftermathGateway.create,
  ) {}

  async initialize(): Promise<void> {
    await this.refreshEndpoints();
    this.endpointTimer = setInterval(
      () => void this.refreshEndpoints(),
      ENDPOINT_REPROBE_MS,
    );
    this.endpointTimer.unref();
  }

  async refreshEndpoints(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.performEndpointRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async performEndpointRefresh(): Promise<void> {
    try {
      const gateway = await this.gatewayFactory(this.gatewayOptions);
      this.gateway = gateway;
      this.gatewayError = null;
      for (const runtime of this.runtimes.values()) {
        runtime.replaceGateway(gateway);
      }
    } catch (error) {
      this.gatewayError =
        error instanceof Error ? error.message : String(error);
    }
  }

  close(): void {
    if (this.endpointTimer) clearInterval(this.endpointTimer);
    this.endpointTimer = null;
  }

  private runtimeKey(ownerAddress: string, bundleId: string | null): string {
    return `${ownerAddress.toLowerCase()}:${bundleId ?? "legacy"}`;
  }

  get(ownerAddress: string): MakerRuntime {
    if (!this.gateway) {
      throw new Error(this.gatewayError ?? "Aftermath gateway is unavailable");
    }
    const owner = ownerAddress.toLowerCase();
    const bundleId = this.store.coreRuntimeBundleId(owner);
    const key = this.runtimeKey(owner, bundleId);
    const existing = this.runtimes.get(key);
    if (existing) return existing;
    if (!bundleId) {
      const priorRuntime = [...this.runtimes.entries()].find(([runtimeKey]) =>
        runtimeKey.startsWith(`${owner}:`),
      )?.[1];
      // A logical rollback leaves an already-running runtime in memory. Its
      // tenant projection reads legacy config after rollback, so reuse it rather
      // than creating a second loop for the same wallet.
      if (priorRuntime) return priorRuntime;
    }

    // A wallet can reach the runtime before its first config creates Core. Once
    // Core exists, preserve that runtime object while moving its manager key to
    // the owner-and-bundle form used by B1 and later bundle phases.
    if (bundleId) {
      const legacyKey = this.runtimeKey(owner, null);
      const legacy = this.runtimes.get(legacyKey);
      if (legacy) {
        this.runtimes.delete(legacyKey);
        this.runtimes.set(key, legacy);
        return legacy;
      }
    }

    const runtime = new MakerRuntime(
      bundleId
        ? this.store.forBundle(owner, bundleId)
        : this.store.forTenant(owner),
      this.gateway,
      this.runtimeOptions,
    );
    this.runtimes.set(key, runtime);
    return runtime;
  }

  get activeEndpoint(): string | null {
    return this.gateway?.endpoint ?? null;
  }

  get endpointHealth(): EndpointHealth[] {
    return this.gateway?.endpointHealth ?? [];
  }

  get error(): string | null {
    return this.gatewayError;
  }

  async stopTenant(ownerAddress: string): Promise<boolean> {
    const owner = ownerAddress.toLowerCase();
    const runtimes = [...this.runtimes.entries()]
      .filter(([key]) => key.startsWith(`${owner}:`))
      .map(([, runtime]) => runtime);
    if (!runtimes.length) {
      if (!this.store.listTenantOwners().includes(owner)) return false;
      runtimes.push(this.get(owner));
    }
    await Promise.all(runtimes.map((runtime) => runtime.stop()));
    if (this.gateway) {
      for (const runtime of runtimes) runtime.replaceGateway(this.gateway);
    }
    return true;
  }

  async stopAll(): Promise<
    Array<{ ownerAddress: string; stopped: boolean; error?: string }>
  > {
    const owners = new Set([
      ...this.store.listTenantOwners(),
      ...[...this.runtimes.keys()].map((key) => key.split(":", 1)[0]!),
    ]);
    return Promise.all(
      [...owners].map(async (ownerAddress) => {
        try {
          return {
            ownerAddress,
            stopped: await this.stopTenant(ownerAddress),
          };
        } catch (error) {
          return {
            ownerAddress,
            stopped: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }
}
