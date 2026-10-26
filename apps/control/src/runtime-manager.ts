import { AftermathGateway, type EndpointHealth } from "@puc/aftermath";
import type { Store } from "./store.js";
import { MakerRuntime, type RuntimeOptions } from "./runtime.js";

type GatewayOptions = {
  preferredEndpoint?: string;
  fallbackEndpoint?: string;
};

export class RuntimeManager {
  private gateway: AftermathGateway | null = null;
  private gatewayError: string | null = null;
  private readonly runtimes = new Map<string, MakerRuntime>();

  constructor(
    private readonly store: Store,
    private readonly runtimeOptions: RuntimeOptions,
    private readonly gatewayOptions: GatewayOptions,
  ) {}

  async initialize(): Promise<void> {
    try {
      this.gateway = await AftermathGateway.create(this.gatewayOptions);
      this.gatewayError = null;
    } catch (error) {
      this.gatewayError =
        error instanceof Error ? error.message : String(error);
    }
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

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.runtimes.values()].map((runtime) => runtime.stop()),
    );
  }
}
