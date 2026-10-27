import fs from "node:fs";
import crypto from "node:crypto";
import { request } from "playwright-core";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const mode = process.env.TRIAL_MODE ?? "paper";
if (mode !== "paper" && mode !== "live") {
  throw new Error("TRIAL_MODE must be paper or live");
}
if (mode === "live" && process.env.RUN_MAINNET_CANARY !== "I_UNDERSTAND") {
  throw new Error("Set RUN_MAINNET_CANARY=I_UNDERSTAND for a Live trial");
}

const baseUrl =
  process.env.MAKER_BASE_URL ?? "https://maker.permanentupperclass.com";
const encryptedPath =
  process.env.AUDIT_WALLET_PATH ??
  process.env.HOME + "/.config/aftermath-maker/audit-owner-20261027.json.enc";
const keyPath =
  process.env.AUDIT_WALLET_KEY_PATH ??
  process.env.HOME + "/.codex/secrets/aftermath-maker/audit-owner-20261027.key";

const encrypted = JSON.parse(fs.readFileSync(encryptedPath, "utf8"));
const key = fs.readFileSync(keyPath);
const decipher = crypto.createDecipheriv(
  encrypted.cipher,
  key,
  Buffer.from(encrypted.iv, "base64"),
);
decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
const wallet = JSON.parse(
  Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]),
);
const signer = Ed25519Keypair.fromSecretKey(wallet.secretKey);
if (signer.toSuiAddress() !== wallet.address) {
  throw new Error("Audit wallet does not match its encrypted address");
}

const api = await request.newContext({ baseURL: baseUrl });
const call = async (method, path, data) => {
  const response = await api[method](
    "/api/control/" + path,
    data === undefined ? {} : { data },
  );
  if (!response.ok()) {
    throw new Error(
      path + " " + response.status() + " " + (await response.text()),
    );
  }
  return response.json();
};

const authenticate = async () => {
  const challenge = await call("post", "api/auth/challenge", {
    address: wallet.address,
  });
  const signed = await signer.signPersonalMessage(
    new TextEncoder().encode(challenge.message),
  );
  await call("post", "api/auth/verify", {
    challengeId: challenge.challengeId,
    address: wallet.address,
    message: challenge.message,
    signature: signed.signature,
  });
};

const summarizeAccounts = (accounts) =>
  accounts.accounts.map((account) => ({
    accountId: account.accountId,
    equityUsd: account.equityUsd,
    availableCollateralUsd: account.availableCollateralUsd,
    positionCount: account.positionCount,
  }));

try {
  await authenticate();
  const [beforeStatus, beforeConfig, beforeAccounts] = await Promise.all([
    call("get", "api/status"),
    call("get", "api/config"),
    call("get", "api/accounts"),
  ]);
  const trial = await call("post", "api/runtime/strategy-trial", {
    mode,
    cadenceMs: 2_000,
    maxSlippageBps: 500,
    ...(mode === "live"
      ? { confirmation: "RUN 3 LIVE CYCLES AND FLATTEN" }
      : {}),
  });
  const [afterStatus, afterConfig, afterAccounts] = await Promise.all([
    call("get", "api/status"),
    call("get", "api/config"),
    call("get", "api/accounts"),
  ]);
  console.log(
    JSON.stringify(
      {
        at: new Date().toISOString(),
        mode,
        gates: beforeStatus.liveGates,
        before: {
          running: beforeStatus.snapshot.running,
          configMode: beforeConfig.config.mode,
          markets: beforeConfig.config.markets.map((market) => market.symbol),
          accounts: summarizeAccounts(beforeAccounts),
        },
        result: trial.result,
        after: {
          running: afterStatus.snapshot.running,
          error: afterStatus.snapshot.lastError,
          configMode: afterConfig.config.mode,
          restored:
            JSON.stringify(afterConfig.config) ===
            JSON.stringify(beforeConfig.config),
          accounts: summarizeAccounts(afterAccounts),
        },
      },
      null,
      2,
    ),
  );
} finally {
  wallet.secretKey = "";
  key.fill(0);
  await api.dispose();
}
