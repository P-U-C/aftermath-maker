import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { EncryptedSecret } from "@puc/aftermath";
import { makerConfigSchema, type MakerConfig, type Setup } from "@puc/core";

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

export type BundleStatus = "stopped" | "running" | "paused" | "error";

export type BundleWalletLimits = {
  maxRunDrawdownUsd: number;
  maxInventoryUsd: number;
  maxGrossExposureUsd: number;
  maxUnrealizedLossUsd: number;
  updatedAt: string;
};

export type StoredBundle = {
  id: string;
  ownerAddress: string;
  name: string;
  makerAccountId: string | null;
  takerAccountId: string | null;
  mode: MakerConfig["mode"];
  marketIds: string[];
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
};

type BundleRow = {
  id: string;
  owner_address: string;
  name: string;
  maker_account_id: string | null;
  taker_account_id: string | null;
  config: string;
  mode: MakerConfig["mode"];
  status: BundleStatus;
  created_at: string;
  updated_at: string;
  last_error: string | null;
};

export const RETENTION_LIMITS = {
  auditEvents: 10_000,
  executions: 50_000,
  makerOrders: 2_000,
  hedgeExecutions: 10_000,
  hedgedFills: 20_000,
  accessRequests: 10_000,
} as const;

type RetentionTable =
  | "tenant_audit_events"
  | "tenant_executions"
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
        CREATE TABLE IF NOT EXISTS bundles (
          id TEXT PRIMARY KEY,
          owner_address TEXT NOT NULL,
          name TEXT NOT NULL COLLATE NOCASE,
          maker_account_id TEXT,
          taker_account_id TEXT,
          config TEXT NOT NULL,
          mode TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('stopped', 'running', 'paused', 'error')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_error TEXT,
          CHECK (
            maker_account_id IS NULL OR taker_account_id IS NULL OR
            maker_account_id <> taker_account_id
          ),
          UNIQUE (owner_address, name)
        );

        CREATE TABLE IF NOT EXISTS bundle_markets (
          bundle_id TEXT NOT NULL,
          owner_address TEXT NOT NULL,
          market_id TEXT NOT NULL,
          symbol TEXT NOT NULL,
          PRIMARY KEY (bundle_id, market_id),
          UNIQUE (owner_address, market_id),
          FOREIGN KEY (bundle_id) REFERENCES bundles(id) ON DELETE CASCADE
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
          updated_at TEXT NOT NULL
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

        CREATE TABLE IF NOT EXISTS bundle_config_mirrors (
          owner_address TEXT PRIMARY KEY,
          core_config_updated_at TEXT NOT NULL,
          mirrored_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS bundles_owner_status
          ON bundles(owner_address, status, updated_at DESC);
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
      this.db.exec(`
        UPDATE bundle_markets
        SET owner_address = (
          SELECT owner_address FROM bundles
          WHERE bundles.id = bundle_markets.bundle_id
        )
        WHERE owner_address = '';

        CREATE UNIQUE INDEX IF NOT EXISTS bundle_markets_owner_market_unique
          ON bundle_markets(owner_address, market_id);

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
                  config, updated_at
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
      }>;
      for (const bundle of existingBundles) {
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
    });
    migrate();
  }

  forTenant(ownerAddress: string): TenantStore {
    return new TenantStore(this.db, normalizeAddress(ownerAddress));
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
        `SELECT id, owner_address, name, maker_account_id, taker_account_id,
                config, mode, status, created_at, updated_at, last_error
         FROM bundles
         WHERE owner_address = ? AND name = 'Core'`,
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

  private configSource():
    { kind: "core"; value: string } | { kind: "legacy"; value: string } | null {
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

  private replaceBundleMarkets(bundleId: string, config: MakerConfig): void {
    this.db
      .prepare("DELETE FROM bundle_markets WHERE bundle_id = ?")
      .run(bundleId);
    const insert = this.db.prepare(
      `INSERT INTO bundle_markets
        (bundle_id, owner_address, market_id, symbol)
       VALUES (?, ?, ?, ?)`,
    );
    for (const market of config.markets) {
      insert.run(bundleId, this.ownerAddress, market.marketId, market.symbol);
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

  private writeCoreConfig(config: MakerConfig): void {
    const existing = this.getCoreRow();
    const now = new Date().toISOString();
    const id = existing?.id ?? coreBundleId(this.ownerAddress);
    const serialized = stringify(config);
    const write = this.db.transaction(() => {
      if (existing) {
        this.db
          .prepare(
            `UPDATE bundles
             SET maker_account_id = ?, taker_account_id = ?, config = ?, mode = ?,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(
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
              (id, owner_address, name, maker_account_id, taker_account_id,
               config, mode, status, created_at, updated_at, last_error)
             VALUES (?, ?, 'Core', ?, ?, ?, ?, 'stopped', ?, ?, NULL)`,
          )
          .run(
            id,
            this.ownerAddress,
            config.makerAccountId ?? null,
            config.hedge.accountId ?? null,
            serialized,
            config.mode,
            now,
            now,
          );
      }
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
    const source = this.configSource();
    if (!source) return null;
    const { config, migrated } = normalizeMakerConfig(
      parse<StoredMakerConfig>(source.value),
    );
    if (migrated) {
      if (source.kind === "core") this.writeCoreConfig(config);
      else this.setSetting("maker_config", config);
    }
    return config;
  }

  setConfig(config: MakerConfig): void {
    this.writeCoreConfig(config);
  }

  listBundles(): StoredBundle[] {
    const rows = this.db
      .prepare(
        `SELECT id, owner_address, name, maker_account_id, taker_account_id,
                config, mode, status, created_at, updated_at, last_error
         FROM bundles
         WHERE owner_address = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(this.ownerAddress) as BundleRow[];
    const markets = this.db.prepare(
      `SELECT market_id FROM bundle_markets
       WHERE bundle_id = ? ORDER BY market_id ASC`,
    );
    return rows.map((row) => ({
      id: row.id,
      ownerAddress: row.owner_address,
      name: row.name,
      makerAccountId: row.maker_account_id,
      takerAccountId: row.taker_account_id,
      mode: row.mode,
      marketIds: (markets.all(row.id) as Array<{ market_id: string }>).map(
        (market) => market.market_id,
      ),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastError: row.last_error,
    }));
  }

  getBundleConfig(bundleId: string): MakerConfig | null {
    const row = this.db
      .prepare(
        `SELECT config FROM bundles
         WHERE owner_address = ? AND id = ?`,
      )
      .get(this.ownerAddress, bundleId) as { config: string } | undefined;
    return row ? makerConfigSchema.parse(parse<unknown>(row.config)) : null;
  }

  getWalletLimits(): BundleWalletLimits | null {
    const row = this.db
      .prepare(
        `SELECT max_run_drawdown_usd, max_inventory_usd,
                max_gross_exposure_usd, max_unrealized_loss_usd, updated_at
         FROM bundle_wallet_limits WHERE owner_address = ?`,
      )
      .get(this.ownerAddress) as
      | {
          max_run_drawdown_usd: number;
          max_inventory_usd: number;
          max_gross_exposure_usd: number;
          max_unrealized_loss_usd: number;
          updated_at: string;
        }
      | undefined;
    return row
      ? {
          maxRunDrawdownUsd: row.max_run_drawdown_usd,
          maxInventoryUsd: row.max_inventory_usd,
          maxGrossExposureUsd: row.max_gross_exposure_usd,
          maxUnrealizedLossUsd: row.max_unrealized_loss_usd,
          updatedAt: row.updated_at,
        }
      : null;
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
      throw new Error("Setup owner does not match authenticated wallet");
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
      throw new Error("Account setup was not found");
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
      throw new Error("Account setup was not found");
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
          (owner_address, occurred_at, category, action, outcome, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.ownerAddress,
        new Date().toISOString(),
        inputs.category,
        inputs.action,
        inputs.outcome,
        stringify(inputs.detail ?? {}),
      );
    this.pruneTable("tenant_audit_events", RETENTION_LIMITS.auditEvents);
  }

  listEvents(limit = 50): AuditEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, occurred_at, category, action, outcome, detail
         FROM tenant_audit_events
         WHERE owner_address = ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(this.ownerAddress, limit) as Array<{
      id: number;
      occurred_at: string;
      category: string;
      action: string;
      outcome: string;
      detail: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
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
          (owner_address, occurred_at, mode, market_id, digest, endpoint,
           bid_price, ask_price, size_usd, outcome, error, gas_used_mist)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.ownerAddress,
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

  trackMakerOrders(inputs: {
    accountId: string;
    marketId: string;
    quoteDigest: string;
    orderIds: string[];
  }): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO tenant_maker_orders
        (owner_address, account_id, order_id, market_id, quote_digest, posted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const postedAt = new Date().toISOString();
    this.db.transaction(() => {
      for (const orderId of inputs.orderIds) {
        insert.run(
          this.ownerAddress,
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
           AND (? IS NULL OR account_id = ? OR account_id = '')
         ORDER BY posted_at DESC
         LIMIT ?`,
      )
      .all(
        this.ownerAddress,
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

  isHedgeFillProcessed(makerAccountId: string, fillKey: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM tenant_hedged_fills
           WHERE owner_address = ? AND maker_account_id = ? AND fill_key = ?`,
        )
        .get(this.ownerAddress, makerAccountId, fillKey),
    );
  }

  markHedgeFillsProcessed(inputs: {
    makerAccountId: string;
    fillKeys: string[];
    hedgeDigest: string;
  }): void {
    const mark = this.db.prepare(
      `INSERT OR IGNORE INTO tenant_hedged_fills
        (owner_address, maker_account_id, fill_key, hedge_digest, processed_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const processedAt = new Date().toISOString();
    this.db.transaction(() => {
      for (const fillKey of inputs.fillKeys) {
        mark.run(
          this.ownerAddress,
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
            (owner_address, occurred_at, maker_account_id, hedge_account_id,
             market_id, digest, side, requested_notional_usd, gas_used_mist)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.ownerAddress,
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
          (owner_address, maker_account_id, fill_key, hedge_digest, processed_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const fillKey of inputs.fillKeys) {
        mark.run(
          this.ownerAddress,
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
         ORDER BY occurred_at DESC
         LIMIT ?`,
      )
      .all(this.ownerAddress, limit) as Array<{
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
           AND mode = 'live'
           AND outcome = 'confirmed'`,
      )
      .get(this.ownerAddress) as {
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
