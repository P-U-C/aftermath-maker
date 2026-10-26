import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import type { Store } from "./store.js";

const SUI_ADDRESS = /^0x[0-9a-fA-F]{64}$/;

function normalizeAddress(address: string): string {
  if (!SUI_ADDRESS.test(address)) throw new Error("Invalid Sui address");
  return address.toLowerCase();
}

function memberList(json: Record<string, unknown>): string[] {
  const raw = json.members;
  const members = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? (raw as Record<string, unknown>).contents
      : null;
  if (!Array.isArray(members)) {
    throw new Error("Whitelist registry has an unexpected member layout");
  }
  return members.map((member) => normalizeAddress(String(member)));
}

export type AllowlistDeployment = {
  packageId: string;
  registryObjectId: string;
  adminCapId: string;
};

export class OnchainAllowlist {
  private cached:
    | { objectId: string; version: string; members: Set<string>; at: number }
    | undefined;

  constructor(
    private readonly client: SuiGrpcClient,
    private readonly store: Store,
    private readonly cacheMs = 30_000,
  ) {}

  get configured(): boolean {
    return Boolean(this.store.getRegistryObjectId());
  }

  async isAllowed(address: string, force = false): Promise<boolean> {
    const objectId = this.store.getRegistryObjectId();
    if (!objectId) return false;
    const normalized = normalizeAddress(address);
    if (
      !force &&
      this.cached?.objectId === objectId &&
      Date.now() - this.cached.at < this.cacheMs
    ) {
      return this.cached.members.has(normalized);
    }

    const response = await this.client.getObject({
      objectId,
      include: { json: true },
    });
    if (!response.object.type.endsWith("::access::Registry")) {
      throw new Error("Configured whitelist object is not a Maker registry");
    }
    if (!response.object.json) {
      throw new Error("Whitelist registry did not return structured content");
    }
    const members = new Set(memberList(response.object.json));
    this.cached = {
      objectId,
      version: response.object.version,
      members,
      at: Date.now(),
    };
    return members.has(normalized);
  }

  clearCache(): void {
    this.cached = undefined;
  }

  async confirmDeployment(
    digest: string,
    expectedOperator: string,
  ): Promise<AllowlistDeployment> {
    const result = await this.client.waitForTransaction({
      digest,
      timeout: 60_000,
      include: { effects: true, objectTypes: true },
    });
    if (result.$kind === "FailedTransaction") {
      throw new Error(
        result.FailedTransaction.status.error?.message ??
          "Whitelist deployment failed",
      );
    }

    const transaction = result.Transaction;
    const types = transaction.objectTypes;
    const created =
      transaction.effects?.changedObjects.filter(
        (object) =>
          object.idOperation === "Created" &&
          object.outputState === "ObjectWrite",
      ) ?? [];

    const registry = created.find((object) =>
      types?.[object.objectId]?.endsWith("::access::Registry"),
    );
    const adminCap = created.find((object) =>
      types?.[object.objectId]?.endsWith("::access::AdminCap"),
    );
    const registryType = registry ? types?.[registry.objectId] : undefined;
    if (!registry || !adminCap || !registryType) {
      throw new Error("Deployment did not create the expected access objects");
    }

    const packageId = registryType.split("::")[0];
    if (!packageId) throw new Error("Registry package ID was not found");
    const deployment = {
      packageId,
      registryObjectId: registry.objectId,
      adminCapId: adminCap.objectId,
    };
    this.store.setRegistryObjectId(deployment.registryObjectId);
    this.store.setSystemSetting("whitelist_package_id", packageId);
    this.store.setSystemSetting("whitelist_admin_cap_id", adminCap.objectId);
    this.clearCache();

    if (!(await this.isAllowed(expectedOperator, true))) {
      throw new Error("Registry deployed, but the operator is not a member");
    }
    return deployment;
  }

  buildMembershipTransaction(inputs: {
    operatorAddress: string;
    memberAddress: string;
    action: "add" | "remove";
  }): Promise<string> {
    const packageId = this.getRequiredSetting("whitelist_package_id");
    const registryId = this.getRequiredSetting("whitelist_registry_object_id");
    const adminCapId = this.getRequiredSetting("whitelist_admin_cap_id");
    const tx = new Transaction();
    tx.moveCall({
      target: `${packageId}::access::${inputs.action}`,
      arguments: [
        tx.object(adminCapId),
        tx.object(registryId),
        tx.pure.address(normalizeAddress(inputs.memberAddress)),
      ],
    });
    tx.setSender(normalizeAddress(inputs.operatorAddress));
    return tx.toJSON();
  }

  private getRequiredSetting(key: string): string {
    if (key === "whitelist_registry_object_id") {
      const value = this.store.getRegistryObjectId();
      if (value) return value;
    }
    const value = this.store.getSystemValue<string>(key);
    if (!value) throw new Error(`${key} is not configured`);
    return value;
  }
}
