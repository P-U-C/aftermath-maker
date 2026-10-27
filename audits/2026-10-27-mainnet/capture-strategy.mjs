import fs from "node:fs";
import crypto from "node:crypto";
import { chromium, request } from "playwright-core";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const baseUrl =
  process.env.MAKER_BASE_URL ?? "https://maker.permanentupperclass.com";
const encryptedPath =
  process.env.AUDIT_WALLET_PATH ??
  process.env.HOME + "/.config/aftermath-maker/audit-owner-20261027.json.enc";
const keyPath =
  process.env.AUDIT_WALLET_KEY_PATH ??
  process.env.HOME + "/.codex/secrets/aftermath-maker/audit-owner-20261027.key";
const executablePath =
  process.env.CHROMIUM_PATH ??
  process.env.HOME +
    "/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";

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
await call("post", "api/runtime/cycle", {});
const [status, configPayload, accountsPayload] = await Promise.all([
  call("get", "api/status"),
  call("get", "api/config"),
  call("get", "api/accounts"),
]);
console.log(
  JSON.stringify({
    deployedState: {
      running: status.snapshot.running,
      mode: status.snapshot.mode,
      liveGates: status.liveGates,
      agentAddress: status.snapshot.agentAddress,
      agentGasSui: status.snapshot.balances.gasSui,
      gasRunwayTransactions: status.snapshot.execution.gasRunwayTransactions,
      averageGasMist: status.snapshot.execution.averageGasMist,
      rotationMode: configPayload.config.rotationMode,
      markets: configPayload.config.markets.map((market) => market.symbol),
      accounts: accountsPayload.accounts.map((account) => ({
        accountId: account.accountId,
        equityUsd: account.equityUsd,
        positionCount: account.positionCount,
      })),
    },
  }),
);
const storageState = await api.storageState();

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox"],
});
const captures = [
  {
    name: "strategy-desktop",
    viewport: { width: 1440, height: 1100 },
    path: "audits/2026-10-27-mainnet/strategy-desktop.png",
  },
  {
    name: "strategy-mobile",
    viewport: { width: 390, height: 844 },
    path: "audits/2026-10-27-mainnet/strategy-mobile.png",
  },
];

try {
  for (const capture of captures) {
    const context = await browser.newContext({
      storageState,
      viewport: capture.viewport,
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Maker controls" }).waitFor();
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      bodyText: document.body.innerText,
    }));
    if (metrics.scrollWidth > metrics.clientWidth + 1) {
      throw new Error(
        `${capture.name} has horizontal overflow: ${metrics.scrollWidth}/${metrics.clientWidth}`,
      );
    }
    console.log(
      JSON.stringify({
        capture: capture.name,
        strategyText: metrics.bodyText
          .split("\n")
          .filter((line) => /cycle|rotation|live pair|farming/i.test(line))
          .slice(0, 30),
      }),
    );
    for (const label of [
      "3-cycle canary",
      "Farming / Profit / Both",
      "One live pair",
      "Run 3 x 2s",
    ]) {
      if (!metrics.bodyText.toLowerCase().includes(label.toLowerCase())) {
        throw new Error(`${capture.name} is missing ${label}`);
      }
    }
    await page.screenshot({ path: capture.path, fullPage: true });
    console.log(
      JSON.stringify({
        capture: capture.name,
        viewport: capture.viewport,
        scrollWidth: metrics.scrollWidth,
        path: capture.path,
      }),
    );
    await context.close();
  }
} finally {
  wallet.secretKey = "";
  key.fill(0);
  await browser.close();
  await api.dispose();
}
