import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

export type EncryptedSecret = {
  version: 1;
  algorithm: "aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

function decodeMasterKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("MAKER_MASTER_KEY must be exactly 32 random base64 bytes");
  }
  return key;
}

function deriveKey(masterKey: string, salt: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      decodeMasterKey(masterKey),
      salt,
      Buffer.from("puc-aftermath-maker-agent-v1"),
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
  const key = deriveKey(masterKey, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  key.fill(0);

  return {
    version: 1,
    algorithm: "aes-256-gcm",
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
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported encrypted signer format");
  }

  const salt = Buffer.from(envelope.salt, "base64");
  const key = deriveKey(masterKey, salt);
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
  context: string;
}): { address: string; encryptedSecret: EncryptedSecret } {
  const keypair = Ed25519Keypair.generate();
  return {
    address: keypair.toSuiAddress(),
    encryptedSecret: encryptSecret(
      keypair.getSecretKey(),
      inputs.masterKey,
      inputs.context,
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
