import { AftermathGateway, type EndpointHealth } from "@puc/aftermath";
import type { MakerConfig, RuntimeSnapshot } from "@puc/core";
import {
  admitBundleProposals,
  calculateBundleGasReserveMist,
  hasBundleGasReserve,
} from "./bundle-supervisor.js";
import type { Store, StoredBundle } from "./store.js";
import { MakerRuntime, type RuntimeOptions } from "./runtime.js";

type GatewayOptions = {
  preferredEndpoint?: string;
  fallbackEndpoint?: string;
};

type GatewayFactory = (options: GatewayOptions) => Promise<AftermathGateway>;

const ENDPOINT_REPROBE_MS = 5 * 60_000;

const publicBundleError =
  "Bundle paused after a cycle error. Review its accounts and limits, then resume it manually.";

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

  private requireGateway(): AftermathGateway {
    if (!this.gateway) {
      throw new Error(this.gatewayError ?? "Aftermath gateway is unavailable");
    }
    return this.gateway;
  }

  private createBundleRuntime(
    ownerAddress: string,
    bundle: StoredBundle,
  ): MakerRuntime {
    const owner = ownerAddress.toLowerCase();
    const key = this.runtimeKey(owner, bundle.id);
    const existing = this.runtimes.get(key);
    if (existing) return existing;
    const runtime = new MakerRuntime(
      this.store.forBundle(owner, bundle.id),
      this.requireGateway(),
      {
        ...this.runtimeOptions,
        pauseOnError: true,
        onBundleError: () => {
          this.store
            .forTenant(owner)
            .setBundleStatus(bundle.id, "error", publicBundleError);
        },
        admitBundleProposal: (proposal) =>
          this.admitBundleProposal(owner, bundle.id, proposal),
      },
    );
    this.runtimes.set(key, runtime);
    return runtime;
  }

  getBundle(ownerAddress: string, bundleId: string): MakerRuntime {
    const owner = ownerAddress.toLowerCase();
    const bundle = this.store.forTenant(owner).getStoredBundle(bundleId);
    if (!bundle || bundle.archivedAt) {
      throw new Error("Bundle was not found for this wallet");
    }
    return this.createBundleRuntime(owner, bundle);
  }

  get(ownerAddress: string): MakerRuntime {
    const owner = ownerAddress.toLowerCase();
    const bundleId = this.store.coreRuntimeBundleId(owner);
    if (bundleId) return this.getBundle(owner, bundleId);

    const legacyKey = this.runtimeKey(owner, null);
    const existing = this.runtimes.get(legacyKey);
    if (existing) return existing;
    const priorRuntime = [...this.runtimes.entries()].find(([runtimeKey]) =>
      runtimeKey.startsWith(`${owner}:`),
    )?.[1];
    // A logical rollback leaves an already-running runtime in memory. Its tenant
    // projection reads the legacy config after rollback, so reuse it rather than
    // creating a second loop for the same wallet.
    if (priorRuntime) return priorRuntime;
    const runtime = new MakerRuntime(
      this.store.forTenant(owner),
      this.requireGateway(),
      this.runtimeOptions,
    );
    this.runtimes.set(legacyKey, runtime);
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

  bundleSnapshots(ownerAddress: string): Array<{
    bundle: StoredBundle;
    snapshot: RuntimeSnapshot | null;
  }> {
    const owner = ownerAddress.toLowerCase();
    return this.store
      .forTenant(owner)
      .listBundles()
      .filter((bundle) => !bundle.archivedAt)
      .map((bundle) => {
        const runtime = this.runtimes.get(this.runtimeKey(owner, bundle.id));
        return { bundle, snapshot: runtime?.snapshot ?? null };
      });
  }

  private assertStartAllowed(
    ownerAddress: string,
    bundle: StoredBundle,
  ): MakerConfig {
    const tenant = this.store.forTenant(ownerAddress);
    const config = tenant.getBundleConfig(bundle.id);
    if (!config) throw new Error("Bundle was not found");
    if (bundle.archivedAt) throw new Error("Bundle was archived");
    if (config.mode === "live") {
      if (bundle.name !== "Core") {
        throw new Error("Only Core can use Live mode");
      }
      const liveOutsideCore = tenant
        .listBundles()
        .some(
          (candidate) =>
            candidate.id !== bundle.id &&
            !candidate.archivedAt &&
            candidate.mode === "live",
        );
      if (liveOutsideCore) {
        throw new Error("Live mode requires Core to be the only Live bundle");
      }
    }
    return config;
  }

  private assertStartGasReserve(
    ownerAddress: string,
    candidate: StoredBundle,
    candidateRuntime: MakerRuntime,
  ): void {
    const tenant = this.store.forTenant(ownerAddress);
    const active = tenant
      .listBundles()
      .filter(
        (bundle) =>
          !bundle.archivedAt &&
          (bundle.status === "running" || bundle.id === candidate.id),
      );
    const configs = active.flatMap((bundle) => {
      const config = tenant.getBundleConfig(bundle.id);
      return config ? [config] : [];
    });
    if (!configs.length) return;
    const conservativeGasMist = Math.max(
      ...configs.map((config) => config.maxGasMist),
    );
    const restingOrderCount = active.reduce(
      (total, bundle) => total + tenant.countTrackedMakerOrders(bundle.id),
      0,
    );
    const requiredGasMist = calculateBundleGasReserveMist({
      cancelGasEstimateMist: conservativeGasMist,
      hedgeGasBufferMist: conservativeGasMist,
      fixedSafetyBufferMist: conservativeGasMist,
      runningBundleCount: active.length,
      restingOrderCount,
    });
    const observedGasMist = [
      candidateRuntime.snapshot.balances.gasSui,
      ...active
        .filter((bundle) => bundle.id !== candidate.id)
        .map(
          (bundle) =>
            this.runtimes.get(this.runtimeKey(ownerAddress, bundle.id))
              ?.snapshot.balances.gasSui ?? null,
        ),
    ]
      .filter((gasSui): gasSui is number => gasSui !== null)
      .map((gasSui) => Math.floor(gasSui * 1_000_000_000));
    if (!observedGasMist.length) return;
    if (
      !hasBundleGasReserve({
        availableGasMist: Math.min(...observedGasMist),
        requiredGasMist,
      })
    ) {
      throw new Error("Wallet gas reserve is too low to start this bundle");
    }
  }

  private admitBundleProposal(
    ownerAddress: string,
    bundleId: string,
    proposal: {
      worstCaseGrossExposureDeltaUsd: number;
      worstCaseInventoryDeltaUsd: number;
      worstCaseUnrealizedLossDeltaUsd: number;
      worstCaseRunDrawdownDeltaUsd: number;
    },
  ): { accepted: boolean; reason: string | null } {
    const tenant = this.store.forTenant(ownerAddress);
    const running = tenant
      .listBundles()
      .filter((bundle) => !bundle.archivedAt && bundle.status === "running");
    // Preserve the current single-Core decision path byte-for-byte. Aggregate
    // admission only becomes relevant once another bundle is actually running.
    if (running.length < 2) return { accepted: true, reason: null };
    const walletLimits = tenant.getWalletLimits();
    if (!walletLimits) {
      return { accepted: false, reason: "Wallet limits are unavailable" };
    }
    const observations = running.map((bundle) => {
      const runtime = this.runtimes.get(
        this.runtimeKey(ownerAddress, bundle.id),
      );
      const snapshot = runtime?.snapshot;
      return {
        bundleId: bundle.id,
        grossExposureUsd: snapshot?.portfolio.grossExposureUsd ?? 0,
        inventoryUsd: snapshot?.balances.inventoryUsd ?? 0,
        unrealizedLossUsd: Math.max(
          0,
          -(snapshot?.portfolio.unrealizedPnlUsd ?? 0),
        ),
        runDrawdownUsd: snapshot?.risk.runDrawdownUsd ?? 0,
      };
    });
    return (
      admitBundleProposals({
        walletLimits,
        observations,
        proposals: [{ bundleId, ...proposal }],
      })[0] ?? { accepted: false, reason: "Wallet limits are unavailable" }
    );
  }

  startBundle(
    ownerAddress: string,
    bundleId: string,
  ): {
    bundle: StoredBundle;
    snapshot: RuntimeSnapshot;
  } {
    const owner = ownerAddress.toLowerCase();
    const tenant = this.store.forTenant(owner);
    const bundle = tenant.getStoredBundle(bundleId);
    if (!bundle || bundle.archivedAt) throw new Error("Bundle was not found");
    this.assertStartAllowed(owner, bundle);
    const runtime = this.getBundle(owner, bundle.id);
    try {
      this.assertStartGasReserve(owner, bundle, runtime);
      tenant.setBundleStatus(bundle.id, "running");
      runtime.start();
      return {
        bundle: tenant.getStoredBundle(bundle.id)!,
        snapshot: runtime.snapshot,
      };
    } catch (error) {
      tenant.setBundleStatus(bundle.id, "paused");
      throw error;
    }
  }

  async pauseBundle(
    ownerAddress: string,
    bundleId: string,
  ): Promise<{
    bundle: StoredBundle;
    snapshot: RuntimeSnapshot;
  }> {
    const owner = ownerAddress.toLowerCase();
    const tenant = this.store.forTenant(owner);
    const bundle = tenant.getStoredBundle(bundleId);
    if (!bundle || bundle.archivedAt) throw new Error("Bundle was not found");
    const runtime = this.getBundle(owner, bundle.id);
    await runtime.stop();
    return {
      bundle: tenant.setBundleStatus(bundle.id, "paused"),
      snapshot: runtime.snapshot,
    };
  }

  async archiveBundle(
    ownerAddress: string,
    bundleId: string,
  ): Promise<StoredBundle> {
    const owner = ownerAddress.toLowerCase();
    const tenant = this.store.forTenant(owner);
    const bundle = tenant.getStoredBundle(bundleId);
    if (!bundle || bundle.archivedAt) throw new Error("Bundle was not found");
    const runtime = this.runtimes.get(this.runtimeKey(owner, bundle.id));
    if (runtime) await runtime.stop();
    const archived = tenant.archiveBundle(bundle.id);
    this.runtimes.delete(this.runtimeKey(owner, bundle.id));
    return archived;
  }

  async reconfigureBundle(inputs: {
    ownerAddress: string;
    bundleId: string;
    config: MakerConfig;
    expectedUpdatedAt?: string;
  }): Promise<StoredBundle> {
    const owner = inputs.ownerAddress.toLowerCase();
    const tenant = this.store.forTenant(owner);
    const updated = tenant.updateBundleConfig({
      bundleId: inputs.bundleId,
      config: inputs.config,
      ...(inputs.expectedUpdatedAt
        ? { expectedUpdatedAt: inputs.expectedUpdatedAt }
        : {}),
    });
    const runtime = this.runtimes.get(this.runtimeKey(owner, inputs.bundleId));
    if (runtime) await runtime.reconfigure();
    return updated;
  }

  async stopTenant(ownerAddress: string): Promise<boolean> {
    const owner = ownerAddress.toLowerCase();
    const tenant = this.store.forTenant(owner);
    const bundles = tenant
      .listBundles()
      .filter((bundle) => !bundle.archivedAt && bundle.status !== "stopped");
    const runtimes = new Map<string, MakerRuntime>();
    for (const bundle of bundles) {
      runtimes.set(
        bundle.id,
        this.runtimes.get(this.runtimeKey(owner, bundle.id)) ??
          this.getBundle(owner, bundle.id),
      );
    }
    for (const [key, runtime] of this.runtimes.entries()) {
      if (key.startsWith(`${owner}:`)) runtimes.set(key, runtime);
    }
    if (!runtimes.size) {
      if (!this.store.listTenantOwners().includes(owner)) return false;
      const core = tenant.getStoredBundle(
        this.store.coreRuntimeBundleId(owner) ?? "",
      );
      if (core && !core.archivedAt)
        runtimes.set(core.id, this.getBundle(owner, core.id));
      else runtimes.set("legacy", this.get(owner));
    }

    await Promise.all([...runtimes.values()].map((runtime) => runtime.stop()));
    for (const bundle of tenant
      .listBundles()
      .filter((bundle) => !bundle.archivedAt && bundle.status !== "stopped")) {
      tenant.setBundleStatus(bundle.id, "stopped");
    }
    if (this.gateway) {
      for (const runtime of runtimes.values())
        runtime.replaceGateway(this.gateway);
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
