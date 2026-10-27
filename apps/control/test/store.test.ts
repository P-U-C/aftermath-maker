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
    store.createAgent({
      ...generated,
      encryptionContext: "account:42",
    });
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

  it("stores grants per account while keeping one decryptable agent signer", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const databaseStore = new Store(join(directory, "maker.db"));
    const ownerAddress = `0x${"7".repeat(64)}`;
    const first = setupSchema.parse({
      ownerAddress,
      accountId: "42",
      accountCapId: "0x1242",
    });
    const second = setupSchema.parse({
      ownerAddress,
      accountId: "43",
      accountCapId: "0x1243",
    });
    const masterKey = randomBytes(32).toString("base64");
    const generated = createEncryptedAgent({
      masterKey,
      context: "account:42",
    });
    const tenant = databaseStore.forTenant(ownerAddress);

    tenant.setSetup(first);
    tenant.setSetup(second);
    tenant.createAgent({
      ...generated,
      encryptionContext: "account:42",
    });
    tenant.confirmAgentGrant({
      accountId: "42",
      digest: "A".repeat(32),
      agentCapId: "0xagent42",
    });
    tenant.confirmAgentGrant({
      accountId: "43",
      digest: "B".repeat(32),
      agentCapId: "0xagent43",
    });
    tenant.setConfig(
      makerConfigSchema.parse({
        markets: [{ marketId: "0x5678", symbol: "SUI" }],
        makerAccountId: "43",
      }),
    );

    expect(tenant.listAccountSetups()).toHaveLength(2);
    expect(tenant.getAccountSetup("42")?.agentCapId).toBe("0xagent42");
    expect(tenant.getAccountSetup("43")?.agentCapId).toBe("0xagent43");
    expect(tenant.getSetup()?.accountId).toBe("43");
    const storedAgent = tenant.getAgent()!;
    expect(storedAgent.encryptionContext).toBe("account:42");
    expect(
      loadAgentKeypair({
        masterKey,
        context: storedAgent.encryptionContext,
        encryptedSecret: storedAgent.encryptedSecret,
      }).toSuiAddress(),
    ).toBe(generated.address);
    databaseStore.close();
  });

  it("keeps tracked orders and gas statistics isolated by wallet", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const databaseStore = new Store(join(directory, "maker.db"));
    const first = databaseStore.forTenant(`0x${"4".repeat(64)}`);
    const second = databaseStore.forTenant(`0x${"5".repeat(64)}`);

    first.trackMakerOrders({
      accountId: "42",
      marketId: "0xmarket",
      quoteDigest: "digest",
      orderIds: ["101", "102"],
    });
    first.logExecution({
      mode: "live",
      marketId: "0xmarket",
      digest: "digest",
      endpoint: "test",
      bidPrice: 9,
      askPrice: 11,
      sizeUsd: 10,
      outcome: "confirmed",
      gasUsedMist: 100,
    });
    first.logExecution({
      mode: "live",
      marketId: "0xmarket",
      digest: "digest-2",
      endpoint: "test",
      bidPrice: 9,
      askPrice: 11,
      sizeUsd: 10,
      outcome: "confirmed",
      gasUsedMist: 300,
    });

    expect(
      first
        .listTrackedMakerOrders({ accountId: "42" })
        .map((order) => order.orderId)
        .sort(),
    ).toEqual(["101", "102"]);
    expect(first.getExecutionStats()).toMatchObject({
      confirmedLiveQuotes: 2,
      averageGasMist: 200,
    });
    expect(second.listTrackedMakerOrders()).toEqual([]);
    expect(second.getExecutionStats().confirmedLiveQuotes).toBe(0);

    expect(first.isHedgeFillProcessed("42", "fill-1")).toBe(false);
    first.recordHedgeExecution({
      makerAccountId: "42",
      hedgeAccountId: "43",
      marketId: "0xmarket",
      digest: "hedge-digest",
      side: "ask",
      requestedNotionalUsd: 25,
      gasUsedMist: 120,
      fillKeys: ["fill-1"],
    });
    expect(first.isHedgeFillProcessed("42", "fill-1")).toBe(true);
    expect(first.listHedgeExecutions(1)[0]).toMatchObject({
      makerAccountId: "42",
      hedgeAccountId: "43",
      requestedNotionalUsd: 25,
    });
    expect(second.listHedgeExecutions()).toEqual([]);
    databaseStore.close();
  });

  it("derives a safe watchdog age for saved slow rotations", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "maker.db");
    const initial = new Store(path);
    initial.close();

    const ownerAddress = `0x${"6".repeat(64)}`;
    const saved = makerConfigSchema.parse({
      markets: [
        { marketId: "0x1001", symbol: "ONE" },
        { marketId: "0x1002", symbol: "TWO" },
        { marketId: "0x1003", symbol: "THREE" },
        { marketId: "0x1004", symbol: "FOUR" },
      ],
      refreshMs: 300_000,
      maxQuoteAgeMs: 1_210_000,
    }) as Record<string, unknown>;
    delete saved.maxQuoteAgeMs;

    const database = new Database(path);
    database
      .prepare(
        `INSERT INTO tenant_settings
          (owner_address, key, value, updated_at) VALUES (?, ?, ?, ?)`,
      )
      .run(
        ownerAddress,
        "maker_config",
        JSON.stringify(saved),
        new Date().toISOString(),
      );
    database.close();

    const reopened = new Store(path);
    expect(reopened.forTenant(ownerAddress).getConfig()?.maxQuoteAgeMs).toBe(
      1_210_000,
    );
    reopened.close();
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
