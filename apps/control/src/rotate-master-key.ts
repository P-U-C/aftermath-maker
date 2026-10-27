import {
  agentEncryptionContext,
  encryptSecret,
  loadAgentKeypair,
  masterKeyId,
} from "@puc/aftermath";
import { Store } from "./store.js";

const databasePath = process.env.DATABASE_PATH ?? "data/maker.db";
const oldMasterKey = process.env.OLD_MAKER_MASTER_KEY;
const newMasterKey = process.env.NEW_MAKER_MASTER_KEY;

if (!oldMasterKey || !newMasterKey) {
  throw new Error("OLD_MAKER_MASTER_KEY and NEW_MAKER_MASTER_KEY are required");
}
const oldKeyId = masterKeyId(oldMasterKey);
const newKeyId = masterKeyId(newMasterKey);
if (oldKeyId === newKeyId) {
  throw new Error("Old and new master keys are identical");
}

const store = new Store(databasePath);
try {
  const updates = store.listTenantOwners().flatMap((ownerAddress) => {
    const tenant = store.forTenant(ownerAddress);
    const agent = tenant.getAgent();
    if (!agent) return [];

    const accountId =
      agent.encryptionContext.match(/^account:(\d+)$/)?.[1] ??
      agent.encryptionContext.match(/^agent-v2:.*:(\d+)$/)?.[1] ??
      tenant.listAccountSetups()[0]?.accountId;
    if (!accountId) {
      throw new Error(
        `Cannot determine the encryption anchor account for ${ownerAddress}`,
      );
    }

    const keypair = loadAgentKeypair({
      masterKey: oldMasterKey,
      context: agent.encryptionContext,
      encryptedSecret: agent.encryptedSecret,
    });
    if (keypair.toSuiAddress() !== agent.address) {
      throw new Error(
        `Decrypted signer does not match the stored agent for ${ownerAddress}`,
      );
    }
    const encryptionContext = agentEncryptionContext({
      ownerAddress,
      agentAddress: agent.address,
      accountId,
    });
    return [
      {
        ownerAddress,
        address: agent.address,
        encryptionContext,
        encryptedSecret: encryptSecret(
          keypair.getSecretKey(),
          newMasterKey,
          encryptionContext,
        ),
      },
    ];
  });

  store.rotateAgentEncryptions(updates);
  process.stdout.write(
    `${JSON.stringify({
      rotatedAgents: updates.length,
      oldKeyId,
      newKeyId,
    })}\n`,
  );
} finally {
  store.close();
}
