import fs from "node:fs";
import crypto from "node:crypto";
import { request } from "playwright-core";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

if (process.env.RUN_MAINNET_RECOVERY !== "I_UNDERSTAND") {
  throw new Error("Set RUN_MAINNET_RECOVERY=I_UNDERSTAND");
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

try {
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

  const { config } = await call("get", "api/config");
  await call("post", "api/runtime/stop", {});
  if (config.mode !== "live") {
    await call("post", "api/config", { ...config, mode: "live" });
  }

  let accounts = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await call("post", "api/runtime/flatten", {
      confirmation: "FLATTEN",
      maxSlippageBps: config.hedge.maxSlippageBps,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    accounts = await call("get", "api/accounts");
    if (accounts.accounts.every((account) => account.positionCount === 0)) {
      break;
    }
    if (attempt === 3) {
      throw new Error("Recovery still has open positions after three passes");
    }
  }

  const maxInventoryUsd = Number(
    process.env.RECOVERY_MAX_INVENTORY_USD ?? config.maxInventoryUsd,
  );
  const maxGrossExposureUsd = Number(
    process.env.RECOVERY_MAX_GROSS_EXPOSURE_USD ??
      Math.max(config.maxGrossExposureUsd, maxInventoryUsd),
  );
  if (maxGrossExposureUsd < maxInventoryUsd) {
    throw new Error("Gross exposure must cover the per-market inventory cap");
  }
  const stagedConfig = {
    ...config,
    mode: "paper",
    refreshMs: 5_000,
    marketDwellMs: 60_000,
    requoteThresholdBps: 5,
    maxRestingMs: 60_000,
    maxQuoteAgeMs: Math.max(config.maxQuoteAgeMs, 90_000),
    maxInventoryUsd,
    maxGrossExposureUsd,
    markets: config.markets.map((market) => ({
      ...market,
      ...(market.overrides
        ? {
            overrides: {
              ...market.overrides,
              maxInventoryUsd,
            },
          }
        : {}),
    })),
  };
  await call("post", "api/config", stagedConfig);
  const [status, finalAccounts] = await Promise.all([
    call("get", "api/status"),
    call("get", "api/accounts"),
  ]);
  if (
    status.snapshot.running ||
    finalAccounts.accounts.some((account) => account.positionCount !== 0)
  ) {
    throw new Error("Recovery did not finish stopped and flat");
  }
  console.log(
    JSON.stringify(
      {
        at: new Date().toISOString(),
        running: status.snapshot.running,
        mode: status.snapshot.mode,
        markets: stagedConfig.markets.map((market) => market.symbol),
        accounts: finalAccounts.accounts.map((account) => ({
          accountId: account.accountId,
          equityUsd: account.equityUsd,
          positionCount: account.positionCount,
        })),
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
