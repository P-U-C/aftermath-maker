import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { PROBLEM_OUTCOMES } from "./audit-event-kinds.js";
import { UserFacingError } from "./http-error.js";
import { z } from "zod";
import type { EncryptedSecret } from "@puc/aftermath";
import {
  makerConfigSchema,
  makerMarketSchema,
  type MakerConfig,
  type Setup,
} from "@puc/core";

const BIGINT_TAG = "__maker_bigint__";

const stringify = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? { [BIGINT_TAG]: item.toString() } : item,
  );

const parse = <T>(value: string): T =>
  JSON.parse(value, (_key, item) => {
    if (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      Object.keys(item).length === 1 &&
      typeof item[BIGINT_TAG] === "string" &&
      /^-?\d+$/.test(item[BIGINT_TAG])
    ) {
      return BigInt(item[BIGINT_TAG]);
    }
    return item;
  }) as T;

const normalizeAddress = (address: string) => address.toLowerCase();

const coreBundleId = (ownerAddress: string) =>
  `core-${normalizeAddress(ownerAddress).replace(/^0x/, "")}`;

type StoredMakerConfig = Partial<MakerConfig> & {
  marketId?: string;
  symbol?: string;
  maxDailyLossUsd?: number;
};

const normalizeMakerConfig = (stored: StoredMakerConfig) => {
  const normalized = { ...stored } as Record<string, unknown>;
  let migrated = false;

  if (!normalized.markets && stored.marketId && stored.symbol) {
    normalized.markets = [{ marketId: stored.marketId, symbol: stored.symbol }];
    delete normalized.marketId;
    delete normalized.symbol;
    migrated = true;
  }

  if (
    normalized.maxUnrealizedLossUsd === undefined &&
    stored.maxDailyLossUsd !== undefined
  ) {
    normalized.maxUnrealizedLossUsd = stored.maxDailyLossUsd;
    migrated = true;
  }
  delete normalized.maxDailyLossUsd;

  const marketCount = Array.isArray(normalized.markets)
    ? normalized.markets.length
    : 1;
  if (normalized.maxGrossExposureUsd === undefined) {
    const perMarket =
      typeof normalized.maxInventoryUsd === "number"
        ? normalized.maxInventoryUsd
        : 50;
    normalized.maxGrossExposureUsd = Math.max(
      perMarket,
      perMarket * Math.min(3, marketCount),
    );
    migrated = true;
  }

  if (normalized.maxQuoteAgeMs === undefined) {
    const refreshMs =
      typeof normalized.refreshMs === "number" ? normalized.refreshMs : 8_000;
    normalized.maxQuoteAgeMs = Math.max(
      120_000,
      refreshMs * marketCount + Math.min(10_000, refreshMs),
    );
    migrated = true;
  }

  return { config: makerConfigSchema.parse(normalized), migrated };
};

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
      marketIds: z
        .array(z.string().regex(/^0x[0-9a-fA-F]+$/, "Expected a Sui object ID"))
        .max(64),
    })
    .strict(),
]);

const strategyMarketsSchema = z.array(makerMarketSchema).max(64);

/** Settings that can safely be shared between bundles. Execution allocation
 * (accounts and mode) deliberately remains on the bundle; markets are strategy-owned. */
const strategyConfigSchema = z
  .object({
    collateralCoinType: z.string().min(8),
    rotationMode: z.enum(["portfolio", "single-slot"]),
    strategyObjective: z.enum(["farming", "profit", "both"]),
    strategyProfile: z.enum(["cautious", "balanced", "active"]),
    hedge: z
      .object({
        enabled: z.boolean(),
        thresholdUsd: z.number().positive().max(10_000),
        maxOrderUsd: z.number().positive().max(10_000),
        maxSlippageBps: z.number().int().min(5).max(500),
      })
      .strict(),
    quoteSizeUsd: z.number().positive().max(1_000),
    spreadBps: z.number().min(8).max(500),
    refreshMs: z.number().int().min(2_000).max(300_000),
    marketDwellMs: z.number().int().min(2_000).max(3_600_000),
    requoteThresholdBps: z.number().min(0).max(500),
    maxRestingMs: z.number().int().min(5_000).max(3_600_000),
    autoRebalanceEnabled: z.boolean(),
    rebalanceGrossExposureUsd: z.number().positive().max(100_000),
    maxQuoteAgeMs: z.number().int().min(10_000).max(86_400_000),
    maxInventoryUsd: z.number().positive().max(10_000),
    inventoryTargetUsd: z.number().min(-10_000).max(10_000),
    maxGrossExposureUsd: z.number().positive().max(100_000),
    maxUnrealizedLossUsd: z.number().positive().max(10_000),
    maxRunDrawdownUsd: z.number().positive().max(10_000),
    maxBookDivergenceBps: z.number().positive().max(5_000),
    maxLeverage: z.number().min(1).max(3),
    maxGasMist: z.number().int().positive().max(500_000_000),
    staleBookMs: z.number().int().min(3_000).max(120_000),
    inventorySkewBps: z.number().min(0).max(250),
  })
  .strict()
  .superRefine((config, context) => {
    if (
      config.hedge.enabled &&
      config.hedge.maxOrderUsd < config.hedge.thresholdUsd
    ) {
      context.addIssue({
        code: "custom",
        path: ["hedge", "maxOrderUsd"],
        message: "Maximum hedge order must cover the hedge threshold",
      });
    }
    if (config.autoRebalanceEnabled) {
      if (!config.hedge.enabled) {
        context.addIssue({
          code: "custom",
          path: ["autoRebalanceEnabled"],
          message: "Automatic rebalancing requires paired-account hedging",
        });
      }
      if (config.rebalanceGrossExposureUsd > config.maxGrossExposureUsd) {
        context.addIssue({
          code: "custom",
          path: ["rebalanceGrossExposureUsd"],
          message: "Rebalance exposure must not exceed the hard gross limit",
        });
      }
    }
    if (config.maxGrossExposureUsd < config.maxInventoryUsd) {
      context.addIssue({
        code: "custom",
        path: ["maxGrossExposureUsd"],
        message: "Gross exposure limit cannot be below a per-market limit",
      });
    }
    if (
      config.rotationMode === "single-slot" &&
      (config.marketDwellMs < config.refreshMs ||
        config.maxRestingMs < config.refreshMs)
    ) {
      context.addIssue({
        code: "custom",
        path: ["rotationMode"],
        message: "Single-slot timing cannot be shorter than the poll interval",
      });
    }
  });

export type StrategyMarketRule = z.infer<typeof strategyMarketRuleSchema>;
export type StrategyConfig = z.infer<typeof strategyConfigSchema>;

const strategyConfigFromMaker = (config: MakerConfig): StrategyConfig => {
  const {
    markets: _markets,
    mode: _mode,
    makerAccountId: _makerAccountId,
    hedge,
    ...shared
  } = config;
  const { accountId: _accountId, ...sharedHedge } = hedge;
  return strategyConfigSchema.parse({ ...shared, hedge: sharedHedge });
};

const composeMakerConfig = (inputs: {
  strategy: StrategyConfig;
  mode: MakerConfig["mode"];
  makerAccountId: string | null;
  takerAccountId: string | null;
  markets: MakerConfig["markets"];
}): MakerConfig =>
  makerConfigSchema.parse({
    ...inputs.strategy,
    mode: inputs.mode,
    makerAccountId: inputs.makerAccountId,
    hedge: { ...inputs.strategy.hedge, accountId: inputs.takerAccountId },
    markets: inputs.markets,
  });

export type StoredAgent = {
  address: string;
  encryptedSecret: EncryptedSecret;
  encryptionContext: string;
  createdAt: string;
};

export type StoredAccountSetup = Setup & {
  addedAt: string;
  grantDigest: string | null;
  agentCapId: string | null;
};

export type StoredAccountMetadata = {
  accountId: string;
  label: string | null;
  tags: string[];
  updatedAt: string;
};

export type AuditEvent = {
  id: number;
  bundleId: string | null;
  occurredAt: string;
  category: string;
  action: string;
  outcome: string;
  detail: Record<string, unknown>;
};

export type StoredChallenge = {
  id: string;
  ownerAddress: string;
  message: string;
  expiresAt: string;
  consumedAt: string | null;
};

export type StoredSession = {
  ownerAddress: string;
  expiresAt: string;
  chainCheckedAt: string | null;
};

export type AccessRequest = {
  id: number;
  walletAddress: string;
  twitterHandle: string;
  status: "pending" | "approved" | "closed";
  requestedAt: string;
  updatedAt: string;
  notifiedAt: string | null;
  notificationAttempts: number;
  notificationError: string | null;
};

type AccessRequestRow = {
  id: number;
  wallet_address: string;
  twitter_handle: string;
  status: AccessRequest["status"];
  requested_at: string;
  updated_at: string;
  notified_at: string | null;
  notification_attempts: number;
  notification_error: string | null;
};

const accessRequestFromRow = (row: AccessRequestRow): AccessRequest => ({
  id: row.id,
  walletAddress: row.wallet_address,
  twitterHandle: row.twitter_handle,
  status: row.status,
  requestedAt: row.requested_at,
  updatedAt: row.updated_at,
  notifiedAt: row.notified_at,
  notificationAttempts: row.notification_attempts,
  notificationError: row.notification_error,
});

export type ExecutionStats = {
  confirmedLiveQuotes: number;
  averageGasMist: number | null;
  lastExecutionAt: string | null;
};

export type TrackedMakerOrder = {
  accountId: string;
  orderId: string;
  marketId: string;
  quoteDigest: string;
  postedAt: string;
};

export type HedgeExecution = {
  occurredAt: string;
  makerAccountId: string;
  hedgeAccountId: string;
  marketId: string;
  digest: string;
  side: "bid" | "ask";
  requestedNotionalUsd: number;
  gasUsedMist: number;
};

export type PaperFill = {
  orderKey: string;
  role: "maker" | "hedge";
  marketId: string;
  symbol: string;
  side: "bid" | "ask";
  price: number;
  sizeUsd: number;
  occurredAt: string;
};

export type PaperPosition = {
  role: "maker" | "hedge";
  marketId: string;
  symbol: string;
  inventoryUsd: number;
};

export type BundleStatus = "stopped" | "running" | "paused" | "error";

export type BundleWalletLimits = {
  maxRunDrawdownUsd: number;
  maxInventoryUsd: number;
  maxGrossExposureUsd: number;
  maxUnrealizedLossUsd: number;
  updatedAt: string;
  confirmedAt: string | null;
};

export type BundleWalletUsage = {
  runDrawdownUsd: number;
  inventoryUsd: number;
  grossExposureUsd: number;
  unrealizedLossUsd: number;
};

export class WalletLimitError extends UserFacingError {
  constructor(message: string) {
    super("wallet-limit", `${message}. Review wallet limits in Bundles.`, {
      kind: "bundles",
    });
  }
}

export type StoredBundle = {
  id: string;
  ownerAddress: string;
  name: string;
  strategyId: string | null;
  strategyName: string | null;
  strategyVersionApplied: number | null;
  needsStrategy: boolean;
  makerAccountId: string | null;
  takerAccountId: string | null;
  mode: MakerConfig["mode"];
  status: BundleStatus;
  marketIds: string[];
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  archivedAt: string | null;
};

export type StoredStrategy = {
  id: string;
  ownerAddress: string;
  name: string;
  config: StrategyConfig;
  marketRule: StrategyMarketRule;
  /** The frozen, canonical market set this strategy supplies to every bundle. */
  markets: MakerConfig["markets"];
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  usedBy: Array<{ id: string; name: string }>;
};

type BundleRow = {
  id: string;
  owner_address: string;
  name: string;
  strategy_id: string | null;
  strategy_name: string | null;
  strategy_version_applied: number | null;
  maker_account_id: string | null;
  taker_account_id: string | null;
  config: string;
  mode: MakerConfig["mode"];
  status: BundleStatus;
  created_at: string;
  updated_at: string;
  last_error: string | null;
  archived_at: string | null;
};

export const RETENTION_LIMITS = {
  auditEvents: 10_000,
  executions: 50_000,
  paperOrders: 10_000,
  paperFills: 50_000,
  makerOrders: 2_000,
  hedgeExecutions: 10_000,
  hedgedFills: 20_000,
  accessRequests: 10_000,
} as const;

type RetentionTable =
  | "tenant_audit_events"
  | "tenant_executions"
  | "tenant_paper_orders"
  | "tenant_paper_fills"
  | "tenant_maker_orders"
  | "tenant_hedge_executions"
  | "tenant_hedged_fills";

export class Store {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
    this.migrateLegacyTenant();
    this.migrateBundles();
    this.migrateObserveModeToPaper();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_signer (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        address TEXT NOT NULL UNIQUE,
        encrypted_secret TEXT NOT NULL,
        created_at TEXT NOT NULL,
        grant_digest TEXT,
        agent_cap_id TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        detail TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        mode TEXT NOT NULL,
        market_id TEXT NOT NULL,
        digest TEXT,
        endpoint TEXT,
        bid_price REAL NOT NULL,
        ask_price REAL NOT NULL,
        size_usd REAL NOT NULL,
        outcome TEXT NOT NULL,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tenant_settings (
        owner_address TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_address, key)
      );

      CREATE TABLE IF NOT EXISTS tenant_agents (
        owner_address TEXT PRIMARY KEY,
        address TEXT NOT NULL UNIQUE,
        encrypted_secret TEXT NOT NULL,
        created_at TEXT NOT NULL,
        grant_digest TEXT,
        agent_cap_id TEXT
      );

      CREATE TABLE IF NOT EXISTS tenant_audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_address TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        detail TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tenant_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_address TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        mode TEXT NOT NULL,
        market_id TEXT NOT NULL,
        digest TEXT,
        endpoint TEXT,
        bid_price REAL NOT NULL,
        ask_price REAL NOT NULL,
        size_usd REAL NOT NULL,
        outcome TEXT NOT NULL,
        error TEXT,
        gas_used_mist INTEGER
      );

      -- Paper activity is deliberately separate from exchange-backed orders and
      -- fills. It must never become input to cancellation or recovery logic.
      CREATE TABLE IF NOT EXISTS tenant_paper_orders (
        owner_address TEXT NOT NULL,
        bundle_id TEXT NOT NULL DEFAULT '',
        trial_id TEXT NOT NULL,
        order_key TEXT NOT NULL,
        market_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('bid', 'ask')),
        price REAL NOT NULL,
        size_usd REAL NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'filled', 'replaced', 'cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_address, bundle_id, trial_id, order_key)
      );

      CREATE TABLE IF NOT EXISTS tenant_paper_fills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_address TEXT NOT NULL,
        bundle_id TEXT NOT NULL DEFAULT '',
        trial_id TEXT NOT NULL,
        order_key TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('maker', 'hedge')),
        market_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('bid', 'ask')),
        price REAL NOT NULL,
        size_usd REAL NOT NULL,
        estimated INTEGER NOT NULL DEFAULT 1 CHECK (estimated = 1),
        occurred_at TEXT NOT NULL,
        UNIQUE (owner_address, bundle_id, trial_id, order_key)
      );

      CREATE TABLE IF NOT EXISTS tenant_maker_orders (
        owner_address TEXT NOT NULL,
        order_id TEXT NOT NULL,
        market_id TEXT NOT NULL,
        quote_digest TEXT NOT NULL,
        posted_at TEXT NOT NULL,
        PRIMARY KEY (owner_address, order_id)
      );

      CREATE TABLE IF NOT EXISTS tenant_hedge_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_address TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        maker_account_id TEXT NOT NULL,
        hedge_account_id TEXT NOT NULL,
        market_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        side TEXT NOT NULL,
        requested_notional_usd REAL NOT NULL,
        gas_used_mist INTEGER NOT NULL,
        UNIQUE (owner_address, digest)
      );

      CREATE TABLE IF NOT EXISTS tenant_hedged_fills (
        owner_address TEXT NOT NULL,
        maker_account_id TEXT NOT NULL,
        fill_key TEXT NOT NULL,
        hedge_digest TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        PRIMARY KEY (owner_address, maker_account_id, fill_key)
      );

      CREATE TABLE IF NOT EXISTS auth_challenges (
        id TEXT PRIMARY KEY,
        owner_address TEXT NOT NULL,
        message TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        owner_address TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        chain_checked_at TEXT,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS access_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_address TEXT NOT NULL UNIQUE,
        twitter_handle TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        requested_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        notified_at TEXT,
        notification_attempts INTEGER NOT NULL DEFAULT 0,
        notification_error TEXT,
        last_notification_attempt_at TEXT
      );

      CREATE INDEX IF NOT EXISTS tenant_audit_events_owner_time
        ON tenant_audit_events(owner_address, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS tenant_executions_owner_time
        ON tenant_executions(owner_address, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS tenant_paper_orders_scope_status
        ON tenant_paper_orders(owner_address, bundle_id, trial_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS tenant_paper_fills_scope_time
        ON tenant_paper_fills(owner_address, bundle_id, trial_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS tenant_maker_orders_owner_time
        ON tenant_maker_orders(owner_address, posted_at DESC);
      CREATE INDEX IF NOT EXISTS tenant_hedge_executions_owner_time
        ON tenant_hedge_executions(owner_address, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS tenant_hedged_fills_owner_time
        ON tenant_hedged_fills(owner_address, processed_at DESC);
      CREATE INDEX IF NOT EXISTS auth_sessions_owner
        ON auth_sessions(owner_address);
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry
        ON auth_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS auth_challenges_expiry
        ON auth_challenges(expires_at);
      CREATE INDEX IF NOT EXISTS access_requests_status_time
        ON access_requests(status, requested_at DESC);
      CREATE INDEX IF NOT EXISTS access_requests_notification
        ON access_requests(notified_at, requested_at);
    `);

    const executionColumns = this.db
      .prepare("PRAGMA table_info(tenant_executions)")
      .all() as Array<{ name: string }>;
    if (!executionColumns.some((column) => column.name === "gas_used_mist")) {
      this.db.exec(
        "ALTER TABLE tenant_executions ADD COLUMN gas_used_mist INTEGER",
      );
    }

    const makerOrderColumns = this.db
      .prepare("PRAGMA table_info(tenant_maker_orders)")
      .all() as Array<{ name: string }>;
    if (!makerOrderColumns.some((column) => column.name === "account_id")) {
      this.db.exec(
        "ALTER TABLE tenant_maker_orders ADD COLUMN account_id TEXT NOT NULL DEFAULT ''",
      );
    }

    const accessRequestColumns = this.db
      .prepare("PRAGMA table_info(access_requests)")
      .all() as Array<{ name: string }>;
    if (
      !accessRequestColumns.some(
        (column) => column.name === "last_notification_attempt_at",
      )
    ) {
      this.db.exec(
        "ALTER TABLE access_requests ADD COLUMN last_notification_attempt_at TEXT",
      );
    }
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS access_requests_notification_attempt
       ON access_requests(last_notification_attempt_at)`,
    );
  }

  private getSystemSetting<T>(key: string): T | null {
    const row = this.db
      .prepare("SELECT value FROM system_settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row ? parse<T>(row.value) : null;
  }

  getSystemValue<T>(key: string): T | null {
    return this.getSystemSetting<T>(key);
  }

  setSystemSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(key, stringify(value), new Date().toISOString());
  }

  getRegistryObjectId(): string | null {
    return this.getSystemSetting<string>("whitelist_registry_object_id");
  }

  setRegistryObjectId(objectId: string): void {
    this.setSystemSetting("whitelist_registry_object_id", objectId);
  }

  getOperatorAddress(): string | null {
    return this.getSystemSetting<string>("operator_address");
  }

  claimBootstrapOperator(address: string): string {
    const normalized = normalizeAddress(address);
    const transaction = this.db.transaction(() => {
      const current = this.getOperatorAddress();
      if (current && current !== normalized) {
        throw new Error("Bootstrap operator has already been claimed");
      }
      if (!current) this.setSystemSetting("operator_address", normalized);
      return normalized;
    });
    return transaction();
  }

  private migrateLegacyTenant(): void {
    if (this.getSystemSetting<boolean>("tenant_v2_migrated")) return;

    const setupRow = this.db
      .prepare("SELECT value FROM settings WHERE key = 'setup'")
      .get() as { value: string } | undefined;
    if (!setupRow) {
      this.setSystemSetting("tenant_v2_migrated", true);
      return;
    }

    const setup = parse<Setup>(setupRow.value);
    const owner = normalizeAddress(setup.ownerAddress);
    const now = new Date().toISOString();
    const migrate = this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT key, value, updated_at FROM settings")
        .all() as Array<{ key: string; value: string; updated_at: string }>;
      const insertSetting = this.db.prepare(
        `INSERT OR IGNORE INTO tenant_settings
          (owner_address, key, value, updated_at) VALUES (?, ?, ?, ?)`,
      );
      for (const row of rows) {
        insertSetting.run(owner, row.key, row.value, row.updated_at);
      }

      const agent = this.db
        .prepare(
          `SELECT address, encrypted_secret, created_at, grant_digest, agent_cap_id
           FROM agent_signer WHERE id = 1`,
        )
        .get() as
        | {
            address: string;
            encrypted_secret: string;
            created_at: string;
            grant_digest: string | null;
            agent_cap_id: string | null;
          }
        | undefined;
      if (agent) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO tenant_agents
              (owner_address, address, encrypted_secret, created_at,
               grant_digest, agent_cap_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            owner,
            agent.address,
            agent.encrypted_secret,
            agent.created_at,
            agent.grant_digest,
            agent.agent_cap_id,
          );
      }

      this.db
        .prepare(
          `INSERT INTO tenant_audit_events
            (owner_address, occurred_at, category, action, outcome, detail)
           SELECT ?, occurred_at, category, action, outcome, detail
           FROM audit_events
           WHERE NOT EXISTS (
             SELECT 1 FROM tenant_audit_events WHERE owner_address = ?
           )`,
        )
        .run(owner, owner);
      this.db
        .prepare(
          `INSERT INTO tenant_executions
            (owner_address, occurred_at, mode, market_id, digest, endpoint,
             bid_price, ask_price, size_usd, outcome, error)
           SELECT ?, occurred_at, mode, market_id, digest, endpoint,
             bid_price, ask_price, size_usd, outcome, error
           FROM executions
           WHERE NOT EXISTS (
             SELECT 1 FROM tenant_executions WHERE owner_address = ?
           )`,
        )
        .run(owner, owner);
      this.setSystemSetting("operator_address", owner);
      this.setSystemSetting("tenant_v2_migrated", true);
      this.setSystemSetting("tenant_v2_migrated_at", now);
    });
    migrate();
  }

  private migrateBundles(): void {
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS strategies (
          id TEXT PRIMARY KEY,
          owner_address TEXT NOT NULL,
          name TEXT NOT NULL COLLATE NOCASE,
          config TEXT NOT NULL,
          market_rule TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          UNIQUE (owner_address, name)
        );

        CREATE TABLE IF NOT EXISTS bundles (
          id TEXT PRIMARY KEY,
          owner_address TEXT NOT NULL,
          name TEXT NOT NULL COLLATE NOCASE,
          strategy_id TEXT REFERENCES strategies(id),
          strategy_version_applied INTEGER,
          maker_account_id TEXT,
          taker_account_id TEXT,
          config TEXT NOT NULL,
          mode TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('stopped', 'running', 'paused', 'error')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_error TEXT,
          archived_at TEXT,
          CHECK (
            maker_account_id IS NULL OR taker_account_id IS NULL OR
            maker_account_id <> taker_account_id
          ),
          UNIQUE (owner_address, name)
        );

        -- Compatibility mirror. The canonical market set is strategy_markets;
        -- paused bundles may therefore share a market before one is started.
        CREATE TABLE IF NOT EXISTS bundle_markets (
          bundle_id TEXT NOT NULL,
          owner_address TEXT NOT NULL,
          market_id TEXT NOT NULL,
          symbol TEXT NOT NULL,
          overrides TEXT,
          PRIMARY KEY (bundle_id, market_id),
          FOREIGN KEY (bundle_id) REFERENCES bundles(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS strategy_markets (
          strategy_id TEXT NOT NULL,
          market_id TEXT NOT NULL,
          symbol TEXT NOT NULL,
          overrides TEXT,
          position INTEGER NOT NULL CHECK (position >= 0),
          PRIMARY KEY (strategy_id, market_id),
          UNIQUE (strategy_id, position),
          FOREIGN KEY (strategy_id) REFERENCES strategies(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS bundle_account_roles (
          bundle_id TEXT NOT NULL,
          owner_address TEXT NOT NULL,
          account_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('maker', 'taker')),
          PRIMARY KEY (bundle_id, role),
          UNIQUE (owner_address, account_id),
          FOREIGN KEY (bundle_id) REFERENCES bundles(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS bundle_wallet_limits (
          owner_address TEXT PRIMARY KEY,
          max_run_drawdown_usd REAL NOT NULL,
          max_inventory_usd REAL NOT NULL,
          max_gross_exposure_usd REAL NOT NULL,
          max_unrealized_loss_usd REAL NOT NULL,
          updated_at TEXT NOT NULL,
          confirmed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS bundle_legacy_backups (
          owner_address TEXT PRIMARY KEY,
          legacy_config_value TEXT NOT NULL,
          legacy_config_updated_at TEXT NOT NULL,
          legacy_status TEXT NOT NULL,
          backed_up_at TEXT NOT NULL,
          rolled_back_at TEXT
        );

        CREATE TABLE IF NOT EXISTS bundle_migration_skips (
          owner_address TEXT PRIMARY KEY,
          legacy_config_updated_at TEXT NOT NULL,
          error TEXT NOT NULL,
          recorded_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS strategy_migration_skips (
          bundle_id TEXT PRIMARY KEY,
          config_updated_at TEXT NOT NULL,
          error TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          FOREIGN KEY (bundle_id) REFERENCES bundles(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS strategy_market_migration_skips (
          strategy_id TEXT PRIMARY KEY,
          strategy_updated_at TEXT NOT NULL,
          error TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          FOREIGN KEY (strategy_id) REFERENCES strategies(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS strategy_market_migrations (
          strategy_id TEXT PRIMARY KEY,
          migrated_at TEXT NOT NULL,
          FOREIGN KEY (strategy_id) REFERENCES strategies(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS bundle_config_mirrors (
          owner_address TEXT PRIMARY KEY,
          core_config_updated_at TEXT NOT NULL,
          mirrored_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS bundles_owner_status
          ON bundles(owner_address, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS strategies_owner_active
          ON strategies(owner_address, archived_at, updated_at DESC);
        CREATE INDEX IF NOT EXISTS bundle_markets_market
          ON bundle_markets(market_id);
        CREATE UNIQUE INDEX IF NOT EXISTS bundles_owner_maker_account_unique
          ON bundles(owner_address, maker_account_id)
          WHERE maker_account_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS bundles_owner_taker_account_unique
          ON bundles(owner_address, taker_account_id)
          WHERE taker_account_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS bundle_account_roles_owner_account_unique
          ON bundle_account_roles(owner_address, account_id);
      `);

      const ensureColumn = (
        table: string,
        column: string,
        definition: string,
      ) => {
        const columns = this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all() as Array<{ name: string }>;
        if (!columns.some((candidate) => candidate.name === column)) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
        }
      };
      ensureColumn(
        "tenant_audit_events",
        "bundle_id",
        "bundle_id TEXT REFERENCES bundles(id)",
      );
      ensureColumn(
        "tenant_executions",
        "bundle_id",
        "bundle_id TEXT REFERENCES bundles(id)",
      );
      ensureColumn(
        "tenant_maker_orders",
        "bundle_id",
        "bundle_id TEXT REFERENCES bundles(id)",
      );
      ensureColumn(
        "tenant_hedge_executions",
        "bundle_id",
        "bundle_id TEXT REFERENCES bundles(id)",
      );
      ensureColumn(
        "tenant_hedged_fills",
        "bundle_id",
        "bundle_id TEXT REFERENCES bundles(id)",
      );
      ensureColumn(
        "bundle_markets",
        "owner_address",
        "owner_address TEXT NOT NULL DEFAULT ''",
      );
      ensureColumn("bundle_markets", "overrides", "overrides TEXT");
      ensureColumn(
        "bundles",
        "strategy_id",
        "strategy_id TEXT REFERENCES strategies(id)",
      );
      ensureColumn(
        "bundles",
        "strategy_version_applied",
        "strategy_version_applied INTEGER",
      );
      ensureColumn("bundles", "archived_at", "archived_at TEXT");
      ensureColumn("bundle_wallet_limits", "confirmed_at", "confirmed_at TEXT");

      // B2 stored an owner-wide UNIQUE constraint inside bundle_markets. SQLite
      // cannot drop an inline constraint, so rebuild this compatibility mirror
      // once before strategies become the canonical market owner.
      const bundleMarketsSql = this.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bundle_markets'",
        )
        .get() as { sql: string } | undefined;
      if (bundleMarketsSql?.sql.includes("UNIQUE (owner_address, market_id)")) {
        this.db.exec(`
          ALTER TABLE bundle_markets RENAME TO bundle_markets_legacy;
          CREATE TABLE bundle_markets (
            bundle_id TEXT NOT NULL,
            owner_address TEXT NOT NULL,
            market_id TEXT NOT NULL,
            symbol TEXT NOT NULL,
            overrides TEXT,
            PRIMARY KEY (bundle_id, market_id),
            FOREIGN KEY (bundle_id) REFERENCES bundles(id) ON DELETE CASCADE
          );
          INSERT INTO bundle_markets
            (bundle_id, owner_address, market_id, symbol, overrides)
          SELECT bundle_id, owner_address, market_id, symbol, overrides
          FROM bundle_markets_legacy;
          DROP TABLE bundle_markets_legacy;
        `);
      }

      this.db.exec(`
        UPDATE bundle_markets
        SET owner_address = (
          SELECT owner_address FROM bundles
          WHERE bundles.id = bundle_markets.bundle_id
        )
        WHERE owner_address = '';

        DROP INDEX IF EXISTS bundle_markets_owner_market_unique;
        CREATE INDEX IF NOT EXISTS strategy_markets_strategy_position
          ON strategy_markets(strategy_id, position);

        DROP INDEX IF EXISTS bundles_owner_maker_account_unique;
        DROP INDEX IF EXISTS bundles_owner_taker_account_unique;
        CREATE UNIQUE INDEX bundles_owner_maker_account_unique
          ON bundles(owner_address, maker_account_id)
          WHERE maker_account_id IS NOT NULL AND archived_at IS NULL;
        CREATE UNIQUE INDEX bundles_owner_taker_account_unique
          ON bundles(owner_address, taker_account_id)
          WHERE taker_account_id IS NOT NULL AND archived_at IS NULL;

        CREATE INDEX IF NOT EXISTS tenant_audit_events_owner_bundle_time
          ON tenant_audit_events(owner_address, bundle_id, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS tenant_executions_owner_bundle_time
          ON tenant_executions(owner_address, bundle_id, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS tenant_maker_orders_owner_bundle_time
          ON tenant_maker_orders(owner_address, bundle_id, posted_at DESC);
        CREATE INDEX IF NOT EXISTS tenant_hedge_executions_owner_bundle_time
          ON tenant_hedge_executions(owner_address, bundle_id, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS tenant_hedged_fills_owner_bundle_time
          ON tenant_hedged_fills(owner_address, bundle_id, processed_at DESC);
      `);

      const legacyConfigs = this.db
        .prepare(
          `SELECT owner_address, value, updated_at
           FROM tenant_settings
           WHERE key = 'maker_config'`,
        )
        .all() as Array<{
        owner_address: string;
        value: string;
        updated_at: string;
      }>;
      const backup = this.db.prepare(
        `INSERT OR IGNORE INTO bundle_legacy_backups
          (owner_address, legacy_config_value, legacy_config_updated_at,
           legacy_status, backed_up_at)
         VALUES (?, ?, ?, 'stopped', ?)`,
      );
      const insertBundle = this.db.prepare(
        `INSERT OR IGNORE INTO bundles
          (id, owner_address, name, maker_account_id, taker_account_id,
           config, mode, status, created_at, updated_at, last_error)
         VALUES (?, ?, 'Core', ?, ?, ?, ?, 'stopped', ?, ?, NULL)`,
      );
      const insertLimits = this.db.prepare(
        `INSERT OR IGNORE INTO bundle_wallet_limits
          (owner_address, max_run_drawdown_usd, max_inventory_usd,
           max_gross_exposure_usd, max_unrealized_loss_usd, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const insertMarket = this.db.prepare(
        `INSERT OR IGNORE INTO bundle_markets
          (bundle_id, owner_address, market_id, symbol)
         VALUES (?, ?, ?, ?)`,
      );
      const insertRole = this.db.prepare(
        `INSERT OR IGNORE INTO bundle_account_roles
          (bundle_id, owner_address, account_id, role)
         VALUES (?, ?, ?, ?)`,
      );
      const hasBackup = this.db.prepare(
        `SELECT 1 FROM bundle_legacy_backups WHERE owner_address = ?`,
      );
      const hasCore = this.db.prepare(
        `SELECT 1 FROM bundles WHERE owner_address = ? AND name = 'Core'`,
      );
      const skippedAtVersion = this.db.prepare(
        `SELECT 1 FROM bundle_migration_skips
         WHERE owner_address = ? AND legacy_config_updated_at = ?`,
      );
      const recordSkip = this.db.prepare(
        `INSERT INTO bundle_migration_skips
          (owner_address, legacy_config_updated_at, error, recorded_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(owner_address) DO UPDATE SET
           legacy_config_updated_at = excluded.legacy_config_updated_at,
           error = excluded.error,
           recorded_at = excluded.recorded_at`,
      );
      const clearSkip = this.db.prepare(
        "DELETE FROM bundle_migration_skips WHERE owner_address = ?",
      );
      const recordEvent = this.db.prepare(
        `INSERT INTO tenant_audit_events
          (owner_address, occurred_at, category, action, outcome, detail)
         VALUES (?, ?, 'bundles', 'migration.core-skipped', 'failed', ?)`,
      );
      const writeLegacyConfig = this.db.prepare(
        `INSERT INTO tenant_settings (owner_address, key, value, updated_at)
         VALUES (?, 'maker_config', ?, ?)
         ON CONFLICT(owner_address, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      );
      const recordCoreMirror = this.db.prepare(
        `INSERT INTO bundle_config_mirrors
          (owner_address, core_config_updated_at, mirrored_at)
         VALUES (?, ?, ?)
         ON CONFLICT(owner_address) DO UPDATE SET
           core_config_updated_at = excluded.core_config_updated_at,
           mirrored_at = excluded.mirrored_at`,
      );
      const getCoreMirror = this.db.prepare(
        `SELECT core_config_updated_at FROM bundle_config_mirrors
         WHERE owner_address = ?`,
      );
      const existingBundles = this.db
        .prepare(
          `SELECT id, owner_address, name, maker_account_id, taker_account_id,
                  config, updated_at, archived_at
           FROM bundles`,
        )
        .all() as Array<{
        id: string;
        owner_address: string;
        name: string;
        maker_account_id: string | null;
        taker_account_id: string | null;
        config: string;
        updated_at: string;
        archived_at: string | null;
      }>;
      for (const bundle of existingBundles) {
        if (bundle.archived_at) continue;
        if (bundle.maker_account_id) {
          insertRole.run(
            bundle.id,
            bundle.owner_address,
            bundle.maker_account_id,
            "maker",
          );
        }
        if (bundle.taker_account_id) {
          insertRole.run(
            bundle.id,
            bundle.owner_address,
            bundle.taker_account_id,
            "taker",
          );
        }
        if (bundle.name !== "Core") continue;
        const mirror = getCoreMirror.get(bundle.owner_address) as
          { core_config_updated_at: string } | undefined;
        if (mirror?.core_config_updated_at === bundle.updated_at) continue;

        const now = new Date().toISOString();
        try {
          const config = normalizeMakerConfig(
            parse<StoredMakerConfig>(bundle.config),
          ).config;
          writeLegacyConfig.run(
            bundle.owner_address,
            stringify(config),
            bundle.updated_at,
          );
        } catch {
          // Keep the existing legacy value as the fallback for an invalid Core
          // row, but record this version so startup does not retry it forever.
        }
        recordCoreMirror.run(bundle.owner_address, bundle.updated_at, now);
      }

      const migrateOwner = this.db.transaction(
        (legacy: (typeof legacyConfigs)[number], ownerAddress: string) => {
          const { config } = normalizeMakerConfig(
            parse<StoredMakerConfig>(legacy.value),
          );
          const id = coreBundleId(ownerAddress);
          const now = new Date().toISOString();
          const serialized = stringify(config);
          backup.run(ownerAddress, legacy.value, legacy.updated_at, now);
          const inserted = insertBundle.run(
            id,
            ownerAddress,
            config.makerAccountId ?? null,
            config.hedge.accountId ?? null,
            serialized,
            config.mode,
            legacy.updated_at,
            legacy.updated_at,
          );
          // Once Core exists, its config and market rows are the source of truth.
          if (inserted.changes === 1) {
            insertLimits.run(
              ownerAddress,
              config.maxRunDrawdownUsd,
              config.maxInventoryUsd,
              config.maxGrossExposureUsd,
              config.maxUnrealizedLossUsd,
              legacy.updated_at,
            );
            for (const market of config.markets) {
              insertMarket.run(
                id,
                ownerAddress,
                market.marketId,
                market.symbol,
              );
            }
            if (config.makerAccountId) {
              insertRole.run(id, ownerAddress, config.makerAccountId, "maker");
            }
            if (config.hedge.accountId) {
              insertRole.run(id, ownerAddress, config.hedge.accountId, "taker");
            }
          }
          writeLegacyConfig.run(ownerAddress, serialized, legacy.updated_at);
          recordCoreMirror.run(ownerAddress, legacy.updated_at, now);
          clearSkip.run(ownerAddress);
        },
      );

      for (const legacy of legacyConfigs) {
        const ownerAddress = normalizeAddress(legacy.owner_address);
        if (
          hasBackup.get(ownerAddress) ||
          hasCore.get(ownerAddress) ||
          skippedAtVersion.get(ownerAddress, legacy.updated_at)
        ) {
          continue;
        }

        try {
          migrateOwner(legacy, ownerAddress);
        } catch (error) {
          const now = new Date().toISOString();
          recordSkip.run(
            ownerAddress,
            legacy.updated_at,
            error instanceof Error ? error.name : "Invalid config",
            now,
          );
          recordEvent.run(
            ownerAddress,
            now,
            stringify({ reason: "invalid_config" }),
          );
        }
      }

      // RFC 0002 migration: every valid existing bundle receives an independent
      // strategy before any strategy can be shared. A bad historical row must
      // never take the service down or be reparsed on each subsequent boot.
      const bundlesWithoutStrategy = this.db
        .prepare(
          `SELECT id, owner_address, name, maker_account_id, taker_account_id,
                  config, mode, status, updated_at, archived_at
           FROM bundles
           WHERE strategy_id IS NULL`,
        )
        .all() as Array<{
        id: string;
        owner_address: string;
        name: string;
        maker_account_id: string | null;
        taker_account_id: string | null;
        config: string;
        mode: MakerConfig["mode"];
        status: BundleStatus;
        updated_at: string;
        archived_at: string | null;
      }>;
      const strategyMigrationSkipped = this.db.prepare(
        `SELECT 1 FROM strategy_migration_skips
         WHERE bundle_id = ? AND config_updated_at = ?`,
      );
      const recordStrategyMigrationSkip = this.db.prepare(
        `INSERT INTO strategy_migration_skips
          (bundle_id, config_updated_at, error, recorded_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(bundle_id) DO UPDATE SET
           config_updated_at = excluded.config_updated_at,
           error = excluded.error,
           recorded_at = excluded.recorded_at`,
      );
      const clearStrategyMigrationSkip = this.db.prepare(
        "DELETE FROM strategy_migration_skips WHERE bundle_id = ?",
      );
      const strategyNameTaken = this.db.prepare(
        `SELECT 1 FROM strategies
         WHERE owner_address = ? AND name = ? COLLATE NOCASE`,
      );
      const insertStrategy = this.db.prepare(
        `INSERT INTO strategies
          (id, owner_address, name, config, market_rule, version,
           created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
      );
      const attachMigratedStrategy = this.db.prepare(
        `UPDATE bundles
         SET strategy_id = ?, strategy_version_applied = 1, config = ?
         WHERE id = ?`,
      );
      const updateMigratedMarket = this.db.prepare(
        `UPDATE bundle_markets
         SET symbol = ?, overrides = ?
         WHERE bundle_id = ? AND market_id = ?`,
      );
      const insertMigratedMarket = this.db.prepare(
        `INSERT OR IGNORE INTO bundle_markets
          (bundle_id, owner_address, market_id, symbol, overrides)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const recordStrategyMigrationEvent = this.db.prepare(
        `INSERT INTO tenant_audit_events
          (owner_address, occurred_at, category, action, outcome, detail)
         VALUES (?, ?, 'strategies', 'migration.bundle-skipped', 'failed', ?)`,
      );
      for (const bundle of bundlesWithoutStrategy) {
        if (
          bundle.archived_at ||
          strategyMigrationSkipped.get(bundle.id, bundle.updated_at)
        ) {
          continue;
        }
        try {
          const config = normalizeMakerConfig(
            parse<StoredMakerConfig>(bundle.config),
          ).config;
          const strategyId = `strategy-${bundle.id}`;
          const baseName = `${bundle.name} strategy`;
          let strategyName = baseName;
          let duplicate = 2;
          while (strategyNameTaken.get(bundle.owner_address, strategyName)) {
            strategyName = `${baseName} ${duplicate}`;
            duplicate += 1;
          }
          const strategy = strategyConfigFromMaker(config);
          const rule: StrategyMarketRule = {
            kind: "preferred-list",
            marketIds: config.markets.map((market) => market.marketId),
          };
          insertStrategy.run(
            strategyId,
            bundle.owner_address,
            strategyName,
            stringify(strategy),
            stringify(rule),
            bundle.updated_at,
            bundle.updated_at,
          );
          for (const market of config.markets) {
            const overrides = market.overrides
              ? stringify(market.overrides)
              : null;
            updateMigratedMarket.run(
              market.symbol,
              overrides,
              bundle.id,
              market.marketId,
            );
            insertMigratedMarket.run(
              bundle.id,
              bundle.owner_address,
              market.marketId,
              market.symbol,
              overrides,
            );
          }
          const projection = composeMakerConfig({
            strategy,
            mode: bundle.mode,
            makerAccountId: bundle.maker_account_id,
            takerAccountId: bundle.taker_account_id,
            markets: config.markets,
          });
          attachMigratedStrategy.run(
            strategyId,
            stringify(projection),
            bundle.id,
          );
          clearStrategyMigrationSkip.run(bundle.id);
        } catch (error) {
          const now = new Date().toISOString();
          recordStrategyMigrationSkip.run(
            bundle.id,
            bundle.updated_at,
            error instanceof Error ? error.name : "Invalid config",
            now,
          );
          recordStrategyMigrationEvent.run(
            bundle.owner_address,
            now,
            stringify({ bundleId: bundle.id, reason: "invalid_config" }),
          );
        }
      }

      // RFC 0002 amendment: strategies now own the resolved market set. Keep
      // bundle_markets as a compatibility mirror for rollback, but materialize
      // every attached strategy once. A shared strategy that already backs
      // divergent bundle market sets is forked before this becomes canonical.
      const strategyMarketRows = this.db.prepare(
        `SELECT market_id, symbol, overrides
         FROM bundle_markets WHERE bundle_id = ? ORDER BY market_id ASC`,
      );
      const strategyMarketInsert = this.db.prepare(
        `INSERT INTO strategy_markets
          (strategy_id, market_id, symbol, overrides, position)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const clearStrategyMarkets = this.db.prepare(
        "DELETE FROM strategy_markets WHERE strategy_id = ?",
      );
      const strategyHasMarkets = this.db.prepare(
        "SELECT 1 FROM strategy_markets WHERE strategy_id = ? LIMIT 1",
      );
      const strategyMarketMigrated = this.db.prepare(
        "SELECT 1 FROM strategy_market_migrations WHERE strategy_id = ?",
      );
      const markStrategyMarketMigrated = this.db.prepare(
        `INSERT OR IGNORE INTO strategy_market_migrations (strategy_id, migrated_at)
         VALUES (?, ?)`,
      );
      const marketMigrationSkipped = this.db.prepare(
        `SELECT 1 FROM strategy_market_migration_skips
         WHERE strategy_id = ? AND strategy_updated_at = ?`,
      );
      const recordMarketMigrationSkip = this.db.prepare(
        `INSERT INTO strategy_market_migration_skips
          (strategy_id, strategy_updated_at, error, recorded_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(strategy_id) DO UPDATE SET
           strategy_updated_at = excluded.strategy_updated_at,
           error = excluded.error,
           recorded_at = excluded.recorded_at`,
      );
      const clearMarketMigrationSkip = this.db.prepare(
        "DELETE FROM strategy_market_migration_skips WHERE strategy_id = ?",
      );
      const allStrategies = this.db
        .prepare(
          `SELECT id, owner_address, name, config, market_rule, version,
                  created_at, updated_at, archived_at
           FROM strategies WHERE archived_at IS NULL`,
        )
        .all() as Array<{
        id: string;
        owner_address: string;
        name: string;
        config: string;
        market_rule: string;
        version: number;
        created_at: string;
        updated_at: string;
        archived_at: string | null;
      }>;
      const bundlesForStrategy = this.db.prepare(
        `SELECT id, owner_address, name, maker_account_id, taker_account_id,
                mode, updated_at
         FROM bundles
         WHERE owner_address = ? AND strategy_id = ? AND archived_at IS NULL
         ORDER BY created_at ASC, id ASC`,
      );
      const strategyNameExists = this.db.prepare(
        `SELECT 1 FROM strategies
         WHERE owner_address = ? AND name = ? COLLATE NOCASE`,
      );
      const insertStrategyFork = this.db.prepare(
        `INSERT INTO strategies
          (id, owner_address, name, config, market_rule, version,
           created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      );
      const attachFork = this.db.prepare(
        `UPDATE bundles SET strategy_id = ?, strategy_version_applied = ?
         WHERE owner_address = ? AND id = ?`,
      );
      const updateProjection = this.db.prepare(
        `UPDATE bundles SET config = ?, strategy_version_applied = ?, updated_at = ?
         WHERE owner_address = ? AND id = ?`,
      );
      const writeCoreProjection = this.db.prepare(
        `INSERT INTO tenant_settings (owner_address, key, value, updated_at)
         VALUES (?, 'maker_config', ?, ?)
         ON CONFLICT(owner_address, key) DO UPDATE SET
           value = excluded.value, updated_at = excluded.updated_at`,
      );
      const writeCoreMarketMirror = this.db.prepare(
        `INSERT INTO bundle_config_mirrors
          (owner_address, core_config_updated_at, mirrored_at)
         VALUES (?, ?, ?)
         ON CONFLICT(owner_address) DO UPDATE SET
           core_config_updated_at = excluded.core_config_updated_at,
           mirrored_at = excluded.mirrored_at`,
      );
      const marketMigrationEvent = this.db.prepare(
        `INSERT INTO tenant_audit_events
          (owner_address, occurred_at, category, action, outcome, detail)
         VALUES (?, ?, 'strategies', 'migration.markets-skipped', 'failed', ?)`,
      );
      type LegacyMarketRow = {
        market_id: string;
        symbol: string;
        overrides: string | null;
      };
      type StrategyBundleRow = {
        id: string;
        owner_address: string;
        name: string;
        maker_account_id: string | null;
        taker_account_id: string | null;
        mode: MakerConfig["mode"];
        updated_at: string;
      };
      const insertCanonicalMarkets = (
        strategyId: string,
        markets: LegacyMarketRow[],
      ) => {
        clearStrategyMarkets.run(strategyId);
        for (const [position, market] of markets.entries()) {
          strategyMarketInsert.run(
            strategyId,
            market.market_id,
            market.symbol,
            market.overrides,
            position,
          );
        }
      };
      const mirrorBundleMarkets = (
        ownerAddress: string,
        bundleId: string,
        markets: LegacyMarketRow[],
      ) => {
        this.db
          .prepare("DELETE FROM bundle_markets WHERE bundle_id = ?")
          .run(bundleId);
        const insert = this.db.prepare(
          `INSERT INTO bundle_markets
            (bundle_id, owner_address, market_id, symbol, overrides)
           VALUES (?, ?, ?, ?, ?)`,
        );
        for (const market of markets) {
          insert.run(
            bundleId,
            ownerAddress,
            market.market_id,
            market.symbol,
            market.overrides,
          );
        }
      };
      const migrateStrategyMarkets = this.db.transaction(
        (strategy: (typeof allStrategies)[number]) => {
          if (strategyHasMarkets.get(strategy.id)) return;
          const rule = strategyMarketRuleSchema.parse(
            parse<unknown>(strategy.market_rule),
          );
          const config = strategyConfigSchema.parse(
            parse<unknown>(strategy.config),
          );
          const attached = bundlesForStrategy.all(
            strategy.owner_address,
            strategy.id,
          ) as StrategyBundleRow[];
          if (!attached.length) {
            if (rule.kind === "preferred-list") {
              insertCanonicalMarkets(
                strategy.id,
                rule.marketIds.map((marketId) => ({
                  market_id: marketId,
                  symbol: marketId,
                  overrides: null,
                })),
              );
            }
            clearMarketMigrationSkip.run(strategy.id);
            markStrategyMarketMigrated.run(
              strategy.id,
              new Date().toISOString(),
            );
            return;
          }
          const groups = new Map<
            string,
            { markets: LegacyMarketRow[]; bundles: StrategyBundleRow[] }
          >();
          for (const bundle of attached) {
            const markets = strategyMarketRows.all(
              bundle.id,
            ) as LegacyMarketRow[];
            if (!markets.length) {
              throw new Error(
                `Bundle ${bundle.name} has no legacy market mirror`,
              );
            }
            const key = stringify(markets);
            const group = groups.get(key) ?? { markets, bundles: [] };
            group.bundles.push(bundle);
            groups.set(key, group);
          }
          let groupIndex = 0;
          for (const group of groups.values()) {
            const targetId =
              groupIndex === 0 ? strategy.id : `strategy-${randomUUID()}`;
            const targetVersion = groupIndex === 0 ? strategy.version : 1;
            if (groupIndex > 0) {
              const baseName = `${group.bundles[0]!.name} strategy`;
              let name = baseName;
              let suffix = 2;
              while (strategyNameExists.get(strategy.owner_address, name)) {
                name = `${baseName} ${suffix}`;
                suffix += 1;
              }
              insertStrategyFork.run(
                targetId,
                strategy.owner_address,
                name,
                strategy.config,
                strategy.market_rule,
                targetVersion,
                strategy.created_at,
                strategy.updated_at,
              );
            }
            insertCanonicalMarkets(targetId, group.markets);
            const resolved = group.markets.map((market) => ({
              marketId: market.market_id,
              symbol: market.symbol,
              ...(market.overrides
                ? {
                    overrides: parse<
                      MakerConfig["markets"][number]["overrides"]
                    >(market.overrides),
                  }
                : {}),
            }));
            for (const bundle of group.bundles) {
              if (targetId !== strategy.id) {
                attachFork.run(
                  targetId,
                  targetVersion,
                  strategy.owner_address,
                  bundle.id,
                );
              }
              mirrorBundleMarkets(
                strategy.owner_address,
                bundle.id,
                group.markets,
              );
              const projection = composeMakerConfig({
                strategy: config,
                mode: bundle.mode,
                makerAccountId: bundle.maker_account_id,
                takerAccountId: bundle.taker_account_id,
                markets: resolved,
              });
              const updatedAt = bundle.updated_at;
              updateProjection.run(
                stringify(projection),
                targetVersion,
                updatedAt,
                strategy.owner_address,
                bundle.id,
              );
              if (bundle.name === "Core") {
                writeCoreProjection.run(
                  strategy.owner_address,
                  stringify(projection),
                  updatedAt,
                );
                writeCoreMarketMirror.run(
                  strategy.owner_address,
                  updatedAt,
                  new Date().toISOString(),
                );
              }
            }
            groupIndex += 1;
          }
          clearMarketMigrationSkip.run(strategy.id);
          markStrategyMarketMigrated.run(strategy.id, new Date().toISOString());
        },
      );
      for (const strategy of allStrategies) {
        if (
          strategyHasMarkets.get(strategy.id) ||
          strategyMarketMigrated.get(strategy.id) ||
          marketMigrationSkipped.get(strategy.id, strategy.updated_at)
        ) {
          continue;
        }
        try {
          migrateStrategyMarkets(strategy);
        } catch (error) {
          const now = new Date().toISOString();
          recordMarketMigrationSkip.run(
            strategy.id,
            strategy.updated_at,
            error instanceof Error ? error.name : "Invalid strategy",
            now,
          );
          marketMigrationEvent.run(
            strategy.owner_address,
            now,
            stringify({ strategyId: strategy.id, reason: "invalid_markets" }),
          );
        }
      }

      // History can only be assigned to Core when the migration evidence shows
      // that no later Core config was saved. All other legacy rows intentionally
      // remain unassigned for B2's "Before bundles" presentation.
      const eligibleCores = this.db
        .prepare(
          `SELECT bundles.id, bundles.owner_address
           FROM bundles
           JOIN bundle_legacy_backups
             ON bundle_legacy_backups.owner_address = bundles.owner_address
           WHERE bundles.name = 'Core'
             AND bundles.created_at = bundles.updated_at
             AND bundle_legacy_backups.legacy_config_updated_at = bundles.created_at
             AND bundle_legacy_backups.rolled_back_at IS NULL`,
        )
        .all() as Array<{ id: string; owner_address: string }>;
      const attributionTables = [
        "tenant_audit_events",
        "tenant_executions",
        "tenant_maker_orders",
        "tenant_hedge_executions",
        "tenant_hedged_fills",
      ];
      for (const core of eligibleCores) {
        for (const table of attributionTables) {
          this.db
            .prepare(
              `UPDATE ${table}
               SET bundle_id = ?
               WHERE owner_address = ? AND bundle_id IS NULL`,
            )
            .run(core.id, core.owner_address);
        }
      }
    });
    migrate();
  }

  /**
   * Observe was a public mode before RFC 0003. Keep its historical execution
   * rows intact, but make every editable bundle a deliberately stopped Paper
   * bundle. This is a one-way, per-row migration so a malformed saved config
   * cannot prevent the control service from starting for other wallets.
   */
  private migrateObserveModeToPaper(): void {
    const rows = this.db
      .prepare(
        `SELECT id, owner_address, name, config, mode, updated_at
         FROM bundles
         WHERE archived_at IS NULL`,
      )
      .all() as Array<{
      id: string;
      owner_address: string;
      name: string;
      config: string;
      mode: MakerConfig["mode"];
      updated_at: string;
    }>;
    if (!rows.length) return;

    const updateBundle = this.db.prepare(
      `UPDATE bundles
       SET config = ?, mode = 'paper', status = 'stopped',
           last_error = NULL, updated_at = ?
       WHERE id = ? AND owner_address = ?`,
    );
    const updateCoreMirror = this.db.prepare(
      `INSERT INTO tenant_settings (owner_address, key, value, updated_at)
       VALUES (?, 'maker_config', ?, ?)
       ON CONFLICT(owner_address, key) DO UPDATE SET
         value = excluded.value, updated_at = excluded.updated_at`,
    );
    const record = this.db.prepare(
      `INSERT INTO tenant_audit_events
        (owner_address, occurred_at, category, action, outcome, detail)
       VALUES (?, ?, 'runtime', 'mode.observe-migrated', ?, ?)`,
    );

    for (const row of rows) {
      const now = new Date().toISOString();
      try {
        const config = makerConfigSchema.parse(parse<unknown>(row.config));
        if (row.mode !== "observe" && config.mode !== "observe") continue;
        const paperConfig = makerConfigSchema.parse({
          ...config,
          mode: "paper",
        });
        this.db.transaction(() => {
          updateBundle.run(
            stringify(paperConfig),
            now,
            row.id,
            row.owner_address,
          );
          if (row.name === "Core") {
            updateCoreMirror.run(
              row.owner_address,
              stringify(paperConfig),
              now,
            );
          }
          record.run(
            row.owner_address,
            now,
            "success",
            stringify({ bundleId: row.id, from: "observe", to: "paper" }),
          );
        })();
      } catch {
        // Leave an unreadable bundle alone rather than guessing a trading
        // configuration. The existing bundle-migration audit remains the
        // source of truth for malformed historical rows.
      }
    }
  }

  forTenant(ownerAddress: string): TenantStore {
    return new TenantStore(this.db, normalizeAddress(ownerAddress));
  }

  forBundle(ownerAddress: string, bundleId: string): TenantStore {
    const normalizedOwner = normalizeAddress(ownerAddress);
    const bundle = this.db
      .prepare(
        `SELECT id FROM bundles
         WHERE owner_address = ? AND id = ? AND archived_at IS NULL`,
      )
      .get(normalizedOwner, bundleId) as { id: string } | undefined;
    if (!bundle)
      throw new UserFacingError(
        "bundle-not-found",
        "This bundle is no longer available. Refresh Bundles and select an active bundle.",
        { kind: "bundles" },
        404,
      );
    return new TenantStore(this.db, normalizedOwner, bundle.id);
  }

  coreRuntimeBundleId(ownerAddress: string): string | null {
    const normalizedOwner = normalizeAddress(ownerAddress);
    if (this.forTenant(normalizedOwner).bundlesRolledBack()) return null;
    const bundle = this.db
      .prepare(
        `SELECT id FROM bundles
         WHERE owner_address = ? AND name = 'Core'`,
      )
      .get(normalizedOwner) as { id: string } | undefined;
    return bundle?.id ?? null;
  }

  listTenantOwners(): string[] {
    const rows = this.db
      .prepare(
        `SELECT owner_address FROM tenant_settings
         UNION
         SELECT owner_address FROM tenant_agents
         UNION
         SELECT owner_address FROM bundles
         ORDER BY owner_address`,
      )
      .all() as Array<{ owner_address: string }>;
    return rows.map((row) => row.owner_address);
  }

  listBundleRollbackCandidates(): string[] {
    const rows = this.db
      .prepare(
        `SELECT owner_address FROM bundle_legacy_backups
         WHERE rolled_back_at IS NULL
         ORDER BY owner_address`,
      )
      .all() as Array<{ owner_address: string }>;
    return rows.map((row) => row.owner_address);
  }

  canRollbackBundleMigration(ownerAddress: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM bundle_legacy_backups
           WHERE owner_address = ? AND rolled_back_at IS NULL`,
        )
        .get(normalizeAddress(ownerAddress)),
    );
  }

  rotateAgentEncryptions(
    updates: Array<{
      ownerAddress: string;
      address: string;
      encryptedSecret: EncryptedSecret;
      encryptionContext: string;
    }>,
  ): void {
    const rotate = this.db.transaction(() => {
      for (const update of updates) {
        const ownerAddress = normalizeAddress(update.ownerAddress);
        const result = this.db
          .prepare(
            `UPDATE tenant_agents
             SET encrypted_secret = ?
             WHERE owner_address = ? AND address = ?`,
          )
          .run(
            stringify(update.encryptedSecret),
            ownerAddress,
            normalizeAddress(update.address),
          );
        if (result.changes !== 1) {
          throw new Error(
            `Stored agent changed during key rotation for ${ownerAddress}`,
          );
        }
        this.db
          .prepare(
            `INSERT INTO tenant_settings
              (owner_address, key, value, updated_at)
             VALUES (?, 'agent_encryption_context', ?, ?)
             ON CONFLICT(owner_address, key) DO UPDATE SET
               value = excluded.value,
               updated_at = excluded.updated_at`,
          )
          .run(
            ownerAddress,
            stringify(update.encryptionContext),
            new Date().toISOString(),
          );
      }
    });
    rotate();
  }

  countOpenChallenges(ownerAddress: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM auth_challenges
         WHERE owner_address = ?
           AND consumed_at IS NULL
           AND expires_at > ?`,
      )
      .get(normalizeAddress(ownerAddress), new Date().toISOString()) as {
      count: number;
    };
    return row.count;
  }

  createChallenge(inputs: StoredChallenge): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM auth_challenges WHERE expires_at < ? OR consumed_at IS NOT NULL",
        )
        .run(now);
      this.db
        .prepare(
          `INSERT INTO auth_challenges
            (id, owner_address, message, expires_at, consumed_at)
           VALUES (?, ?, ?, ?, NULL)`,
        )
        .run(
          inputs.id,
          normalizeAddress(inputs.ownerAddress),
          inputs.message,
          inputs.expiresAt,
        );
    })();
  }

  consumeChallenge(inputs: {
    id: string;
    ownerAddress: string;
    message: string;
  }): StoredChallenge {
    const normalized = normalizeAddress(inputs.ownerAddress);
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT id, owner_address, message, expires_at, consumed_at
           FROM auth_challenges WHERE id = ?`,
        )
        .get(inputs.id) as
        | {
            id: string;
            owner_address: string;
            message: string;
            expires_at: string;
            consumed_at: string | null;
          }
        | undefined;
      if (
        !row ||
        row.owner_address !== normalized ||
        row.message !== inputs.message ||
        row.consumed_at ||
        Date.parse(row.expires_at) <= Date.now()
      ) {
        throw new Error("Authentication challenge is invalid or expired");
      }
      const consumedAt = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE auth_challenges SET consumed_at = ?
           WHERE id = ? AND consumed_at IS NULL`,
        )
        .run(consumedAt, inputs.id);
      return {
        id: row.id,
        ownerAddress: row.owner_address,
        message: row.message,
        expiresAt: row.expires_at,
        consumedAt,
      };
    })();
  }

  createSession(inputs: {
    tokenHash: string;
    ownerAddress: string;
    expiresAt: string;
    chainCheckedAt: string;
  }): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM auth_sessions WHERE expires_at < ? OR revoked_at IS NOT NULL",
        )
        .run(now);
      this.db
        .prepare(
          `INSERT INTO auth_sessions
            (token_hash, owner_address, created_at, expires_at, chain_checked_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          inputs.tokenHash,
          normalizeAddress(inputs.ownerAddress),
          now,
          inputs.expiresAt,
          inputs.chainCheckedAt,
        );
    })();
  }

  getSession(tokenHash: string): StoredSession | null {
    const row = this.db
      .prepare(
        `SELECT owner_address, expires_at, chain_checked_at
         FROM auth_sessions
         WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(tokenHash, new Date().toISOString()) as
      | {
          owner_address: string;
          expires_at: string;
          chain_checked_at: string | null;
        }
      | undefined;
    return row
      ? {
          ownerAddress: row.owner_address,
          expiresAt: row.expires_at,
          chainCheckedAt: row.chain_checked_at,
        }
      : null;
  }

  markSessionChainChecked(tokenHash: string, checkedAt: string): void {
    this.db
      .prepare(
        "UPDATE auth_sessions SET chain_checked_at = ? WHERE token_hash = ?",
      )
      .run(checkedAt, tokenHash);
  }

  revokeSession(tokenHash: string): void {
    this.db
      .prepare("UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?")
      .run(new Date().toISOString(), tokenHash);
  }

  createAccessRequest(inputs: {
    walletAddress: string;
    twitterHandle: string;
  }): { request: AccessRequest; created: boolean } {
    const walletAddress = normalizeAddress(inputs.walletAddress);
    const existing = this.db
      .prepare(
        `SELECT id, wallet_address, twitter_handle, status, requested_at,
                updated_at, notified_at, notification_attempts,
                notification_error
         FROM access_requests WHERE wallet_address = ?`,
      )
      .get(walletAddress) as AccessRequestRow | undefined;
    const now = new Date().toISOString();
    if (existing) {
      return {
        request: accessRequestFromRow(existing),
        created: false,
      };
    }

    const result = this.db
      .prepare(
        `INSERT INTO access_requests
          (wallet_address, twitter_handle, status, requested_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?)`,
      )
      .run(walletAddress, inputs.twitterHandle, now, now);
    this.enforceAccessRequestRetention();
    return {
      request: {
        id: Number(result.lastInsertRowid),
        walletAddress,
        twitterHandle: inputs.twitterHandle,
        status: "pending",
        requestedAt: now,
        updatedAt: now,
        notifiedAt: null,
        notificationAttempts: 0,
        notificationError: null,
      },
      created: true,
    };
  }

  listAccessRequests(limit = 50): AccessRequest[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Access request limit must be between 1 and 500");
    }
    const rows = this.db
      .prepare(
        `SELECT id, wallet_address, twitter_handle, status, requested_at,
                updated_at, notified_at, notification_attempts,
                notification_error
         FROM access_requests
         ORDER BY requested_at DESC
         LIMIT ?`,
      )
      .all(limit) as AccessRequestRow[];
    return rows.map(accessRequestFromRow);
  }

  listPendingAccessRequestNotifications(limit = 20): AccessRequest[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Notification limit must be between 1 and 100");
    }
    const rows = this.db
      .prepare(
        `SELECT id, wallet_address, twitter_handle, status, requested_at,
                updated_at, notified_at, notification_attempts,
                notification_error
         FROM access_requests
         WHERE status = 'pending'
           AND notified_at IS NULL
           AND notification_attempts < 5
         ORDER BY requested_at ASC
         LIMIT ?`,
      )
      .all(limit) as AccessRequestRow[];
    return rows.map(accessRequestFromRow);
  }

  markAccessRequestNotification(
    id: number,
    result: { ok: true } | { ok: false; error: string },
  ): void {
    if (result.ok) {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE access_requests
           SET notified_at = ?, last_notification_attempt_at = ?,
               notification_attempts = notification_attempts + 1,
               notification_error = NULL
           WHERE id = ?`,
        )
        .run(now, now, id);
      return;
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE access_requests
         SET last_notification_attempt_at = ?,
             notification_attempts = notification_attempts + 1,
             notification_error = ?
         WHERE id = ?`,
      )
      .run(now, result.error.slice(0, 500), id);
  }

  setAccessRequestStatus(
    walletAddress: string,
    status: AccessRequest["status"],
  ): void {
    this.db
      .prepare(
        `UPDATE access_requests SET status = ?, updated_at = ?
         WHERE wallet_address = ?`,
      )
      .run(status, new Date().toISOString(), normalizeAddress(walletAddress));
  }

  countAccessRequestNotificationAttemptsSince(since: string): number {
    return Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM access_requests
             WHERE last_notification_attempt_at IS NOT NULL
               AND last_notification_attempt_at >= ?`,
          )
          .get(since) as { count: number }
      ).count,
    );
  }

  enforceAccessRequestRetention(limit = RETENTION_LIMITS.accessRequests): void {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        "Access request retention limit must be a positive integer",
      );
    }
    this.db
      .prepare(
        `DELETE FROM access_requests
         WHERE id IN (
           SELECT id FROM access_requests
           ORDER BY id DESC
           LIMIT -1 OFFSET ?
         )`,
      )
      .run(limit);
  }

  close(): void {
    this.db.close();
  }
}

export class TenantStore {
  constructor(
    private readonly db: Database.Database,
    public readonly ownerAddress: string,
    public readonly bundleId: string | null = null,
  ) {}

  private pruneTable(table: RetentionTable, limit: number): void {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Retention limit must be a positive integer");
    }
    this.db
      .prepare(
        `DELETE FROM ${table}
         WHERE owner_address = ?
           AND rowid IN (
             SELECT rowid FROM ${table}
             WHERE owner_address = ?
             ORDER BY rowid DESC
             LIMIT -1 OFFSET ?
           )`,
      )
      .run(this.ownerAddress, this.ownerAddress, limit);
  }

  enforceRetention(
    limits: Partial<typeof RETENTION_LIMITS> = RETENTION_LIMITS,
  ): void {
    const applied = { ...RETENTION_LIMITS, ...limits };
    this.db.transaction(() => {
      this.pruneTable("tenant_audit_events", applied.auditEvents);
      this.pruneTable("tenant_executions", applied.executions);
      this.pruneTable("tenant_paper_orders", applied.paperOrders);
      this.pruneTable("tenant_paper_fills", applied.paperFills);
      this.pruneTable("tenant_maker_orders", applied.makerOrders);
      this.pruneTable("tenant_hedge_executions", applied.hedgeExecutions);
      this.pruneTable("tenant_hedged_fills", applied.hedgedFills);
    })();
  }

  private getSetting<T>(key: string): T | null {
    const row = this.db
      .prepare(
        "SELECT value FROM tenant_settings WHERE owner_address = ? AND key = ?",
      )
      .get(this.ownerAddress, key) as { value: string } | undefined;
    return row ? parse<T>(row.value) : null;
  }

  private setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO tenant_settings (owner_address, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(owner_address, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(this.ownerAddress, key, stringify(value), new Date().toISOString());
  }

  private getCoreRow(): BundleRow | null {
    const row = this.db
      .prepare(
        `SELECT bundles.id, bundles.owner_address, bundles.name,
                bundles.maker_account_id, bundles.taker_account_id,
                bundles.config, bundles.mode, bundles.status,
                bundles.created_at, bundles.updated_at, bundles.last_error,
                bundles.archived_at, bundles.strategy_id,
                bundles.strategy_version_applied,
                strategies.name AS strategy_name
         FROM bundles
         LEFT JOIN strategies ON strategies.id = bundles.strategy_id
         WHERE bundles.owner_address = ? AND bundles.name = 'Core'`,
      )
      .get(this.ownerAddress) as BundleRow | undefined;
    return row ?? null;
  }

  bundlesRolledBack(): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM bundle_legacy_backups
           WHERE owner_address = ? AND rolled_back_at IS NOT NULL`,
        )
        .get(this.ownerAddress),
    );
  }

  private attributedBundleId(): string | null {
    if (this.bundlesRolledBack()) return null;
    if (this.bundleId) return this.bundleId;
    const bundle = this.db
      .prepare(
        `SELECT id FROM bundles
         WHERE owner_address = ? AND name = 'Core'`,
      )
      .get(this.ownerAddress) as { id: string } | undefined;
    return bundle?.id ?? null;
  }

  private getBundleRow(bundleId: string): BundleRow | null {
    const row = this.db
      .prepare(
        `SELECT bundles.id, bundles.owner_address, bundles.name,
                bundles.maker_account_id, bundles.taker_account_id,
                bundles.config, bundles.mode, bundles.status,
                bundles.created_at, bundles.updated_at, bundles.last_error,
                bundles.archived_at, bundles.strategy_id,
                bundles.strategy_version_applied,
                strategies.name AS strategy_name
         FROM bundles
         LEFT JOIN strategies ON strategies.id = bundles.strategy_id
         WHERE bundles.owner_address = ? AND bundles.id = ?`,
      )
      .get(this.ownerAddress, bundleId) as BundleRow | undefined;
    return row ?? null;
  }

  private getBundleMarkets(bundleId: string): MakerConfig["markets"] {
    const rows = this.db
      .prepare(
        `SELECT market_id, symbol, overrides
         FROM bundle_markets
         WHERE bundle_id = ?
         ORDER BY market_id ASC`,
      )
      .all(bundleId) as Array<{
      market_id: string;
      symbol: string;
      overrides: string | null;
    }>;
    return rows.map((market) => ({
      marketId: market.market_id,
      symbol: market.symbol,
      ...(market.overrides
        ? {
            overrides: parse<MakerConfig["markets"][number]["overrides"]>(
              market.overrides,
            ),
          }
        : {}),
    }));
  }

  private getStrategyMarkets(strategyId: string): MakerConfig["markets"] {
    const rows = this.db
      .prepare(
        `SELECT market_id, symbol, overrides
         FROM strategy_markets
         WHERE strategy_id = ?
         ORDER BY position ASC, market_id ASC`,
      )
      .all(strategyId) as Array<{
      market_id: string;
      symbol: string;
      overrides: string | null;
    }>;
    return rows.map((market) => ({
      marketId: market.market_id,
      symbol: market.symbol,
      ...(market.overrides
        ? {
            overrides: parse<MakerConfig["markets"][number]["overrides"]>(
              market.overrides,
            ),
          }
        : {}),
    }));
  }

  private replaceStrategyMarkets(
    strategyId: string,
    markets: MakerConfig["markets"],
  ): void {
    this.db
      .prepare("DELETE FROM strategy_markets WHERE strategy_id = ?")
      .run(strategyId);
    const insert = this.db.prepare(
      `INSERT INTO strategy_markets
        (strategy_id, market_id, symbol, overrides, position)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const [position, market] of markets.entries()) {
      insert.run(
        strategyId,
        market.marketId,
        market.symbol,
        market.overrides ? stringify(market.overrides) : null,
        position,
      );
    }
  }

  private mirrorStrategyMarkets(
    strategyId: string,
    bundleIds = this.strategyUsedBy(strategyId).map((bundle) => bundle.id),
  ): void {
    const markets = this.getStrategyMarkets(strategyId);
    for (const bundleId of bundleIds) {
      this.replaceBundleMarkets(bundleId, { markets });
    }
  }

  private strategyRow(strategyId: string):
    | {
        id: string;
        owner_address: string;
        name: string;
        config: string;
        market_rule: string;
        version: number;
        created_at: string;
        updated_at: string;
        archived_at: string | null;
      }
    | undefined {
    return this.db
      .prepare(
        `SELECT id, owner_address, name, config, market_rule, version,
                created_at, updated_at, archived_at
         FROM strategies
         WHERE owner_address = ? AND id = ?`,
      )
      .get(this.ownerAddress, strategyId) as
      | {
          id: string;
          owner_address: string;
          name: string;
          config: string;
          market_rule: string;
          version: number;
          created_at: string;
          updated_at: string;
          archived_at: string | null;
        }
      | undefined;
  }

  private composeBundleConfig(row: BundleRow): MakerConfig {
    if (!row.strategy_id) {
      return normalizeMakerConfig(parse<StoredMakerConfig>(row.config)).config;
    }
    const strategy = this.strategyRow(row.strategy_id);
    if (!strategy || strategy.archived_at) {
      throw new UserFacingError(
        "strategy-not-found",
        "The attached strategy is no longer available. Choose a strategy in Bundles.",
        { kind: "bundles" },
        404,
      );
    }
    return composeMakerConfig({
      strategy: strategyConfigSchema.parse(parse<unknown>(strategy.config)),
      mode: row.mode,
      makerAccountId: row.maker_account_id,
      takerAccountId: row.taker_account_id,
      markets: this.getStrategyMarkets(strategy.id),
    });
  }

  private strategyUsedBy(
    strategyId: string,
  ): Array<{ id: string; name: string }> {
    return this.db
      .prepare(
        `SELECT id, name FROM bundles
         WHERE owner_address = ? AND strategy_id = ? AND archived_at IS NULL
         ORDER BY created_at ASC, id ASC`,
      )
      .all(this.ownerAddress, strategyId) as Array<{
      id: string;
      name: string;
    }>;
  }

  private storedStrategy(
    row: NonNullable<ReturnType<TenantStore["strategyRow"]>>,
  ): StoredStrategy {
    return {
      id: row.id,
      ownerAddress: row.owner_address,
      name: row.name,
      config: strategyConfigSchema.parse(parse<unknown>(row.config)),
      marketRule: strategyMarketRuleSchema.parse(
        parse<unknown>(row.market_rule),
      ),
      markets: this.getStrategyMarkets(row.id),
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
      usedBy: this.strategyUsedBy(row.id),
    };
  }

  private nextStrategyName(base: string): string {
    let name = base;
    let suffix = 2;
    const exists = this.db.prepare(
      `SELECT 1 FROM strategies
       WHERE owner_address = ? AND name = ? COLLATE NOCASE`,
    );
    while (exists.get(this.ownerAddress, name)) {
      name = `${base} ${suffix}`;
      suffix += 1;
    }
    return name;
  }

  /**
   * The legacy config endpoints are intentionally narrow adapters: they may
   * update a dedicated strategy, but never silently alter a second bundle that
   * happens to share it. Core forks first; non-Core callers must use the
   * strategy API so the shared fan-out is explicit.
   */
  private writeLegacyStrategyForBundle(inputs: {
    bundleId: string;
    bundleName: string;
    currentStrategyId: string | null;
    config: MakerConfig;
    forkShared: boolean;
  }): { strategyId: string; version: number } {
    const sharedConfig = strategyConfigFromMaker(inputs.config);
    const current = inputs.currentStrategyId
      ? this.strategyRow(inputs.currentStrategyId)
      : undefined;
    const uses = current ? this.strategyUsedBy(current.id) : [];
    const mustFork = Boolean(current && uses.length > 1);
    if (mustFork && !inputs.forkShared) {
      throw new UserFacingError(
        "shared-strategy",
        "This bundle uses a shared strategy. Edit it in Strategy instead.",
        { kind: "strategy" },
      );
    }
    const now = this.nextBundleUpdatedAt(inputs.bundleId);
    if (current && !mustFork) {
      const version = current.version + 1;
      this.db
        .prepare(
          `UPDATE strategies
           SET config = ?, version = ?, updated_at = ?
           WHERE owner_address = ? AND id = ?`,
        )
        .run(
          stringify(sharedConfig),
          version,
          now,
          this.ownerAddress,
          current.id,
        );
      this.replaceStrategyMarkets(current.id, inputs.config.markets);
      this.mirrorStrategyMarkets(current.id);
      return { strategyId: current.id, version };
    }

    const strategyId = `strategy-${randomUUID()}`;
    const name = this.nextStrategyName(`${inputs.bundleName} strategy`);
    const currentRule = current
      ? strategyMarketRuleSchema.parse(parse<unknown>(current.market_rule))
      : ({
          kind: "preferred-list",
          marketIds: inputs.config.markets.map((market) => market.marketId),
        } satisfies StrategyMarketRule);
    this.db
      .prepare(
        `INSERT INTO strategies
          (id, owner_address, name, config, market_rule, version,
           created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
      )
      .run(
        strategyId,
        this.ownerAddress,
        name,
        stringify(sharedConfig),
        stringify(currentRule),
        now,
        now,
      );
    this.replaceStrategyMarkets(strategyId, inputs.config.markets);
    return { strategyId, version: 1 };
  }

  private configSource():
    | { kind: "bundle"; value: string }
    | { kind: "core"; value: string }
    | { kind: "legacy"; value: string }
    | null {
    if (this.bundleId) {
      const row = this.db
        .prepare(
          `SELECT config FROM bundles
           WHERE owner_address = ? AND id = ? AND archived_at IS NULL`,
        )
        .get(this.ownerAddress, this.bundleId) as
        { config: string } | undefined;
      return row ? { kind: "bundle", value: row.config } : null;
    }
    const core = this.getCoreRow();
    if (core && !this.bundlesRolledBack()) {
      return { kind: "core", value: core.config };
    }
    const row = this.db
      .prepare(
        `SELECT value FROM tenant_settings
         WHERE owner_address = ? AND key = 'maker_config'`,
      )
      .get(this.ownerAddress) as { value: string } | undefined;
    return row ? { kind: "legacy", value: row.value } : null;
  }

  private replaceBundleMarkets(
    bundleId: string,
    config: Pick<MakerConfig, "markets">,
  ): void {
    this.db
      .prepare("DELETE FROM bundle_markets WHERE bundle_id = ?")
      .run(bundleId);
    const insert = this.db.prepare(
      `INSERT INTO bundle_markets
        (bundle_id, owner_address, market_id, symbol, overrides)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const market of config.markets) {
      insert.run(
        bundleId,
        this.ownerAddress,
        market.marketId,
        market.symbol,
        market.overrides ? stringify(market.overrides) : null,
      );
    }
  }

  private replaceBundleAccountRoles(
    bundleId: string,
    config: MakerConfig,
  ): void {
    this.db
      .prepare("DELETE FROM bundle_account_roles WHERE bundle_id = ?")
      .run(bundleId);
    const insert = this.db.prepare(
      `INSERT INTO bundle_account_roles
        (bundle_id, owner_address, account_id, role)
       VALUES (?, ?, ?, ?)`,
    );
    if (config.makerAccountId) {
      insert.run(bundleId, this.ownerAddress, config.makerAccountId, "maker");
    }
    if (config.hedge.accountId) {
      insert.run(bundleId, this.ownerAddress, config.hedge.accountId, "taker");
    }
  }

  private nextBundleUpdatedAt(bundleId: string): string {
    const current = this.db
      .prepare("SELECT updated_at FROM bundles WHERE id = ?")
      .get(bundleId) as { updated_at: string } | undefined;
    const currentMs = current ? Date.parse(current.updated_at) : Number.NaN;
    return new Date(
      Number.isFinite(currentMs)
        ? Math.max(Date.now(), currentMs + 1)
        : Date.now(),
    ).toISOString();
  }

  assertConfigFitsWallet(
    config: MakerConfig,
    walletLimits: BundleWalletLimits,
  ): void {
    const maximumInventoryUsd = Math.max(
      config.maxInventoryUsd,
      ...config.markets.map(
        (market) => market.overrides?.maxInventoryUsd ?? config.maxInventoryUsd,
      ),
    );
    const limits: Array<[string, number, number]> = [
      [
        "Run drawdown",
        config.maxRunDrawdownUsd,
        walletLimits.maxRunDrawdownUsd,
      ],
      ["Inventory", maximumInventoryUsd, walletLimits.maxInventoryUsd],
      [
        "Gross exposure",
        config.maxGrossExposureUsd,
        walletLimits.maxGrossExposureUsd,
      ],
      [
        "Unrealized loss",
        config.maxUnrealizedLossUsd,
        walletLimits.maxUnrealizedLossUsd,
      ],
    ];
    const overLimit = limits.find(([, value, envelope]) => value > envelope);
    if (overLimit) {
      throw new UserFacingError(
        "wallet-limit",
        `${overLimit[0]} limit exceeds this wallet's confirmed envelope. Raise the wallet limit in Bundles or lower the strategy limit.`,
        { kind: "bundles" },
      );
    }
  }

  private runningBundleWalletLimitFloor(): BundleWalletUsage {
    const rows = this.db
      .prepare(
        `SELECT config FROM bundles
         WHERE owner_address = ? AND archived_at IS NULL AND status = 'running'`,
      )
      .all(this.ownerAddress) as Array<{ config: string }>;
    return rows.reduce<BundleWalletUsage>(
      (floor, row) => {
        const config = makerConfigSchema.parse(parse<unknown>(row.config));
        return {
          runDrawdownUsd: Math.max(
            floor.runDrawdownUsd,
            config.maxRunDrawdownUsd,
          ),
          inventoryUsd: Math.max(
            floor.inventoryUsd,
            config.maxInventoryUsd,
            ...config.markets.map(
              (market) =>
                market.overrides?.maxInventoryUsd ?? config.maxInventoryUsd,
            ),
          ),
          grossExposureUsd: Math.max(
            floor.grossExposureUsd,
            config.maxGrossExposureUsd,
          ),
          unrealizedLossUsd: Math.max(
            floor.unrealizedLossUsd,
            config.maxUnrealizedLossUsd,
          ),
        };
      },
      {
        runDrawdownUsd: 0,
        inventoryUsd: 0,
        grossExposureUsd: 0,
        unrealizedLossUsd: 0,
      },
    );
  }

  private assertBundleAssignmentsAvailable(
    bundleId: string,
    config: MakerConfig,
  ): void {
    if (
      config.makerAccountId &&
      config.makerAccountId === config.hedge.accountId
    ) {
      throw new UserFacingError(
        "accounts-not-distinct",
        "Choose separate Maker and hedge accounts in Venues.",
        { kind: "venues" },
        409,
      );
    }
    const accountIds = [config.makerAccountId, config.hedge.accountId].filter(
      (accountId): accountId is string => Boolean(accountId),
    );
    const assignedAccount = this.db.prepare(
      `SELECT 1
       FROM bundle_account_roles roles
       JOIN bundles ON bundles.id = roles.bundle_id
       WHERE roles.owner_address = ?
         AND roles.account_id = ?
         AND roles.bundle_id <> ?
         AND bundles.archived_at IS NULL`,
    );
    for (const accountId of accountIds) {
      if (assignedAccount.get(this.ownerAddress, accountId, bundleId)) {
        throw new UserFacingError(
          "account-role-taken",
          "This account is already assigned to a bundle. Select an unused account in Bundles.",
          { kind: "bundles" },
          409,
        );
      }
    }
  }

  /**
   * Market membership is strategy-owned. Paper may share a market with any
   * bundle; only another running Live bundle reserves a Live market.
   */
  assertBundleMarketsAvailableToStart(bundleId: string): void {
    const bundle = this.getStoredBundle(bundleId);
    if (!bundle || bundle.archivedAt)
      throw new UserFacingError(
        "bundle-not-found",
        "This bundle is no longer available. Refresh Bundles and select an active bundle.",
        { kind: "bundles" },
        404,
      );
    if (!bundle.strategyId) {
      throw new UserFacingError(
        "needs-strategy",
        "Attach a strategy in Bundles before starting this bundle.",
        { kind: "bundles" },
        409,
      );
    }
    if (bundle.mode !== "live") return;
    const assigned = this.db.prepare(
      `SELECT bundles.name
       FROM bundles
       JOIN strategy_markets ON strategy_markets.strategy_id = bundles.strategy_id
       WHERE bundles.owner_address = ?
         AND bundles.id <> ?
         AND bundles.archived_at IS NULL
         AND bundles.status = 'running'
         AND bundles.mode = 'live'
         AND strategy_markets.market_id = ?
       ORDER BY bundles.created_at ASC, bundles.id ASC
       LIMIT 1`,
    );
    for (const market of this.getStrategyMarkets(bundle.strategyId)) {
      const existing = assigned.get(
        this.ownerAddress,
        bundle.id,
        market.marketId,
      ) as { name: string } | undefined;
      if (existing) {
        throw new UserFacingError(
          "market-taken",
          `${market.symbol} is already quoted live by ${existing.name}. Only one Live bundle can quote a market.`,
          { kind: "strategy" },
        );
      }
    }
  }

  private writeBundleConfig(bundleId: string, config: MakerConfig): void {
    const write = this.db.transaction(() => {
      const bundle = this.db
        .prepare(
          `SELECT id, name, strategy_id, archived_at FROM bundles
           WHERE owner_address = ? AND id = ?`,
        )
        .get(this.ownerAddress, bundleId) as
        | {
            id: string;
            name: string;
            strategy_id: string | null;
            archived_at: string | null;
          }
        | undefined;
      if (!bundle || bundle.archived_at) {
        throw new UserFacingError(
          "bundle-not-found",
          "This bundle is no longer available. Refresh Bundles and select an active bundle.",
          { kind: "bundles" },
          404,
        );
      }
      if (bundle.name !== "Core" && config.mode === "live") {
        throw new UserFacingError(
          "live-core-only",
          "Only Core can use Live mode. Switch this bundle to Paper.",
          { kind: "bundles" },
          409,
        );
      }
      const walletLimits = this.getWalletLimits();
      if (!walletLimits) {
        throw new UserFacingError(
          "core-required",
          "Configure Core in Bundles before creating another bundle.",
          { kind: "bundles" },
          409,
        );
      }
      this.assertConfigFitsWallet(config, walletLimits);
      this.assertBundleAssignmentsAvailable(bundleId, config);
      const strategy = this.writeLegacyStrategyForBundle({
        bundleId,
        bundleName: bundle.name,
        currentStrategyId: bundle.strategy_id,
        config,
        forkShared: bundle.name === "Core",
      });
      this.db
        .prepare(
          `UPDATE bundles
           SET strategy_id = ?, strategy_version_applied = ?,
               maker_account_id = ?, taker_account_id = ?, config = ?, mode = ?,
               updated_at = ?
           WHERE owner_address = ? AND id = ?`,
        )
        .run(
          strategy.strategyId,
          strategy.version,
          config.makerAccountId ?? null,
          config.hedge.accountId ?? null,
          stringify(config),
          config.mode,
          this.nextBundleUpdatedAt(bundleId),
          this.ownerAddress,
          bundleId,
        );
      this.replaceBundleMarkets(bundleId, config);
      this.replaceBundleAccountRoles(bundleId, config);
    });
    write();
  }

  private writeCoreConfig(config: MakerConfig): void {
    const existing = this.getCoreRow();
    const id = existing?.id ?? coreBundleId(this.ownerAddress);
    const now = this.nextBundleUpdatedAt(id);
    const serialized = stringify(config);
    const write = this.db.transaction(() => {
      const walletLimits = this.getWalletLimits();
      const activeBundles = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM bundles
           WHERE owner_address = ? AND archived_at IS NULL`,
        )
        .get(this.ownerAddress) as { count: number };
      const mayAdjustInitialEnvelope =
        Boolean(walletLimits) &&
        !walletLimits!.confirmedAt &&
        activeBundles.count <= 1;
      if (walletLimits && !mayAdjustInitialEnvelope) {
        this.assertConfigFitsWallet(config, walletLimits);
      }
      this.assertBundleAssignmentsAvailable(id, config);
      const strategy = this.writeLegacyStrategyForBundle({
        bundleId: id,
        bundleName: "Core",
        currentStrategyId: existing?.strategy_id ?? null,
        config,
        forkShared: true,
      });
      if (existing) {
        this.db
          .prepare(
            `UPDATE bundles
             SET strategy_id = ?, strategy_version_applied = ?,
                 maker_account_id = ?, taker_account_id = ?, config = ?, mode = ?,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(
            strategy.strategyId,
            strategy.version,
            config.makerAccountId ?? null,
            config.hedge.accountId ?? null,
            serialized,
            config.mode,
            now,
            id,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO bundles
              (id, owner_address, name, strategy_id, strategy_version_applied,
               maker_account_id, taker_account_id, config, mode, status,
               created_at, updated_at, last_error)
             VALUES (?, ?, 'Core', ?, ?, ?, ?, ?, ?, 'stopped', ?, ?, NULL)`,
          )
          .run(
            id,
            this.ownerAddress,
            strategy.strategyId,
            strategy.version,
            config.makerAccountId ?? null,
            config.hedge.accountId ?? null,
            serialized,
            config.mode,
            now,
            now,
          );
      }
      if (!walletLimits || mayAdjustInitialEnvelope) {
        this.db
          .prepare(
            `INSERT INTO bundle_wallet_limits
              (owner_address, max_run_drawdown_usd, max_inventory_usd,
               max_gross_exposure_usd, max_unrealized_loss_usd, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(owner_address) DO UPDATE SET
               max_run_drawdown_usd = excluded.max_run_drawdown_usd,
               max_inventory_usd = excluded.max_inventory_usd,
               max_gross_exposure_usd = excluded.max_gross_exposure_usd,
               max_unrealized_loss_usd = excluded.max_unrealized_loss_usd,
               updated_at = excluded.updated_at`,
          )
          .run(
            this.ownerAddress,
            config.maxRunDrawdownUsd,
            config.maxInventoryUsd,
            config.maxGrossExposureUsd,
            config.maxUnrealizedLossUsd,
            now,
          );
      }
      this.replaceBundleMarkets(id, config);
      this.replaceBundleAccountRoles(id, config);
      this.db
        .prepare(
          `INSERT INTO tenant_settings (owner_address, key, value, updated_at)
           VALUES (?, 'maker_config', ?, ?)
           ON CONFLICT(owner_address, key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`,
        )
        .run(this.ownerAddress, serialized, now);
      this.db
        .prepare(
          `INSERT INTO bundle_config_mirrors
            (owner_address, core_config_updated_at, mirrored_at)
           VALUES (?, ?, ?)
           ON CONFLICT(owner_address) DO UPDATE SET
             core_config_updated_at = excluded.core_config_updated_at,
             mirrored_at = excluded.mirrored_at`,
        )
        .run(this.ownerAddress, now, now);
    });
    write();
  }

  getConfig(): MakerConfig | null {
    if (this.bundleId) return this.getBundleConfig(this.bundleId);
    const core = this.getCoreRow();
    if (core && !this.bundlesRolledBack()) {
      return this.getBundleConfig(core.id);
    }
    const source = this.configSource();
    if (!source) return null;
    const { config, migrated } = normalizeMakerConfig(
      parse<StoredMakerConfig>(source.value),
    );
    if (migrated) {
      this.setSetting("maker_config", config);
    }
    return config;
  }

  setConfig(config: MakerConfig): void {
    if (this.bundleId) {
      this.writeBundleConfig(this.bundleId, config);
      return;
    }
    this.writeCoreConfig(config);
  }

  updateBundleConfig(inputs: {
    bundleId: string;
    config: MakerConfig;
    expectedUpdatedAt?: string;
  }): StoredBundle {
    const current = this.getStoredBundle(inputs.bundleId);
    if (!current || current.archivedAt)
      throw new UserFacingError(
        "bundle-not-found",
        "This bundle is no longer available. Refresh Bundles and select an active bundle.",
        { kind: "bundles" },
        404,
      );
    if (
      inputs.expectedUpdatedAt !== undefined &&
      inputs.expectedUpdatedAt !== current.updatedAt
    ) {
      throw new UserFacingError(
        "bundle-version-conflict",
        "Bundle changed elsewhere; refresh before saving. Compare your changes with the current bundle.",
        { kind: "bundles" },
        409,
      );
    }
    if (current.name === "Core") this.writeCoreConfig(inputs.config);
    else this.writeBundleConfig(inputs.bundleId, inputs.config);
    return this.getStoredBundle(inputs.bundleId)!;
  }

  listBundles(): StoredBundle[] {
    const rows = this.db
      .prepare(
        `SELECT bundles.id, bundles.owner_address, bundles.name,
                bundles.maker_account_id, bundles.taker_account_id,
                bundles.config, bundles.mode, bundles.status,
                bundles.created_at, bundles.updated_at, bundles.last_error,
                bundles.archived_at, bundles.strategy_id,
                bundles.strategy_version_applied,
                strategies.name AS strategy_name
         FROM bundles
         LEFT JOIN strategies ON strategies.id = bundles.strategy_id
         WHERE bundles.owner_address = ?
         ORDER BY bundles.created_at ASC, bundles.id ASC`,
      )
      .all(this.ownerAddress) as BundleRow[];
    const markets = this.db.prepare(
      `SELECT market_id FROM strategy_markets
       WHERE strategy_id = ? ORDER BY position ASC, market_id ASC`,
    );
    return rows.map((row) => ({
      id: row.id,
      ownerAddress: row.owner_address,
      name: row.name,
      strategyId: row.strategy_id,
      strategyName: row.strategy_name,
      strategyVersionApplied: row.strategy_version_applied,
      needsStrategy: !row.strategy_id,
      makerAccountId: row.maker_account_id,
      takerAccountId: row.taker_account_id,
      mode: row.mode,
      status: row.status,
      marketIds:
        row.archived_at || !row.strategy_id
          ? []
          : (markets.all(row.strategy_id) as Array<{ market_id: string }>).map(
              (market) => market.market_id,
            ),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastError: row.last_error,
      archivedAt: row.archived_at,
    }));
  }

  getBundleConfig(bundleId: string): MakerConfig | null {
    const row = this.getBundleRow(bundleId);
    return row ? this.composeBundleConfig(row) : null;
  }

  listStrategies(): StoredStrategy[] {
    const rows = this.db
      .prepare(
        `SELECT id, owner_address, name, config, market_rule, version,
                created_at, updated_at, archived_at
         FROM strategies
         WHERE owner_address = ?
         ORDER BY archived_at IS NOT NULL, updated_at DESC, id ASC`,
      )
      .all(this.ownerAddress) as Array<
      NonNullable<ReturnType<TenantStore["strategyRow"]>>
    >;
    return rows.map((row) => this.storedStrategy(row));
  }

  getStrategy(strategyId: string): StoredStrategy | null {
    const row = this.strategyRow(strategyId);
    return row ? this.storedStrategy(row) : null;
  }

  createStrategy(inputs: {
    name: string;
    config: unknown;
    marketRule: unknown;
    markets?: unknown;
  }): StoredStrategy {
    const config = strategyConfigSchema.parse(inputs.config);
    const marketRule = strategyMarketRuleSchema.parse(inputs.marketRule);
    const markets =
      inputs.markets === undefined
        ? marketRule.kind === "preferred-list"
          ? marketRule.marketIds.map((marketId) => ({
              marketId,
              symbol: marketId,
            }))
          : []
        : strategyMarketsSchema.parse(inputs.markets);
    const name = inputs.name.trim();
    if (!name || name.length > 80) {
      throw new UserFacingError(
        "strategy-name-invalid",
        "Use a strategy name between 1 and 80 characters.",
        { kind: "strategy" },
        400,
      );
    }
    const nameTaken = this.db
      .prepare(
        "SELECT 1 FROM strategies WHERE owner_address = ? AND name = ? COLLATE NOCASE",
      )
      .get(this.ownerAddress, name);
    if (nameTaken)
      throw new UserFacingError(
        "strategy-name-taken",
        "Another strategy already uses this name. Choose a different name.",
        { kind: "strategy" },
      );
    const id = `strategy-${randomUUID()}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO strategies
          (id, owner_address, name, config, market_rule, version,
           created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
      )
      .run(
        id,
        this.ownerAddress,
        name,
        stringify(config),
        stringify(marketRule),
        now,
        now,
      );
    this.replaceStrategyMarkets(id, markets);
    return this.getStrategy(id)!;
  }

  updateStrategy(inputs: {
    strategyId: string;
    name: string;
    config: unknown;
    marketRule: unknown;
    markets?: unknown;
    expectedVersion: number;
  }): { strategy: StoredStrategy; affectedBundles: StoredBundle[] } {
    const name = inputs.name.trim();
    if (!name || name.length > 80) {
      throw new UserFacingError(
        "strategy-name-invalid",
        "Use a strategy name between 1 and 80 characters.",
        { kind: "strategy" },
        400,
      );
    }
    const config = strategyConfigSchema.parse(inputs.config);
    const marketRule = strategyMarketRuleSchema.parse(inputs.marketRule);
    const update = this.db.transaction(() => {
      const current = this.strategyRow(inputs.strategyId);
      if (!current || current.archived_at)
        throw new UserFacingError(
          "strategy-not-found",
          "This strategy is no longer available. Choose a strategy in Strategy.",
          { kind: "strategy" },
          404,
        );
      if (current.version !== inputs.expectedVersion) {
        throw new UserFacingError(
          "strategy-version-conflict",
          "Strategy changed elsewhere; refresh before saving. Compare your draft with the latest version.",
          { kind: "strategy" },
          409,
        );
      }
      const markets =
        inputs.markets === undefined
          ? this.getStrategyMarkets(current.id)
          : strategyMarketsSchema.parse(inputs.markets);
      const nameTaken = this.db
        .prepare(
          `SELECT 1 FROM strategies
           WHERE owner_address = ? AND name = ? COLLATE NOCASE AND id <> ?`,
        )
        .get(this.ownerAddress, name, current.id);
      if (nameTaken)
        throw new UserFacingError(
          "strategy-name-taken",
          "Another strategy already uses this name. Choose a different name.",
          { kind: "strategy" },
          409,
        );
      const bundles = this.strategyUsedBy(current.id);
      const projections = bundles.map((bundle) => {
        const row = this.getBundleRow(bundle.id)!;
        return {
          bundle,
          status: row.status,
          config: composeMakerConfig({
            strategy: config,
            mode: row.mode,
            makerAccountId: row.maker_account_id,
            takerAccountId: row.taker_account_id,
            markets,
          }),
        };
      });
      const running = projections.filter(
        (projection) =>
          projection.status === "running" && projection.config.mode === "live",
      );
      if (running.length > 1 && markets.length) {
        throw new UserFacingError(
          "market-taken",
          `${markets[0]!.symbol} is already quoted live by ${running[0]!.bundle.name}. Only one Live bundle can quote a market.`,
          { kind: "strategy" },
        );
      }
      if (running.length && markets.length) {
        const reservedMarket = this.db.prepare(
          `SELECT bundles.name
           FROM bundles
           JOIN strategy_markets
             ON strategy_markets.strategy_id = bundles.strategy_id
           WHERE bundles.owner_address = ?
             AND bundles.archived_at IS NULL
             AND bundles.status = 'running'
             AND bundles.mode = 'live'
             AND bundles.strategy_id <> ?
             AND strategy_markets.market_id = ?
           ORDER BY bundles.created_at ASC, bundles.id ASC
           LIMIT 1`,
        );
        for (const market of markets) {
          const existing = reservedMarket.get(
            this.ownerAddress,
            current.id,
            market.marketId,
          ) as { name: string } | undefined;
          if (existing) {
            throw new UserFacingError(
              "market-taken",
              `${market.symbol} is already quoted live by ${existing.name}. Only one Live bundle can quote a market.`,
              { kind: "strategy" },
            );
          }
        }
      }
      const walletLimits = this.getWalletLimits();
      if (walletLimits) {
        for (const projection of projections) {
          this.assertConfigFitsWallet(projection.config, walletLimits);
        }
      }
      const version = current.version + 1;
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE strategies
           SET name = ?, config = ?, market_rule = ?, version = ?, updated_at = ?
           WHERE owner_address = ? AND id = ?`,
        )
        .run(
          name,
          stringify(config),
          stringify(marketRule),
          version,
          now,
          this.ownerAddress,
          current.id,
        );
      this.replaceStrategyMarkets(current.id, markets);
      this.mirrorStrategyMarkets(current.id);
      const writeBundle = this.db.prepare(
        `UPDATE bundles
         SET config = ?, strategy_version_applied = ?, updated_at = ?
         WHERE owner_address = ? AND id = ?`,
      );
      let coreProjection:
        { config: MakerConfig; updatedAt: string } | undefined;
      for (const projection of projections) {
        const updatedAt = this.nextBundleUpdatedAt(projection.bundle.id);
        writeBundle.run(
          stringify(projection.config),
          version,
          updatedAt,
          this.ownerAddress,
          projection.bundle.id,
        );
        if (projection.bundle.name === "Core") {
          coreProjection = { config: projection.config, updatedAt };
        }
      }
      if (coreProjection) {
        this.db
          .prepare(
            `INSERT INTO tenant_settings (owner_address, key, value, updated_at)
             VALUES (?, 'maker_config', ?, ?)
             ON CONFLICT(owner_address, key) DO UPDATE SET
               value = excluded.value,
               updated_at = excluded.updated_at`,
          )
          .run(
            this.ownerAddress,
            stringify(coreProjection.config),
            coreProjection.updatedAt,
          );
        this.db
          .prepare(
            `INSERT INTO bundle_config_mirrors
              (owner_address, core_config_updated_at, mirrored_at)
             VALUES (?, ?, ?)
             ON CONFLICT(owner_address) DO UPDATE SET
               core_config_updated_at = excluded.core_config_updated_at,
               mirrored_at = excluded.mirrored_at`,
          )
          .run(this.ownerAddress, coreProjection.updatedAt, now);
      }
      return projections.map((projection) => projection.bundle.id);
    });
    const affectedIds = update();
    return {
      strategy: this.getStrategy(inputs.strategyId)!,
      affectedBundles: affectedIds.map((id) => this.getStoredBundle(id)!),
    };
  }

  duplicateStrategy(inputs: {
    strategyId: string;
    name?: string;
  }): StoredStrategy {
    const current = this.strategyRow(inputs.strategyId);
    if (!current || current.archived_at)
      throw new UserFacingError(
        "strategy-not-found",
        "This strategy is no longer available. Choose a strategy in Strategy.",
        { kind: "strategy" },
        404,
      );
    const requested = inputs.name?.trim();
    const name = requested || this.nextStrategyName(`${current.name} copy`);
    return this.createStrategy({
      name,
      config: parse<unknown>(current.config),
      marketRule: parse<unknown>(current.market_rule),
      markets: this.getStrategyMarkets(current.id),
    });
  }

  archiveStrategy(strategyId: string): StoredStrategy {
    const current = this.strategyRow(strategyId);
    if (!current || current.archived_at)
      throw new UserFacingError(
        "strategy-not-found",
        "This strategy is no longer available. Choose a strategy in Strategy.",
        { kind: "strategy" },
        404,
      );
    const usedBy = this.strategyUsedBy(strategyId);
    if (usedBy.length) {
      throw new UserFacingError(
        "strategy-in-use",
        "This strategy is used by a bundle. Detach it in Bundles before deleting it.",
        { kind: "bundles" },
        409,
      );
    }
    this.db
      .prepare(
        `UPDATE strategies SET archived_at = ?, updated_at = ?
         WHERE owner_address = ? AND id = ?`,
      )
      .run(
        new Date().toISOString(),
        new Date().toISOString(),
        this.ownerAddress,
        strategyId,
      );
    return this.getStrategy(strategyId)!;
  }

  getWalletLimits(): BundleWalletLimits | null {
    const row = this.db
      .prepare(
        `SELECT max_run_drawdown_usd, max_inventory_usd,
                max_gross_exposure_usd, max_unrealized_loss_usd, updated_at
                , confirmed_at
         FROM bundle_wallet_limits WHERE owner_address = ?`,
      )
      .get(this.ownerAddress) as
      | {
          max_run_drawdown_usd: number;
          max_inventory_usd: number;
          max_gross_exposure_usd: number;
          max_unrealized_loss_usd: number;
          updated_at: string;
          confirmed_at: string | null;
        }
      | undefined;
    return row
      ? {
          maxRunDrawdownUsd: row.max_run_drawdown_usd,
          maxInventoryUsd: row.max_inventory_usd,
          maxGrossExposureUsd: row.max_gross_exposure_usd,
          maxUnrealizedLossUsd: row.max_unrealized_loss_usd,
          updatedAt: row.updated_at,
          confirmedAt: row.confirmed_at,
        }
      : null;
  }

  confirmWalletLimits(): BundleWalletLimits {
    const current = this.getWalletLimits();
    if (!current) {
      throw new UserFacingError(
        "core-required",
        "Configure Core in Bundles before confirming wallet limits.",
        { kind: "bundles" },
        409,
      );
    }
    if (!current.confirmedAt) {
      const confirmedAt = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE bundle_wallet_limits
           SET confirmed_at = ? WHERE owner_address = ?`,
        )
        .run(confirmedAt, this.ownerAddress);
      return { ...current, confirmedAt };
    }
    return current;
  }

  updateWalletLimits(inputs: {
    maxRunDrawdownUsd: number;
    maxInventoryUsd: number;
    maxGrossExposureUsd: number;
    maxUnrealizedLossUsd: number;
    usage: BundleWalletUsage;
  }): BundleWalletLimits {
    const update = this.db.transaction(() => {
      const current = this.getWalletLimits();
      if (!current) {
        throw new WalletLimitError(
          "Configure Core before editing wallet limits",
        );
      }
      const configured = this.runningBundleWalletLimitFloor();
      const currentUsage: BundleWalletUsage = {
        runDrawdownUsd: Math.max(
          0,
          configured.runDrawdownUsd,
          inputs.usage.runDrawdownUsd,
        ),
        inventoryUsd: Math.max(
          0,
          configured.inventoryUsd,
          inputs.usage.inventoryUsd,
        ),
        grossExposureUsd: Math.max(
          0,
          configured.grossExposureUsd,
          inputs.usage.grossExposureUsd,
        ),
        unrealizedLossUsd: Math.max(
          0,
          configured.unrealizedLossUsd,
          inputs.usage.unrealizedLossUsd,
        ),
      };
      const minimums: Array<[string, number, number]> = [
        ["Run drawdown", inputs.maxRunDrawdownUsd, currentUsage.runDrawdownUsd],
        ["Inventory", inputs.maxInventoryUsd, currentUsage.inventoryUsd],
        [
          "Gross exposure",
          inputs.maxGrossExposureUsd,
          currentUsage.grossExposureUsd,
        ],
        [
          "Unrealized loss",
          inputs.maxUnrealizedLossUsd,
          currentUsage.unrealizedLossUsd,
        ],
      ];
      const belowRunningUse = minimums.find(([, limit, used]) => limit < used);
      if (belowRunningUse) {
        const [label, , used] = belowRunningUse;
        throw new WalletLimitError(
          `${label} limit cannot be below $${used.toFixed(2)} used by running bundles`,
        );
      }
      const updatedAt = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE bundle_wallet_limits
           SET max_run_drawdown_usd = ?, max_inventory_usd = ?,
               max_gross_exposure_usd = ?, max_unrealized_loss_usd = ?,
               updated_at = ?
           WHERE owner_address = ?`,
        )
        .run(
          inputs.maxRunDrawdownUsd,
          inputs.maxInventoryUsd,
          inputs.maxGrossExposureUsd,
          inputs.maxUnrealizedLossUsd,
          updatedAt,
          this.ownerAddress,
        );
      return {
        maxRunDrawdownUsd: inputs.maxRunDrawdownUsd,
        maxInventoryUsd: inputs.maxInventoryUsd,
        maxGrossExposureUsd: inputs.maxGrossExposureUsd,
        maxUnrealizedLossUsd: inputs.maxUnrealizedLossUsd,
        updatedAt,
        confirmedAt: current.confirmedAt,
      };
    });
    return update();
  }

  createBundle(inputs: {
    name: string;
    config: MakerConfig;
    confirmWalletLimits?: boolean;
  }): StoredBundle {
    const create = this.db.transaction(() => {
      const name = inputs.name.trim();
      if (!name || name.length > 80 || name.toLowerCase() === "core") {
        throw new UserFacingError(
          "bundle-name-invalid",
          "Use a bundle name between 1 and 80 characters.",
          { kind: "bundles" },
          400,
        );
      }
      if (inputs.config.mode === "live") {
        throw new UserFacingError(
          "live-core-only",
          "Only Core can use Live mode. Switch this bundle to Paper.",
          { kind: "bundles" },
          409,
        );
      }
      const active = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM bundles
           WHERE owner_address = ? AND archived_at IS NULL`,
        )
        .get(this.ownerAddress) as { count: number };
      if (active.count >= 4) {
        throw new UserFacingError(
          "bundle-limit",
          "A wallet can have at most four active bundles. Archive an unused bundle before creating another.",
          { kind: "bundles" },
          409,
        );
      }
      const walletLimits = this.getWalletLimits();
      if (!walletLimits) {
        throw new UserFacingError(
          "core-required",
          "Configure Core in Bundles before creating another bundle.",
          { kind: "bundles" },
          409,
        );
      }
      if (active.count >= 1 && !walletLimits.confirmedAt) {
        if (!inputs.confirmWalletLimits) {
          throw new UserFacingError(
            "wallet-limits-unconfirmed",
            "Confirm wallet limits in Bundles before creating a second bundle.",
            { kind: "bundles" },
          );
        }
        this.confirmWalletLimits();
      }
      this.assertConfigFitsWallet(inputs.config, walletLimits);
      const id = `bundle-${randomUUID()}`;
      this.assertBundleAssignmentsAvailable(id, inputs.config);
      const now = new Date().toISOString();
      const strategy = this.writeLegacyStrategyForBundle({
        bundleId: id,
        bundleName: name,
        currentStrategyId: null,
        config: inputs.config,
        forkShared: false,
      });
      this.db
        .prepare(
          `INSERT INTO bundles
            (id, owner_address, name, strategy_id, strategy_version_applied,
             maker_account_id, taker_account_id, config, mode, status,
             created_at, updated_at, last_error, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          id,
          this.ownerAddress,
          name,
          strategy.strategyId,
          strategy.version,
          inputs.config.makerAccountId ?? null,
          inputs.config.hedge.accountId ?? null,
          stringify(inputs.config),
          inputs.config.mode,
          "stopped",
          now,
          now,
        );
      this.replaceBundleMarkets(id, inputs.config);
      this.replaceBundleAccountRoles(id, inputs.config);
      return this.getStoredBundle(id)!;
    });
    return create();
  }

  createAllocatedBundle(inputs: {
    name: string;
    makerAccountId: string | null;
    takerAccountId: string | null;
    mode: MakerConfig["mode"];
    /** Compatibility-only scaffold for a paused bundle without a strategy. */
    markets?: MakerConfig["markets"];
    strategyId: string | null;
    confirmWalletLimits?: boolean;
  }): StoredBundle {
    const create = this.db.transaction(() => {
      const name = inputs.name.trim();
      if (!name || name.length > 80 || name.toLowerCase() === "core") {
        throw new UserFacingError(
          "bundle-name-invalid",
          "Use a bundle name between 1 and 80 characters.",
          { kind: "bundles" },
          400,
        );
      }
      if (
        this.db
          .prepare(
            "SELECT 1 FROM bundles WHERE owner_address = ? AND name = ? COLLATE NOCASE",
          )
          .get(this.ownerAddress, name)
      ) {
        throw new UserFacingError(
          "bundle-name-taken",
          "A bundle already uses that name. Choose a different bundle name.",
          { kind: "bundles" },
          409,
        );
      }
      if (inputs.mode === "live") {
        throw new UserFacingError(
          "live-core-only",
          "Only Core can use Live mode. Switch this bundle to Paper.",
          { kind: "bundles" },
          409,
        );
      }
      const active = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM bundles
           WHERE owner_address = ? AND archived_at IS NULL`,
        )
        .get(this.ownerAddress) as { count: number };
      if (active.count >= 4) {
        throw new UserFacingError(
          "bundle-limit",
          "A wallet can have at most four active bundles. Archive an unused bundle before creating another.",
          { kind: "bundles" },
          409,
        );
      }
      const strategy = inputs.strategyId
        ? this.strategyRow(inputs.strategyId)
        : undefined;
      if (inputs.strategyId && (!strategy || strategy.archived_at)) {
        throw new UserFacingError(
          "strategy-not-found",
          "This strategy is no longer available. Choose an active strategy in Strategy.",
          { kind: "strategy" },
          404,
        );
      }
      const strategyConfig = strategy
        ? strategyConfigSchema.parse(parse<unknown>(strategy.config))
        : undefined;
      const strategyMarkets = strategy
        ? this.getStrategyMarkets(strategy.id)
        : (inputs.markets ?? this.getConfig()?.markets ?? []);
      if (!strategyMarkets.length) {
        throw new UserFacingError(
          "needs-markets",
          "Choose a strategy with at least one market before creating this bundle.",
          { kind: "strategy" },
          400,
        );
      }
      const config = strategyConfig
        ? composeMakerConfig({
            strategy: strategyConfig,
            mode: inputs.mode,
            makerAccountId: inputs.makerAccountId,
            takerAccountId: inputs.takerAccountId,
            markets: strategyMarkets,
          })
        : makerConfigSchema.parse({
            markets: strategyMarkets,
            mode: inputs.mode,
            makerAccountId: inputs.makerAccountId,
            hedge: {
              enabled: false,
              accountId: inputs.takerAccountId,
              thresholdUsd: 25,
              maxOrderUsd: 100,
              maxSlippageBps: 75,
            },
          });
      const walletLimits = this.getWalletLimits();
      if (strategy && !walletLimits) {
        throw new UserFacingError(
          "wallet-limits-required",
          "Set Core wallet limits in Bundles before creating this bundle.",
          { kind: "bundles" },
          409,
        );
      }
      if (strategy && walletLimits) {
        if (active.count >= 1 && !walletLimits.confirmedAt) {
          if (!inputs.confirmWalletLimits) {
            throw new UserFacingError(
              "wallet-limits-unconfirmed",
              "Confirm wallet limits in Bundles before creating a second bundle.",
              { kind: "bundles" },
            );
          }
          this.confirmWalletLimits();
        }
        this.assertConfigFitsWallet(config, walletLimits);
      }
      const id = `bundle-${randomUUID()}`;
      this.assertBundleAssignmentsAvailable(id, config);
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO bundles
            (id, owner_address, name, strategy_id, strategy_version_applied,
             maker_account_id, taker_account_id, config, mode, status,
             created_at, updated_at, last_error, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          id,
          this.ownerAddress,
          name,
          strategy?.id ?? null,
          strategy?.version ?? null,
          config.makerAccountId,
          config.hedge.accountId,
          stringify(config),
          config.mode,
          strategy ? "stopped" : "paused",
          now,
          now,
        );
      this.replaceBundleMarkets(id, config);
      this.replaceBundleAccountRoles(id, config);
      return this.getStoredBundle(id)!;
    });
    return create();
  }

  updateBundleAllocation(inputs: {
    bundleId: string;
    makerAccountId?: string | null;
    takerAccountId?: string | null;
    mode?: MakerConfig["mode"];
    markets?: MakerConfig["markets"];
    strategyId?: string | null;
    expectedUpdatedAt?: string;
  }): StoredBundle {
    const update = this.db.transaction(() => {
      const current = this.getBundleRow(inputs.bundleId);
      if (!current || current.archived_at)
        throw new UserFacingError(
          "bundle-not-found",
          "This bundle is no longer available. Refresh Bundles and select an active bundle.",
          { kind: "bundles" },
          404,
        );
      if (
        inputs.expectedUpdatedAt !== undefined &&
        inputs.expectedUpdatedAt !== current.updated_at
      ) {
        throw new UserFacingError(
          "bundle-version-conflict",
          "Bundle changed elsewhere; refresh before saving. Compare your changes with the current bundle.",
          { kind: "bundles" },
          409,
        );
      }
      const makerAccountId =
        inputs.makerAccountId === undefined
          ? current.maker_account_id
          : inputs.makerAccountId;
      const takerAccountId =
        inputs.takerAccountId === undefined
          ? current.taker_account_id
          : inputs.takerAccountId;
      const mode = inputs.mode ?? current.mode;
      if (mode === "live" && current.name !== "Core") {
        throw new UserFacingError(
          "live-core-only",
          "Only Core can use Live mode. Switch this bundle to Paper.",
          { kind: "bundles" },
          409,
        );
      }
      const strategyId =
        inputs.strategyId === undefined
          ? current.strategy_id
          : inputs.strategyId;
      if (inputs.markets !== undefined) {
        throw new UserFacingError(
          "markets-on-strategy",
          "Edit markets in Strategy, then return to Bundles.",
          { kind: "strategy" },
          409,
        );
      }
      const strategy = strategyId ? this.strategyRow(strategyId) : undefined;
      const markets = strategy
        ? this.getStrategyMarkets(strategy.id)
        : this.getBundleMarkets(current.id);
      if (strategyId && (!strategy || strategy.archived_at)) {
        throw new UserFacingError(
          "strategy-not-found",
          "This strategy is no longer available. Choose an active strategy in Strategy.",
          { kind: "strategy" },
          404,
        );
      }
      if (strategy && !markets.length) {
        throw new UserFacingError(
          "needs-markets",
          "Select at least one market in Strategy before attaching it to a bundle.",
          { kind: "strategy" },
          409,
        );
      }
      const fallback = this.composeBundleConfig(current);
      const config = strategy
        ? composeMakerConfig({
            strategy: strategyConfigSchema.parse(
              parse<unknown>(strategy.config),
            ),
            mode,
            makerAccountId,
            takerAccountId,
            markets,
          })
        : makerConfigSchema.parse({
            ...fallback,
            mode,
            makerAccountId,
            hedge: { ...fallback.hedge, accountId: takerAccountId },
            markets,
          });
      const walletLimits = this.getWalletLimits();
      if (walletLimits && strategy)
        this.assertConfigFitsWallet(config, walletLimits);
      this.assertBundleAssignmentsAvailable(current.id, config);
      const updatedAt = this.nextBundleUpdatedAt(current.id);
      this.db
        .prepare(
          `UPDATE bundles
           SET strategy_id = ?, strategy_version_applied = ?,
               maker_account_id = ?, taker_account_id = ?, config = ?, mode = ?,
               status = CASE
                 WHEN ? IS NULL THEN 'paused'
                 WHEN ? IS NULL THEN 'stopped'
                 ELSE status
               END,
               updated_at = ?
           WHERE owner_address = ? AND id = ?`,
        )
        .run(
          strategy?.id ?? null,
          strategy?.version ?? null,
          config.makerAccountId,
          config.hedge.accountId,
          stringify(config),
          config.mode,
          strategy?.id ?? null,
          current.strategy_id,
          updatedAt,
          this.ownerAddress,
          current.id,
        );
      this.replaceBundleMarkets(current.id, config);
      this.replaceBundleAccountRoles(current.id, config);
      if (current.name === "Core") {
        this.db
          .prepare(
            `INSERT INTO tenant_settings (owner_address, key, value, updated_at)
             VALUES (?, 'maker_config', ?, ?)
             ON CONFLICT(owner_address, key) DO UPDATE SET
               value = excluded.value,
               updated_at = excluded.updated_at`,
          )
          .run(this.ownerAddress, stringify(config), updatedAt);
      }
      return this.getStoredBundle(current.id)!;
    });
    return update();
  }

  getStoredBundle(bundleId: string): StoredBundle | null {
    return this.listBundles().find((bundle) => bundle.id === bundleId) ?? null;
  }

  setBundleStatus(
    bundleId: string,
    status: BundleStatus,
    lastError: string | null = null,
  ): StoredBundle {
    const now = this.nextBundleUpdatedAt(bundleId);
    const result = this.db
      .prepare(
        `UPDATE bundles
         SET status = ?, last_error = ?, updated_at = ?
         WHERE owner_address = ? AND id = ? AND archived_at IS NULL`,
      )
      .run(
        status,
        lastError ? lastError.slice(0, 500) : null,
        now,
        this.ownerAddress,
        bundleId,
      );
    if (result.changes !== 1)
      throw new UserFacingError(
        "bundle-not-found",
        "This bundle is no longer available. Refresh Bundles and select an active bundle.",
        { kind: "bundles" },
        404,
      );
    return this.getStoredBundle(bundleId)!;
  }

  archiveBundle(bundleId: string): StoredBundle {
    const archive = this.db.transaction(() => {
      const current = this.db
        .prepare(
          `SELECT name FROM bundles
           WHERE owner_address = ? AND id = ? AND archived_at IS NULL`,
        )
        .get(this.ownerAddress, bundleId) as { name: string } | undefined;
      if (!current)
        throw new UserFacingError(
          "bundle-not-found",
          "This bundle is no longer available. Refresh Bundles and select an active bundle.",
          { kind: "bundles" },
          404,
        );
      if (current.name === "Core") {
        throw new UserFacingError(
          "core-required",
          "Core cannot be archived. Keep it as the wallet control bundle.",
          { kind: "bundles" },
          409,
        );
      }
      const now = this.nextBundleUpdatedAt(bundleId);
      this.db
        .prepare(
          `UPDATE bundles
           SET status = 'stopped', archived_at = ?, updated_at = ?, last_error = NULL
           WHERE owner_address = ? AND id = ?`,
        )
        .run(now, now, this.ownerAddress, bundleId);
      this.db
        .prepare("DELETE FROM bundle_markets WHERE bundle_id = ?")
        .run(bundleId);
      this.db
        .prepare("DELETE FROM bundle_account_roles WHERE bundle_id = ?")
        .run(bundleId);
      return this.getStoredBundle(bundleId)!;
    });
    return archive();
  }

  rollbackBundleMigration(): boolean {
    const rollback = this.db.transaction(() => {
      const backup = this.db
        .prepare(
          `SELECT legacy_config_value, legacy_config_updated_at
           FROM bundle_legacy_backups WHERE owner_address = ?`,
        )
        .get(this.ownerAddress) as
        | {
            legacy_config_value: string;
            legacy_config_updated_at: string;
          }
        | undefined;
      if (!backup) return false;

      const core = this.getCoreRow();
      let legacyValue = backup.legacy_config_value;
      try {
        if (core) {
          legacyValue = stringify(
            normalizeMakerConfig(parse<StoredMakerConfig>(core.config)).config,
          );
        }
      } catch {
        // The pre-migration snapshot remains the lossless fallback when Core is
        // unavailable or no longer valid.
      }

      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO tenant_settings (owner_address, key, value, updated_at)
           VALUES (?, 'maker_config', ?, ?)
           ON CONFLICT(owner_address, key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`,
        )
        .run(this.ownerAddress, legacyValue, now);
      this.db
        .prepare(
          `UPDATE bundle_legacy_backups SET rolled_back_at = ?
           WHERE owner_address = ?`,
        )
        .run(now, this.ownerAddress);
      this.db
        .prepare(
          `UPDATE bundles SET status = 'stopped', updated_at = ?
           WHERE owner_address = ?`,
        )
        .run(now, this.ownerAddress);
      return true;
    });
    return rollback();
  }

  listAccountSetups(): StoredAccountSetup[] {
    const stored = this.getSetting<StoredAccountSetup[]>("account_setups");
    if (stored) return stored;

    const legacy = this.getSetting<Setup>("setup");
    if (!legacy) return [];

    const grant = this.db
      .prepare(
        `SELECT grant_digest, agent_cap_id
         FROM tenant_agents WHERE owner_address = ?`,
      )
      .get(this.ownerAddress) as
      { grant_digest: string | null; agent_cap_id: string | null } | undefined;
    const migrated: StoredAccountSetup[] = [
      {
        ...legacy,
        ownerAddress: this.ownerAddress,
        addedAt: new Date().toISOString(),
        grantDigest: grant?.grant_digest ?? null,
        agentCapId: grant?.agent_cap_id ?? null,
      },
    ];
    this.setSetting("account_setups", migrated);
    if (!this.getSetting<string>("agent_encryption_context")) {
      this.setSetting(
        "agent_encryption_context",
        `account:${legacy.accountId}`,
      );
    }
    return migrated;
  }

  getAccountSetup(accountId: string): StoredAccountSetup | null {
    return (
      this.listAccountSetups().find(
        (account) => account.accountId === accountId,
      ) ?? null
    );
  }

  getSetup(): Setup | null {
    const accounts = this.listAccountSetups();
    const configuredId = this.getConfig()?.makerAccountId;
    const selected =
      (configuredId
        ? accounts.find((account) => account.accountId === configuredId)
        : null) ??
      accounts.find((account) => account.agentCapId) ??
      accounts[0];
    if (!selected) return null;
    const {
      addedAt: _addedAt,
      grantDigest: _grantDigest,
      agentCapId: _agentCapId,
      ...setup
    } = selected;
    return setup;
  }

  setSetup(setup: Setup): StoredAccountSetup {
    if (normalizeAddress(setup.ownerAddress) !== this.ownerAddress) {
      throw new UserFacingError(
        "account-owner-mismatch",
        "Connect the wallet that owns this account before setting it up.",
        { kind: "accounts" },
        403,
      );
    }
    const accounts = this.listAccountSetups();
    const existing = accounts.find(
      (account) => account.accountId === setup.accountId,
    );
    const next: StoredAccountSetup = {
      ...setup,
      ownerAddress: this.ownerAddress,
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      grantDigest: existing?.grantDigest ?? null,
      agentCapId: existing?.agentCapId ?? null,
    };
    this.setSetting("account_setups", [
      ...accounts.filter((account) => account.accountId !== setup.accountId),
      next,
    ]);
    return next;
  }

  listAccountMetadata(): StoredAccountMetadata[] {
    return this.getSetting<StoredAccountMetadata[]>("account_metadata") ?? [];
  }

  getAccountMetadata(accountId: string): StoredAccountMetadata | null {
    return (
      this.listAccountMetadata().find(
        (metadata) => metadata.accountId === accountId,
      ) ?? null
    );
  }

  setAccountMetadata(inputs: {
    accountId: string;
    label: string | null;
    tags: string[];
  }): StoredAccountMetadata {
    const metadata = this.listAccountMetadata();
    const next: StoredAccountMetadata = {
      ...inputs,
      updatedAt: new Date().toISOString(),
    };
    this.setSetting("account_metadata", [
      ...metadata.filter((item) => item.accountId !== inputs.accountId),
      next,
    ]);
    return next;
  }

  getAgent(): StoredAgent | null {
    const row = this.db
      .prepare(
        `SELECT address, encrypted_secret, created_at
         FROM tenant_agents WHERE owner_address = ?`,
      )
      .get(this.ownerAddress) as
      | {
          address: string;
          encrypted_secret: string;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    const fallbackAccount = this.listAccountSetups()[0];
    const encryptionContext =
      this.getSetting<string>("agent_encryption_context") ??
      (fallbackAccount ? `account:${fallbackAccount.accountId}` : null);
    if (!encryptionContext) {
      throw new Error("Agent encryption context is unavailable");
    }
    return {
      address: row.address,
      encryptedSecret: parse<EncryptedSecret>(row.encrypted_secret),
      encryptionContext,
      createdAt: row.created_at,
    };
  }

  createAgent(inputs: {
    address: string;
    encryptedSecret: EncryptedSecret;
    encryptionContext: string;
  }): StoredAgent {
    const existing = this.getAgent();
    if (existing) return existing;

    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tenant_agents
          (owner_address, address, encrypted_secret, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        this.ownerAddress,
        inputs.address,
        stringify(inputs.encryptedSecret),
        createdAt,
      );
    this.setSetting("agent_encryption_context", inputs.encryptionContext);
    return {
      address: inputs.address,
      encryptedSecret: inputs.encryptedSecret,
      encryptionContext: inputs.encryptionContext,
      createdAt,
    };
  }

  clearAgentGrant(accountId: string): void {
    const accounts = this.listAccountSetups();
    if (!accounts.some((account) => account.accountId === accountId)) {
      throw new UserFacingError(
        "account-not-found",
        "This account setup is no longer available. Select an account in Venues.",
        { kind: "venues" },
        404,
      );
    }
    this.setSetting(
      "account_setups",
      accounts.map((account) =>
        account.accountId === accountId
          ? { ...account, grantDigest: null, agentCapId: null }
          : account,
      ),
    );
  }

  confirmAgentGrant(inputs: {
    accountId: string;
    digest: string;
    agentCapId: string;
  }): void {
    const accounts = this.listAccountSetups();
    if (!accounts.some((account) => account.accountId === inputs.accountId)) {
      throw new UserFacingError(
        "account-not-found",
        "This account setup is no longer available. Select an account in Venues.",
        { kind: "venues" },
        404,
      );
    }
    this.setSetting(
      "account_setups",
      accounts.map((account) =>
        account.accountId === inputs.accountId
          ? {
              ...account,
              grantDigest: inputs.digest,
              agentCapId: inputs.agentCapId,
            }
          : account,
      ),
    );
  }

  logEvent(inputs: {
    category: string;
    action: string;
    outcome: string;
    detail?: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO tenant_audit_events
          (owner_address, bundle_id, occurred_at, category, action, outcome, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.ownerAddress,
        this.attributedBundleId(),
        new Date().toISOString(),
        inputs.category,
        inputs.action,
        inputs.outcome,
        stringify(inputs.detail ?? {}),
      );
    this.pruneTable("tenant_audit_events", RETENTION_LIMITS.auditEvents);
  }

  listEvents(
    limit = 50,
    bundleId: string | null | undefined = this.bundleId,
    problems = false,
  ): AuditEvent[] {
    const beforeBundles = bundleId === "before";
    const rows = this.db
      .prepare(
        `SELECT id, bundle_id, occurred_at, category, action, outcome, detail
         FROM tenant_audit_events
         WHERE owner_address = ?
           AND (
             ? IS NULL OR
             (? = 'before' AND bundle_id IS NULL) OR
             bundle_id = ?
           )
           AND (? = 0 OR outcome IN (${PROBLEM_OUTCOMES.map(() => "?").join(", ")}))
         ORDER BY id DESC LIMIT ?`,
      )
      .all(
        this.ownerAddress,
        bundleId ?? null,
        beforeBundles ? "before" : (bundleId ?? null),
        beforeBundles ? "before" : (bundleId ?? null),
        problems ? 1 : 0,
        ...PROBLEM_OUTCOMES,
        limit,
      ) as Array<{
      id: number;
      bundle_id: string | null;
      occurred_at: string;
      category: string;
      action: string;
      outcome: string;
      detail: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      bundleId: row.bundle_id,
      occurredAt: row.occurred_at,
      category: row.category,
      action: row.action,
      outcome: row.outcome,
      detail: parse<Record<string, unknown>>(row.detail),
    }));
  }

  logExecution(inputs: {
    mode: string;
    marketId: string;
    digest?: string;
    endpoint?: string;
    bidPrice: number;
    askPrice: number;
    sizeUsd: number;
    outcome: string;
    error?: string;
    gasUsedMist?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO tenant_executions
          (owner_address, bundle_id, occurred_at, mode, market_id, digest, endpoint,
           bid_price, ask_price, size_usd, outcome, error, gas_used_mist)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.ownerAddress,
        this.attributedBundleId(),
        new Date().toISOString(),
        inputs.mode,
        inputs.marketId,
        inputs.digest ?? null,
        inputs.endpoint ?? null,
        inputs.bidPrice,
        inputs.askPrice,
        inputs.sizeUsd,
        inputs.outcome,
        inputs.error ?? null,
        inputs.gasUsedMist ?? null,
      );
    this.pruneTable("tenant_executions", RETENTION_LIMITS.executions);
  }

  private paperBundleId(): string {
    return this.attributedBundleId() ?? "";
  }

  /** Replace only the simulated resting orders for this market and scope. */
  recordPaperQuote(inputs: {
    trialId: string;
    marketId: string;
    symbol: string;
    bidPrice: number;
    askPrice: number;
    sizeUsd: number;
  }): void {
    const bundleId = this.paperBundleId();
    const now = new Date().toISOString();
    const quoteKey = `${now}:${Math.random().toString(36).slice(2, 10)}`;
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE tenant_paper_orders
           SET status = 'replaced', updated_at = ?
           WHERE owner_address = ? AND bundle_id = ? AND trial_id = ?
             AND market_id = ? AND status = 'open'`,
        )
        .run(now, this.ownerAddress, bundleId, inputs.trialId, inputs.marketId);
      const insert = this.db.prepare(
        `INSERT INTO tenant_paper_orders
          (owner_address, bundle_id, trial_id, order_key, market_id, symbol,
           side, price, size_usd, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      );
      insert.run(
        this.ownerAddress,
        bundleId,
        inputs.trialId,
        `${quoteKey}:bid`,
        inputs.marketId,
        inputs.symbol,
        "bid",
        inputs.bidPrice,
        inputs.sizeUsd,
        now,
        now,
      );
      insert.run(
        this.ownerAddress,
        bundleId,
        inputs.trialId,
        `${quoteKey}:ask`,
        inputs.marketId,
        inputs.symbol,
        "ask",
        inputs.askPrice,
        inputs.sizeUsd,
        now,
        now,
      );
    });
    write();
    this.pruneTable("tenant_paper_orders", RETENTION_LIMITS.paperOrders);
  }

  /**
   * A Paper fill is an estimate only: it occurs when a later observed book
   * crosses a simulated resting order. No chain state or real order history is
   * ever read back as a Paper fill.
   */
  matchPaperOrders(inputs: {
    trialId: string;
    marketId: string;
    bestBid: number;
    bestAsk: number;
  }): PaperFill[] {
    const bundleId = this.paperBundleId();
    const rows = this.db
      .prepare(
        `SELECT order_key, market_id, symbol, side, price, size_usd
         FROM tenant_paper_orders
         WHERE owner_address = ? AND bundle_id = ? AND trial_id = ?
           AND market_id = ? AND status = 'open'
         ORDER BY created_at ASC, order_key ASC`,
      )
      .all(
        this.ownerAddress,
        bundleId,
        inputs.trialId,
        inputs.marketId,
      ) as Array<{
      order_key: string;
      market_id: string;
      symbol: string;
      side: "bid" | "ask";
      price: number;
      size_usd: number;
    }>;
    const fills = rows.filter(
      (order) =>
        (order.side === "bid" && inputs.bestAsk <= order.price) ||
        (order.side === "ask" && inputs.bestBid >= order.price),
    );
    if (!fills.length) return [];
    const now = new Date().toISOString();
    const write = this.db.transaction(() => {
      const close = this.db.prepare(
        `UPDATE tenant_paper_orders
         SET status = 'filled', updated_at = ?
         WHERE owner_address = ? AND bundle_id = ? AND trial_id = ?
           AND order_key = ? AND status = 'open'`,
      );
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO tenant_paper_fills
          (owner_address, bundle_id, trial_id, order_key, role, market_id,
           symbol, side, price, size_usd, occurred_at)
         VALUES (?, ?, ?, ?, 'maker', ?, ?, ?, ?, ?, ?)`,
      );
      for (const fill of fills) {
        close.run(
          now,
          this.ownerAddress,
          bundleId,
          inputs.trialId,
          fill.order_key,
        );
        insert.run(
          this.ownerAddress,
          bundleId,
          inputs.trialId,
          fill.order_key,
          fill.market_id,
          fill.symbol,
          fill.side,
          fill.price,
          fill.size_usd,
          now,
        );
      }
    });
    write();
    this.pruneTable("tenant_paper_fills", RETENTION_LIMITS.paperFills);
    return fills.map((fill) => ({
      orderKey: fill.order_key,
      role: "maker",
      marketId: fill.market_id,
      symbol: fill.symbol,
      side: fill.side,
      price: fill.price,
      sizeUsd: fill.size_usd,
      occurredAt: now,
    }));
  }

  /** Record the estimated opposite-side hedge without sending a transaction. */
  recordPaperHedge(inputs: { trialId: string; makerFill: PaperFill }): void {
    const bundleId = this.paperBundleId();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO tenant_paper_fills
          (owner_address, bundle_id, trial_id, order_key, role, market_id,
           symbol, side, price, size_usd, occurred_at)
         VALUES (?, ?, ?, ?, 'hedge', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.ownerAddress,
        bundleId,
        inputs.trialId,
        `hedge:${inputs.makerFill.orderKey}`,
        inputs.makerFill.marketId,
        inputs.makerFill.symbol,
        inputs.makerFill.side === "bid" ? "ask" : "bid",
        inputs.makerFill.price,
        inputs.makerFill.sizeUsd,
        new Date().toISOString(),
      );
    this.pruneTable("tenant_paper_fills", RETENTION_LIMITS.paperFills);
  }

  getPaperState(trialId: string): {
    openOrders: number;
    fills: number;
    hedges: number;
    positions: PaperPosition[];
  } {
    const bundleId = this.paperBundleId();
    const open = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM tenant_paper_orders
         WHERE owner_address = ? AND bundle_id = ? AND trial_id = ?
           AND status = 'open'`,
      )
      .get(this.ownerAddress, bundleId, trialId) as { count: number };
    const fills = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM tenant_paper_fills
         WHERE owner_address = ? AND bundle_id = ? AND trial_id = ?`,
      )
      .get(this.ownerAddress, bundleId, trialId) as { count: number };
    const hedges = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM tenant_paper_fills
         WHERE owner_address = ? AND bundle_id = ? AND trial_id = ?
           AND role = 'hedge'`,
      )
      .get(this.ownerAddress, bundleId, trialId) as { count: number };
    const positions = this.db
      .prepare(
        `SELECT role, market_id, symbol,
                SUM(CASE WHEN side = 'bid' THEN size_usd ELSE -size_usd END)
                  AS inventory_usd
         FROM tenant_paper_fills
         WHERE owner_address = ? AND bundle_id = ? AND trial_id = ?
         GROUP BY role, market_id, symbol
         HAVING ABS(inventory_usd) > 0.000001
         ORDER BY market_id ASC, role ASC`,
      )
      .all(this.ownerAddress, bundleId, trialId) as Array<{
      role: "maker" | "hedge";
      market_id: string;
      symbol: string;
      inventory_usd: number;
    }>;
    return {
      openOrders: open.count,
      fills: fills.count,
      hedges: hedges.count,
      positions: positions.map((position) => ({
        role: position.role,
        marketId: position.market_id,
        symbol: position.symbol,
        inventoryUsd: position.inventory_usd,
      })),
    };
  }

  listPaperFills(
    inputs: { trialId?: string; limit?: number } = {},
  ): PaperFill[] {
    const bundleId = this.paperBundleId();
    const limit = inputs.limit ?? 200;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error("Paper fill limit must be between 1 and 10000");
    }
    const rows = this.db
      .prepare(
        `SELECT order_key, role, market_id, symbol, side, price, size_usd,
                occurred_at
         FROM tenant_paper_fills
         WHERE owner_address = ? AND bundle_id = ?
           AND (? IS NULL OR trial_id = ?)
         ORDER BY occurred_at DESC, id DESC
         LIMIT ?`,
      )
      .all(
        this.ownerAddress,
        bundleId,
        inputs.trialId ?? null,
        inputs.trialId ?? null,
        limit,
      ) as Array<{
      order_key: string;
      role: "maker" | "hedge";
      market_id: string;
      symbol: string;
      side: "bid" | "ask";
      price: number;
      size_usd: number;
      occurred_at: string;
    }>;
    return rows.map((row) => ({
      orderKey: row.order_key,
      role: row.role,
      marketId: row.market_id,
      symbol: row.symbol,
      side: row.side,
      price: row.price,
      sizeUsd: row.size_usd,
      occurredAt: row.occurred_at,
    }));
  }

  cancelPaperOrders(trialId?: string): void {
    const bundleId = this.paperBundleId();
    this.db
      .prepare(
        `UPDATE tenant_paper_orders
         SET status = 'cancelled', updated_at = ?
         WHERE owner_address = ? AND bundle_id = ? AND status = 'open'
           AND (? IS NULL OR trial_id = ?)`,
      )
      .run(
        new Date().toISOString(),
        this.ownerAddress,
        bundleId,
        trialId ?? null,
        trialId ?? null,
      );
  }

  trackMakerOrders(inputs: {
    accountId: string;
    marketId: string;
    quoteDigest: string;
    orderIds: string[];
  }): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO tenant_maker_orders
        (owner_address, bundle_id, account_id, order_id, market_id, quote_digest,
         posted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const postedAt = new Date().toISOString();
    const bundleId = this.attributedBundleId();
    this.db.transaction(() => {
      for (const orderId of inputs.orderIds) {
        insert.run(
          this.ownerAddress,
          bundleId,
          inputs.accountId,
          orderId,
          inputs.marketId,
          inputs.quoteDigest,
          postedAt,
        );
      }
      this.pruneTable("tenant_maker_orders", RETENTION_LIMITS.makerOrders);
    })();
  }

  listTrackedMakerOrders(
    inputs: { accountId?: string; limit?: number } = {},
  ): TrackedMakerOrder[] {
    const limit = Math.min(
      RETENTION_LIMITS.makerOrders,
      Math.max(1, inputs.limit ?? RETENTION_LIMITS.makerOrders),
    );
    const rows = this.db
      .prepare(
        `SELECT account_id, order_id, market_id, quote_digest, posted_at
         FROM tenant_maker_orders
         WHERE owner_address = ?
           AND (? IS NULL OR bundle_id = ?)
           AND (? IS NULL OR account_id = ? OR account_id = '')
         ORDER BY posted_at DESC
         LIMIT ?`,
      )
      .all(
        this.ownerAddress,
        this.bundleId,
        this.bundleId,
        inputs.accountId ?? null,
        inputs.accountId ?? null,
        limit,
      ) as Array<{
      account_id: string;
      order_id: string;
      market_id: string;
      quote_digest: string;
      posted_at: string;
    }>;
    return rows.map((row) => ({
      accountId: row.account_id,
      orderId: row.order_id,
      marketId: row.market_id,
      quoteDigest: row.quote_digest,
      postedAt: row.posted_at,
    }));
  }

  countTrackedMakerOrders(bundleId: string | null = this.bundleId): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM tenant_maker_orders
         WHERE owner_address = ? AND (? IS NULL OR bundle_id = ?)`,
      )
      .get(this.ownerAddress, bundleId, bundleId) as { count: number };
    return row.count;
  }

  isHedgeFillProcessed(makerAccountId: string, fillKey: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM tenant_hedged_fills
           WHERE owner_address = ?
             AND (? IS NULL OR bundle_id = ?)
             AND maker_account_id = ? AND fill_key = ?`,
        )
        .get(
          this.ownerAddress,
          this.bundleId,
          this.bundleId,
          makerAccountId,
          fillKey,
        ),
    );
  }

  markHedgeFillsProcessed(inputs: {
    makerAccountId: string;
    fillKeys: string[];
    hedgeDigest: string;
  }): void {
    const mark = this.db.prepare(
      `INSERT OR IGNORE INTO tenant_hedged_fills
        (owner_address, bundle_id, maker_account_id, fill_key, hedge_digest,
         processed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const processedAt = new Date().toISOString();
    const bundleId = this.attributedBundleId();
    this.db.transaction(() => {
      for (const fillKey of inputs.fillKeys) {
        mark.run(
          this.ownerAddress,
          bundleId,
          inputs.makerAccountId,
          fillKey,
          inputs.hedgeDigest,
          processedAt,
        );
      }
      this.pruneTable("tenant_hedged_fills", RETENTION_LIMITS.hedgedFills);
    })();
  }

  recordHedgeExecution(inputs: {
    makerAccountId: string;
    hedgeAccountId: string;
    marketId: string;
    digest: string;
    side: "bid" | "ask";
    requestedNotionalUsd: number;
    gasUsedMist: number;
    fillKeys: string[];
  }): void {
    const occurredAt = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO tenant_hedge_executions
            (owner_address, bundle_id, occurred_at, maker_account_id,
             hedge_account_id, market_id, digest, side, requested_notional_usd,
             gas_used_mist)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.ownerAddress,
          this.attributedBundleId(),
          occurredAt,
          inputs.makerAccountId,
          inputs.hedgeAccountId,
          inputs.marketId,
          inputs.digest,
          inputs.side,
          inputs.requestedNotionalUsd,
          inputs.gasUsedMist,
        );
      const mark = this.db.prepare(
        `INSERT OR IGNORE INTO tenant_hedged_fills
          (owner_address, bundle_id, maker_account_id, fill_key, hedge_digest,
           processed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const fillKey of inputs.fillKeys) {
        mark.run(
          this.ownerAddress,
          this.attributedBundleId(),
          inputs.makerAccountId,
          fillKey,
          inputs.digest,
          occurredAt,
        );
      }
      this.pruneTable(
        "tenant_hedge_executions",
        RETENTION_LIMITS.hedgeExecutions,
      );
      this.pruneTable("tenant_hedged_fills", RETENTION_LIMITS.hedgedFills);
    })();
  }

  listHedgeExecutions(limit = 500): HedgeExecution[] {
    const rows = this.db
      .prepare(
        `SELECT occurred_at, maker_account_id, hedge_account_id, market_id,
                digest, side, requested_notional_usd, gas_used_mist
         FROM tenant_hedge_executions
         WHERE owner_address = ?
           AND (? IS NULL OR bundle_id = ?)
         ORDER BY occurred_at DESC
         LIMIT ?`,
      )
      .all(this.ownerAddress, this.bundleId, this.bundleId, limit) as Array<{
      occurred_at: string;
      maker_account_id: string;
      hedge_account_id: string;
      market_id: string;
      digest: string;
      side: "bid" | "ask";
      requested_notional_usd: number;
      gas_used_mist: number;
    }>;
    return rows.map((row) => ({
      occurredAt: row.occurred_at,
      makerAccountId: row.maker_account_id,
      hedgeAccountId: row.hedge_account_id,
      marketId: row.market_id,
      digest: row.digest,
      side: row.side,
      requestedNotionalUsd: row.requested_notional_usd,
      gasUsedMist: row.gas_used_mist,
    }));
  }

  getExecutionStats(): ExecutionStats {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS confirmed_live_quotes,
                AVG(gas_used_mist) AS average_gas_mist,
                MAX(occurred_at) AS last_execution_at
         FROM tenant_executions
         WHERE owner_address = ?
           AND (? IS NULL OR bundle_id = ?)
           AND mode = 'live'
           AND outcome = 'confirmed'`,
      )
      .get(this.ownerAddress, this.bundleId, this.bundleId) as {
      confirmed_live_quotes: number;
      average_gas_mist: number | null;
      last_execution_at: string | null;
    };
    return {
      confirmedLiveQuotes: row.confirmed_live_quotes,
      averageGasMist: row.average_gas_mist,
      lastExecutionAt: row.last_execution_at,
    };
  }
}
