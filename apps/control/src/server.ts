export { AUDIT_EVENT_KINDS, PROBLEM_OUTCOMES } from "./audit-event-kinds.js";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import type { BuilderFeePolicy } from "@puc/core";
import { OnchainAllowlist } from "./allowlist.js";
import { WalletAuth } from "./auth.js";
import { activeBuilderCode } from "./integrator.js";
import { RuntimeManager } from "./runtime-manager.js";
import { buildServer, envSchema } from "./server-app.js";
import { Store } from "./store.js";

const env = envSchema.parse(process.env);
const store = new Store(env.DATABASE_PATH);
if (env.SUI_WHITELIST_OBJECT_ID && !store.getRegistryObjectId()) {
  store.setRegistryObjectId(env.SUI_WHITELIST_OBJECT_ID);
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
    ...(env.MAKER_MASTER_KEY ? { masterKey: env.MAKER_MASTER_KEY } : {}),
    liveEnabled: env.LIVE_TRADING_ENABLED,
    mainnetAllowed: env.ALLOW_MAINNET,
    builderCode,
  },
  {
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
  "https://fullnode.mainnet.sui.io:443";
const publicSuiClient = new SuiGrpcClient({
  network: "mainnet",
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
