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

  get(ownerAddress: string): MakerRuntime {
    if (!this.gateway) {
      throw new Error(this.gatewayError ?? "Aftermath gateway is unavailable");
    }
    const key = ownerAddress.toLowerCase();
    const existing = this.runtimes.get(key);
    if (existing) return existing;
    const runtime = new MakerRuntime(
      this.store.forTenant(key),
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
    const key = ownerAddress.toLowerCase();
    let runtime = this.runtimes.get(key);
    if (!runtime) {
      if (!this.store.listTenantOwners().includes(key)) return false;
      runtime = this.get(key);
    }
    await runtime.stop();
    if (this.gateway) runtime.replaceGateway(this.gateway);
    return true;
  }

  async stopAll(): Promise<
    Array<{ ownerAddress: string; stopped: boolean; error?: string }>
  > {
    const owners = new Set([
      ...this.store.listTenantOwners(),
      ...this.runtimes.keys(),
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
