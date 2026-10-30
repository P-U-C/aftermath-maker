import { createHash, timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import Fastify, { type FastifyRequest } from "fastify";
import { z } from "zod";
import { agentEncryptionContext, createEncryptedAgent } from "@puc/aftermath";
import {
  decimalToBaseUnits,
  integratorInspectionSchema,
  makerConfigSchema,
  makerMarketOverridesSchema,
  setupSchema,
  USDC_COIN_TYPE,
  type BuilderFeePolicy,
} from "@puc/core";
import { OnchainAllowlist } from "./allowlist.js";
import { AuthError, WalletAuth } from "./auth.js";
import { classifyHttpError } from "./http-error.js";
import { RuntimeManager } from "./runtime-manager.js";
import { Store, type TenantStore } from "./store.js";

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);
const optionalObjectId = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
);
const optionalIntegratorId = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.coerce.number().int().nonnegative().optional(),
);

const walletLimitsSchema = z
  .object({
    maxRunDrawdownUsd: z.number().positive().max(10_000),
    maxInventoryUsd: z.number().positive().max(10_000),
    maxGrossExposureUsd: z.number().positive().max(100_000),
    maxUnrealizedLossUsd: z.number().positive().max(10_000),
    confirmed: z.literal(true),
  })
  .strict();

const bundleMarketSchema = z
  .object({
    marketId: z.string().regex(/^0x[0-9a-fA-F]+$/),
    symbol: z.string().min(1).max(24),
    overrides: makerMarketOverridesSchema.optional(),
  })
  .strict();

const strategyMarketRuleSchema = z.union([
  z
    .object({
      kind: z.literal("quick-pick"),
      pick: z.enum(["rewards", "balanced", "quiet", "steady", "clear"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("preferred-list"),
      marketIds: z.array(z.string().regex(/^0x[0-9a-fA-F]+$/)).max(64),
    })
    .strict(),
]);

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  CONTROL_HOST: z.string().default("127.0.0.1"),
  CONTROL_PORT: z.coerce.number().int().positive().default(8787),
  DATABASE_PATH: z.string().default("data/maker.db"),
  MAKER_MASTER_KEY: z.string().optional(),
  CONTROL_TOKEN: z.string().min(24).optional(),
  PUBLIC_ORIGIN: z.string().url().default("http://localhost:8788"),
  WALLET_AUTH_BOOTSTRAP: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SUI_WHITELIST_OBJECT_ID: optionalObjectId,
  LIVE_TRADING_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  ALLOW_MAINNET: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SUI_VALIDATOR_GRPC_URL: optionalUrl,
  SUI_FALLBACK_GRPC_URL: optionalUrl,
  AFTERMATH_INTEGRATOR_ID: optionalIntegratorId,
  AFTERMATH_INTEGRATOR_FEE_BPS: z.coerce.number().min(0).max(5).default(1),
});

const env = envSchema.parse(process.env);

function secretMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

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

const builderCode = (): BuilderFeePolicy | null => {
  const integratorId =
    env.AFTERMATH_INTEGRATOR_ID ??
    store.getSystemValue<number>("aftermath_integrator_id");
  return integratorId === null || integratorId === undefined
    ? null
    : {
        integratorId,
        integratorFee: env.AFTERMATH_INTEGRATOR_FEE_BPS / 10_000,
      };
};

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
const allowlist = new OnchainAllowlist(
  new SuiGrpcClient({ network: "mainnet", baseUrl: publicGrpc }),
  store,
);
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
);

type RequestAuth = {
  ownerAddress: string;
  operator: boolean;
};
type AuthenticatedRequest = FastifyRequest & { makerAuth?: RequestAuth };

const app = Fastify({
  logger: {
    level: env.NODE_ENV === "production" ? "info" : "debug",
    redact: [
      "req.headers.authorization",
      "req.headers.x-control-token",
      "req.headers.x-maker-session",
      "body.signature",
      "body.accessRequestToken",
      "body.encryptedSecret",
    ],
  },
  trustProxy: false,
  bodyLimit: 64 * 1024,
});

await app.register(cors, { origin: false });
await app.register(rateLimit, {
  max: 120,
  timeWindow: "1 minute",
  keyGenerator: (request) => {
    const header = request.headers["x-maker-session"];
    const session = Array.isArray(header) ? header[0] : header;
    if (session) {
      const tokenHash = createHash("sha256").update(session).digest("hex");
      const stored = store.getSession(tokenHash);
      if (stored) return `owner:${stored.ownerAddress}`;
    }
    const forwarded = request.headers["x-maker-client-ip"];
    const clientIp = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return `unauthenticated:${clientIp ?? request.ip}`;
  },
});

const publicPaths = new Set([
  "/health",
  "/ready",
  "/api/auth/challenge",
  "/api/auth/verify",
  "/api/access-requests",
]);

app.addHook("onRequest", async (request, reply) => {
  const path = request.url.split("?")[0]!;
  if (!["/health", "/ready"].includes(path)) {
    if (!env.CONTROL_TOKEN) {
      return reply.code(503).send({
        error: "CONTROL_TOKEN is not configured; API access is disabled",
      });
    }
    const controlHeader = request.headers["x-control-token"];
    const controlToken = Array.isArray(controlHeader)
      ? controlHeader[0]
      : controlHeader;
    if (!secretMatches(controlToken, env.CONTROL_TOKEN)) {
      return reply.code(401).send({ error: "Invalid control token" });
    }
  }

  if (publicPaths.has(path)) return;
  if (path.startsWith("/api/")) {
    const token = request.headers["x-maker-session"];
    const value = Array.isArray(token) ? token[0] : token;
    (request as AuthenticatedRequest).makerAuth = await auth.authenticate(
      value,
      {
        allowStaleOnChainError:
          path === "/api/runtime/stop" ||
          path === "/api/runtime/flatten" ||
          path.startsWith("/api/operator/runtime/"),
      },
    );
  }
});

app.setErrorHandler((error, request, reply) => {
  const response = classifyHttpError(error);
  if (response.status >= 500) {
    request.log.error({ err: error }, "request failed");
  } else {
    request.log.info(
      { status: response.status, error: response.internalMessage },
      "request rejected",
    );
  }
  reply.code(response.status).send({ error: response.publicMessage });
});

function requestAuth(request: FastifyRequest): RequestAuth {
  const value = (request as AuthenticatedRequest).makerAuth;
  if (!value) throw new AuthError(401, "Wallet session required");
  return value;
}

function operatorAuth(request: FastifyRequest): RequestAuth {
  const value = requestAuth(request);
  if (!value.operator) throw new AuthError(403, "Operator wallet required");
  return value;
}

function tenant(request: FastifyRequest) {
  return store.forTenant(requestAuth(request).ownerAddress);
}

function runtime(request: FastifyRequest) {
  return runtimeManager.get(requestAuth(request).ownerAddress);
}

function assertConfiguredAccounts(
  scoped: TenantStore,
  config: ReturnType<typeof makerConfigSchema.parse>,
): void {
  if (config.makerAccountId) {
    const makerAccount = scoped.getAccountSetup(config.makerAccountId);
    if (!makerAccount?.agentCapId) {
      throw new Error("The selected Maker account is not authorized");
    }
  }
  if (config.hedge.enabled && config.hedge.accountId) {
    const hedgeAccount = scoped.getAccountSetup(config.hedge.accountId);
    if (!hedgeAccount?.agentCapId) {
      throw new Error("The selected hedge account is not authorized");
    }
  }
}

function assertLiveModeEnabled(
  config: ReturnType<typeof makerConfigSchema.parse>,
): void {
  if (
    config.mode === "live" &&
    (!env.LIVE_TRADING_ENABLED || !env.ALLOW_MAINNET)
  ) {
    throw new AuthError(
      409,
      "Live mode requires LIVE_TRADING_ENABLED=true and ALLOW_MAINNET=true",
    );
  }
}

app.get("/health", async () => ({
  ok: true,
  service: "aftermath-maker-control",
  time: new Date().toISOString(),
}));

app.get("/ready", async (_request, reply) => {
  const ready = Boolean(runtimeManager.activeEndpoint);
  return reply.code(ready ? 200 : 503).send({
    ready,
    activeEndpoint: runtimeManager.activeEndpoint,
    endpoints: runtimeManager.endpointHealth,
    error: runtimeManager.error,
  });
});

app.post("/api/auth/challenge", async (request) => {
  const body = z
    .object({
      address: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    })
    .strict()
    .parse(request.body);
  return auth.begin(body.address);
});

app.post("/api/auth/verify", async (request) => {
  const body = z
    .object({
      challengeId: z.string().uuid(),
      address: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      message: z.string().min(40).max(2_000),
      signature: z.string().min(20).max(2_000),
    })
    .strict()
    .parse(request.body);
  return auth.verify(body);
});

app.post("/api/auth/logout", async (request) => {
  const token = request.headers["x-maker-session"];
  auth.logout(Array.isArray(token) ? token[0] : token);
  return { ok: true };
});

app.get("/api/auth/me", async (request) => {
  const identity = requestAuth(request);
  return {
    ...identity,
    registryConfigured: allowlist.configured,
    registryObjectId: store.getRegistryObjectId(),
  };
});

app.post(
  "/api/access-requests",
  { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } },
  async (request) => {
    const body = z
      .object({
        accessRequestToken: z.string().min(1).max(1_024),
        twitterHandle: z
          .string()
          .trim()
          .regex(/^@?[A-Za-z0-9_]{1,15}$/),
        company: z.string().max(200).optional().default(""),
      })
      .strict()
      .parse(request.body);
    auth.createAccessRequest({
      accessRequestToken: body.accessRequestToken,
      twitterHandle: body.twitterHandle.startsWith("@")
        ? body.twitterHandle
        : `@${body.twitterHandle}`,
      company: body.company,
    });
    return { ok: true };
  },
);

app.get("/api/status", async (request) => {
  const active = runtime(request);
  const identity = requestAuth(request);
  return {
    snapshot: active.snapshot,
    bundles: runtimeManager.bundleSnapshots(identity.ownerAddress),
    activeEndpoint: active.activeEndpoint,
    endpoints: active.endpointHealth,
    liveGates: {
      liveTradingEnabled: env.LIVE_TRADING_ENABLED,
      mainnetAllowed: env.ALLOW_MAINNET,
    },
    builderCode: builderCode(),
  };
});

app.get("/api/config", async (request) => ({
  config: tenant(request).getConfig(),
}));

app.get("/api/strategies", async (request) => {
  const scoped = tenant(request);
  if (scoped.bundlesRolledBack()) {
    throw new AuthError(409, "Bundles rolled back");
  }
  return {
    strategies: scoped
      .listStrategies()
      .filter((strategy) => !strategy.archivedAt),
  };
});

app.get("/api/strategies/:strategyId", async (request) => {
  const scoped = tenant(request);
  if (scoped.bundlesRolledBack()) {
    throw new AuthError(409, "Bundles rolled back");
  }
  const params = z
    .object({ strategyId: z.string().min(1).max(200) })
    .parse(request.params);
  const strategy = scoped.getStrategy(params.strategyId);
  if (!strategy || strategy.archivedAt) {
    throw new AuthError(404, "Strategy was not found");
  }
  return { strategy };
});

app.post("/api/strategies", async (request) => {
  const scoped = tenant(request);
  if (scoped.bundlesRolledBack()) {
    throw new AuthError(409, "Bundles rolled back");
  }
  const body = z
    .object({
      name: z.string().trim().min(1).max(80),
      config: z.unknown(),
      marketRule: strategyMarketRuleSchema,
      markets: z.array(bundleMarketSchema).max(64),
    })
    .strict()
    .parse(request.body);
  const strategy = scoped.createStrategy(body);
  scoped.logEvent({
    category: "strategies",
    action: "create",
    outcome: "success",
    detail: { name: strategy.name },
  });
  return { strategy };
});

app.patch("/api/strategies/:strategyId", async (request) => {
  const scoped = tenant(request);
  if (scoped.bundlesRolledBack()) {
    throw new AuthError(409, "Bundles rolled back");
  }
  const params = z
    .object({ strategyId: z.string().min(1).max(200) })
    .parse(request.params);
  const body = z
    .object({
      name: z.string().trim().min(1).max(80),
      config: z.unknown(),
      marketRule: strategyMarketRuleSchema,
      markets: z.array(bundleMarketSchema).max(64),
      expectedVersion: z.number().int().positive(),
    })
    .strict()
    .parse(request.body);
  const result = scoped.updateStrategy({
    ...body,
    strategyId: params.strategyId,
  });
  await runtimeManager.reconfigureStrategyBundles(
    requestAuth(request).ownerAddress,
    result.affectedBundles.map((bundle) => bundle.id),
  );
  scoped.logEvent({
    category: "strategies",
    action: "update",
    outcome: "success",
    detail: {
      name: result.strategy.name,
      bundleNames: result.affectedBundles.map((bundle) => bundle.name),
    },
  });
  return result;
});

app.post("/api/strategies/:strategyId/duplicate", async (request) => {
  const scoped = tenant(request);
  if (scoped.bundlesRolledBack()) {
    throw new AuthError(409, "Bundles rolled back");
  }
  const params = z
    .object({ strategyId: z.string().min(1).max(200) })
    .parse(request.params);
  const body = z
    .object({ name: z.string().trim().min(1).max(80).optional() })
    .strict()
    .parse(request.body ?? {});
  const strategy = scoped.duplicateStrategy({
    strategyId: params.strategyId,
    ...(body.name ? { name: body.name } : {}),
  });
  scoped.logEvent({
    category: "strategies",
    action: "duplicate",
    outcome: "success",
    detail: { name: strategy.name },
  });
  return { strategy };
});

app.post("/api/strategies/:strategyId/archive", async (request) => {
  const scoped = tenant(request);
  if (scoped.bundlesRolledBack()) {
    throw new AuthError(409, "Bundles rolled back");
  }
  const params = z
    .object({ strategyId: z.string().min(1).max(200) })
    .parse(request.params);
  const strategy = scoped.archiveStrategy(params.strategyId);
  scoped.logEvent({
    category: "strategies",
    action: "archive",
    outcome: "success",
    detail: { name: strategy.name },
  });
  return { strategy };
});

app.get("/api/bundles", async (request) => {
  const scoped = tenant(request);
  if (scoped.bundlesRolledBack()) {
    throw new AuthError(409, "Bundles rolled back");
  }
  return {
    bundles: scoped.listBundles(),
    walletLimits: scoped.getWalletLimits(),
  };
});

app.get("/api/bundles/:bundleId/config", async (request) => {
  const scoped = tenant(request);
  if (scoped.bundlesRolledBack()) {
    throw new AuthError(409, "Bundles rolled back");
  }
  const params = z
    .object({ bundleId: z.string().min(1).max(200) })
    .parse(request.params);
  const config = scoped.getBundleConfig(params.bundleId);
  if (!config) throw new AuthError(404, "Bundle was not found");
  return { config };
});

app.post("/api/bundles/wallet-limits", async (request) => {
  const scoped = tenant(request);
  if (scoped.bundlesRolledBack()) {
    throw new AuthError(409, "Bundles rolled back");
  }
  const body = walletLimitsSchema.parse(request.body);
  const ownerAddress = requestAuth(request).ownerAddress;
  const walletLimits = scoped.updateWalletLimits({
    maxRunDrawdownUsd: body.maxRunDrawdownUsd,
    maxInventoryUsd: body.maxInventoryUsd,
    maxGrossExposureUsd: body.maxGrossExposureUsd,
    maxUnrealizedLossUsd: body.maxUnrealizedLossUsd,
    usage: runtimeManager.runningWalletUsage(ownerAddress),
  });
  scoped.logEvent({
    category: "bundles",
    action: "wallet-limits.update",
    outcome: "success",
  });
  return { walletLimits };
});

app.post("/api/bundles", async (request) => {
  const scoped = tenant(request);
  if (scoped.bundlesRolledBack()) {
    throw new AuthError(409, "Bundles rolled back");
  }
  const body = z
    .union([
      z
        .object({
          name: z.string().trim().min(1).max(80),
          config: z.unknown(),
          confirmWalletLimits: z.boolean().optional(),
        })
        .strict(),
      z
        .object({
          name: z.string().trim().min(1).max(80),
          makerAccountId: z.string().regex(/^\d+$/).nullable(),
          takerAccountId: z.string().regex(/^\d+$/).nullable(),
          mode: z.enum(["observe", "paper"]),
          /** Compatibility-only: canonical markets come from strategyId. */
          markets: z.array(bundleMarketSchema).min(1).max(64).optional(),
          strategyId: z.string().min(1).max(200).nullable(),
          confirmWalletLimits: z.boolean().optional(),
        })
        .strict(),
    ])
    .parse(request.body);
  const bundle =
    "config" in body
      ? (() => {
          const config = makerConfigSchema.parse(body.config);
          assertLiveModeEnabled(config);
          assertConfiguredAccounts(scoped, config);
          return scoped.createBundle({
            name: body.name,
            config,
            ...(body.confirmWalletLimits !== undefined
              ? { confirmWalletLimits: body.confirmWalletLimits }
              : {}),
          });
        })()
      : (() => {
          for (const accountId of [body.makerAccountId, body.takerAccountId]) {
            if (accountId && !scoped.getAccountSetup(accountId)?.agentCapId) {
              throw new Error("The selected account is not authorized");
            }
          }
          return scoped.createAllocatedBundle({
            name: body.name,
            makerAccountId: body.makerAccountId,
            takerAccountId: body.takerAccountId,
            mode: body.mode,
            ...(body.markets ? { markets: body.markets } : {}),
            strategyId: body.strategyId,
            ...(body.confirmWalletLimits !== undefined
              ? { confirmWalletLimits: body.confirmWalletLimits }
              : {}),
          });
        })();
  store.forBundle(requestAuth(request).ownerAddress, bundle.id).logEvent({
    category: "bundles",
    action: "create",
    outcome: "success",
    detail: {
      name: bundle.name,
      mode: bundle.mode,
      marketIds: bundle.marketIds,
    },
  });
  return { bundle, walletLimits: scoped.getWalletLimits() };
});

app.post("/api/bundles/:bundleId/config", async (request) => {
  const scoped = tenant(request);
  if (scoped.bundlesRolledBack()) {
    throw new AuthError(409, "Bundles rolled back");
  }
  const params = z
    .object({ bundleId: z.string().min(1).max(200) })
    .parse(request.params);
  const body = z
    .object({
      config: z.unknown(),
      updatedAt: z.string().datetime().optional(),
    })
    .strict()
    .parse(request.body);
  const config = makerConfigSchema.parse(body.config);
  assertLiveModeEnabled(config);
  assertConfiguredAccounts(scoped, config);
  const bundle = await runtimeManager.reconfigureBundle({
    ownerAddress: requestAuth(request).ownerAddress,
    bundleId: params.bundleId,
    config,
    ...(body.updatedAt ? { expectedUpdatedAt: body.updatedAt } : {}),
  });
  store.forBundle(requestAuth(request).ownerAddress, bundle.id).logEvent({
    category: "bundles",
    action: "configure",
    outcome: "success",
    detail: {
      name: bundle.name,
      mode: bundle.mode,
      marketIds: bundle.marketIds,
    },
  });
  return { bundle, config: scoped.getBundleConfig(bundle.id) };
});

app.patch("/api/bundles/:bundleId", async (request) => {
  const scoped = tenant(request);
  if (scoped.bundlesRolledBack()) {
    throw new AuthError(409, "Bundles rolled back");
  }
  const params = z
    .object({ bundleId: z.string().min(1).max(200) })
    .parse(request.params);
  const body = z
    .object({
      makerAccountId: z.string().regex(/^\d+$/).nullable().optional(),
      takerAccountId: z.string().regex(/^\d+$/).nullable().optional(),
      mode: z.enum(["observe", "paper"]).optional(),
      strategyId: z.string().min(1).max(200).nullable().optional(),
      expectedUpdatedAt: z.string().datetime().optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.makerAccountId !== undefined ||
        value.takerAccountId !== undefined ||
        value.mode !== undefined ||
        value.strategyId !== undefined,
      "Choose at least one bundle field to update",
    )
    .parse(request.body);
  for (const accountId of [body.makerAccountId, body.takerAccountId]) {
    if (accountId && !scoped.getAccountSetup(accountId)?.agentCapId) {
      throw new Error("The selected account is not authorized");
    }
  }
  const bundle = await runtimeManager.updateBundleAllocation({
    ownerAddress: requestAuth(request).ownerAddress,
    bundleId: params.bundleId,
    ...(body.makerAccountId !== undefined
      ? { makerAccountId: body.makerAccountId }
      : {}),
    ...(body.takerAccountId !== undefined
      ? { takerAccountId: body.takerAccountId }
      : {}),
    ...(body.mode ? { mode: body.mode } : {}),
    ...(body.strategyId !== undefined ? { strategyId: body.strategyId } : {}),
    ...(body.expectedUpdatedAt
      ? { expectedUpdatedAt: body.expectedUpdatedAt }
      : {}),
  });
  scoped.logEvent({
    category: "bundles",
    action: "allocation.update",
    outcome: "success",
    detail: {
      name: bundle.name,
      strategyId: bundle.strategyId,
      marketIds: bundle.marketIds,
    },
  });
  return { bundle, config: scoped.getBundleConfig(bundle.id) };
});

app.post("/api/bundles/:bundleId/start", async (request) => {
  const scoped = tenant(request);
  if (scoped.bundlesRolledBack()) {
    throw new AuthError(409, "Bundles rolled back");
  }
  const params = z
    .object({ bundleId: z.string().min(1).max(200) })
    .parse(request.params);
  const config = scoped.getBundleConfig(params.bundleId);
  if (!config) throw new AuthError(404, "Bundle was not found");
  assertLiveModeEnabled(config);
  const started = runtimeManager.startBundle(
    requestAuth(request).ownerAddress,
    params.bundleId,
  );
  return started;
});

app.post("/api/bundles/:bundleId/resume", async (request) => {
  const scoped = tenant(request);
  if (scoped.bundlesRolledBack()) {
    throw new AuthError(409, "Bundles rolled back");
  }
  const params = z
    .object({ bundleId: z.string().min(1).max(200) })
    .parse(request.params);
  const config = scoped.getBundleConfig(params.bundleId);
  if (!config) throw new AuthError(404, "Bundle was not found");
  assertLiveModeEnabled(config);
  return runtimeManager.startBundle(
    requestAuth(request).ownerAddress,
    params.bundleId,
  );
});

app.post("/api/bundles/:bundleId/pause", async (request) => {
  const scoped = tenant(request);
  if (scoped.bundlesRolledBack()) {
    throw new AuthError(409, "Bundles rolled back");
  }
  const params = z
    .object({ bundleId: z.string().min(1).max(200) })
    .parse(request.params);
  return runtimeManager.pauseBundle(
    requestAuth(request).ownerAddress,
    params.bundleId,
  );
});

app.post("/api/bundles/:bundleId/archive", async (request) => {
  const scoped = tenant(request);
  if (scoped.bundlesRolledBack()) {
    throw new AuthError(409, "Bundles rolled back");
  }
  const params = z
    .object({ bundleId: z.string().min(1).max(200) })
    .parse(request.params);
  return {
    bundle: await runtimeManager.archiveBundle(
      requestAuth(request).ownerAddress,
      params.bundleId,
    ),
  };
});

app.get("/api/events", async (request) => {
  const query = z
    .object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      bundle: z.string().min(1).max(200).optional(),
    })
    .parse(request.query);
  if (
    query.bundle &&
    query.bundle !== "before" &&
    !tenant(request).getStoredBundle(query.bundle)
  ) {
    throw new AuthError(404, "Bundle was not found");
  }
  return { events: tenant(request).listEvents(query.limit, query.bundle) };
});

app.get("/api/performance", async (request) => {
  const query = z
    .object({
      period: z.enum(["1D", "EPOCH", "ALL"]).default("1D"),
      since: z.string().datetime().optional(),
      bundle: z.string().min(1).max(200).optional(),
    })
    .strict()
    .parse(request.query);
  if (query.period === "EPOCH" && !query.since) {
    throw new AuthError(400, "Epoch performance requires a start time");
  }
  if (query.bundle === "before") {
    return {
      performance: null,
      group: "Before bundles",
      events: tenant(request).listEvents(200, "before"),
    };
  }
  const active = query.bundle
    ? runtimeManager.getBundle(requestAuth(request).ownerAddress, query.bundle)
    : runtime(request);
  return {
    performance: await active.performance({
      period: query.period,
      ...(query.since ? { since: query.since } : {}),
    }),
  };
});

app.get("/api/markets", async (request) => {
  const query = z
    .object({ collateralCoinType: z.string().default(USDC_COIN_TYPE) })
    .parse(request.query);
  return {
    markets: await runtime(request).listMarkets(query.collateralCoinType),
  };
});

app.get("/api/rewards", async (request) => {
  const query = z
    .object({
      collateralCoinType: z.string().default(USDC_COIN_TYPE),
      objective: z.enum(["farming", "profit", "both"]).default("both"),
    })
    .parse(request.query);
  return {
    rewards: await runtime(request).rewardDashboard(
      query.collateralCoinType,
      query.objective,
    ),
  };
});

app.get("/api/setup", async (request) => {
  const scoped = tenant(request);
  const setup = scoped.getSetup();
  const accounts = scoped.listAccountSetups();
  const active = setup
    ? accounts.find((account) => account.accountId === setup.accountId)
    : null;
  const agent = scoped.getAgent();
  return {
    setup,
    accounts,
    agent: agent
      ? {
          address: agent.address,
          createdAt: agent.createdAt,
          grantDigest: active?.grantDigest ?? null,
          agentCapId: active?.agentCapId ?? null,
        }
      : null,
  };
});

app.get("/api/accounts", async (request) => {
  const identity = requestAuth(request);
  const scoped = tenant(request);
  const query = z
    .object({ collateralCoinType: z.string().default(USDC_COIN_TYPE) })
    .parse(request.query);
  const metadata = new Map(
    scoped.listAccountMetadata().map((item) => [item.accountId, item]),
  );
  const accounts = await runtime(request).requireGateway().listOwnerAccounts({
    walletAddress: identity.ownerAddress,
    collateralCoinType: query.collateralCoinType,
  });
  return {
    accounts: accounts.map((account) => {
      const saved = metadata.get(account.accountId);
      return {
        ...account,
        label: saved?.label ?? null,
        tags: saved?.tags ?? [],
      };
    }),
  };
});

const accountMetadataSchema = z
  .object({
    label: z.union([z.string().trim().min(1).max(40), z.null()]),
    tags: z.array(z.string().trim().min(1).max(20)).max(8),
  })
  .strict();

app.put("/api/accounts/:accountId/metadata", async (request) => {
  const identity = requestAuth(request);
  const params = z
    .object({ accountId: z.string().regex(/^\d+$/) })
    .parse(request.params);
  const body = accountMetadataSchema.parse(request.body);
  const accounts = await runtime(request).requireGateway().listOwnerAccounts({
    walletAddress: identity.ownerAddress,
    collateralCoinType: USDC_COIN_TYPE,
  });
  if (!accounts.some((account) => account.accountId === params.accountId)) {
    throw new AuthError(404, "Account was not found in the connected wallet");
  }

  const tags = Array.from(
    new Map(body.tags.map((tag) => [tag.toLowerCase(), tag])).values(),
  );
  const scoped = tenant(request);
  const metadata = scoped.setAccountMetadata({
    accountId: params.accountId,
    label: body.label,
    tags,
  });
  scoped.logEvent({
    category: "accounts",
    action: "metadata.update",
    outcome: "success",
    detail: {
      accountId: params.accountId,
      label: metadata.label,
      tags: metadata.tags,
    },
  });
  return { metadata };
});

app.post("/api/accounts/create-transaction", async (request) => {
  const identity = requestAuth(request);
  const body = z
    .object({
      collateralCoinType: z.string().min(8).default(USDC_COIN_TYPE),
    })
    .strict()
    .parse(request.body ?? {});
  const prepared = await runtime(request)
    .requireGateway()
    .buildCreateAccountTransaction({
      ownerAddress: identity.ownerAddress,
      collateralCoinType: body.collateralCoinType,
    });
  tenant(request).logEvent({
    category: "onboarding",
    action: "account.create-transaction",
    outcome: "prepared",
    detail: { collateralCoinType: body.collateralCoinType },
  });
  return prepared;
});

const collateralMutationSchema = z
  .object({
    accountId: z.string().regex(/^\d+$/),
    amountUsdc: z
      .string()
      .min(1)
      .max(30)
      .regex(/^(0|[1-9]\d*)(?:\.\d{1,6})?$/),
  })
  .strict();

app.post("/api/accounts/deposit-transaction", async (request) => {
  const identity = requestAuth(request);
  const body = collateralMutationSchema.parse(request.body);
  const active = runtime(request);
  if (active.snapshot.running) {
    throw new AuthError(409, "Stop the engine before changing collateral");
  }
  const amount = decimalToBaseUnits(body.amountUsdc, 6);
  if (amount <= 0n) throw new AuthError(400, "Deposit amount must be positive");
  const prepared = await active
    .requireGateway()
    .buildDepositCollateralTransaction({
      ownerAddress: identity.ownerAddress,
      accountId: body.accountId,
      collateralCoinType: USDC_COIN_TYPE,
      amount,
    });
  tenant(request).logEvent({
    category: "collateral",
    action: "deposit.transaction",
    outcome: "prepared",
    detail: { accountId: body.accountId, amountUsdc: body.amountUsdc },
  });
  return prepared;
});

app.post("/api/accounts/withdraw-transaction", async (request) => {
  const identity = requestAuth(request);
  const body = collateralMutationSchema.parse(request.body);
  const active = runtime(request);
  if (active.snapshot.running) {
    throw new AuthError(409, "Stop the engine before changing collateral");
  }
  const amount = decimalToBaseUnits(body.amountUsdc, 6);
  if (amount <= 0n) {
    throw new AuthError(400, "Withdrawal amount must be positive");
  }
  const prepared = await active
    .requireGateway()
    .buildWithdrawCollateralTransaction({
      ownerAddress: identity.ownerAddress,
      accountId: body.accountId,
      collateralCoinType: USDC_COIN_TYPE,
      amount,
    });
  tenant(request).logEvent({
    category: "collateral",
    action: "withdraw.transaction",
    outcome: "prepared",
    detail: { accountId: body.accountId, amountUsdc: body.amountUsdc },
  });
  return prepared;
});

app.post("/api/config", async (request) => {
  const scoped = tenant(request);
  const config = makerConfigSchema.parse(request.body);
  assertLiveModeEnabled(config);
  assertConfiguredAccounts(scoped, config);
  await runtime(request).reconfigure(config);
  scoped.logEvent({
    category: "configuration",
    action: "maker.update",
    outcome: "success",
    detail: {
      marketIds: config.markets.map((market) => market.marketId),
      mode: config.mode,
      strategyObjective: config.strategyObjective,
      strategyProfile: config.strategyProfile,
      spreadBps: config.spreadBps,
      quoteSizeUsd: config.quoteSizeUsd,
      maxGrossExposureUsd: config.maxGrossExposureUsd,
    },
  });
  return { config };
});

app.post("/api/setup/provision", async (request) => {
  if (!env.MAKER_MASTER_KEY) {
    throw new Error("MAKER_MASTER_KEY is not configured");
  }
  const identity = requestAuth(request);
  const scoped = tenant(request);
  const setup = setupSchema.parse(request.body);
  if (setup.ownerAddress.toLowerCase() !== identity.ownerAddress) {
    throw new AuthError(403, "Setup owner must be the signed-in wallet");
  }
  scoped.setSetup(setup);
  const created = createEncryptedAgent({
    masterKey: env.MAKER_MASTER_KEY,
    context: (agentAddress) =>
      agentEncryptionContext({
        ownerAddress: identity.ownerAddress,
        agentAddress,
        accountId: setup.accountId,
      }),
  });
  const agent = scoped.createAgent(created);
  scoped.logEvent({
    category: "onboarding",
    action: "agent.provision",
    outcome: "success",
    detail: {
      ownerAddress: identity.ownerAddress,
      accountId: setup.accountId,
      agentAddress: agent.address,
    },
  });
  return {
    setup: scoped.getSetup(),
    agentAddress: agent.address,
    alreadyExisted: agent.address !== created.address,
  };
});

app.post("/api/setup/grant-transaction", async (request) => {
  const body = z
    .object({
      accountId: z.string().regex(/^\d+$/),
      gasMist: z.coerce
        .bigint()
        .min(20_000_000n)
        .max(1_000_000_000n)
        .default(100_000_000n),
    })
    .parse(request.body ?? {});
  const scoped = tenant(request);
  const setup = scoped.getAccountSetup(body.accountId);
  const agent = scoped.getAgent();
  if (!setup || !agent) throw new Error("Provision the account first");

  const fee = builderCode();
  if (!fee) {
    throw new Error("Builder-code registration is not complete");
  }
  const prepared = await runtime(request)
    .requireGateway()
    .buildGrantAgentTransaction({
      setup,
      agentAddress: agent.address,
      gasMist: body.gasMist,
      builderCode: fee,
    });
  return {
    ...prepared,
    agentAddress: agent.address,
    gasMist: body.gasMist.toString(),
    builderCode: fee,
  };
});

app.post("/api/setup/confirm", async (request) => {
  const body = z
    .object({
      accountId: z.string().regex(/^\d+$/),
      digest: z.string().min(20).max(100),
    })
    .parse(request.body);
  const scoped = tenant(request);
  const setup = scoped.getAccountSetup(body.accountId);
  const agent = scoped.getAgent();
  if (!setup || !agent) throw new Error("Provision the account first");

  const fee = builderCode();
  if (!fee) {
    throw new Error("Builder-code registration is not complete");
  }
  const verified = await runtime(request).requireGateway().verifyAgentGrant({
    setup,
    agentAddress: agent.address,
    digest: body.digest,
    builderCode: fee,
  });
  scoped.confirmAgentGrant({
    accountId: body.accountId,
    digest: body.digest,
    agentCapId: verified.agentCapId,
  });
  const currentConfig = scoped.getConfig();
  if (currentConfig && !currentConfig.makerAccountId) {
    scoped.setConfig({
      ...currentConfig,
      makerAccountId: body.accountId,
    });
  }
  scoped.logEvent({
    category: "onboarding",
    action: "agent.grant",
    outcome: "confirmed",
    detail: {
      accountId: body.accountId,
      digest: body.digest,
      agentCapId: verified.agentCapId,
      builderCode: builderCode(),
    },
  });
  await runtime(request).cycle();
  return {
    confirmed: true,
    agentCapId: verified.agentCapId,
    builderCode: builderCode(),
  };
});

app.post("/api/setup/revoke-transaction", async (request) => {
  const body = z
    .object({ accountId: z.string().regex(/^\d+$/) })
    .strict()
    .parse(request.body);
  const scoped = tenant(request);
  const setup = scoped.getAccountSetup(body.accountId);
  const agent = scoped.getAgent();
  if (!setup?.agentCapId || !agent) {
    throw new Error("No confirmed agent capability exists for this account");
  }

  const active = runtime(request);
  await active.stop();
  const gateway = active.requireGateway();
  const markets = await gateway.listMarkets(setup.collateralCoinType);
  const portfolio = await gateway.getAgentPortfolioSnapshot({
    setup,
    agentAddress: agent.address,
    marketIds: markets.map((market) => market.id),
  });
  const taggedOrders = portfolio.positions.reduce(
    (count, position) => count + position.makerOrderIds.length,
    0,
  );
  if (taggedOrders > 0) {
    throw new Error(
      `Refusing revocation while ${taggedOrders} Maker-tagged orders remain open`,
    );
  }

  const prepared = await gateway.buildRevokeAgentTransaction({
    setup,
    agentCapId: setup.agentCapId,
    builderCode: builderCode(),
  });
  return {
    ...prepared,
    agentCapId: setup.agentCapId,
  };
});

app.post("/api/setup/revoke-confirm", async (request) => {
  const body = z
    .object({
      accountId: z.string().regex(/^\d+$/),
      digest: z.string().min(20).max(100),
    })
    .strict()
    .parse(request.body);
  const scoped = tenant(request);
  const setup = scoped.getAccountSetup(body.accountId);
  const agent = scoped.getAgent();
  if (!setup?.agentCapId || !agent) {
    throw new Error("No confirmed agent capability exists for this account");
  }

  await runtime(request).requireGateway().verifyAgentRevocation({
    setup,
    agentAddress: agent.address,
    agentCapId: setup.agentCapId,
    digest: body.digest,
    builderCode: builderCode(),
  });
  scoped.clearAgentGrant(body.accountId);

  const current = scoped.getConfig();
  if (current) {
    const revokedMaker = current.makerAccountId === body.accountId;
    const revokedHedge = current.hedge.accountId === body.accountId;
    await runtime(request).reconfigure({
      ...current,
      mode: revokedMaker ? "observe" : current.mode,
      makerAccountId: revokedMaker ? null : current.makerAccountId,
      hedge: revokedHedge
        ? { ...current.hedge, enabled: false, accountId: null }
        : current.hedge,
    });
  }
  scoped.logEvent({
    category: "onboarding",
    action: "agent.revoke",
    outcome: "confirmed",
    detail: {
      accountId: body.accountId,
      digest: body.digest,
      agentCapId: setup.agentCapId,
      builderApprovalRemoved: Boolean(builderCode()),
    },
  });
  return { confirmed: true };
});

app.post("/api/runtime/start", async (request) => {
  runtime(request).start();
  return { snapshot: runtime(request).snapshot };
});

app.post("/api/runtime/stop", async (request) => {
  await runtimeManager.stopTenant(requestAuth(request).ownerAddress);
  return { snapshot: runtime(request).snapshot };
});

app.post("/api/runtime/strategy-trial", async (request) => {
  const body = z
    .object({
      mode: z.enum(["paper", "live"]),
      cadenceMs: z.number().int().min(2_000).max(15_000).default(2_000),
      maxSlippageBps: z.number().int().min(5).max(500).default(100),
      confirmation: z.string().optional(),
    })
    .strict()
    .parse(request.body);
  if (
    body.mode === "live" &&
    body.confirmation !== "RUN 3 LIVE CYCLES AND FLATTEN"
  ) {
    throw new AuthError(
      400,
      "Live trial requires the exact confirmation phrase",
    );
  }
  return {
    result: await runtime(request).runStrategyTrial({
      mode: body.mode,
      cadenceMs: body.cadenceMs,
      maxSlippageBps: body.maxSlippageBps,
    }),
    snapshot: runtime(request).snapshot,
  };
});

app.post("/api/runtime/flatten", async (request) => {
  const body = z
    .object({
      confirmation: z.literal("FLATTEN"),
      maxSlippageBps: z.number().int().min(5).max(500).default(100),
    })
    .strict()
    .parse(request.body);
  return {
    result: await runtime(request).flatten(body.maxSlippageBps / 10_000),
    snapshot: runtime(request).snapshot,
  };
});

app.post("/api/runtime/cycle", async (request) => {
  await runtime(request).cycle();
  return { snapshot: runtime(request).snapshot };
});

app.post("/api/inspect/builder-fee", async (request) => {
  const scoped = tenant(request);
  const input = integratorInspectionSchema.parse(request.body);
  const inspection = await runtime(request)
    .requireGateway()
    .inspectIntegrator(input);
  scoped.logEvent({
    category: "inspection",
    action: "builder-fee",
    outcome: "success",
    detail: inspection,
  });
  return { inspection };
});

app.get("/api/operator/status", async (request) => {
  const identity = operatorAuth(request);
  return {
    operatorAddress: identity.ownerAddress,
    registryObjectId: store.getRegistryObjectId(),
    packageId: store.getSystemValue<string>("whitelist_package_id"),
    adminCapId: store.getSystemValue<string>("whitelist_admin_cap_id"),
    builderCode: builderCode(),
    bootstrap: !allowlist.configured,
  };
});

app.get("/api/operator/access-requests", async (request) => {
  operatorAuth(request);
  const query = z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
    })
    .parse(request.query);
  return { accessRequests: store.listAccessRequests(query.limit) };
});

app.post("/api/operator/whitelist/confirm-deployment", async (request) => {
  const identity = operatorAuth(request);
  const body = z
    .object({ digest: z.string().min(20).max(100) })
    .strict()
    .parse(request.body);
  return {
    deployment: await allowlist.confirmDeployment(
      body.digest,
      identity.ownerAddress,
    ),
  };
});

app.post("/api/operator/whitelist/transaction", async (request) => {
  const identity = operatorAuth(request);
  const body = z
    .object({
      action: z.enum(["add", "remove"]),
      memberAddress: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    })
    .strict()
    .parse(request.body);
  if (
    body.action === "remove" &&
    body.memberAddress.toLowerCase() === identity.ownerAddress
  ) {
    throw new Error("The operator cannot remove its own access");
  }
  return {
    transaction: await allowlist.buildMembershipTransaction({
      operatorAddress: identity.ownerAddress,
      memberAddress: body.memberAddress,
      action: body.action,
    }),
  };
});

app.post("/api/operator/whitelist/confirm-member", async (request) => {
  operatorAuth(request);
  const body = z
    .object({
      address: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      expected: z.boolean(),
    })
    .strict()
    .parse(request.body);
  allowlist.clearCache();
  const allowed = await allowlist.isAllowed(body.address, true);
  if (allowed !== body.expected) {
    throw new Error("On-chain membership does not match the requested state");
  }
  const address = body.address.toLowerCase();
  store.setAccessRequestStatus(address, allowed ? "approved" : "pending");
  const runtimeStopped = !allowed
    ? await runtimeManager.stopTenant(address)
    : false;
  return { address, allowed, runtimeStopped };
});

app.post("/api/operator/runtime/stop-tenant", async (request) => {
  const identity = operatorAuth(request);
  const body = z
    .object({
      ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    })
    .strict()
    .parse(request.body);
  const ownerAddress = body.ownerAddress.toLowerCase();
  const stopped = await runtimeManager.stopTenant(ownerAddress);
  store.forTenant(identity.ownerAddress).logEvent({
    category: "operator",
    action: "runtime.stop-tenant",
    outcome: stopped ? "completed" : "not-found",
    detail: { ownerAddress },
  });
  return { ownerAddress, stopped };
});

app.post("/api/operator/runtime/stop-all", async (request) => {
  const identity = operatorAuth(request);
  z.object({ confirmation: z.literal("STOP ALL") })
    .strict()
    .parse(request.body);
  const results = await runtimeManager.stopAll();
  store.forTenant(identity.ownerAddress).logEvent({
    category: "operator",
    action: "runtime.stop-all",
    outcome: results.every((result) => result.stopped)
      ? "completed"
      : "partial",
    detail: { results },
  });
  return { results };
});

app.post("/api/operator/builder/registration-transaction", async (request) => {
  const identity = operatorAuth(request);
  if (builderCode()) {
    throw new Error("An Aftermath integrator ID is already configured");
  }
  return runtime(request)
    .requireGateway()
    .buildIntegratorRegistrationTransaction(identity.ownerAddress);
});

app.post("/api/operator/builder/confirm-registration", async (request) => {
  const identity = operatorAuth(request);
  const body = z
    .object({
      digest: z.string().min(20).max(100),
      expectedIntegratorId: z.number().int().nonnegative(),
    })
    .strict()
    .parse(request.body);
  const registration = await runtime(request)
    .requireGateway()
    .confirmIntegratorRegistration({
      digest: body.digest,
      ownerAddress: identity.ownerAddress,
      expectedIntegratorId: body.expectedIntegratorId,
    });
  store.setSystemSetting("aftermath_integrator_id", registration.integratorId);
  store.setSystemSetting(
    "aftermath_integrator_address",
    registration.integratorAddress,
  );
  return {
    registration,
    builderCode: builderCode(),
  };
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
