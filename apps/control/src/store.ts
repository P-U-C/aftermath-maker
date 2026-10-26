import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { EncryptedSecret } from "@puc/aftermath";
import { makerConfigSchema, type MakerConfig, type Setup } from "@puc/core";

const stringify = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? `${item.toString()}n` : item,
  );

const parse = <T>(value: string): T =>
  JSON.parse(value, (_key, item) => {
    if (typeof item === "string" && /^\d+n$/.test(item)) {
      return BigInt(item.slice(0, -1));
    }
    return item;
  }) as T;

const normalizeAddress = (address: string) => address.toLowerCase();

export type StoredAgent = {
  address: string;
  encryptedSecret: EncryptedSecret;
  createdAt: string;
  grantDigest: string | null;
  agentCapId: string | null;
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
        error TEXT
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

      CREATE INDEX IF NOT EXISTS tenant_audit_events_owner_time
        ON tenant_audit_events(owner_address, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS tenant_executions_owner_time
        ON tenant_executions(owner_address, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS auth_sessions_owner
        ON auth_sessions(owner_address);
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry
        ON auth_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS auth_challenges_expiry
        ON auth_challenges(expires_at);
    `);
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

  forTenant(ownerAddress: string): TenantStore {
    return new TenantStore(this.db, normalizeAddress(ownerAddress));
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

  close(): void {
    this.db.close();
  }
}

export class TenantStore {
  constructor(
    private readonly db: Database.Database,
    public readonly ownerAddress: string,
  ) {}

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

  getConfig(): MakerConfig | null {
    const stored = this.getSetting<MakerConfig & { maxDailyLossUsd?: number }>(
      "maker_config",
    );
    if (!stored) return null;

    const legacyLossLimit = stored.maxDailyLossUsd;
    const normalized = { ...stored } as Record<string, unknown>;
    delete normalized.maxDailyLossUsd;
    if (
      normalized.maxUnrealizedLossUsd === undefined &&
      legacyLossLimit !== undefined
    ) {
      normalized.maxUnrealizedLossUsd = legacyLossLimit;
      this.setSetting("maker_config", normalized);
    }
    return makerConfigSchema.parse(normalized);
  }

  setConfig(config: MakerConfig): void {
    this.setSetting("maker_config", config);
  }

  getSetup(): Setup | null {
    return this.getSetting<Setup>("setup");
  }

  setSetup(setup: Setup): void {
    if (normalizeAddress(setup.ownerAddress) !== this.ownerAddress) {
      throw new Error("Setup owner does not match authenticated wallet");
    }
    this.setSetting("setup", {
      ...setup,
      ownerAddress: this.ownerAddress,
    });
  }

  getAgent(): StoredAgent | null {
    const row = this.db
      .prepare(
        `SELECT address, encrypted_secret, created_at, grant_digest, agent_cap_id
         FROM tenant_agents WHERE owner_address = ?`,
      )
      .get(this.ownerAddress) as
      | {
          address: string;
          encrypted_secret: string;
          created_at: string;
          grant_digest: string | null;
          agent_cap_id: string | null;
        }
      | undefined;
    return row
      ? {
          address: row.address,
          encryptedSecret: parse<EncryptedSecret>(row.encrypted_secret),
          createdAt: row.created_at,
          grantDigest: row.grant_digest,
          agentCapId: row.agent_cap_id,
        }
      : null;
  }

  createAgent(inputs: {
    address: string;
    encryptedSecret: EncryptedSecret;
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
    return {
      address: inputs.address,
      encryptedSecret: inputs.encryptedSecret,
      createdAt,
      grantDigest: null,
      agentCapId: null,
    };
  }

  confirmAgentGrant(inputs: { digest: string; agentCapId: string }): void {
    this.db
      .prepare(
        `UPDATE tenant_agents
         SET grant_digest = ?, agent_cap_id = ?
         WHERE owner_address = ?`,
      )
      .run(inputs.digest, inputs.agentCapId, this.ownerAddress);
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
  }): void {
    this.db
      .prepare(
        `INSERT INTO tenant_executions
          (owner_address, occurred_at, mode, market_id, digest, endpoint,
           bid_price, ask_price, size_usd, outcome, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
  }
}
