import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

type EncryptedSecretBase = {
  algorithm: "aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

export type EncryptedSecret =
  | (EncryptedSecretBase & { version: 1 })
  | (EncryptedSecretBase & { version: 2; keyId: string });

function decodeMasterKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("MAKER_MASTER_KEY must be exactly 32 random base64 bytes");
  }
  return key;
}

export function masterKeyId(masterKey: string): string {
  return createHash("sha256")
    .update(decodeMasterKey(masterKey))
    .digest("hex")
    .slice(0, 16);
}

export function agentEncryptionContext(inputs: {
  ownerAddress: string;
  agentAddress: string;
  accountId: string;
}): string {
  return [
    "agent-v2",
    inputs.ownerAddress.toLowerCase(),
    inputs.agentAddress.toLowerCase(),
    inputs.accountId,
  ].join(":");
}

function deriveKey(
  masterKey: string,
  salt: Buffer,
  version: EncryptedSecret["version"],
): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      decodeMasterKey(masterKey),
      salt,
      Buffer.from(
        version === 1
          ? "puc-aftermath-maker-agent-v1"
          : "puc-aftermath-maker-agent-v2",
      ),
      32,
    ),
  );
}

export function encryptSecret(
  plaintext: string,
  masterKey: string,
  context: string,
): EncryptedSecret {
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = deriveKey(masterKey, salt, 2);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  key.fill(0);

  return {
    version: 2,
    algorithm: "aes-256-gcm",
    keyId: masterKeyId(masterKey),
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptSecret(
  envelope: EncryptedSecret,
  masterKey: string,
  context: string,
): string {
  if (
    ![1, 2].includes(envelope.version) ||
    envelope.algorithm !== "aes-256-gcm"
  ) {
    throw new Error("Unsupported encrypted signer format");
  }
  if (envelope.version === 2 && envelope.keyId !== masterKeyId(masterKey)) {
    throw new Error(
      `Signer is encrypted with key ${envelope.keyId}, not the supplied master key`,
    );
  }

  const salt = Buffer.from(envelope.salt, "base64");
  const key = deriveKey(masterKey, salt, envelope.version);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  key.fill(0);
  return plaintext;
}

export function createEncryptedAgent(inputs: {
  masterKey: string;
  context: string | ((agentAddress: string) => string);
}): {
  address: string;
  encryptedSecret: EncryptedSecret;
  encryptionContext: string;
} {
  const keypair = Ed25519Keypair.generate();
  const address = keypair.toSuiAddress();
  const encryptionContext =
    typeof inputs.context === "function"
      ? inputs.context(address)
      : inputs.context;
  return {
    address,
    encryptionContext,
    encryptedSecret: encryptSecret(
      keypair.getSecretKey(),
      inputs.masterKey,
      encryptionContext,
    ),
  };
}

export function loadAgentKeypair(inputs: {
  masterKey: string;
  context: string;
  encryptedSecret: EncryptedSecret;
}): Ed25519Keypair {
  const secret = decryptSecret(
    inputs.encryptedSecret,
    inputs.masterKey,
    inputs.context,
  );
  return Ed25519Keypair.fromSecretKey(secret);
}
