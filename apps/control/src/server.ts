export { AUDIT_EVENT_KINDS, PROBLEM_OUTCOMES } from "./audit-event-kinds.js";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import type { BuilderFeePolicy } from "@puc/core";
import { OnchainAllowlist } from "./allowlist.js";
import { WalletAuth } from "./auth.js";
import { activeBuilderCode } from "./integrator.js";
import { RuntimeManager } from "./runtime-manager.js";
import {
  buildServer,
  envSchema,
  executionSigningKey,
  executionWhitelistObjectId,
} from "./server-app.js";
import { Store } from "./store.js";

const env = envSchema.parse(process.env);
const signingKey = executionSigningKey(env);
const whitelistObjectId = executionWhitelistObjectId(env);
const store = new Store(env.DATABASE_PATH);
if (whitelistObjectId && !store.getRegistryObjectId()) {
  store.setRegistryObjectId(whitelistObjectId);
}
if (
  env.AFTERMATH_INTEGRATOR_ID !== undefined &&
  store.getSystemValue<number>("aftermath_integrator_id") === null
) {
  store.setSystemSetting(
    "aftermath_integrator_id",
    env.AFTERMATH_INTEGRATOR_ID,
  );
}

const builderCode = (): BuilderFeePolicy | null =>
  activeBuilderCode({
    confirmedIntegratorId: store.getSystemValue<number>(
      "aftermath_integrator_id",
    ),
    configuredIntegratorId: env.AFTERMATH_INTEGRATOR_ID,
    feeBps: env.AFTERMATH_INTEGRATOR_FEE_BPS,
  });
const runtimeManager = new RuntimeManager(
  store,
  {
    ...(signingKey ? { masterKey: signingKey } : {}),
    // Testnet has its own explicit gate. The two Mainnet gates remain false
    // in development and are never treated as Testnet authorization.
    liveEnabled:
      env.SUI_NETWORK === "testnet"
        ? env.TESTNET_EXECUTION_ENABLED
        : env.LIVE_TRADING_ENABLED,
    mainnetAllowed: env.SUI_NETWORK === "testnet" ? true : env.ALLOW_MAINNET,
    builderCode,
  },
  {
    network: env.SUI_NETWORK,
    ...(env.SUI_VALIDATOR_GRPC_URL
      ? { preferredEndpoint: env.SUI_VALIDATOR_GRPC_URL }
      : {}),
    ...(env.SUI_FALLBACK_GRPC_URL
      ? { fallbackEndpoint: env.SUI_FALLBACK_GRPC_URL }
      : {}),
  },
);
await runtimeManager.initialize();

const publicGrpc =
  env.SUI_VALIDATOR_GRPC_URL ??
  env.SUI_FALLBACK_GRPC_URL ??
  `https://fullnode.${env.SUI_NETWORK}.sui.io:443`;
const publicSuiClient = new SuiGrpcClient({
  network: env.SUI_NETWORK,
  baseUrl: publicGrpc,
});
const allowlist = new OnchainAllowlist(publicSuiClient, store);
const auth = new WalletAuth(
  store,
  allowlist,
  env.PUBLIC_ORIGIN,
  env.WALLET_AUTH_BOOTSTRAP,
  12,
  30_000,
  async (ownerAddress) => {
    await runtimeManager.stopTenant(ownerAddress);
    store.forTenant(ownerAddress).logEvent({
      category: "access",
      action: "membership-revoked-stop",
      outcome: "completed",
    });
  },
  env.CONTROL_TOKEN,
  publicSuiClient,
  env.SUI_NETWORK === "testnet" ? "Testnet" : "Mainnet",
);
const app = await buildServer({
  env,
  store,
  runtimeManager,
  auth,
  allowlist,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await runtimeManager.stopAll();
  runtimeManager.close();
  await app.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({
  host: env.CONTROL_HOST,
  port: env.CONTROL_PORT,
});
