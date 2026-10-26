import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { z } from "zod";
import { createEncryptedAgent } from "@puc/aftermath";
import {
  integratorInspectionSchema,
  makerConfigSchema,
  setupSchema,
  USDC_COIN_TYPE,
} from "@puc/core";
import { MakerRuntime } from "./runtime.js";
import { Store } from "./store.js";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  CONTROL_HOST: z.string().default("127.0.0.1"),
  CONTROL_PORT: z.coerce.number().int().positive().default(8787),
  DATABASE_PATH: z.string().default("data/maker.db"),
  MAKER_MASTER_KEY: z.string().optional(),
  CONTROL_TOKEN: z.string().min(24).optional(),
  LIVE_TRADING_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  ALLOW_MAINNET: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SUI_VALIDATOR_GRPC_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional(),
  ),
  SUI_FALLBACK_GRPC_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional(),
  ),
});

const env = envSchema.parse(process.env);
const store = new Store(env.DATABASE_PATH);
const runtime = new MakerRuntime(store, {
  ...(env.MAKER_MASTER_KEY ? { masterKey: env.MAKER_MASTER_KEY } : {}),
  liveEnabled: env.LIVE_TRADING_ENABLED,
  mainnetAllowed: env.ALLOW_MAINNET,
  ...(env.SUI_VALIDATOR_GRPC_URL
    ? { preferredEndpoint: env.SUI_VALIDATOR_GRPC_URL }
    : {}),
  ...(env.SUI_FALLBACK_GRPC_URL
    ? { fallbackEndpoint: env.SUI_FALLBACK_GRPC_URL }
    : {}),
});

const app = Fastify({
  logger: {
    level: env.NODE_ENV === "production" ? "info" : "debug",
    redact: [
      "req.headers.authorization",
      "req.headers.x-control-token",
      "body.encryptedSecret",
    ],
  },
  trustProxy: false,
  bodyLimit: 64 * 1024,
});

await app.register(cors, {
  origin: false,
});
await app.register(rateLimit, {
  max: 120,
  timeWindow: "1 minute",
});

app.addHook("onRequest", async (request, reply) => {
  if (
    request.method === "GET" ||
    request.url === "/health" ||
    request.url === "/ready"
  ) {
    return;
  }
  if (!env.CONTROL_TOKEN) {
    return reply.code(503).send({
      error: "CONTROL_TOKEN is not configured; mutations are disabled",
    });
  }
  if (request.headers["x-control-token"] !== env.CONTROL_TOKEN) {
    return reply.code(401).send({ error: "Invalid control token" });
  }
});

app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error }, "request failed");
  const errorName =
    error && typeof error === "object" && "name" in error
      ? String(error.name)
      : "Error";
  const errorText =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : String(error);
  const status =
    errorName === "ZodError"
      ? 400
      : errorText.includes("not configured")
        ? 503
        : 500;
  reply.code(status).send({
    error: errorText,
  });
});

app.get("/health", async () => ({
  ok: true,
  service: "aftermath-maker-control",
  time: new Date().toISOString(),
}));

app.get("/ready", async (_request, reply) => {
  const ready = Boolean(runtime.activeEndpoint);
  return reply.code(ready ? 200 : 503).send({
    ready,
    activeEndpoint: runtime.activeEndpoint,
    endpoints: runtime.endpointHealth,
  });
});

app.get("/api/status", async () => ({
  snapshot: runtime.snapshot,
  activeEndpoint: runtime.activeEndpoint,
  endpoints: runtime.endpointHealth,
  liveGates: {
    liveTradingEnabled: env.LIVE_TRADING_ENABLED,
    mainnetAllowed: env.ALLOW_MAINNET,
  },
}));

app.get("/api/config", async () => ({
  config: store.getConfig(),
}));

app.get("/api/events", async (request) => {
  const query = z
    .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
    .parse(request.query);
  return { events: store.listEvents(query.limit) };
});

app.get("/api/markets", async (request) => {
  const query = z
    .object({ collateralCoinType: z.string().default(USDC_COIN_TYPE) })
    .parse(request.query);
  return {
    markets: await runtime.listMarkets(query.collateralCoinType),
  };
});

app.get("/api/setup", async () => {
  const setup = store.getSetup();
  const agent = store.getAgent();
  return {
    setup,
    agent: agent
      ? {
          address: agent.address,
          createdAt: agent.createdAt,
          grantDigest: agent.grantDigest,
          agentCapId: agent.agentCapId,
        }
      : null,
  };
});

app.get("/api/accounts", async (request) => {
  const query = z
    .object({
      walletAddress: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      collateralCoinType: z.string().default(USDC_COIN_TYPE),
    })
    .parse(request.query);
  const caps = await runtime.requireGateway().getOwnedAccountCaps(query);
  return {
    accounts: caps
      .filter((cap) => !cap.isAgent)
      .map((cap) => ({
        accountId: cap.accountId.toString(),
        accountCapId: cap.objectId,
        collateralCoinType: cap.collateralCoinType,
        collateral: cap.collateral,
      })),
  };
});

app.post("/api/config", async (request) => {
  const config = makerConfigSchema.parse(request.body);
  if (
    config.mode === "live" &&
    (!env.LIVE_TRADING_ENABLED || !env.ALLOW_MAINNET)
  ) {
    throw new Error(
      "Live mode requires LIVE_TRADING_ENABLED=true and ALLOW_MAINNET=true",
    );
  }
  store.setConfig(config);
  await runtime.reconfigure();
  store.logEvent({
    category: "configuration",
    action: "maker.update",
    outcome: "success",
    detail: {
      marketId: config.marketId,
      mode: config.mode,
      spreadBps: config.spreadBps,
      quoteSizeUsd: config.quoteSizeUsd,
    },
  });
  return { config };
});

app.post("/api/setup/provision", async (request) => {
  if (!env.MAKER_MASTER_KEY) {
    throw new Error("MAKER_MASTER_KEY is not configured");
  }
  const setup = setupSchema.parse(request.body);
  const existingSetup = store.getSetup();
  if (
    existingSetup &&
    (existingSetup.ownerAddress !== setup.ownerAddress ||
      existingSetup.accountId !== setup.accountId)
  ) {
    throw new Error(
      "A different account is already configured; explicit reset is required",
    );
  }
  store.setSetup(setup);
  const created = createEncryptedAgent({
    masterKey: env.MAKER_MASTER_KEY,
    context: `account:${setup.accountId}`,
  });
  const agent = store.createAgent(created);
  store.logEvent({
    category: "onboarding",
    action: "agent.provision",
    outcome: "success",
    detail: {
      ownerAddress: setup.ownerAddress,
      accountId: setup.accountId,
      agentAddress: agent.address,
    },
  });
  return {
    setup,
    agentAddress: agent.address,
    alreadyExisted: agent.address !== created.address,
  };
});

app.post("/api/setup/grant-transaction", async (request) => {
  const body = z
    .object({
      gasMist: z.coerce
        .bigint()
        .min(20_000_000n)
        .max(1_000_000_000n)
        .default(100_000_000n),
    })
    .parse(request.body ?? {});
  const setup = store.getSetup();
  const agent = store.getAgent();
  if (!setup || !agent) throw new Error("Provision the setup first");

  const transaction = await runtime
    .requireGateway()
    .buildGrantAgentTransaction({
      setup,
      agentAddress: agent.address,
      gasMist: body.gasMist,
    });
  return {
    transaction,
    agentAddress: agent.address,
    gasMist: body.gasMist.toString(),
  };
});

app.post("/api/setup/confirm", async (request) => {
  const body = z
    .object({ digest: z.string().min(20).max(100) })
    .parse(request.body);
  const setup = store.getSetup();
  const agent = store.getAgent();
  if (!setup || !agent) throw new Error("Provision the setup first");

  const verified = await runtime.requireGateway().verifyAgentGrant({
    setup,
    agentAddress: agent.address,
  });
  store.confirmAgentGrant({
    digest: body.digest,
    agentCapId: verified.agentCapId,
  });
  store.logEvent({
    category: "onboarding",
    action: "agent.grant",
    outcome: "confirmed",
    detail: {
      digest: body.digest,
      agentCapId: verified.agentCapId,
    },
  });
  await runtime.cycle();
  return {
    confirmed: true,
    agentCapId: verified.agentCapId,
  };
});

app.post("/api/setup/revoke-transaction", async () => {
  const setup = store.getSetup();
  const agent = store.getAgent();
  if (!setup || !agent?.agentCapId) {
    throw new Error("No confirmed agent capability exists");
  }
  return {
    transaction: await runtime.requireGateway().buildRevokeAgentTransaction({
      setup,
      agentCapId: agent.agentCapId,
    }),
  };
});

app.post("/api/runtime/start", async () => {
  runtime.start();
  return { snapshot: runtime.snapshot };
});

app.post("/api/runtime/stop", async () => {
  await runtime.stop();
  return { snapshot: runtime.snapshot };
});

app.post("/api/runtime/cycle", async () => {
  await runtime.cycle();
  return { snapshot: runtime.snapshot };
});

app.post("/api/inspect/builder-fee", async (request) => {
  const input = integratorInspectionSchema.parse(request.body);
  const inspection = await runtime.requireGateway().inspectIntegrator(input);
  store.logEvent({
    category: "inspection",
    action: "builder-fee",
    outcome: "success",
    detail: inspection,
  });
  return { inspection };
});

await runtime.initialize();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await runtime.stop();
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
