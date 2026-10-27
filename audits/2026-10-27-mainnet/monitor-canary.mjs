import fs from "node:fs";
import crypto from "node:crypto";
import { request } from "playwright-core";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

if (process.env.RUN_MAINNET_CANARY !== "I_UNDERSTAND") {
  throw new Error(
    "Set RUN_MAINNET_CANARY=I_UNDERSTAND to run the audit monitor",
  );
}

const baseUrl =
  process.env.MAKER_BASE_URL ?? "https://maker.permanentupperclass.com";
const durationMs = Number(process.env.CANARY_DURATION_MS ?? 20 * 60_000);
const pollMs = Number(process.env.CANARY_POLL_MS ?? 15_000);
const flattenSlippageBps = Number(
  process.env.CANARY_FLATTEN_SLIPPAGE_BPS ?? 500,
);
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

const recoverToPaper = async () => {
  await call("post", "api/runtime/stop", {});
  const payload = await call("get", "api/config");
  let flatten = null;
  if (payload.config.mode === "live") {
    flatten = await call("post", "api/runtime/flatten", {
      confirmation: "FLATTEN",
      maxSlippageBps: flattenSlippageBps,
    });
    await call("post", "api/config", { ...payload.config, mode: "paper" });
  }
  return flatten;
};

const summarizeAccounts = (accounts) =>
  accounts.accounts.map((account) => ({
    id: account.accountId,
    equityUsd: account.equityUsd,
    positionCount:
      account.positionCount ??
      account.positions?.filter((position) => position.hasPosition).length ??
      null,
    grossExposureUsd:
      account.grossExposureUsd ??
      account.positions?.reduce(
        (total, position) => total + Math.abs(position.inventoryUsd ?? 0),
        0,
      ) ??
      null,
  }));

let exitCode = 0;
try {
  await authenticate();
  const baseline = await call("get", "api/performance");
  const baselineFills = Number(
    process.env.CANARY_BASELINE_FILLS ?? baseline.performance.attributed.fills,
  );
  const baselineHedges = Number(
    process.env.CANARY_BASELINE_HEDGES ?? baseline.performance.hedge.fills,
  );
  const deadline = Date.now() + durationMs;
  let finished = false;

  while (Date.now() < deadline && !finished) {
    const [status, performance, accounts] = await Promise.all([
      call("get", "api/status"),
      call("get", "api/performance"),
      call("get", "api/accounts"),
    ]);
    const record = {
      at: new Date().toISOString(),
      running: status.snapshot.running,
      error: status.snapshot.lastError,
      lastSuccessfulCycleAt: status.snapshot.lastSuccessfulCycleAt,
      hedge: status.snapshot.hedge,
      newMakerFills: performance.performance.attributed.fills - baselineFills,
      newHedges: performance.performance.hedge.fills - baselineHedges,
      accounts: summarizeAccounts(accounts),
    };
    console.log(JSON.stringify(record));

    if (record.error || !record.running) {
      const recovered = await recoverToPaper();
      const finalAccounts = await call("get", "api/accounts");
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          outcome: "runtime-stopped",
          flatten: recovered?.result ?? null,
          accounts: summarizeAccounts(finalAccounts),
        }),
      );
      exitCode = 1;
      finished = true;
      break;
    }

    if (record.newHedges > 0) {
      const recovered = await recoverToPaper();
      const finalAccounts = await call("get", "api/accounts");
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          outcome: "hedge-observed",
          flatten: recovered?.result ?? null,
          accounts: summarizeAccounts(finalAccounts),
        }),
      );
      finished = true;
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  if (!finished) {
    const recovered = await recoverToPaper();
    const finalAccounts = await call("get", "api/accounts");
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        outcome: "time-limit",
        durationMs,
        flatten: recovered?.result ?? null,
        accounts: summarizeAccounts(finalAccounts),
      }),
    );
  }
} catch (error) {
  exitCode = 1;
  console.error(
    JSON.stringify({
      at: new Date().toISOString(),
      outcome: "monitor-error",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  try {
    await recoverToPaper();
  } catch (stopError) {
    console.error(
      JSON.stringify({
        at: new Date().toISOString(),
        outcome: "emergency-stop-error",
        error:
          stopError instanceof Error ? stopError.message : String(stopError),
      }),
    );
  }
} finally {
  wallet.secretKey = "";
  key.fill(0);
  await api.dispose();
}

process.exitCode = exitCode;
