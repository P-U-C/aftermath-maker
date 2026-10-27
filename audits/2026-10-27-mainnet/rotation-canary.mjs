import fs from "node:fs";
import crypto from "node:crypto";
import { request } from "playwright-core";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const mode = process.env.ROTATION_CANARY_MODE ?? "paper";
if (mode !== "paper" && mode !== "live") {
  throw new Error("ROTATION_CANARY_MODE must be paper or live");
}
if (mode === "live" && process.env.RUN_MAINNET_CANARY !== "I_UNDERSTAND") {
  throw new Error("Set RUN_MAINNET_CANARY=I_UNDERSTAND for a Live canary");
}

const baseUrl =
  process.env.MAKER_BASE_URL ?? "https://maker.permanentupperclass.com";
const encryptedPath =
  process.env.AUDIT_WALLET_PATH ??
  process.env.HOME + "/.config/aftermath-maker/audit-owner-20261027.json.enc";
const keyPath =
  process.env.AUDIT_WALLET_KEY_PATH ??
  process.env.HOME + "/.codex/secrets/aftermath-maker/audit-owner-20261027.key";
const marketCount = Number(process.env.ROTATION_MARKETS ?? 15);
const cycleCount = Number(process.env.ROTATION_CYCLES ?? 3);
const cadenceMs = Number(process.env.ROTATION_CADENCE_MS ?? 2_000);
const finalState = process.env.ROTATION_FINAL_STATE ?? "restored";
if (finalState !== "restored" && finalState !== "staged") {
  throw new Error("ROTATION_FINAL_STATE must be restored or staged");
}

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
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const inventoryFloor = (quoteSizeUsd, spreadBps, skewBps) =>
  Math.ceil(
    quoteSizeUsd *
      (1 + Math.max(0, spreadBps) / 20_000 + Math.max(0, skewBps) / 10_000) *
      100,
  ) / 100;

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

let originalConfig = null;
let trialConfig = null;
let started = false;
let recovered = false;
try {
  await authenticate();
  const [status, configPayload] = await Promise.all([
    call("get", "api/status"),
    call("get", "api/config"),
  ]);
  originalConfig = configPayload.config;
  if (status.snapshot.running) {
    throw new Error("Runtime must be stopped before the rotation canary");
  }
  if ((status.snapshot.portfolio.grossExposureUsd ?? 0) > 0) {
    throw new Error("Maker account must be flat before the rotation canary");
  }
  const rewards = await call(
    "get",
    "api/rewards?collateralCoinType=" +
      encodeURIComponent(originalConfig.collateralCoinType) +
      "&objective=" +
      originalConfig.strategyObjective,
  );
  const quoteCap = Math.max(
    originalConfig.quoteSizeUsd,
    ...originalConfig.markets.map(
      (market) => market.overrides?.quoteSizeUsd ?? originalConfig.quoteSizeUsd,
    ),
  );
  const inventoryCap = Math.max(
    originalConfig.maxInventoryUsd,
    ...originalConfig.markets.map(
      (market) =>
        market.overrides?.maxInventoryUsd ?? originalConfig.maxInventoryUsd,
    ),
  );
  const candidates = rewards.rewards.marketModel.opportunities
    .filter((opportunity) => {
      if (!opportunity.objectiveEligible) return false;
      if (opportunity.minimumQuoteSizeUsd > quoteCap + 1e-9) return false;
      return (
        inventoryFloor(
          opportunity.minimumQuoteSizeUsd,
          opportunity.suggestedSpreadBps,
          originalConfig.inventorySkewBps,
        ) <=
        inventoryCap + 1e-9
      );
    })
    .slice(0, marketCount);
  if (candidates.length < marketCount) {
    throw new Error(
      `Only ${candidates.length} markets fit the saved quote and inventory caps; ${marketCount} requested`,
    );
  }

  trialConfig = {
    ...originalConfig,
    mode,
    rotationMode: "single-slot",
    strategyProfile: "balanced",
    markets: candidates.map((opportunity) => ({
      marketId: opportunity.marketId,
      symbol: opportunity.symbol,
      overrides: {
        quoteSizeUsd: opportunity.minimumQuoteSizeUsd,
        spreadBps: opportunity.suggestedSpreadBps,
        maxInventoryUsd: inventoryCap,
        inventoryTargetUsd: 0,
        inventorySkewBps: originalConfig.inventorySkewBps,
        maxLeverage: 1,
      },
    })),
    refreshMs: cadenceMs,
    maxQuoteAgeMs: Math.max(
      10_000,
      cadenceMs * candidates.length + Math.min(10_000, cadenceMs),
    ),
    staleBookMs: 3_000,
    maxLeverage: 1,
  };

  await call("post", "api/config", trialConfig);
  const baseline = await call("get", "api/status");
  const baselineCycle = baseline.snapshot.cycle;
  const baselineConfirmedQuotes =
    baseline.snapshot.execution.confirmedLiveQuotes;
  await call("post", "api/runtime/start", {});
  started = true;

  const deadline = Date.now() + 120_000;
  let latest = baseline;
  while (Date.now() < deadline) {
    await sleep(1_000);
    latest = await call("get", "api/status");
    if (latest.snapshot.lastError) {
      throw new Error(latest.snapshot.lastError);
    }
    const progress =
      mode === "live"
        ? latest.snapshot.execution.confirmedLiveQuotes -
          baselineConfirmedQuotes
        : latest.snapshot.cycle - baselineCycle;
    if (progress >= cycleCount) break;
  }
  const completedCycles =
    mode === "live"
      ? latest.snapshot.execution.confirmedLiveQuotes - baselineConfirmedQuotes
      : latest.snapshot.cycle - baselineCycle;
  if (completedCycles < cycleCount) {
    throw new Error("Rotation canary timed out before completing its cycles");
  }

  await call("post", "api/runtime/stop", {});
  started = false;
  if (mode === "live") {
    await call("post", "api/runtime/flatten", {
      confirmation: "FLATTEN",
      maxSlippageBps: originalConfig.hedge.maxSlippageBps,
    });
  }
  recovered = true;
  const finalConfig =
    finalState === "staged"
      ? { ...trialConfig, mode: "paper" }
      : originalConfig;
  await call("post", "api/config", finalConfig);
  const [finalStatus, accounts] = await Promise.all([
    call("get", "api/status"),
    call("get", "api/accounts"),
  ]);
  console.log(
    JSON.stringify(
      {
        at: new Date().toISOString(),
        mode,
        marketCount: candidates.length,
        markets: candidates.map((candidate) => candidate.symbol),
        completedCycles,
        transactions: latest.snapshot.markets
          .filter((market) => market.lastTransactionDigest)
          .map((market) => ({
            symbol: market.symbol,
            digest: market.lastTransactionDigest,
          })),
        finalState,
        restored:
          finalState === "restored" &&
          finalStatus.snapshot.mode === originalConfig.mode,
        staged:
          finalState === "staged" &&
          finalStatus.snapshot.mode === "paper" &&
          finalConfig.rotationMode === "single-slot" &&
          finalConfig.markets.length === candidates.length,
        running: finalStatus.snapshot.running,
        error: finalStatus.snapshot.lastError,
        accounts: accounts.accounts.map((account) => ({
          accountId: account.accountId,
          equityUsd: account.equityUsd,
          positionCount: account.positionCount,
        })),
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (started) {
    await call("post", "api/runtime/stop", {}).catch(() => undefined);
  }
  if (mode === "live" && trialConfig) {
    recovered = await call("post", "api/runtime/flatten", {
      confirmation: "FLATTEN",
      maxSlippageBps: originalConfig?.hedge.maxSlippageBps ?? 500,
    })
      .then(() => true)
      .catch(() => false);
  }
  if (originalConfig && (mode !== "live" || recovered)) {
    await call("post", "api/config", originalConfig).catch(() => undefined);
  }
  throw error;
} finally {
  wallet.secretKey = "";
  key.fill(0);
  await api.dispose();
}
