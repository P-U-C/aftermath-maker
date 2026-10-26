import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createEncryptedAgent, loadAgentKeypair } from "@puc/aftermath";
import { makerConfigSchema, setupSchema } from "@puc/core";
import { Store } from "../src/store.js";

describe("persistent control store", () => {
  it("persists config, setup, encrypted signer, and audit events", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const databaseStore = new Store(join(directory, "maker.db"));
    const masterKey = randomBytes(32).toString("base64");
    const setup = setupSchema.parse({
      ownerAddress: `0x${"1".repeat(64)}`,
      accountId: "42",
      accountCapId: "0x1234",
    });
    const store = databaseStore.forTenant(setup.ownerAddress);
    const config = makerConfigSchema.parse({
      markets: [{ marketId: "0x5678", symbol: "SUI" }],
    });
    const generated = createEncryptedAgent({
      masterKey,
      context: "account:42",
    });

    store.setSetup(setup);
    store.setConfig(config);
    store.createAgent(generated);
    store.logEvent({
      category: "test",
      action: "write",
      outcome: "success",
    });

    const agent = store.getAgent();
    expect(store.getSetup()).toEqual(setup);
    expect(store.getConfig()).toEqual(config);
    expect(agent?.address).toBe(generated.address);
    expect(store.listEvents(1)[0]?.action).toBe("write");

    const restored = loadAgentKeypair({
      masterKey,
      context: "account:42",
      encryptedSecret: agent!.encryptedSecret,
    });
    expect(restored.toSuiAddress()).toBe(generated.address);

    const other = databaseStore.forTenant(`0x${"2".repeat(64)}`);
    expect(other.getSetup()).toBeNull();
    expect(other.getConfig()).toBeNull();
    expect(other.getAgent()).toBeNull();
    expect(other.listEvents()).toEqual([]);
    databaseStore.close();
  });

  it("migrates the legacy daily-loss field without losing the limit", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "maker.db");
    const store = new Store(path);
    store.close();

    const config = makerConfigSchema.parse({
      markets: [{ marketId: "0x5678", symbol: "SUI" }],
      maxUnrealizedLossUsd: 17,
    });
    const legacy = {
      ...config,
      marketId: config.markets[0]!.marketId,
      symbol: config.markets[0]!.symbol,
      maxDailyLossUsd: 17,
    } as Record<string, unknown>;
    delete legacy.markets;
    delete legacy.maxGrossExposureUsd;
    delete legacy.maxUnrealizedLossUsd;

    const ownerAddress = `0x${"3".repeat(64)}`;
    const legacySetup = setupSchema.parse({
      ownerAddress,
      accountId: "73",
      accountCapId: "0xabcd",
    });
    const database = new Database(path);
    const insert = database.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)`,
    );
    insert.run("setup", JSON.stringify(legacySetup), new Date().toISOString());
    insert.run(
      "maker_config",
      JSON.stringify(legacy),
      new Date().toISOString(),
    );
    database
      .prepare("DELETE FROM system_settings WHERE key = ?")
      .run("tenant_v2_migrated");
    database.close();

    const reopened = new Store(path);
    const migrated = reopened.forTenant(ownerAddress).getConfig();
    expect(migrated?.maxUnrealizedLossUsd).toBe(17);
    expect(migrated?.markets).toEqual([{ marketId: "0x5678", symbol: "SUI" }]);
    expect(migrated?.maxGrossExposureUsd).toBe(50);
    reopened.close();
  });
});
