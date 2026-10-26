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

export class Store {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
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

      CREATE INDEX IF NOT EXISTS audit_events_time
        ON audit_events(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS executions_time
        ON executions(occurred_at DESC);
    `);
  }

  private getSetting<T>(key: string): T | null {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row ? parse<T>(row.value) : null;
  }

  private setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(key, stringify(value), new Date().toISOString());
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
    this.setSetting("setup", setup);
  }

  getAgent(): StoredAgent | null {
    const row = this.db
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
        `INSERT INTO agent_signer
          (id, address, encrypted_secret, created_at)
         VALUES (1, ?, ?, ?)`,
      )
      .run(inputs.address, stringify(inputs.encryptedSecret), createdAt);
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
        `UPDATE agent_signer
         SET grant_digest = ?, agent_cap_id = ?
         WHERE id = 1`,
      )
      .run(inputs.digest, inputs.agentCapId);
  }

  logEvent(inputs: {
    category: string;
    action: string;
    outcome: string;
    detail?: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO audit_events
          (occurred_at, category, action, outcome, detail)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
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
         FROM audit_events
         ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as Array<{
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
        `INSERT INTO executions
          (occurred_at, mode, market_id, digest, endpoint, bid_price,
           ask_price, size_usd, outcome, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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

  close(): void {
    this.db.close();
  }
}
