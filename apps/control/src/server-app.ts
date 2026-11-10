import { createHash, timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  agentEncryptionContext,
  createEncryptedAgent,
  type AgentAccountCapability,
  type OwnerAccountSummary,
} from "@puc/aftermath";
import {
  decimalToBaseUnits,
  evaluatePaperAdverseSelection,
  allocateRewardShareVolume,
  integratorInspectionSchema,
  makerConfigSchema,
  makerMarketOverridesSchema,
  scoreRewardShare,
  requiredMakerCollateralUsd,
  setupSchema,
  gasCostUsd,
  summarizeStrategyResult,
  summarizeInventoryTradingLedger,
  USDC_COIN_TYPE,
  type BuilderFeePolicy,
  type MakerConfig,
  type StrategyResultFill,
} from "@puc/core";
export { AUDIT_EVENT_KINDS, PROBLEM_OUTCOMES } from "./audit-event-kinds.js";
import type { OnchainAllowlist } from "./allowlist.js";
import { AuthError, WalletAuth } from "./auth.js";
import { buildIdentity } from "./build-identity.js";
import { bundleCreateHttpError } from "./bundle-create-error.js";
import { assertCollateralWithdrawalAllowed } from "./collateral-guard.js";
import {
  deriveBundleReadiness,
  assertBundleReadyToStart,
  type BundleReadiness,
} from "./bundle-readiness.js";
import { classifyHttpError, UserFacingError } from "./http-error.js";
import {
  createRequestErrorRecorder,
  safeAuditId,
} from "./request-error-audit.js";
import { activeBuilderCode } from "./integrator.js";
import type { RuntimeManager } from "./runtime-manager.js";
import type { PerformanceSnapshot } from "./runtime.js";
import type { RewardShareSettings, Store, TenantStore } from "./store.js";
import { VENUE_READ_TIMEOUT_MS, withTimeout } from "./venue-read.js";

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
const optionalAddress = z.preprocess(
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

export function aggregatePerformance(
  reports: Array<{ bundleName: string; performance: PerformanceSnapshot }>,
): PerformanceSnapshot | null {
  const first = reports[0]?.performance;
  if (!first) return null;
  const sum = (select: (report: PerformanceSnapshot) => number) =>
    reports.reduce((total, report) => total + select(report.performance), 0);
  const volume = new Map<
    string,
    PerformanceSnapshot["volumeByMarket"][number]
  >();
  for (const { performance } of reports) {
    for (const row of performance.volumeByMarket) {
      const current = volume.get(row.marketId);
      volume.set(
        row.marketId,
        current
          ? {
              ...current,
              makerNotionalUsd: current.makerNotionalUsd + row.makerNotionalUsd,
              makerFills: current.makerFills + row.makerFills,
              takerNotionalUsd: current.takerNotionalUsd + row.takerNotionalUsd,
              takerFills: current.takerFills + row.takerFills,
              realizedPnlUsd: current.realizedPnlUsd + row.realizedPnlUsd,
              feesUsd: current.feesUsd + row.feesUsd,
            }
          : { ...row },
      );
    }
  }
  return {
    ...first,
    asOf: new Date().toISOString(),
    account: null,
    attributed: {
      fills: sum((report) => report.attributed.fills),
      notionalUsd: sum((report) => report.attributed.notionalUsd),
      realizedPnlUsd: sum((report) => report.attributed.realizedPnlUsd),
      protocolFeesUsd: sum((report) => report.attributed.protocolFeesUsd),
      estimatedBuilderFeesUsd: sum(
        (report) => report.attributed.estimatedBuilderFeesUsd,
      ),
      netAfterKnownCostsUsd: sum(
        (report) => report.attributed.netAfterKnownCostsUsd,
      ),
      makerVolumeCoveragePct: null,
    },
    hedge: {
      ...first.hedge,
      enabled: reports.some((report) => report.performance.hedge.enabled),
      accountId: null,
      executions: sum((report) => report.hedge.executions),
      fills: sum((report) => report.hedge.fills),
      notionalUsd: sum((report) => report.hedge.notionalUsd),
      realizedPnlUsd: sum((report) => report.hedge.realizedPnlUsd),
      protocolFeesUsd: sum((report) => report.hedge.protocolFeesUsd),
      estimatedBuilderFeesUsd: sum(
        (report) => report.hedge.estimatedBuilderFeesUsd,
      ),
      netAfterKnownCostsUsd: sum(
        (report) => report.hedge.netAfterKnownCostsUsd,
      ),
    },
    combinedNetAfterKnownCostsUsd: sum(
      (report) => report.combinedNetAfterKnownCostsUsd,
    ),
    paper: {
      estimated: reports.some((report) => report.performance.paper.estimated),
      makerFills: sum((report) => report.paper.makerFills),
      hedgeFills: sum((report) => report.paper.hedgeFills),
      notionalUsd: sum((report) => report.paper.notionalUsd),
      estimatedVenueFeesUsd: sum(
        (report) => report.paper.estimatedVenueFeesUsd,
      ),
      estimatedBuilderFeesUsd: sum(
        (report) => report.paper.estimatedBuilderFeesUsd,
      ),
    },
    volumeByMarket: [...volume.values()].sort((left, right) =>
      left.symbol.localeCompare(right.symbol),
    ),
    fills: reports
      .flatMap(({ bundleName, performance }) =>
        performance.fills.map((fill) => ({ ...fill, bundleName })),
      )
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)),
    note: "All active bundles. Each fill is labelled with its bundle; Paper estimates and confirmed Live fills remain separate.",
  };
}

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
    marketMaxLeverage: z.number().min(1).max(100).optional(),
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

const rewardShareSettingsSchema = z
  .object({
    selectedAccountIds: z.array(z.string().regex(/^\d+$/)).max(32).default([]),
    poolUsd: z.number().nonnegative().max(10_000_000).default(70_000),
    volumeRewardFraction: z.number().min(0).max(1).default(1),
    incrementUsd: z.number().positive().max(10_000_000).default(32_000),
    fillSizeUsd: z.number().positive().max(10_000_000).nullable().default(null),
    forecast: z.enum(["recent", "none"]).default("recent"),
    scenario: z.enum(["per-market", "cross-market"]).default("per-market"),
    rewardMarketCount: z
      .number()
      .int()
      .positive()
      .max(1_000)
      .nullable()
      .default(null),
    extraCostBps: z.number().min(0).max(1_000).default(0),
    fixedCostUsd: z.number().min(0).max(1_000_000).default(0),
  })
  .strict();

const defaultRewardShareSettings = (): RewardShareSettings =>
  rewardShareSettingsSchema.parse({});

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    CONTROL_HOST: z.string().default("127.0.0.1"),
    CONTROL_PORT: z.coerce.number().int().positive().default(8787),
    DATABASE_PATH: z.string().default("data/maker.db"),
    MAKER_MASTER_KEY: z.string().optional(),
    TESTNET_MAKER_MASTER_KEY: z.string().optional(),
    CONTROL_TOKEN: z.string().min(24).optional(),
    PUBLIC_ORIGIN: z.string().url().default("http://localhost:8788"),
    WALLET_AUTH_BOOTSTRAP: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    SHADOW_PAPER_MODE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    SUI_WHITELIST_OBJECT_ID: optionalObjectId,
    TESTNET_SUI_WHITELIST_OBJECT_ID: optionalObjectId,
    TESTNET_BOOTSTRAP_OPERATOR_ADDRESS: optionalAddress,
    LIVE_TRADING_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    ALLOW_MAINNET: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    SUI_NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),
    TESTNET_EXECUTION_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    SUI_VALIDATOR_GRPC_URL: optionalUrl,
    SUI_FALLBACK_GRPC_URL: optionalUrl,
    AFTERMATH_INTEGRATOR_ID: optionalIntegratorId,
    AFTERMATH_INTEGRATOR_FEE_BPS: z.coerce.number().min(0).max(5).default(1),
  })
  .superRefine((env, context) => {
    if (env.SUI_NETWORK === "testnet" && env.MAKER_MASTER_KEY) {
      context.addIssue({
        code: "custom",
        path: ["MAKER_MASTER_KEY"],
        message:
          "MAKER_MASTER_KEY is forbidden on Testnet; use TESTNET_MAKER_MASTER_KEY",
      });
    }
    if (env.SUI_NETWORK === "mainnet" && env.TESTNET_MAKER_MASTER_KEY) {
      context.addIssue({
        code: "custom",
        path: ["TESTNET_MAKER_MASTER_KEY"],
        message:
          "TESTNET_MAKER_MASTER_KEY is only valid when SUI_NETWORK=testnet",
      });
    }
    if (env.SUI_NETWORK === "testnet" && env.SUI_WHITELIST_OBJECT_ID) {
      context.addIssue({
        code: "custom",
        path: ["SUI_WHITELIST_OBJECT_ID"],
        message:
          "SUI_WHITELIST_OBJECT_ID is forbidden on Testnet; use TESTNET_SUI_WHITELIST_OBJECT_ID",
      });
    }
    if (env.SUI_NETWORK === "mainnet" && env.TESTNET_SUI_WHITELIST_OBJECT_ID) {
      context.addIssue({
        code: "custom",
        path: ["TESTNET_SUI_WHITELIST_OBJECT_ID"],
        message:
          "TESTNET_SUI_WHITELIST_OBJECT_ID is only valid when SUI_NETWORK=testnet",
      });
    }
    if (
      env.SUI_NETWORK === "mainnet" &&
      env.TESTNET_BOOTSTRAP_OPERATOR_ADDRESS
    ) {
      context.addIssue({
        code: "custom",
        path: ["TESTNET_BOOTSTRAP_OPERATOR_ADDRESS"],
        message:
          "TESTNET_BOOTSTRAP_OPERATOR_ADDRESS is only valid when SUI_NETWORK=testnet",
      });
    }
    if (
      env.SHADOW_PAPER_MODE &&
      (env.SUI_NETWORK !== "mainnet" ||
        env.MAKER_MASTER_KEY ||
        env.LIVE_TRADING_ENABLED ||
        env.ALLOW_MAINNET)
    ) {
      context.addIssue({
        code: "custom",
        path: ["SHADOW_PAPER_MODE"],
        message:
          "SHADOW_PAPER_MODE requires Mainnet reads with no signing key and both Live gates off",
      });
    }
  });

export type ServerEnv = z.infer<typeof envSchema>;

function executionServerEnabled(env: ServerEnv): boolean {
  return env.SUI_NETWORK === "testnet"
    ? env.TESTNET_EXECUTION_ENABLED
    : env.LIVE_TRADING_ENABLED && env.ALLOW_MAINNET;
}

export function executionSigningKey(env: ServerEnv): string | undefined {
  return env.SUI_NETWORK === "testnet"
    ? env.TESTNET_MAKER_MASTER_KEY
    : env.MAKER_MASTER_KEY;
}

export function executionWhitelistObjectId(env: ServerEnv): string | undefined {
  return env.SUI_NETWORK === "testnet"
    ? env.TESTNET_SUI_WHITELIST_OBJECT_ID
    : env.SUI_WHITELIST_OBJECT_ID;
}

/**
 * A fresh public Testnet database can have one pre-authorized wallet, but
 * never an unbounded first-wallet race. Mainnet keeps its existing auth flow.
 */
export function executionBootstrapOperatorAddress(
  env: ServerEnv,
): string | undefined {
  return env.SUI_NETWORK === "testnet"
    ? env.TESTNET_BOOTSTRAP_OPERATOR_ADDRESS
    : undefined;
}

/** A fresh public Paper shadow has no on-chain registry to read. */
export function shadowPaperBootstrapEnabled(env: ServerEnv): boolean {
  return env.SHADOW_PAPER_MODE && env.WALLET_AUTH_BOOTSTRAP;
}

function executionUnavailableMessage(
  env: ServerEnv,
  operator: boolean,
): string {
  if (env.SUI_NETWORK === "testnet") {
    return operator
      ? "Testnet execution is off on this server. Set TESTNET_EXECUTION_ENABLED=true in control's Testnet environment, then recreate control."
      : "Testnet execution is off on this server. Ask the operator.";
  }
  return operator
    ? "Live is off on this server. Set LIVE_TRADING_ENABLED=true and ALLOW_MAINNET=true in control's .env, then recreate control: docker compose up -d --no-build --force-recreate control."
    : "Live is off on this server. The operator wallet can turn it on. If you run this server, sign in with the wallet that first set it up.";
}

function secretMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

type RequestAuth = {
  ownerAddress: string;
  operator: boolean;
};
type AuthenticatedRequest = FastifyRequest & { makerAuth?: RequestAuth };

export type ServerDeps = {
  env: ServerEnv;
  store: Store;
  runtimeManager: RuntimeManager;
  auth: WalletAuth;
  allowlist: OnchainAllowlist;
  clock?: () => Date;
};

export async function buildServer({
  env,
  store,
  runtimeManager,
  auth,
  allowlist,
  clock = () => new Date(),
}: ServerDeps) {
  const builderCode = (): BuilderFeePolicy | null =>
    activeBuilderCode({
      confirmedIntegratorId: store.getSystemValue<number>(
        "aftermath_integrator_id",
      ),
      configuredIntegratorId: env.AFTERMATH_INTEGRATOR_ID,
      feeBps: env.AFTERMATH_INTEGRATOR_FEE_BPS,
    });

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
    // A signed-in owner's dashboard polls every few seconds from each open
    // device and view, so the owner budget is larger than the anonymous one.
    max: (_request, key) => (key.startsWith("owner:") ? 600 : 120),
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

  const logRequestError = createRequestErrorRecorder(
    (owner, event) => store.forTenant(owner).logEvent(event),
    () => clock().getTime(),
  );
  app.setErrorHandler((error, request, reply) => {
    const response = classifyHttpError(
      request.routeOptions.url === "/api/access-requests" &&
        (error as { statusCode?: number }).statusCode === 429
        ? new UserFacingError(
            "access-request-limit",
            "You've sent 3 requests this hour. Try again later.",
            undefined,
            429,
          )
        : error,
    );
    if (response.status >= 500) {
      request.log.error(
        { err: error, correlationId: request.id },
        "request failed",
      );
    } else {
      request.log.info(
        { status: response.status, error: response.internalMessage },
        "request rejected",
      );
    }
    const owner =
      (request as AuthenticatedRequest).makerAuth?.ownerAddress ?? null;
    // A throttled poll retries on its own; it isn't something to act on, so
    // it stays out of the owner's activity log.
    if (
      owner &&
      response.status !== 401 &&
      response.status !== 403 &&
      response.code !== "rate-limited"
    ) {
      try {
        const params = (request.params ?? {}) as Record<string, unknown>;
        const bundleId = safeAuditId(params.bundleId);
        const strategyId = safeAuditId(params.strategyId);
        logRequestError({
          owner,
          path: request.routeOptions.url ?? request.url,
          reference: String(request.id),
          response,
          ...(bundleId ? { bundleId } : {}),
          ...(strategyId ? { strategyId } : {}),
        });
      } catch (auditError) {
        request.log.error(
          { err: auditError, correlationId: request.id },
          "request failure audit failed",
        );
      }
    }
    reply.code(response.status).send({
      error: response.publicMessage,
      ...(response.code
        ? {
            code: response.code,
            ...(response.fix ? { fix: response.fix } : {}),
          }
        : {}),
      ...(response.status >= 500 ? { requestId: String(request.id) } : {}),
    });
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
    // Paper estimates use the owner's read-only account summaries.  Requiring
    // an agent capability here would turn creating a disposable Paper strategy
    // into an on-chain authorization flow.  Live continues to require the
    // confirmed account capability below.
    if (config.mode === "paper") return;
    if (config.makerAccountId) {
      const makerAccount = scoped.getAccountSetup(config.makerAccountId);
      if (!makerAccount?.agentCapId) {
        throw new UserFacingError(
          "account-not-authorized",
          "Authorize the selected Maker account in Venues before continuing.",
          { kind: "venues" },
        );
      }
    }
    if (config.hedge.enabled && config.hedge.accountId) {
      const hedgeAccount = scoped.getAccountSetup(config.hedge.accountId);
      if (!hedgeAccount?.agentCapId) {
        throw new UserFacingError(
          "account-not-authorized",
          "Authorize the selected hedge account in Venues before continuing.",
          { kind: "venues" },
        );
      }
    }
  }

  function assertLiveModeEnabled(
    config: ReturnType<typeof makerConfigSchema.parse>,
    operator = false,
  ): void {
    if (config.mode === "observe") {
      throw new UserFacingError(
        "mode-required",
        "Choose Paper or Live mode before saving.",
        { kind: "bundles" },
        400,
      );
    }
    if (config.mode === "live" && !executionServerEnabled(env)) {
      throw new UserFacingError(
        "live-unavailable",
        operator
          ? executionUnavailableMessage(env, true)
          : executionUnavailableMessage(env, false),
        { kind: "bundles" },
      );
    }
  }

  app.get("/health", async () => ({
    ...buildIdentity,
    ok: true,
    service: "aftermath-maker-control",
    time: clock().toISOString(),
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
      ...buildIdentity,
      snapshot: active.snapshot,
      bundles: runtimeManager.bundleSnapshots(identity.ownerAddress),
      activeEndpoint: active.activeEndpoint,
      endpoints: active.endpointHealth,
      liveGates: {
        liveTradingEnabled: env.LIVE_TRADING_ENABLED,
        mainnetAllowed: env.ALLOW_MAINNET,
        executionNetwork: env.SUI_NETWORK,
        testnetExecutionEnabled: env.TESTNET_EXECUTION_ENABLED,
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
      throw new UserFacingError(
        "bundles-rolled-back",
        "Bundles rolled back. Refresh Bundles before continuing.",
        { kind: "bundles" },
      );
    }
    scoped.ensureDefaultStrategies();
    return {
      strategies: scoped
        .listStrategies()
        .filter((strategy) => !strategy.archivedAt),
    };
  });

  app.get("/api/strategies/:strategyId", async (request) => {
    const scoped = tenant(request);
    if (scoped.bundlesRolledBack()) {
      throw new UserFacingError(
        "bundles-rolled-back",
        "Bundles rolled back. Refresh Bundles before continuing.",
        { kind: "bundles" },
      );
    }
    const params = z
      .object({ strategyId: z.string().min(1).max(200) })
      .parse(request.params);
    const strategy = scoped.getStrategy(params.strategyId);
    if (!strategy || strategy.archivedAt) {
      throw new UserFacingError(
        "strategy-not-found",
        "This strategy is no longer available. Choose a strategy in Strategy.",
        { kind: "strategy" },
        404,
      );
    }
    return { strategy };
  });

  app.get("/api/strategies/:strategyId/results", async (request) => {
    const scoped = tenant(request);
    const params = z
      .object({ strategyId: z.string().min(1).max(200) })
      .parse(request.params);
    const strategy = scoped.getStrategy(params.strategyId);
    if (!strategy || strategy.archivedAt) {
      throw new UserFacingError(
        "strategy-not-found",
        "This strategy is no longer available. Choose a strategy in Strategy.",
        { kind: "strategy" },
        404,
      );
    }
    const owner = requestAuth(request).ownerAddress;
    const attachments = scoped.listStrategyAttachments(params.strategyId);
    const markets = await runtime(request)
      .listMarkets(USDC_COIN_TYPE)
      .catch(() => []);
    const marks = new Map(
      markets
        .filter((market) => Number.isFinite(market.indexPrice))
        .map((market) => [market.id, market.indexPrice]),
    );
    const day = (iso: string) =>
      new Date(iso).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
    const paperFills: StrategyResultFill[] = [];
    const paperEvidence = new Map<
      string,
      {
        marketId: string;
        symbol: string;
        fills: number;
        makerFills: number;
        volumeUsd: number;
        knownFeesUsd: number;
        feeTermsMissing: number;
        markout5mUsd: number;
        markout5mMeasuredFills: number;
        markout5mUnavailableFills: number;
      }
    >();
    const paperGas: Array<{
      gasUsedMist: number | null;
      suiUsd: number | null;
    }> = [];
    const paperAdverseSelection = new Map<
      string,
      Array<{
        fillAtMs: number;
        sizeUsd: number;
        markoutUsd: number | null;
        coverage: "complete" | "partial" | "stale" | "unavailable";
      }>
    >();
    const paperGaps = ["Funding isn't simulated in Paper yet."];
    const liveFills: StrategyResultFill[] = [];
    const liveGas: Array<{
      gasUsedMist: number | null;
      suiUsd: number | null;
    }> = [];
    const liveGaps: string[] = [];
    let liveFundingUsd: number | null = 0;
    let liveUnrealizedUsd = 0;
    let liveReadError: string | null = null;
    let paperFeeTermsMissing = 0;
    const prunedSince = (
      table: Parameters<typeof scoped.historyKeptSince>[0],
      attachedAt: string,
    ) => {
      const kept = scoped.historyKeptSince(table);
      return kept && kept > attachedAt ? kept : null;
    };
    for (const attachment of attachments) {
      for (const fill of scoped.listStrategyPaperFills(attachment)) {
        const feeTermsKnown =
          fill.venueFeeUsd !== null && fill.builderFeeUsd !== null;
        paperFills.push({
          occurredAt: fill.occurredAt,
          marketId: fill.marketId,
          account: `${attachment.bundleId}:${fill.role}`,
          side: fill.side,
          price: fill.price,
          sizeUsd: fill.sizeUsd,
          executionFeeUsd: fill.venueFeeUsd ?? 0,
          builderFeeUsd: fill.builderFeeUsd ?? 0,
        });
        const evidence = paperEvidence.get(fill.marketId) ?? {
          marketId: fill.marketId,
          symbol: fill.symbol,
          fills: 0,
          makerFills: 0,
          volumeUsd: 0,
          knownFeesUsd: 0,
          feeTermsMissing: 0,
          markout5mUsd: 0,
          markout5mMeasuredFills: 0,
          markout5mUnavailableFills: 0,
        };
        evidence.fills += 1;
        evidence.makerFills += fill.kind === "quote" ? 1 : 0;
        evidence.volumeUsd += fill.sizeUsd;
        if (feeTermsKnown) {
          evidence.knownFeesUsd +=
            (fill.venueFeeUsd ?? 0) + (fill.builderFeeUsd ?? 0);
        } else {
          evidence.feeTermsMissing += 1;
          paperFeeTermsMissing += 1;
        }
        paperEvidence.set(fill.marketId, evidence);
        if (fill.kind !== "quote")
          paperGaps.push("Gas for Paper hedges and closes isn't estimated.");
      }
      for (const markout of scoped.listStrategyPaperMarkouts(attachment)) {
        const evidence = paperEvidence.get(markout.marketId);
        if (!evidence) continue;
        if (markout.coverage === "complete" && markout.markoutUsd !== null) {
          evidence.markout5mUsd += markout.markoutUsd;
          evidence.markout5mMeasuredFills += 1;
        } else {
          evidence.markout5mUnavailableFills += 1;
        }
        const observations = paperAdverseSelection.get(markout.marketId) ?? [];
        observations.push({
          fillAtMs: markout.fillAtMs,
          sizeUsd: markout.sizeUsd,
          markoutUsd: markout.markoutUsd,
          coverage: markout.coverage,
        });
        paperAdverseSelection.set(markout.marketId, observations);
      }
      paperGas.push(...scoped.listStrategyGas(attachment, "paper"));
      const paperPruned =
        prunedSince("tenant_paper_fills", attachment.attachedAt) ??
        prunedSince("tenant_executions", attachment.attachedAt);
      if (paperPruned)
        paperGaps.push(
          `History before ${day(paperPruned)} was pruned, so earlier Paper activity isn't counted.`,
        );

      liveGas.push(...scoped.listStrategyGas(attachment, "live"));
      const livePruned =
        prunedSince("tenant_executions", attachment.attachedAt) ??
        prunedSince("tenant_hedge_executions", attachment.attachedAt);
      if (livePruned)
        liveGaps.push(
          `Gas before ${day(livePruned)} was pruned from history and isn't counted.`,
        );
      const bundle = scoped.getStoredBundle(attachment.bundleId);
      if (!bundle || bundle.archivedAt) continue;
      try {
        const bundleRuntime = runtimeManager.getBundle(owner, bundle.id);
        const performance = await bundleRuntime.performance({
          period: "EPOCH",
          since: attachment.attachedAt,
        });
        if (!performance.historyComplete)
          liveGaps.push("Live fill history is incomplete.");
        let attachmentLiveFills = 0;
        for (const fill of performance.fills) {
          if (fill.estimated) continue;
          if (fill.occurredAt < attachment.attachedAt) continue;
          if (attachment.detachedAt && fill.occurredAt >= attachment.detachedAt)
            continue;
          attachmentLiveFills += 1;
          liveFills.push({
            occurredAt: fill.occurredAt,
            marketId: fill.marketId,
            account: `${bundle.id}:${fill.role}`,
            side: fill.side,
            price: fill.price,
            sizeUsd: fill.notionalUsd,
            executionFeeUsd: fill.protocolFeesUsd,
            builderFeeUsd: fill.estimatedBuilderFeeUsd,
            realizedPnlUsd: fill.realizedPnlUsd,
          });
        }
        if (!attachmentLiveFills) continue;
        // Funding comes from the maker account's history since the strategy
        // was attached, so it can only be separated for a current attachment.
        if (attachment.detachedAt) {
          liveFundingUsd = null;
          liveGaps.push("Funding from earlier runs isn't separated yet.");
        } else if (performance.account === null) {
          liveFundingUsd = null;
          liveGaps.push("Account funding history couldn't be read.");
        } else if (liveFundingUsd !== null) {
          liveFundingUsd += performance.account.fundingPnlUsd;
        }
        if (performance.hedge.enabled)
          liveGaps.push("Hedge account funding isn't read yet.");
        if (!attachment.detachedAt && bundle.mode === "live")
          liveUnrealizedUsd +=
            bundleRuntime.snapshot.portfolio.unrealizedPnlUsd ?? 0;
      } catch (error) {
        liveReadError = error instanceof Error ? error.message : String(error);
      }
    }
    if (paperFeeTermsMissing) {
      paperGaps.push(
        `${paperFeeTermsMissing} legacy Paper ${paperFeeTermsMissing === 1 ? "fill has" : "fills have"} no retained fee terms, so those fees aren't counted.`,
      );
    }
    if (liveReadError) liveGaps.push("Live fills couldn't be read just now.");
    const gasResult = (
      rows: Array<{ gasUsedMist: number | null; suiUsd: number | null }>,
      gaps: string[],
    ) => {
      const gas = gasCostUsd(rows);
      if (gas.unpriced)
        gaps.push(
          `${gas.unpriced} ${gas.unpriced === 1 ? "transaction has" : "transactions have"} no SUI price, so ${gas.unpriced === 1 ? "its" : "their"} gas isn't counted.`,
        );
      return gas.usd;
    };
    // Only the fields the collateral rule reads; accounts and mode don't matter.
    const requiredCollateralUsd = requiredMakerCollateralUsd({
      ...strategy.config,
      markets: strategy.markets,
    } as unknown as MakerConfig);
    return {
      results: {
        requiredCollateralUsd,
        paper: summarizeStrategyResult({
          fills: paperFills,
          marks,
          requiredCollateralUsd,
          fundingUsd: null,
          gasUsd: gasResult(paperGas, paperGaps),
          gaps: paperGaps,
        }),
        paperEvidence: [...paperEvidence.values()]
          .map((row) => {
            const adverseSelection = evaluatePaperAdverseSelection({
              asOfMs: Date.now(),
              observations: paperAdverseSelection.get(row.marketId) ?? [],
            });
            return {
              ...row,
              markout5mUsd:
                row.markout5mMeasuredFills > 0 ? row.markout5mUsd : null,
              adverseSelection,
            };
          })
          .sort((left, right) => left.symbol.localeCompare(right.symbol)),
        live: summarizeStrategyResult({
          fills: liveFills,
          marks,
          requiredCollateralUsd,
          reportedRealized: true,
          unrealizedPnlUsd: liveUnrealizedUsd,
          fundingUsd: liveFundingUsd,
          gasUsd: gasResult(liveGas, liveGaps),
          gaps: liveGaps,
        }),
        liveReadError,
      },
      attachments,
    };
  });

  app.post("/api/strategies", async (request) => {
    const scoped = tenant(request);
    if (scoped.bundlesRolledBack()) {
      throw new UserFacingError(
        "bundles-rolled-back",
        "Bundles rolled back. Refresh Bundles before continuing.",
        { kind: "bundles" },
      );
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
      throw new UserFacingError(
        "bundles-rolled-back",
        "Bundles rolled back. Refresh Bundles before continuing.",
        { kind: "bundles" },
      );
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
    let result: ReturnType<typeof scoped.updateStrategy>;
    try {
      result = scoped.updateStrategy({
        ...body,
        strategyId: params.strategyId,
      });
    } catch (error) {
      if (error instanceof UserFacingError) throw error;
      if (
        error instanceof Error &&
        (error.message.includes("Strategy changed elsewhere") ||
          error.message.includes("already quoted by"))
      )
        throw new UserFacingError("strategy-conflict", error.message, {
          kind: "strategy",
        });
      throw error;
    }
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
      throw new UserFacingError(
        "bundles-rolled-back",
        "Bundles rolled back. Refresh Bundles before continuing.",
        { kind: "bundles" },
      );
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
      throw new UserFacingError(
        "bundles-rolled-back",
        "Bundles rolled back. Refresh Bundles before continuing.",
        { kind: "bundles" },
      );
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

  /** One venue read per request; readiness is then derived from it. */
  async function readOwnerVenue(
    scoped: TenantStore,
    ownerAddress: string,
    strict: boolean,
  ): Promise<{
    accounts: OwnerAccountSummary[] | null;
    gasSui: number | null;
    agentCapabilities: AgentAccountCapability[] | null;
  }> {
    const agent = scoped.getAgent();
    let accounts: OwnerAccountSummary[] | null = null;
    let gasSui: number | null = null;
    let agentCapabilities: AgentAccountCapability[] | null = null;
    try {
      const gateway = runtimeManager.get(ownerAddress).requireGateway();
      accounts = await withTimeout(
        gateway.listOwnerAccounts({
          walletAddress: ownerAddress,
          collateralCoinType: USDC_COIN_TYPE,
        }),
        VENUE_READ_TIMEOUT_MS,
        "Owner account read timed out",
      );
      if (agent) {
        const [gas, capabilities] = await Promise.allSettled([
          withTimeout(
            gateway.getTradingKeyGasSui(agent.address),
            VENUE_READ_TIMEOUT_MS,
            "Trading key gas read timed out",
          ),
          withTimeout(
            gateway.listAgentAccountCapabilities({
              agentAddress: agent.address,
              collateralCoinType: USDC_COIN_TYPE,
            }),
            VENUE_READ_TIMEOUT_MS,
            "Trading-key capability read timed out",
          ),
        ]);
        gasSui = gas.status === "fulfilled" ? gas.value : null;
        agentCapabilities =
          capabilities.status === "fulfilled" ? capabilities.value : null;
        if (agentCapabilities) {
          scoped.reconcileAgentGrants({
            accounts,
            agentCapabilities,
          });
        }
      }
    } catch {
      if (strict) {
        throw new UserFacingError(
          "venue-read-unavailable",
          "Maker couldn't check account data right now. Try again in a minute.",
          { kind: "venues" },
          503,
        );
      }
      // Bundles still renders waiting stages during an unavailable venue read.
    }
    return { accounts, gasSui, agentCapabilities };
  }

  /**
   * Each bundle's readiness in its current mode, except `asLive` bundles,
   * which are judged as if switched to Live alongside every running Live
   * bundle (their shared gas reserve included).
   */
  function deriveOwnerBundleReadiness(
    scoped: TenantStore,
    venue: { accounts: OwnerAccountSummary[] | null; gasSui: number | null },
    asLive: ReadonlySet<string>,
  ): Map<string, BundleReadiness> {
    const bundles = scoped.listBundles().filter((bundle) => !bundle.archivedAt);
    const authorizedAccountIds = new Set(
      scoped
        .listAccountSetups()
        .filter((entry) => entry.agentCapId)
        .map((entry) => entry.accountId),
    );
    const runningLive = bundles.flatMap((bundle) => {
      const config = scoped.getBundleConfig(bundle.id);
      return bundle.status === "running" && config?.mode === "live"
        ? [config]
        : [];
    });
    return new Map(
      bundles.map((bundle) => {
        const storedConfig = scoped.getBundleConfig(bundle.id);
        const config =
          storedConfig && asLive.has(bundle.id)
            ? makerConfigSchema.parse({ ...storedConfig, mode: "live" })
            : storedConfig;
        const liveConfigs =
          config?.mode === "live" && bundle.status !== "running"
            ? [...runningLive, config]
            : runningLive;
        return [
          bundle.id,
          deriveBundleReadiness({
            bundle,
            config,
            accounts: venue.accounts,
            authorizedAccountIds,
            gasSui: venue.gasSui,
            liveConfigs,
          }),
        ];
      }),
    );
  }

  async function ownerBundleReadiness(
    scoped: TenantStore,
    ownerAddress: string,
    strict = false,
    liveCandidateBundleId?: string,
  ): Promise<Map<string, BundleReadiness>> {
    return deriveOwnerBundleReadiness(
      scoped,
      await readOwnerVenue(scoped, ownerAddress, strict),
      new Set(liveCandidateBundleId ? [liveCandidateBundleId] : []),
    );
  }

  app.get("/api/bundles", async (request) => {
    const scoped = tenant(request);
    if (scoped.bundlesRolledBack()) {
      throw new UserFacingError(
        "bundles-rolled-back",
        "Bundles rolled back. Refresh Bundles before continuing.",
        { kind: "bundles" },
      );
    }
    const owner = requestAuth(request).ownerAddress;
    const bundles = scoped.listBundles();
    const venue = await readOwnerVenue(scoped, owner, false);
    const readiness = deriveOwnerBundleReadiness(scoped, venue, new Set());
    // Any bundle can go Live; each is judged as if it joined the running
    // Live bundles, so Go live shows that bundle's own checklist.
    const paperBundleIds = new Set(
      bundles
        .filter((bundle) => !bundle.archivedAt && bundle.mode === "paper")
        .map((bundle) => bundle.id),
    );
    const asLive = deriveOwnerBundleReadiness(scoped, venue, paperBundleIds);
    const serverEnabled = executionServerEnabled(env);
    const signerReady = Boolean(executionSigningKey(env));
    return {
      bundles: bundles.map((bundle) => ({
        ...bundle,
        readiness: readiness.get(bundle.id) ?? null,
      })),
      walletLimits: scoped.getWalletLimits(),
      liveReadiness: bundles
        .filter((bundle) => paperBundleIds.has(bundle.id))
        .map((bundle) => {
          const bundleReadiness = asLive.get(bundle.id) ?? null;
          const stopped =
            bundle.status === "stopped" || bundle.status === "paused";
          return {
            bundleId: bundle.id,
            serverEnabled,
            signerReady,
            stopped,
            readiness: bundleReadiness,
            ready: Boolean(
              serverEnabled && signerReady && stopped && bundleReadiness?.ready,
            ),
          };
        }),
    };
  });

  app.get("/api/bundles/:bundleId/config", async (request) => {
    const scoped = tenant(request);
    if (scoped.bundlesRolledBack()) {
      throw new UserFacingError(
        "bundles-rolled-back",
        "Bundles rolled back. Refresh Bundles before continuing.",
        { kind: "bundles" },
      );
    }
    const params = z
      .object({ bundleId: z.string().min(1).max(200) })
      .parse(request.params);
    const config = scoped.getBundleConfig(params.bundleId);
    if (!config)
      throw new UserFacingError(
        "bundle-not-found",
        "This bundle is no longer available. Refresh Bundles and choose an active bundle.",
        { kind: "bundles" },
        404,
      );
    return { config };
  });

  app.post("/api/bundles/wallet-limits", async (request) => {
    const scoped = tenant(request);
    if (scoped.bundlesRolledBack()) {
      throw new UserFacingError(
        "bundles-rolled-back",
        "Bundles rolled back. Refresh Bundles before continuing.",
        { kind: "bundles" },
      );
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
      throw new UserFacingError(
        "bundles-rolled-back",
        "Bundles rolled back. Refresh Bundles before continuing.",
        { kind: "bundles" },
      );
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
            mode: z.literal("paper"),
            /** Compatibility-only: canonical markets come from strategyId. */
            markets: z.array(bundleMarketSchema).min(1).max(64).optional(),
            strategyId: z.string().min(1).max(200).nullable(),
            confirmWalletLimits: z.boolean().optional(),
          })
          .strict(),
      ])
      .parse(request.body);
    let bundle: ReturnType<typeof scoped.createAllocatedBundle>;
    try {
      bundle =
        "config" in body
          ? (() => {
              const config = makerConfigSchema.parse(body.config);
              assertLiveModeEnabled(config, requestAuth(request).operator);
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
              if (body.strategyId && !body.makerAccountId) {
                throw new UserFacingError(
                  "account-required",
                  "Select a Maker account in Bundles before creating this bundle.",
                  { kind: "bundles" },
                  400,
                );
              }
              const selectedStrategy = body.strategyId
                ? scoped.getStrategy(body.strategyId)
                : null;
              if (
                selectedStrategy &&
                !selectedStrategy.archivedAt &&
                selectedStrategy.config.hedge.enabled &&
                !body.takerAccountId
              ) {
                throw new UserFacingError(
                  "hedge-account-required",
                  "Choose a separate hedge account in Bundles before creating this bundle.",
                  { kind: "bundles" },
                  400,
                );
              }
              // Paper allocation is read-only until Start, where owner
              // account discovery validates the selected account.  Do not
              // require a persistent agent capability just to save a draft.
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
    } catch (error) {
      if (
        error instanceof AuthError ||
        error instanceof UserFacingError ||
        (error instanceof Error && error.name === "ZodError")
      )
        throw error;
      const expected = bundleCreateHttpError(error);
      if (expected)
        throw new UserFacingError(
          "bundle-precondition",
          expected.message,
          { kind: "bundles" },
          expected.status,
        );
      throw error;
    }
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
      throw new UserFacingError(
        "bundles-rolled-back",
        "Bundles rolled back. Refresh Bundles before continuing.",
        { kind: "bundles" },
      );
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
    const current = scoped.getStoredBundle(params.bundleId);
    if (!current || current.archivedAt) {
      throw new UserFacingError(
        "bundle-not-found",
        "This bundle is no longer available. Refresh Bundles and choose an active bundle.",
        { kind: "bundles" },
        404,
      );
    }
    assertLiveModeEnabled(config, requestAuth(request).operator);
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
      throw new UserFacingError(
        "bundles-rolled-back",
        "Bundles rolled back. Refresh Bundles before continuing.",
        { kind: "bundles" },
      );
    }
    const params = z
      .object({ bundleId: z.string().min(1).max(200) })
      .parse(request.params);
    const body = z
      .object({
        makerAccountId: z.string().regex(/^\d+$/).nullable().optional(),
        takerAccountId: z.string().regex(/^\d+$/).nullable().optional(),
        mode: z.literal("paper").optional(),
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
    // This endpoint updates a Paper allocation only.  Account ownership is
    // checked by the owner-scoped venue read at Start, not by an agent key.
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

  app.post("/api/bundles/:bundleId/mode", async (request) => {
    const scoped = tenant(request);
    const params = z
      .object({ bundleId: z.string().min(1).max(200) })
      .parse(request.params);
    const body = z
      .object({
        mode: z.enum(["paper", "live"]),
        confirmed: z.boolean(),
      })
      .strict()
      .parse(request.body);
    if (!body.confirmed) {
      throw new UserFacingError(
        "live-confirmation-required",
        "Confirm that Maker will trade real funds before switching to Live.",
        { kind: "bundles" },
        409,
      );
    }
    const bundle = scoped.getStoredBundle(params.bundleId);
    if (!bundle || bundle.archivedAt) {
      throw new UserFacingError(
        "bundle-not-found",
        "This bundle is no longer available. Refresh Bundles and choose an active bundle.",
        { kind: "bundles" },
        404,
      );
    }
    if (bundle.status !== "stopped" && bundle.status !== "paused") {
      throw new UserFacingError(
        "mode-requires-stopped",
        "Stop or pause this bundle before changing its mode.",
        { kind: "bundles" },
        409,
      );
    }
    let liveReadiness: BundleReadiness | null = null;
    if (body.mode === "live") {
      if (!executionServerEnabled(env)) {
        throw new UserFacingError(
          "live-unavailable",
          requestAuth(request).operator
            ? executionUnavailableMessage(env, true)
            : executionUnavailableMessage(env, false),
          { kind: "bundles" },
          409,
        );
      }
      if (!executionSigningKey(env)) {
        throw new UserFacingError(
          "live-signer-missing",
          "The control signing key is unavailable.",
          { kind: "bundles" },
          409,
        );
      }
      liveReadiness =
        (
          await ownerBundleReadiness(
            scoped,
            requestAuth(request).ownerAddress,
            true,
            bundle.id,
          )
        ).get(bundle.id) ?? null;
      assertBundleReadyToStart(bundle, liveReadiness ?? undefined);
    }
    const updated = scoped.updateBundleMode({
      bundleId: bundle.id,
      mode: body.mode,
    });
    scoped.logEvent({
      category: "bundles",
      action: "mode.update",
      outcome: "success",
      detail: { name: updated.name, from: bundle.mode, to: body.mode },
    });
    return {
      bundle: updated,
      ...(liveReadiness ? { liveReadiness } : {}),
    };
  });

  app.post("/api/bundles/:bundleId/start", async (request) => {
    const scoped = tenant(request);
    if (scoped.bundlesRolledBack()) {
      throw new UserFacingError(
        "bundles-rolled-back",
        "Bundles rolled back. Refresh Bundles before continuing.",
        { kind: "bundles" },
      );
    }
    const params = z
      .object({ bundleId: z.string().min(1).max(200) })
      .parse(request.params);
    const bundle = scoped.getStoredBundle(params.bundleId);
    if (!bundle || bundle.archivedAt) {
      throw new UserFacingError(
        "bundle-not-found",
        "This bundle is no longer available. Refresh Bundles and choose an active bundle.",
        { kind: "bundles" },
        404,
      );
    }
    if (bundle.needsStrategy) {
      throw new UserFacingError(
        "bundle-not-ready-strategy",
        `Attach a strategy in Bundles before starting ${bundle.name}.`,
        { kind: "bundles" },
      );
    }
    const config = scoped.getBundleConfig(params.bundleId);
    if (!config)
      throw new UserFacingError(
        "bundle-not-found",
        "This bundle is no longer available. Refresh Bundles and choose an active bundle.",
        { kind: "bundles" },
        404,
      );
    assertLiveModeEnabled(config, requestAuth(request).operator);
    assertBundleReadyToStart(
      bundle,
      (
        await ownerBundleReadiness(
          scoped,
          requestAuth(request).ownerAddress,
          true,
        )
      ).get(bundle.id),
    );
    const started = runtimeManager.startBundle(
      requestAuth(request).ownerAddress,
      params.bundleId,
    );
    return started;
  });

  app.post("/api/bundles/:bundleId/resume", async (request) => {
    const scoped = tenant(request);
    if (scoped.bundlesRolledBack()) {
      throw new UserFacingError(
        "bundles-rolled-back",
        "Bundles rolled back. Refresh Bundles before continuing.",
        { kind: "bundles" },
      );
    }
    const params = z
      .object({ bundleId: z.string().min(1).max(200) })
      .parse(request.params);
    const bundle = scoped.getStoredBundle(params.bundleId);
    if (!bundle || bundle.archivedAt) {
      throw new UserFacingError(
        "bundle-not-found",
        "This bundle is no longer available. Refresh Bundles and choose an active bundle.",
        { kind: "bundles" },
        404,
      );
    }
    if (bundle.needsStrategy) {
      throw new UserFacingError(
        "bundle-not-ready-strategy",
        `Attach a strategy in Bundles before starting ${bundle.name}.`,
        { kind: "bundles" },
      );
    }
    const config = scoped.getBundleConfig(params.bundleId);
    if (!config)
      throw new UserFacingError(
        "bundle-not-found",
        "This bundle is no longer available. Refresh Bundles and choose an active bundle.",
        { kind: "bundles" },
        404,
      );
    assertLiveModeEnabled(config, requestAuth(request).operator);
    assertBundleReadyToStart(
      bundle,
      (
        await ownerBundleReadiness(
          scoped,
          requestAuth(request).ownerAddress,
          true,
        )
      ).get(bundle.id),
    );
    return runtimeManager.startBundle(
      requestAuth(request).ownerAddress,
      params.bundleId,
    );
  });

  app.post("/api/bundles/:bundleId/pause", async (request) => {
    const scoped = tenant(request);
    if (scoped.bundlesRolledBack()) {
      throw new UserFacingError(
        "bundles-rolled-back",
        "Bundles rolled back. Refresh Bundles before continuing.",
        { kind: "bundles" },
      );
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
      throw new UserFacingError(
        "bundles-rolled-back",
        "Bundles rolled back. Refresh Bundles before continuing.",
        { kind: "bundles" },
      );
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
        problems: z.enum(["1"]).optional(),
      })
      .parse(request.query);
    if (
      query.bundle &&
      query.bundle !== "before" &&
      !tenant(request).getStoredBundle(query.bundle)
    ) {
      throw new UserFacingError(
        "bundle-not-found",
        "This bundle is no longer available. Refresh Bundles and choose an active bundle.",
        { kind: "bundles" },
        404,
      );
    }
    return {
      events: tenant(request).listEvents(
        query.limit,
        query.bundle,
        query.problems === "1",
      ),
    };
  });

  app.get("/api/performance", async (request) => {
    const scoped = tenant(request);
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
    const ownerAddress = requestAuth(request).ownerAddress;
    if (!query.bundle) {
      const reports = await Promise.all(
        scoped
          .listBundles()
          .filter((bundle) => !bundle.archivedAt)
          .map(async (bundle) => ({
            bundleName: bundle.name,
            performance: await runtimeManager
              .getBundle(ownerAddress, bundle.id)
              .performance({
                period: query.period,
                ...(query.since ? { since: query.since } : {}),
              }),
          })),
      );
      return { performance: aggregatePerformance(reports) };
    }
    const active = runtimeManager.getBundle(ownerAddress, query.bundle);
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
        objective: z
          .enum(["farming", "profit", "both", "volume"])
          .default("both"),
      })
      .parse(request.query);
    return {
      rewards: await runtime(request).rewardDashboard(
        query.collateralCoinType,
        query.objective,
      ),
    };
  });

  /** Read-only Inventory recycling evidence. Rewards intentionally remain a
   * separate wallet-level collection and are never folded into this ledger. */
  app.get("/api/inventory-recycling", async (request) => {
    const scoped = tenant(request);
    const query = z
      .object({ runId: z.string().min(1).max(200).optional() })
      .strict()
      .parse(request.query);
    const fills = scoped.listAttributedFills(query.runId);
    const effects = scoped.listInventoryLedgerEffects(query.runId);
    return {
      ledger: summarizeInventoryTradingLedger({ fills, effects }),
      reconciliation: scoped.latestInventoryReconciliation(query.runId),
      fills,
      effects,
      marketObservations: scoped.listMarketObservations({ limit: 500 }),
      paperMarkouts: scoped.listInventoryPaperMarkouts(query.runId),
      quoteDecisions: scoped.listInventoryQuoteDecisions(query.runId),
      rewards: scoped.listRewardAllocations(),
    };
  });

  app.get("/api/rewards/share", async (request) => {
    const identity = requestAuth(request);
    const scoped = tenant(request);
    const query = z
      .object({
        accountIds: z.string().optional(),
        scenario: z.enum(["per-market", "cross-market"]).optional(),
        volumeBudgetUsd: z.coerce
          .number()
          .positive()
          .max(100_000_000)
          .optional(),
      })
      .parse(request.query);
    const stored =
      scoped.getRewardShareSettings() ?? defaultRewardShareSettings();
    const ownerAccounts = await runtime(request)
      .requireGateway()
      .listOwnerAccounts({
        walletAddress: identity.ownerAddress,
        collateralCoinType: USDC_COIN_TYPE,
      });
    const allowed = new Set(ownerAccounts.map((account) => account.accountId));
    const selectedAccountIds = query.accountIds
      ? query.accountIds.split(",").filter(Boolean)
      : stored.selectedAccountIds.length
        ? stored.selectedAccountIds
        : ownerAccounts.map((account) => account.accountId);
    if (selectedAccountIds.some((accountId) => !allowed.has(accountId))) {
      throw new AuthError(
        403,
        "Selected account does not belong to the connected wallet",
      );
    }
    const settings = {
      ...stored,
      ...(query.scenario ? { scenario: query.scenario } : {}),
    };
    const snapshot = await runtime(request)
      .requireGateway()
      .getRewardShareSnapshot({
        walletAddress: identity.ownerAddress,
        accountIds: selectedAccountIds,
        collateralCoinType: USDC_COIN_TYPE,
        poolUsd: settings.poolUsd,
        ...(settings.rewardMarketCount
          ? { rewardMarketCount: settings.rewardMarketCount }
          : {}),
      });
    const scoreSettings = {
      scenario: settings.scenario,
      volumeRewardFraction: settings.volumeRewardFraction,
      incrementUsd: settings.incrementUsd,
      ...(settings.fillSizeUsd === null
        ? {}
        : { fillSizeUsd: settings.fillSizeUsd }),
      forecast: settings.forecast,
      extraCostBps: settings.extraCostBps,
      fixedCostUsd: settings.fixedCostUsd,
    } as const;
    const modeledSnapshot = {
      ...snapshot,
      markets: snapshot.markets.map((market) => ({
        ...market,
        cost: {
          ...market.cost,
          builderFeeBps: env.AFTERMATH_INTEGRATOR_FEE_BPS,
        },
      })),
    };
    const rankings = scoreRewardShare(modeledSnapshot, scoreSettings);
    const scenarioTotals = (["per-market", "cross-market"] as const).map(
      (scenario) => ({
        scenario,
        modeledIncrementalRewardUsd: scoreRewardShare(modeledSnapshot, {
          ...scoreSettings,
          scenario,
        }).reduce((total, row) => total + row.modeledAdditionalRewardUsd, 0),
      }),
    );
    return {
      settings: { ...settings, selectedAccountIds },
      snapshot: {
        asOf: snapshot.asOf,
        epochEnd: snapshot.epochEnd,
        rewardMarketCount: snapshot.rewardMarketCount,
        marketCount: snapshot.markets.length,
        flags: snapshot.flags,
      },
      rankings,
      reconciliation: {
        ...snapshot.reconciliation,
        scenarios: scenarioTotals,
      },
      ...(query.volumeBudgetUsd
        ? {
            allocation: allocateRewardShareVolume(
              modeledSnapshot,
              query.volumeBudgetUsd,
              scoreSettings,
            ),
          }
        : {}),
      fetchedAt: new Date().toISOString(),
      stale: Date.now() - Date.parse(snapshot.asOf) > 90 * 60_000,
      incomplete: snapshot.incomplete,
    };
  });

  app.put("/api/rewards/share/settings", async (request) => {
    const identity = requestAuth(request);
    const scoped = tenant(request);
    const settings = rewardShareSettingsSchema.parse(request.body);
    const owned = await runtime(request).requireGateway().listOwnerAccounts({
      walletAddress: identity.ownerAddress,
      collateralCoinType: USDC_COIN_TYPE,
    });
    const allowed = new Set(owned.map((account) => account.accountId));
    if (
      settings.selectedAccountIds.some((accountId) => !allowed.has(accountId))
    ) {
      throw new AuthError(
        403,
        "Selected account does not belong to the connected wallet",
      );
    }
    scoped.setRewardShareSettings(settings);
    scoped.logEvent({
      category: "rewards",
      action: "share.settings.update",
      outcome: "success",
      detail: {
        scenario: settings.scenario,
        accountCount: settings.selectedAccountIds.length,
      },
    });
    return { settings };
  });

  app.get("/api/setup", async (request) => {
    const identity = requestAuth(request);
    const scoped = tenant(request);
    // A deployment can retain Maker's encrypted signer while losing the
    // account-to-cap cache. Refresh that cache from the signer's address
    // before telling the client that a key is missing.
    await readOwnerVenue(scoped, identity.ownerAddress, false);
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
        // Capability IDs are used only to prove a locally held signer still
        // has access. The browser needs the count for clear status copy, not
        // the IDs themselves.
        const { delegatedTradingKeyIds: _delegatedTradingKeyIds, ...visible } =
          account;
        return {
          ...visible,
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

  const depositBatchSchema = z
    .object({
      deposits: z
        .array(collateralMutationSchema)
        .min(1)
        .max(2)
        .refine(
          (items) =>
            new Set(items.map((entry) => entry.accountId)).size ===
            items.length,
          "Choose different accounts for one combined deposit",
        ),
    })
    .strict();

  app.post("/api/accounts/deposit-transaction", async (request) => {
    const identity = requestAuth(request);
    const body = z
      .union([collateralMutationSchema, depositBatchSchema])
      .parse(request.body);
    const active = runtime(request);
    if ("deposits" in body) {
      const deposits = body.deposits.map((entry) => ({
        accountId: entry.accountId,
        amount: decimalToBaseUnits(entry.amountUsdc, 6),
      }));
      if (deposits.some((entry) => entry.amount <= 0n))
        throw new UserFacingError(
          "deposit-amount-invalid",
          "Enter a positive amount for each account.",
          { kind: "venues" },
          400,
        );
      const prepared = await active
        .requireGateway()
        .buildDepositCollateralBatchTransaction({
          ownerAddress: identity.ownerAddress,
          collateralCoinType: USDC_COIN_TYPE,
          deposits,
        });
      tenant(request).logEvent({
        category: "collateral",
        action: "deposit.transaction",
        outcome: "prepared",
        detail: {
          accountIds: deposits.map((entry) => entry.accountId),
          combined: true,
        },
      });
      return prepared;
    }
    const amount = decimalToBaseUnits(body.amountUsdc, 6);
    if (amount <= 0n)
      throw new AuthError(400, "Deposit amount must be positive");
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
    const amount = decimalToBaseUnits(body.amountUsdc, 6);
    if (amount <= 0n) {
      throw new AuthError(400, "Withdrawal amount must be positive");
    }
    const owned = await active.requireGateway().listOwnerAccounts({
      walletAddress: identity.ownerAddress,
      collateralCoinType: USDC_COIN_TYPE,
    });
    const account = owned.find((item) => item.accountId === body.accountId);
    if (!account)
      throw new UserFacingError(
        "account-not-found",
        "Choose an account owned by this wallet in Venues.",
        { kind: "venues" },
        404,
      );
    assertCollateralWithdrawalAllowed({
      accountId: body.accountId,
      amountUsdc: body.amountUsdc,
      bundles: tenant(request)
        .listBundles()
        .filter((bundle) => !bundle.archivedAt),
      openMakerOrderCount: account.openMakerOrderCount,
      withdrawableCollateralUsd: account.withdrawableCollateralUsd,
    });
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

  app.post("/api/setup/gas-transaction", async (request) => {
    const identity = requestAuth(request);
    const body = z
      .object({
        accountId: z.string().regex(/^\d+$/),
        gasMist: z.coerce.bigint(),
      })
      .strict()
      .parse(request.body);
    if (body.gasMist < 10_000_000n || body.gasMist > 10_000_000_000n) {
      throw new UserFacingError(
        "gas-amount-invalid",
        "Enter between 0.01 and 10 SUI to top up a trading key.",
        { kind: "venues" },
        400,
      );
    }
    const scoped = tenant(request);
    const account = scoped.getAccountSetup(body.accountId);
    const agent = scoped.getAgent();
    if (!account?.agentCapId || !agent) {
      throw new UserFacingError(
        "needs-trading-key",
        "Authorize a trading key for this account in Venues before adding gas.",
        { kind: "venues" },
      );
    }
    const prepared = await runtime(request)
      .requireGateway()
      .buildTopUpAgentGasTransaction({
        ownerAddress: identity.ownerAddress,
        accountId: body.accountId,
        collateralCoinType: account.collateralCoinType,
        agentAddress: agent.address,
        gasMist: body.gasMist,
      });
    scoped.logEvent({
      category: "onboarding",
      action: "agent.gas-transaction",
      outcome: "prepared",
      detail: { accountId: body.accountId },
    });
    return prepared;
  });

  app.post("/api/config", async (request) => {
    const scoped = tenant(request);
    const config = makerConfigSchema.parse(request.body);
    assertLiveModeEnabled(config, requestAuth(request).operator);
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
    const signingKey = executionSigningKey(env);
    if (!signingKey) {
      throw new Error(
        env.SUI_NETWORK === "testnet"
          ? "TESTNET_MAKER_MASTER_KEY is not configured"
          : "MAKER_MASTER_KEY is not configured",
      );
    }
    const identity = requestAuth(request);
    const scoped = tenant(request);
    const setup = setupSchema.parse(request.body);
    if (setup.ownerAddress.toLowerCase() !== identity.ownerAddress) {
      throw new AuthError(403, "Setup owner must be the signed-in wallet");
    }
    scoped.setSetup(setup);
    const created = createEncryptedAgent({
      masterKey: signingKey,
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
    if (!setup || !agent)
      throw new UserFacingError(
        "account-setup-required",
        "Provision this account in Venues before continuing.",
        { kind: "venues" },
      );

    const fee = builderCode();
    if (!fee && env.SUI_NETWORK !== "testnet") {
      throw new UserFacingError(
        "builder-registration-required",
        "Venue fee registration is not complete. Ask the operator to complete setup before continuing.",
        { kind: "venues" },
      );
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
    if (!setup || !agent)
      throw new UserFacingError(
        "account-setup-required",
        "Provision this account in Venues before continuing.",
        { kind: "venues" },
      );

    const fee = builderCode();
    if (!fee && env.SUI_NETWORK !== "testnet") {
      throw new UserFacingError(
        "builder-registration-required",
        "Venue fee registration is not complete. Ask the operator to complete setup before continuing.",
        { kind: "venues" },
      );
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
      throw new UserFacingError(
        "account-not-authorized",
        "Authorize the trading key for this account in Venues before continuing.",
        { kind: "venues" },
      );
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
      throw new UserFacingError(
        "orders-open",
        `Cancel ${taggedOrders} open Maker order${taggedOrders === 1 ? "" : "s"} before revoking the trading key.`,
        { kind: "venues" },
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
      throw new UserFacingError(
        "account-not-authorized",
        "Authorize the trading key for this account in Venues before continuing.",
        { kind: "venues" },
      );
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
        mode: revokedMaker ? "paper" : current.mode,
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

  app.post("/api/runtime/paper-trial", async (request) => {
    const body = z
      .object({
        cadenceMs: z.number().int().min(2_000).max(15_000).default(2_000),
      })
      .strict()
      .parse(request.body);
    return {
      result: await runtimeManager.runPaperTrial({
        ownerAddress: requestAuth(request).ownerAddress,
        cadenceMs: body.cadenceMs,
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

  app.post(
    "/api/operator/builder/registration-transaction",
    async (request) => {
      const identity = operatorAuth(request);
      if (builderCode()) {
        throw new Error("An Aftermath integrator ID is already configured");
      }
      return runtime(request)
        .requireGateway()
        .buildIntegratorRegistrationTransaction(identity.ownerAddress);
    },
  );

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
    store.setSystemSetting(
      "aftermath_integrator_id",
      registration.integratorId,
    );
    store.setSystemSetting(
      "aftermath_integrator_address",
      registration.integratorAddress,
    );
    return {
      registration,
      builderCode: builderCode(),
    };
  });

  return app;
}
