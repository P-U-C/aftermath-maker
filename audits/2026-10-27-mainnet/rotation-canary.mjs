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
const marketOffset = Number(process.env.ROTATION_MARKET_OFFSET ?? 0);
const cycleCount = Number(process.env.ROTATION_CYCLES ?? 3);
const cadenceMs = Number(process.env.ROTATION_CADENCE_MS ?? 2_000);
const dwellMs = Number(process.env.ROTATION_DWELL_MS ?? cadenceMs);
const requoteThresholdBps = Number(
  process.env.ROTATION_REQUOTE_THRESHOLD_BPS ?? 5,
);
const maxRestingMs = Number(
  process.env.ROTATION_MAX_RESTING_MS ?? Math.max(dwellMs, cadenceMs),
);
const autoRebalanceEnabled = process.env.ROTATION_AUTO_REBALANCE === "true";
const rebalanceGrossExposureUsd = Number(
  process.env.ROTATION_REBALANCE_GROSS_USD ?? 2.5,
);
const timeoutMs = Number(
  process.env.ROTATION_TIMEOUT_MS ??
    Math.max(120_000, cycleCount * dwellMs * 1.5 + 60_000),
);
const finalState = process.env.ROTATION_FINAL_STATE ?? "restored";
if (finalState !== "restored" && finalState !== "staged") {
  throw new Error("ROTATION_FINAL_STATE must be restored or staged");
}
if (!Number.isInteger(marketCount) || marketCount < 1 || marketCount > 64) {
  throw new Error("ROTATION_MARKETS must be an integer from 1 to 64");
}
if (!Number.isInteger(marketOffset) || marketOffset < 0) {
  throw new Error("ROTATION_MARKET_OFFSET must be a non-negative integer");
}
if (!Number.isInteger(cycleCount) || cycleCount < 1) {
  throw new Error("ROTATION_CYCLES must be a positive integer");
}
if (dwellMs < cadenceMs || maxRestingMs < cadenceMs) {
  throw new Error(
    "Rotation dwell and maximum resting age must cover the poll cadence",
  );
}
if (
  autoRebalanceEnabled &&
  (!Number.isFinite(rebalanceGrossExposureUsd) ||
    rebalanceGrossExposureUsd <= 0)
) {
  throw new Error("ROTATION_REBALANCE_GROSS_USD must be positive");
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
const flattenAndVerify = async (maxSlippageBps) => {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const recovery = await call("post", "api/runtime/flatten", {
      confirmation: "FLATTEN",
      maxSlippageBps,
    });
    await sleep(1_500);
    const first = await call("get", "api/accounts");
    if (first.accounts.every((account) => account.positionCount === 0)) {
      await sleep(1_500);
      const second = await call("get", "api/accounts");
      if (second.accounts.every((account) => account.positionCount === 0)) {
        return recovery;
      }
    }
  }
  throw new Error(
    "Recovery did not produce two consecutive flat account reads",
  );
};
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
  const [status, configPayload, startingAccounts] = await Promise.all([
    call("get", "api/status"),
    call("get", "api/config"),
    call("get", "api/accounts"),
  ]);
  originalConfig = configPayload.config;
  if (status.snapshot.running) {
    throw new Error("Runtime must be stopped before the rotation canary");
  }
  if ((status.snapshot.portfolio.grossExposureUsd ?? 0) > 0) {
    throw new Error("Maker account must be flat before the rotation canary");
  }
  if (
    startingAccounts.accounts.some((account) => account.positionCount !== 0)
  ) {
    throw new Error(
      "Every owner account must be flat before the rotation canary",
    );
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
  const eligibleCandidates = rewards.rewards.marketModel.opportunities.filter(
    (opportunity) => {
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
    },
  );
  if (eligibleCandidates.length < marketCount) {
    throw new Error(
      `Only ${eligibleCandidates.length} markets fit the saved quote and inventory caps; ${marketCount} requested`,
    );
  }
  const normalizedOffset = marketOffset % eligibleCandidates.length;
  const candidates = Array.from(
    { length: marketCount },
    (_, index) =>
      eligibleCandidates[
        (normalizedOffset + index) % eligibleCandidates.length
      ],
  );
  const requiredInventoryHeadroom = Math.max(
    ...candidates.map((opportunity) =>
      inventoryFloor(
        opportunity.minimumQuoteSizeUsd * 2,
        opportunity.suggestedSpreadBps,
        originalConfig.inventorySkewBps,
      ),
    ),
  );
  if (inventoryCap < requiredInventoryHeadroom) {
    throw new Error(
      `The saved $${inventoryCap.toFixed(2)} inventory cap is below the $${requiredInventoryHeadroom.toFixed(2)} two-fill canary headroom`,
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
    marketDwellMs: dwellMs,
    requoteThresholdBps,
    maxRestingMs,
    autoRebalanceEnabled,
    rebalanceGrossExposureUsd: Math.min(
      rebalanceGrossExposureUsd,
      originalConfig.maxGrossExposureUsd,
    ),
    maxQuoteAgeMs: Math.max(
      cadenceMs * 2 + Math.min(10_000, cadenceMs),
      maxRestingMs + 30_000,
    ),
    staleBookMs: 3_000,
    maxLeverage: 1,
  };

  await call("post", "api/config", trialConfig);
  const baseline = await call("get", "api/status");
  const baselineCycle = baseline.snapshot.cycle;
  const baselineConfirmedQuotes =
    baseline.snapshot.execution.confirmedLiveQuotes;
  const baselineAvoidedTransactions =
    baseline.snapshot.execution.avoidedTransactions ?? 0;
  const startingGasSui = baseline.snapshot.balances.gasSui;
  await call("post", "api/runtime/start", {});
  started = true;

  const deadline = Date.now() + timeoutMs;
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
    if (!latest.snapshot.running && progress < cycleCount) {
      throw new Error("Runtime stopped before the rotation canary completed");
    }
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
    await flattenAndVerify(originalConfig.hedge.maxSlippageBps);
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
        marketOffset: normalizedOffset,
        markets: candidates.map((candidate) => candidate.symbol),
        completedCycles,
        pollIntervalMs: cadenceMs,
        marketDwellMs: dwellMs,
        requoteThresholdBps,
        maxRestingMs,
        autoRebalanceEnabled,
        rebalanceGrossExposureUsd: trialConfig.rebalanceGrossExposureUsd,
        avoidedTransactions:
          latest.snapshot.execution.avoidedTransactions ??
          baselineAvoidedTransactions,
        startingGasSui,
        endingGasSui: finalStatus.snapshot.balances.gasSui,
        gasSpentSui:
          startingGasSui === null ||
          finalStatus.snapshot.balances.gasSui === null
            ? null
            : startingGasSui - finalStatus.snapshot.balances.gasSui,
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
    recovered = await flattenAndVerify(
      originalConfig?.hedge.maxSlippageBps ?? 500,
    )
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
