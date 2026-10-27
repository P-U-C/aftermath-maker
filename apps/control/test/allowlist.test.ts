import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OnchainAllowlist } from "../src/allowlist.js";
import { Store } from "../src/store.js";

const operator = `0x${"1".repeat(64)}`;
const attacker = `0x${"2".repeat(64)}`;
const packageId = `0x${"a".repeat(64)}`;
const registryId = `0x${"b".repeat(64)}`;
const adminCapId = `0x${"c".repeat(64)}`;

function harness(sender = operator, adminOwner = operator) {
  const directory = join(
    process.env.TMPDIR ?? "/tmp",
    `aftermath-maker-allowlist-${randomBytes(8).toString("hex")}`,
  );
  mkdirSync(directory, { recursive: true });
  const store = new Store(join(directory, "maker.db"));
  const client = {
    waitForTransaction: async () => ({
      $kind: "Transaction",
      Transaction: {
        transaction: { sender },
        effects: {
          changedObjects: [
            {
              objectId: registryId,
              idOperation: "Created",
              outputState: "ObjectWrite",
              outputOwner: {
                $kind: "Shared",
                Shared: { initialSharedVersion: "1" },
              },
            },
            {
              objectId: adminCapId,
              idOperation: "Created",
              outputState: "ObjectWrite",
              outputOwner: { $kind: "AddressOwner", AddressOwner: adminOwner },
            },
          ],
        },
        objectTypes: {
          [registryId]: `${packageId}::access::Registry`,
          [adminCapId]: `${packageId}::access::AdminCap`,
        },
      },
    }),
    getObject: async () => ({
      object: {
        type: `${packageId}::access::Registry`,
        version: "1",
        json: { members: [operator] },
      },
    }),
  };
  return {
    store,
    allowlist: new OnchainAllowlist(client as never, store, 0),
  };
}

describe("on-chain allowlist confirmation", () => {
  it("binds a deployment digest to the operator signer and AdminCap owner", async () => {
    const { store, allowlist } = harness();

    await expect(
      allowlist.confirmDeployment("digest", operator),
    ).resolves.toEqual({
      packageId,
      registryObjectId: registryId,
      adminCapId,
    });
    expect(store.getRegistryObjectId()).toBe(registryId);
    store.close();
  });

  it("rejects a deployment signed by another wallet", async () => {
    const { store, allowlist } = harness(attacker, operator);

    await expect(
      allowlist.confirmDeployment("digest", operator),
    ).rejects.toThrow("signed by another wallet");
    expect(store.getRegistryObjectId()).toBeNull();
    store.close();
  });

  it("rejects a deployment whose AdminCap belongs to another wallet", async () => {
    const { store, allowlist } = harness(operator, attacker);

    await expect(
      allowlist.confirmDeployment("digest", operator),
    ).rejects.toThrow("AdminCap was not assigned to the operator");
    expect(store.getRegistryObjectId()).toBeNull();
    store.close();
  });
});
