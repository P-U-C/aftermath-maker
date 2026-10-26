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
    const store = new Store(join(directory, "maker.db"));
    const masterKey = randomBytes(32).toString("base64");
    const setup = setupSchema.parse({
      ownerAddress: `0x${"1".repeat(64)}`,
      accountId: "42",
      accountCapId: "0x1234",
    });
    const config = makerConfigSchema.parse({
      marketId: "0x5678",
      symbol: "SUI",
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
    store.close();
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
      marketId: "0x5678",
      symbol: "SUI",
      maxUnrealizedLossUsd: 17,
    });
    const legacy = { ...config, maxDailyLossUsd: 17 } as Record<
      string,
      unknown
    >;
    delete legacy.maxUnrealizedLossUsd;

    const database = new Database(path);
    database
      .prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)`)
      .run("maker_config", JSON.stringify(legacy), new Date().toISOString());
    database.close();

    const reopened = new Store(path);
    expect(reopened.getConfig()?.maxUnrealizedLossUsd).toBe(17);
    reopened.close();
  });
});
