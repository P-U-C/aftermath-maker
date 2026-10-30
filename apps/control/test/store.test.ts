import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  agentEncryptionContext,
  createEncryptedAgent,
  encryptSecret,
  loadAgentKeypair,
} from "@puc/aftermath";
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
    expect(databaseStore.listTenantOwners()).toEqual([setup.ownerAddress]);
    databaseStore.close();
  });

  it("keeps account labels and tags isolated by wallet", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const databaseStore = new Store(join(directory, "maker.db"));
    const first = databaseStore.forTenant(`0x${"3".repeat(64)}`);
    const second = databaseStore.forTenant(`0x${"4".repeat(64)}`);

    first.setAccountMetadata({
      accountId: "1745",
      label: "Primary maker",
      tags: ["farming", "low-risk"],
    });
    first.setAccountMetadata({
      accountId: "1745",
      label: "Core maker",
      tags: ["profit"],
    });

    expect(first.listAccountMetadata()).toHaveLength(1);
    expect(first.getAccountMetadata("1745")).toMatchObject({
      label: "Core maker",
      tags: ["profit"],
    });
    expect(second.listAccountMetadata()).toEqual([]);
    databaseStore.close();
  });

  it("keeps estimated Paper orders, fills, and hedges outside live order state", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const databaseStore = new Store(join(directory, "maker.db"));
    const tenant = databaseStore.forTenant(`0x${"9".repeat(64)}`);

    tenant.recordPaperQuote({
      trialId: "runtime",
      marketId: "0x9001",
      symbol: "PAPER",
      bidPrice: 10,
      askPrice: 11,
      sizeUsd: 1,
    });
    const [makerFill] = tenant.matchPaperOrders({
      trialId: "runtime",
      marketId: "0x9001",
      bestBid: 9.9,
      bestAsk: 9.8,
    });
    expect(makerFill).toBeDefined();
    tenant.recordPaperHedge({ trialId: "runtime", makerFill: makerFill! });

    expect(tenant.getPaperState("runtime")).toMatchObject({
      openOrders: 1,
      fills: 2,
      hedges: 1,
      positions: expect.arrayContaining([
        expect.objectContaining({ role: "maker", inventoryUsd: 1 }),
        expect.objectContaining({ role: "hedge", inventoryUsd: -1 }),
      ]),
    });
    expect(tenant.listTrackedMakerOrders()).toEqual([]);
    databaseStore.close();
  });

  it("does not coerce user strings that look like legacy bigint values", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const databaseStore = new Store(join(directory, "maker.db"));
    const tenant = databaseStore.forTenant(`0x${"9".repeat(64)}`);
    tenant.setConfig(
      makerConfigSchema.parse({
        markets: [{ marketId: "0x100", symbol: "100n" }],
      }),
    );

    expect(tenant.getConfig()?.markets[0]?.symbol).toBe("100n");
    databaseStore.close();
  });

  it("atomically re-encrypts stored agents under a new key and bound context", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const databaseStore = new Store(join(directory, "maker.db"));
    const ownerAddress = `0x${"8".repeat(64)}`;
    const oldMasterKey = randomBytes(32).toString("base64");
    const newMasterKey = randomBytes(32).toString("base64");
    const generated = createEncryptedAgent({
      masterKey: oldMasterKey,
      context: "account:42",
    });
    const tenant = databaseStore.forTenant(ownerAddress);
    tenant.createAgent({
      ...generated,
      encryptionContext: "account:42",
    });
    const oldKeypair = loadAgentKeypair({
      masterKey: oldMasterKey,
      context: "account:42",
      encryptedSecret: generated.encryptedSecret,
    });
    const encryptionContext = agentEncryptionContext({
      ownerAddress,
      agentAddress: generated.address,
      accountId: "42",
    });

    databaseStore.rotateAgentEncryptions([
      {
        ownerAddress,
        address: generated.address,
        encryptionContext,
        encryptedSecret: encryptSecret(
          oldKeypair.getSecretKey(),
          newMasterKey,
          encryptionContext,
        ),
      },
    ]);

    const rotated = tenant.getAgent()!;
    expect(rotated.encryptionContext).toBe(encryptionContext);
    expect(
      loadAgentKeypair({
        masterKey: newMasterKey,
        context: rotated.encryptionContext,
        encryptedSecret: rotated.encryptedSecret,
      }).toSuiAddress(),
    ).toBe(generated.address);
    expect(() =>
      loadAgentKeypair({
        masterKey: oldMasterKey,
        context: rotated.encryptionContext,
        encryptedSecret: rotated.encryptedSecret,
      }),
    ).toThrow("not the supplied master key");
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

  it("enforces documented per-tenant retention without crossing tenants", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const databaseStore = new Store(join(directory, "maker.db"));
    const first = databaseStore.forTenant(`0x${"3".repeat(64)}`);
    const second = databaseStore.forTenant(`0x${"4".repeat(64)}`);

    for (let index = 1; index <= 3; index += 1) {
      first.logEvent({
        category: "retention",
        action: `event-${index}`,
        outcome: "success",
      });
      first.logExecution({
        mode: "live",
        marketId: `market-${index}`,
        bidPrice: index,
        askPrice: index + 1,
        sizeUsd: 10,
        outcome: "confirmed",
        gasUsedMist: index,
      });
      first.trackMakerOrders({
        accountId: "42",
        marketId: `market-${index}`,
        quoteDigest: `quote-${index}`,
        orderIds: [`order-${index}`],
      });
      first.markHedgeFillsProcessed({
        makerAccountId: "42",
        fillKeys: [`fill-${index}`],
        hedgeDigest: `hedge-${index}`,
      });
    }
    second.logEvent({
      category: "retention",
      action: "other-tenant",
      outcome: "success",
    });

    first.enforceRetention({
      auditEvents: 2,
      executions: 2,
      makerOrders: 2,
      hedgedFills: 2,
    });

    expect(first.listEvents().map((event) => event.action)).toEqual([
      "event-3",
      "event-2",
    ]);
    expect(first.getExecutionStats().confirmedLiveQuotes).toBe(2);
    expect(
      first
        .listTrackedMakerOrders()
        .map((order) => order.orderId)
        .sort(),
    ).toEqual(["order-2", "order-3"]);
    expect(first.isHedgeFillProcessed("42", "fill-1")).toBe(false);
    expect(first.isHedgeFillProcessed("42", "fill-3")).toBe(true);
    expect(second.listEvents()[0]?.action).toBe("other-tenant");
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
    delete legacy.strategyObjective;

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
    expect(migrated?.strategyObjective).toBe("both");
    reopened.close();
  });

  it("deduplicates access requests without overwriting an existing handle", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const databaseStore = new Store(join(directory, "maker.db"));
    const walletAddress = `0x${"A".repeat(64)}`;

    const first = databaseStore.createAccessRequest({
      walletAddress,
      twitterHandle: "@first_handle",
    });
    const duplicate = databaseStore.createAccessRequest({
      walletAddress: walletAddress.toLowerCase(),
      twitterHandle: "@updated_handle",
    });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(databaseStore.listAccessRequests()).toHaveLength(1);
    expect(databaseStore.listAccessRequests()[0]).toMatchObject({
      walletAddress: walletAddress.toLowerCase(),
      twitterHandle: "@first_handle",
      status: "pending",
      notificationAttempts: 0,
    });

    databaseStore.markAccessRequestNotification(first.request.id, {
      ok: false,
      error: "mail unavailable",
    });
    expect(
      databaseStore.listPendingAccessRequestNotifications()[0],
    ).toMatchObject({ notificationAttempts: 1 });

    databaseStore.markAccessRequestNotification(first.request.id, {
      ok: true,
    });
    expect(databaseStore.listPendingAccessRequestNotifications()).toEqual([]);

    databaseStore.setAccessRequestStatus(walletAddress, "approved");
    expect(databaseStore.listAccessRequests()[0]?.status).toBe("approved");
    databaseStore.close();
  });

  it("retains only the newest configured number of access requests", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const databaseStore = new Store(join(directory, "maker.db"));
    for (const digit of ["1", "2", "3"]) {
      databaseStore.createAccessRequest({
        walletAddress: `0x${digit.repeat(64)}`,
        twitterHandle: `@maker_${digit}`,
      });
    }

    databaseStore.enforceAccessRequestRetention(2);
    expect(
      databaseStore
        .listAccessRequests()
        .map((request) => request.twitterHandle)
        .sort(),
    ).toEqual(["@maker_2", "@maker_3"]);
    databaseStore.close();
  });

  it("upgrades a legacy tenant to one Core bundle, reruns idempotently, and rolls back", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "maker.db");
    const ownerAddress = `0x${"b".repeat(64)}`;
    const legacyConfig = makerConfigSchema.parse({
      markets: [
        { marketId: "0x1001", symbol: "ONE" },
        { marketId: "0x1002", symbol: "TWO" },
      ],
      makerAccountId: "42",
      hedge: { enabled: true, accountId: "43", thresholdUsd: 12 },
      maxRunDrawdownUsd: 7,
      maxInventoryUsd: 11,
      maxGrossExposureUsd: 19,
      maxUnrealizedLossUsd: 5,
    });

    const initial = new Store(path);
    initial.close();
    const legacyDatabase = new Database(path);
    legacyDatabase
      .prepare(
        `INSERT INTO tenant_settings
          (owner_address, key, value, updated_at) VALUES (?, ?, ?, ?)`,
      )
      .run(
        ownerAddress,
        "maker_config",
        JSON.stringify(legacyConfig),
        "2026-10-28T00:00:00.000Z",
      );
    legacyDatabase.close();

    const upgraded = new Store(path);
    const tenant = upgraded.forTenant(ownerAddress);
    expect(JSON.stringify(tenant.getConfig())).toBe(
      JSON.stringify(legacyConfig),
    );
    expect(tenant.listBundles()).toMatchObject([
      {
        name: "Core",
        makerAccountId: "42",
        takerAccountId: "43",
        marketIds: ["0x1001", "0x1002"],
      },
    ]);
    expect(tenant.listBundles()[0]).toMatchObject({ status: "stopped" });
    expect(tenant.listStrategies()).toMatchObject([
      {
        name: "Core strategy",
        marketRule: {
          kind: "preferred-list",
          marketIds: ["0x1001", "0x1002"],
        },
      },
    ]);
    expect(tenant.getWalletLimits()).toMatchObject({
      maxRunDrawdownUsd: 7,
      maxInventoryUsd: 11,
      maxGrossExposureUsd: 19,
      maxUnrealizedLossUsd: 5,
    });

    const core = tenant.listBundles()[0]!;
    const changed = makerConfigSchema.parse({
      ...legacyConfig,
      markets: [{ marketId: "0x1002", symbol: "TWO" }],
      quoteSizeUsd: 17,
    });
    tenant.setConfig(changed);
    expect(tenant.getBundleConfig(core.id)).toEqual(changed);
    expect(JSON.stringify(tenant.getConfig())).toBe(JSON.stringify(changed));
    upgraded.close();

    const rerun = new Store(path);
    const rerunTenant = rerun.forTenant(ownerAddress);
    expect(
      rerunTenant.listBundles().filter((bundle) => bundle.name === "Core"),
    ).toHaveLength(1);
    expect(rerunTenant.listStrategies()).toHaveLength(1);
    expect(JSON.stringify(rerunTenant.getConfig())).toBe(
      JSON.stringify(changed),
    );
    expect(rerunTenant.listBundles()[0]?.marketIds).toEqual(["0x1002"]);
    expect(rerunTenant.rollbackBundleMigration()).toBe(true);
    expect(JSON.stringify(rerunTenant.getConfig())).toBe(
      JSON.stringify(changed),
    );
    expect(rerunTenant.bundlesRolledBack()).toBe(true);
    rerun.close();

    const rolledBack = new Store(path);
    expect(JSON.stringify(rolledBack.forTenant(ownerAddress).getConfig())).toBe(
      JSON.stringify(changed),
    );
    rolledBack.close();

    const migratedDatabase = new Database(path);
    for (const table of [
      "tenant_audit_events",
      "tenant_executions",
      "tenant_maker_orders",
      "tenant_hedge_executions",
      "tenant_hedged_fills",
    ]) {
      const columns = migratedDatabase
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "bundle_id")).toBe(true);
    }
    const marketColumns = migratedDatabase
      .prepare("PRAGMA table_info(bundle_markets)")
      .all() as Array<{ name: string }>;
    expect(
      marketColumns.some((column) => column.name === "owner_address"),
    ).toBe(true);
    expect(() =>
      migratedDatabase
        .prepare("UPDATE bundles SET taker_account_id = ? WHERE id = ?")
        .run("42", core.id),
    ).toThrow();
    expect(() =>
      migratedDatabase
        .prepare(
          `INSERT INTO bundle_account_roles
            (bundle_id, owner_address, account_id, role)
           VALUES (?, ?, ?, 'taker')`,
        )
        .run(core.id, ownerAddress, "42"),
    ).toThrow();
    migratedDatabase
      .prepare(
        `INSERT INTO bundles
          (id, owner_address, name, maker_account_id, taker_account_id,
           config, mode, status, created_at, updated_at, last_error)
         VALUES (?, ?, 'Secondary', NULL, NULL, ?, ?, 'stopped', ?, ?, NULL)`,
      )
      .run(
        "secondary-bundle",
        ownerAddress,
        JSON.stringify(changed),
        changed.mode,
        "2026-10-28T00:00:00.000Z",
        "2026-10-28T00:00:00.000Z",
      );
    expect(() =>
      migratedDatabase
        .prepare(
          `INSERT INTO bundle_markets
            (bundle_id, owner_address, market_id, symbol)
           VALUES (?, ?, ?, ?)`,
        )
        .run("secondary-bundle", ownerAddress, "0x1002", "TWO"),
    ).not.toThrow();
    migratedDatabase.close();
  });

  it("migrates reusable strategies, fans out shared settings, and forks Core compatibility writes", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const databaseStore = new Store(join(directory, "maker.db"));
    const ownerAddress = `0x${"d".repeat(64)}`;
    const tenant = databaseStore.forTenant(ownerAddress);
    const coreConfig = makerConfigSchema.parse({
      markets: [{ marketId: "0xd001", symbol: "CORE" }],
      makerAccountId: "1",
      hedge: {
        enabled: true,
        accountId: "2",
        thresholdUsd: 10,
        maxOrderUsd: 20,
        maxSlippageBps: 75,
      },
      maxRunDrawdownUsd: 10,
      maxInventoryUsd: 20,
      maxGrossExposureUsd: 40,
      maxUnrealizedLossUsd: 8,
    });
    tenant.setConfig(coreConfig);
    tenant.confirmWalletLimits();
    const paper = tenant.createBundle({
      name: "Rewards",
      config: makerConfigSchema.parse({
        ...coreConfig,
        mode: "paper",
        makerAccountId: "3",
        hedge: { ...coreConfig.hedge, accountId: "4" },
        markets: [{ marketId: "0xd002", symbol: "REWARD" }],
      }),
    });
    const core = tenant.listBundles().find((bundle) => bundle.name === "Core")!;
    const coreStrategy = tenant.getStrategy(core.strategyId!)!;
    expect(coreStrategy).toMatchObject({
      name: "Core strategy",
      marketRule: { kind: "preferred-list", marketIds: ["0xd001"] },
      usedBy: [{ id: core.id, name: "Core" }],
    });

    const shared = tenant.duplicateStrategy({
      strategyId: coreStrategy.id,
      name: "Steady",
    });
    tenant.updateBundleAllocation({ bundleId: core.id, strategyId: shared.id });
    tenant.updateBundleAllocation({
      bundleId: paper.id,
      strategyId: shared.id,
    });
    const updated = tenant.updateStrategy({
      strategyId: shared.id,
      name: "Steady renamed",
      config: { ...shared.config, quoteSizeUsd: 17 },
      marketRule: shared.marketRule,
      expectedVersion: shared.version,
    });
    expect(updated.affectedBundles.map((bundle) => bundle.name).sort()).toEqual(
      ["Core", "Rewards"],
    );
    expect(updated.strategy.name).toBe("Steady renamed");
    expect(tenant.getBundleConfig(core.id)).toMatchObject({
      quoteSizeUsd: 17,
      markets: [{ marketId: "0xd001", symbol: "CORE" }],
    });
    expect(tenant.getBundleConfig(paper.id)).toMatchObject({
      quoteSizeUsd: 17,
      markets: [{ marketId: "0xd001", symbol: "CORE" }],
    });
    expect(() => tenant.archiveStrategy(shared.id)).toThrow("in use");

    tenant.setConfig({ ...coreConfig, quoteSizeUsd: 19 });
    const forkedCore = tenant.getStoredBundle(core.id)!;
    expect(forkedCore.strategyId).not.toBe(shared.id);
    expect(tenant.getBundleConfig(paper.id)?.quoteSizeUsd).toBe(17);
    expect(tenant.getConfig()?.quoteSizeUsd).toBe(19);
    expect(
      databaseStore.forTenant(`0x${"e".repeat(64)}`).getStrategy(shared.id),
    ).toBeNull();

    const unconfigured = tenant.createAllocatedBundle({
      name: "Later",
      makerAccountId: "5",
      takerAccountId: null,
      mode: "observe",
      markets: [{ marketId: "0xd003", symbol: "LATER" }],
      strategyId: null,
    });
    expect(unconfigured).toMatchObject({
      status: "paused",
      needsStrategy: true,
    });
    const detachedStrategy = tenant.createStrategy({
      name: "Detached",
      config: {
        ...coreStrategy.config,
        hedge: { ...coreStrategy.config.hedge, enabled: false },
      },
      marketRule: coreStrategy.marketRule,
    });
    expect(
      tenant.updateBundleAllocation({
        bundleId: unconfigured.id,
        strategyId: detachedStrategy.id,
      }),
    ).toMatchObject({
      status: "stopped",
      needsStrategy: false,
    });
    databaseStore.close();
  });

  it("retains ordered per-field market overrides on an unrelated strategy edit", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const databaseStore = new Store(join(directory, "maker.db"));
    const tenant = databaseStore.forTenant(`0x${"f".repeat(64)}`);
    const base = makerConfigSchema.parse({
      markets: [{ marketId: "0xd001", symbol: "CORE" }],
      maxInventoryUsd: 20,
      maxGrossExposureUsd: 60,
    });
    tenant.setConfig(base);
    const core = tenant.listBundles().find((bundle) => bundle.name === "Core")!;
    const original = tenant.getStrategy(core.strategyId!)!;
    const markets = [
      { marketId: "0xd002", symbol: "SECOND", overrides: { spreadBps: 52 } },
      { marketId: "0xd001", symbol: "CORE", overrides: { quoteSizeUsd: 13 } },
    ];
    const first = tenant.updateStrategy({
      strategyId: original.id,
      name: original.name,
      config: original.config,
      marketRule: { kind: "quick-pick", pick: "balanced" },
      markets,
      expectedVersion: original.version,
    }).strategy;
    expect(first.markets).toEqual(markets);
    const renamed = tenant.updateStrategy({
      strategyId: first.id,
      name: "Renamed",
      config: { ...first.config, spreadBps: 72, quoteSizeUsd: 19 },
      marketRule: first.marketRule,
      markets: first.markets,
      expectedVersion: first.version,
    }).strategy;
    expect(renamed.markets).toEqual(markets);
    expect(tenant.getBundleConfig(core.id)?.markets).toEqual(markets);
    expect(tenant.getBundleConfig(core.id)?.spreadBps).toBe(72);
    expect(() =>
      tenant.updateStrategy({
        strategyId: first.id,
        name: "Stale",
        config: first.config,
        marketRule: first.marketRule,
        markets: [],
        expectedVersion: first.version,
      }),
    ).toThrow("Strategy changed elsewhere");
    expect(tenant.getStrategy(first.id)?.markets).toEqual(markets);
    databaseStore.close();
  });

  it("forks a shared legacy strategy with divergent bundle market mirrors", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "maker.db");
    const ownerAddress = `0x${"c".repeat(64)}`;
    const initial = new Store(path);
    const tenant = initial.forTenant(ownerAddress);
    const coreConfig = makerConfigSchema.parse({
      markets: [{ marketId: "0xc001", symbol: "CORE" }],
      makerAccountId: "1",
      hedge: {
        enabled: true,
        accountId: "2",
        thresholdUsd: 10,
        maxOrderUsd: 20,
        maxSlippageBps: 75,
      },
      maxRunDrawdownUsd: 10,
      maxInventoryUsd: 20,
      maxGrossExposureUsd: 40,
      maxUnrealizedLossUsd: 8,
    });
    tenant.setConfig(coreConfig);
    tenant.confirmWalletLimits();
    const rewardsConfig = makerConfigSchema.parse({
      ...coreConfig,
      mode: "paper",
      makerAccountId: "3",
      hedge: { ...coreConfig.hedge, accountId: "4" },
      markets: [{ marketId: "0xc002", symbol: "REWARDS" }],
    });
    const rewards = tenant.createBundle({
      name: "Rewards",
      config: rewardsConfig,
    });
    const core = tenant.listBundles().find((bundle) => bundle.name === "Core")!;
    const shared = tenant.duplicateStrategy({
      strategyId: core.strategyId!,
      name: "Shared legacy",
    });
    initial.close();

    const raw = new Database(path);
    raw
      .prepare(
        `UPDATE bundles SET strategy_id = ?, strategy_version_applied = 1
         WHERE owner_address = ? AND id IN (?, ?)`,
      )
      .run(shared.id, ownerAddress, core.id, rewards.id);
    raw
      .prepare("DELETE FROM strategy_markets WHERE strategy_id = ?")
      .run(shared.id);
    raw.close();

    const migrated = new Store(path);
    const migratedTenant = migrated.forTenant(ownerAddress);
    const migratedCore = migratedTenant.getStoredBundle(core.id)!;
    const migratedRewards = migratedTenant.getStoredBundle(rewards.id)!;
    expect(migratedCore.strategyId).toBe(shared.id);
    expect(migratedRewards.strategyId).not.toBe(shared.id);
    expect(migratedTenant.getBundleConfig(core.id)).toEqual(coreConfig);
    expect(migratedTenant.getBundleConfig(rewards.id)).toEqual(rewardsConfig);
    const strategyCount = migratedTenant.listStrategies().length;
    migrated.close();

    const rerun = new Store(path);
    expect(rerun.forTenant(ownerAddress).listStrategies()).toHaveLength(
      strategyCount,
    );
    rerun.close();
  });

  it("skips one malformed historical bundle strategy without blocking startup twice", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "maker.db");
    const ownerAddress = `0x${"7".repeat(64)}`;
    new Store(path).close();
    const raw = new Database(path);
    raw
      .prepare(
        `INSERT INTO bundles
          (id, owner_address, name, maker_account_id, taker_account_id,
           config, mode, status, created_at, updated_at, last_error, archived_at)
         VALUES (?, ?, ?, NULL, NULL, ?, 'observe', 'paused', ?, ?, NULL, NULL)`,
      )
      .run(
        "bad-historical-bundle",
        ownerAddress,
        "Historical",
        "{not valid json",
        "2026-10-29T00:00:00.000Z",
        "2026-10-29T00:00:00.000Z",
      );
    raw.close();

    const first = new Store(path);
    const firstTenant = first.forTenant(ownerAddress);
    expect(firstTenant.getStoredBundle("bad-historical-bundle")).toMatchObject({
      needsStrategy: true,
    });
    expect(firstTenant.listEvents()).toMatchObject([
      {
        category: "strategies",
        action: "migration.bundle-skipped",
        outcome: "failed",
      },
    ]);
    first.close();

    const second = new Store(path);
    expect(
      second
        .forTenant(ownerAddress)
        .listEvents()
        .filter((event) => event.action === "migration.bundle-skipped"),
    ).toHaveLength(1);
    second.close();
  });

  it("migrates an editable Observe bundle to stopped Paper without rewriting history", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "maker.db");
    const ownerAddress = `0x${"8".repeat(64)}`;
    const initial = new Store(path);
    const tenant = initial.forTenant(ownerAddress);
    const legacy = makerConfigSchema.parse({
      markets: [{ marketId: "0x8001", symbol: "LEGACY" }],
      mode: "observe",
    });
    tenant.setConfig(legacy);
    const core = tenant.listBundles().find((bundle) => bundle.name === "Core")!;
    tenant.logExecution({
      mode: "observe",
      marketId: "0x8001",
      bidPrice: 10,
      askPrice: 11,
      sizeUsd: 1,
      outcome: "simulated",
    });
    initial.close();

    const raw = new Database(path);
    raw
      .prepare(
        `UPDATE bundles SET config = ?, mode = 'observe', status = 'running'
         WHERE id = ?`,
      )
      .run(JSON.stringify(legacy), core.id);
    raw
      .prepare(
        `UPDATE tenant_settings SET value = ?
         WHERE owner_address = ? AND key = 'maker_config'`,
      )
      .run(JSON.stringify(legacy), ownerAddress);
    raw.close();

    const migrated = new Store(path);
    const migratedTenant = migrated.forTenant(ownerAddress);
    expect(migratedTenant.getStoredBundle(core.id)).toMatchObject({
      mode: "paper",
      status: "stopped",
    });
    expect(migratedTenant.getConfig()).toMatchObject({ mode: "paper" });
    expect(
      migratedTenant
        .listEvents()
        .some(
          (event) =>
            event.action === "mode.observe-migrated" &&
            event.outcome === "success",
        ),
    ).toBe(true);
    const historyDb = new Database(path);
    const history = historyDb
      .prepare(
        `SELECT mode FROM tenant_executions
         WHERE owner_address = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(ownerAddress) as { mode: string };
    historyDb.close();
    expect(history.mode).toBe("observe");
    migrated.close();

    const rerun = new Store(path);
    expect(
      rerun
        .forTenant(ownerAddress)
        .listEvents()
        .filter((event) => event.action === "mode.observe-migrated"),
    ).toHaveLength(1);
    rerun.close();
  });

  it("attributes Core records and backfills only unambiguous legacy history", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "maker.db");
    const ownerAddress = `0x${"f".repeat(64)}`;
    const config = makerConfigSchema.parse({
      markets: [{ marketId: "0x5001", symbol: "FIVE" }],
    });

    const initial = new Store(path);
    initial.close();
    const legacyDatabase = new Database(path);
    legacyDatabase
      .prepare(
        `INSERT INTO tenant_settings
          (owner_address, key, value, updated_at) VALUES (?, ?, ?, ?)`,
      )
      .run(
        ownerAddress,
        "maker_config",
        JSON.stringify(config),
        "2026-10-28T00:00:00.000Z",
      );
    legacyDatabase.close();

    const upgraded = new Store(path);
    const tenant = upgraded.forTenant(ownerAddress);
    const coreId = tenant.listBundles()[0]!.id;
    tenant.logEvent({ category: "runtime", action: "new", outcome: "ok" });
    tenant.logExecution({
      mode: "paper",
      marketId: "0x5001",
      bidPrice: 1,
      askPrice: 2,
      sizeUsd: 3,
      outcome: "simulated",
    });
    tenant.trackMakerOrders({
      accountId: "42",
      marketId: "0x5001",
      quoteDigest: "new-order",
      orderIds: ["100"],
    });
    tenant.recordHedgeExecution({
      makerAccountId: "42",
      hedgeAccountId: "43",
      marketId: "0x5001",
      digest: "new-hedge",
      side: "ask",
      requestedNotionalUsd: 3,
      gasUsedMist: 4,
      fillKeys: ["new-fill"],
    });
    upgraded.close();

    const history = new Database(path);
    history
      .prepare(
        `INSERT INTO tenant_audit_events
          (owner_address, bundle_id, occurred_at, category, action, outcome, detail)
         VALUES (?, NULL, ?, 'runtime', 'legacy', 'ok', '{}')`,
      )
      .run(ownerAddress, "2026-10-27T00:00:00.000Z");
    history
      .prepare(
        `INSERT INTO tenant_executions
          (owner_address, bundle_id, occurred_at, mode, market_id, bid_price,
           ask_price, size_usd, outcome)
         VALUES (?, NULL, ?, 'paper', '0x5001', 1, 2, 3, 'simulated')`,
      )
      .run(ownerAddress, "2026-10-27T00:00:00.000Z");
    history
      .prepare(
        `INSERT INTO tenant_maker_orders
          (owner_address, bundle_id, account_id, order_id, market_id,
           quote_digest, posted_at)
         VALUES (?, NULL, '42', '101', '0x5001', 'legacy-order', ?)`,
      )
      .run(ownerAddress, "2026-10-27T00:00:00.000Z");
    history
      .prepare(
        `INSERT INTO tenant_hedge_executions
          (owner_address, bundle_id, occurred_at, maker_account_id,
           hedge_account_id, market_id, digest, side, requested_notional_usd,
           gas_used_mist)
         VALUES (?, NULL, ?, '42', '43', '0x5001', 'legacy-hedge', 'ask', 3, 4)`,
      )
      .run(ownerAddress, "2026-10-27T00:00:00.000Z");
    history
      .prepare(
        `INSERT INTO tenant_hedged_fills
          (owner_address, bundle_id, maker_account_id, fill_key, hedge_digest,
           processed_at)
         VALUES (?, NULL, '42', 'legacy-fill', 'legacy-hedge', ?)`,
      )
      .run(ownerAddress, "2026-10-27T00:00:00.000Z");
    history.close();

    const backfilled = new Store(path);
    backfilled.close();
    const attributed = new Database(path, { readonly: true });
    for (const table of [
      "tenant_audit_events",
      "tenant_executions",
      "tenant_maker_orders",
      "tenant_hedge_executions",
      "tenant_hedged_fills",
    ]) {
      const rows = attributed
        .prepare(`SELECT bundle_id FROM ${table} WHERE owner_address = ?`)
        .all(ownerAddress) as Array<{ bundle_id: string | null }>;
      expect(rows).not.toHaveLength(0);
      expect(rows.every((row) => row.bundle_id === coreId)).toBe(true);
    }
    attributed.close();

    const changed = new Store(path);
    changed.forTenant(ownerAddress).setConfig({
      ...config,
      quoteSizeUsd: config.quoteSizeUsd + 1,
    });
    changed.close();
    const uncertain = new Database(path);
    uncertain
      .prepare(
        `INSERT INTO tenant_audit_events
          (owner_address, bundle_id, occurred_at, category, action, outcome, detail)
         VALUES (?, NULL, ?, 'runtime', 'before-bundles', 'ok', '{}')`,
      )
      .run(ownerAddress, "2026-10-26T00:00:00.000Z");
    uncertain.close();

    const reopened = new Store(path);
    reopened.close();
    const preservedDatabase = new Database(path, { readonly: true });
    const preserved = preservedDatabase
      .prepare(
        `SELECT bundle_id FROM tenant_audit_events
         WHERE owner_address = ? AND action = 'before-bundles'`,
      )
      .get(ownerAddress) as { bundle_id: string | null };
    expect(preserved.bundle_id).toBeNull();
    preservedDatabase.close();
  });

  it("skips and audits a malformed legacy config without blocking startup", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "maker.db");
    const badOwner = `0x${"d".repeat(64)}`;
    const goodOwner = `0x${"e".repeat(64)}`;
    const goodConfig = makerConfigSchema.parse({
      markets: [{ marketId: "0x3001", symbol: "THREE" }],
    });

    const initial = new Store(path);
    initial.close();
    const legacyDatabase = new Database(path);
    const insert = legacyDatabase.prepare(
      `INSERT INTO tenant_settings (owner_address, key, value, updated_at)
       VALUES (?, 'maker_config', ?, ?)`,
    );
    insert.run(
      badOwner,
      JSON.stringify({ markets: [] }),
      "2026-10-28T00:00:00.000Z",
    );
    insert.run(
      goodOwner,
      JSON.stringify(goodConfig),
      "2026-10-28T00:00:00.000Z",
    );
    legacyDatabase.close();

    const booted = new Store(path);
    expect(booted.forTenant(badOwner).listBundles()).toEqual([]);
    expect(booted.forTenant(goodOwner).listBundles()).toHaveLength(1);
    expect(booted.forTenant(badOwner).listEvents()).toMatchObject([
      {
        category: "bundles",
        action: "migration.core-skipped",
        outcome: "failed",
        detail: { reason: "invalid_config" },
      },
    ]);
    booted.close();

    const reopened = new Store(path);
    expect(reopened.forTenant(badOwner).listEvents()).toHaveLength(1);
    expect(reopened.forTenant(badOwner).listBundles()).toEqual([]);
    expect(reopened.forTenant(goodOwner).listBundles()).toHaveLength(1);
    reopened.close();
  });

  it("backfills the legacy mirror from an existing Core config once", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "maker.db");
    const ownerAddress = `0x${"f".repeat(64)}`;
    const first = makerConfigSchema.parse({
      markets: [{ marketId: "0x4001", symbol: "FOUR" }],
      quoteSizeUsd: 10,
    });
    const current = makerConfigSchema.parse({
      ...first,
      quoteSizeUsd: 33,
    });

    const initial = new Store(path);
    initial.forTenant(ownerAddress).setConfig(first);
    initial.close();

    const database = new Database(path);
    database
      .prepare(
        `UPDATE bundles SET config = ?, updated_at = ?
         WHERE owner_address = ? AND name = 'Core'`,
      )
      .run(JSON.stringify(current), "2026-10-28T01:00:00.000Z", ownerAddress);
    database
      .prepare("DELETE FROM bundle_config_mirrors WHERE owner_address = ?")
      .run(ownerAddress);
    database.close();

    const upgraded = new Store(path);
    upgraded.close();
    const mirrorDatabase = new Database(path, { readonly: true });
    const mirrored = mirrorDatabase
      .prepare(
        `SELECT value FROM tenant_settings
         WHERE owner_address = ? AND key = 'maker_config'`,
      )
      .get(ownerAddress) as { value: string };
    expect(mirrored.value).toBe(JSON.stringify(current));
    mirrorDatabase.close();
  });

  it("keeps the config API projection byte-compatible while reading and writing Core", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "maker.db");
    const databaseStore = new Store(path);
    const tenant = databaseStore.forTenant(`0x${"c".repeat(64)}`);
    const first = makerConfigSchema.parse({
      markets: [{ marketId: "0x2001", symbol: "ONE" }],
      quoteSizeUsd: 13,
    });
    const second = makerConfigSchema.parse({
      ...first,
      markets: [
        { marketId: "0x2001", symbol: "ONE" },
        { marketId: "0x2002", symbol: "TWO" },
      ],
      quoteSizeUsd: 21,
    });

    tenant.setConfig(first);
    const core = tenant.listBundles()[0]!;
    expect(JSON.stringify(tenant.getConfig())).toBe(JSON.stringify(first));
    expect(JSON.stringify(tenant.getBundleConfig(core.id))).toBe(
      JSON.stringify(first),
    );

    tenant.setConfig(second);
    expect(JSON.stringify(tenant.getConfig())).toBe(JSON.stringify(second));
    expect(JSON.stringify(tenant.getBundleConfig(core.id))).toBe(
      JSON.stringify(second),
    );
    expect(tenant.listBundles()).toMatchObject([
      { id: core.id, name: "Core", marketIds: ["0x2001", "0x2002"] },
    ]);
    databaseStore.close();

    const legacyDatabase = new Database(path, { readonly: true });
    const legacy = legacyDatabase
      .prepare(
        `SELECT value FROM tenant_settings
         WHERE owner_address = ? AND key = 'maker_config'`,
      )
      .get(tenant.ownerAddress) as { value: string };
    expect(legacy.value).toBe(JSON.stringify(second));
    legacyDatabase.close();
  });

  it("creates a stopped Paper bundle for an applied strategy and rejects setup failures atomically", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const databaseStore = new Store(join(directory, "maker.db"));
    const tenant = databaseStore.forTenant(`0x${"c".repeat(64)}`);
    const config = makerConfigSchema.parse({
      markets: [{ marketId: "0xa001", symbol: "ALPHA" }],
      makerAccountId: "1",
      hedge: {
        enabled: false,
        accountId: null,
        thresholdUsd: 25,
        maxOrderUsd: 100,
        maxSlippageBps: 75,
      },
      maxInventoryUsd: 20,
      maxGrossExposureUsd: 40,
    });
    tenant.setConfig(config);
    tenant.confirmWalletLimits();
    const core = tenant.listBundles().find((bundle) => bundle.name === "Core")!;
    const strategy = tenant.getStrategy(core.strategyId!)!;
    const created = tenant.createAllocatedBundle({
      name: "Rewards",
      makerAccountId: "3",
      takerAccountId: null,
      mode: "paper",
      strategyId: strategy.id,
    });
    expect(created).toMatchObject({
      mode: "paper",
      status: "stopped",
      strategyId: strategy.id,
      makerAccountId: "3",
      marketIds: ["0xa001"],
    });
    expect(() =>
      tenant.createAllocatedBundle({
        name: "Duplicate",
        makerAccountId: "3",
        takerAccountId: null,
        mode: "paper",
        strategyId: strategy.id,
      }),
    ).toThrow("Each account can hold one bundle role");
    expect(() =>
      tenant.createAllocatedBundle({
        name: "Rewards",
        makerAccountId: "4",
        takerAccountId: null,
        mode: "paper",
        strategyId: strategy.id,
      }),
    ).toThrow("A bundle already uses that name");
    const empty = tenant.createStrategy({
      name: "Empty strategy",
      config: strategy.config,
      marketRule: { kind: "quick-pick", pick: "clear" },
      markets: [],
    });
    expect(() =>
      tenant.createAllocatedBundle({
        name: "No markets",
        makerAccountId: "4",
        takerAccountId: null,
        mode: "paper",
        strategyId: empty.id,
      }),
    ).toThrow("Choose a strategy with one or more markets");
    expect(() =>
      tenant.createAllocatedBundle({
        name: "Missing strategy",
        makerAccountId: "4",
        takerAccountId: null,
        mode: "paper",
        strategyId: "strategy-unknown",
      }),
    ).toThrow("Strategy was not found for this wallet");
    expect(
      tenant.listBundles().filter((bundle) => !bundle.archivedAt),
    ).toHaveLength(2);

    const freshTenant = databaseStore.forTenant(`0x${"d".repeat(64)}`);
    const unattached = freshTenant.createStrategy({
      name: "Unattached",
      config: strategy.config,
      marketRule: strategy.marketRule,
      markets: strategy.markets,
    });
    expect(() =>
      freshTenant.createAllocatedBundle({
        name: "First",
        makerAccountId: "5",
        takerAccountId: null,
        mode: "paper",
        strategyId: unattached.id,
      }),
    ).toThrow("Configure Core wallet limits");
    expect(freshTenant.listBundles()).toHaveLength(0);
    databaseStore.close();
  });

  it("enforces Paper and Observe bundle constraints, wallet confirmation, and scoped attribution", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const databaseStore = new Store(join(directory, "maker.db"));
    const ownerAddress = `0x${"a".repeat(64)}`;
    const tenant = databaseStore.forTenant(ownerAddress);
    const coreConfig = makerConfigSchema.parse({
      markets: [{ marketId: "0x1001", symbol: "ONE" }],
      makerAccountId: "1",
      hedge: {
        enabled: true,
        accountId: "2",
        thresholdUsd: 25,
        maxOrderUsd: 100,
        maxSlippageBps: 75,
      },
      maxRunDrawdownUsd: 10,
      maxInventoryUsd: 20,
      maxGrossExposureUsd: 40,
      maxUnrealizedLossUsd: 8,
    });
    tenant.setConfig(coreConfig);
    const paperConfig = makerConfigSchema.parse({
      ...coreConfig,
      markets: [{ marketId: "0x1002", symbol: "TWO" }],
      makerAccountId: "3",
      hedge: {
        ...coreConfig.hedge,
        accountId: "4",
      },
      mode: "paper",
    });

    expect(() =>
      tenant.createBundle({ name: "Paper", config: paperConfig }),
    ).toThrow("Confirm the wallet limits");
    const paper = tenant.createBundle({
      name: "Paper",
      config: paperConfig,
      confirmWalletLimits: true,
    });
    expect(paper).toMatchObject({
      name: "Paper",
      mode: "paper",
      status: "stopped",
      marketIds: ["0x1002"],
    });
    expect(tenant.getWalletLimits()?.confirmedAt).not.toBeNull();

    expect(() =>
      tenant.createBundle({
        name: "Shared account",
        config: {
          ...paperConfig,
          makerAccountId: "3",
          markets: [{ marketId: "0x1003", symbol: "THREE" }],
        },
      }),
    ).toThrow("one bundle role");
    expect(
      tenant.createBundle({
        name: "Shared market",
        config: {
          ...paperConfig,
          makerAccountId: "5",
          hedge: { ...paperConfig.hedge, accountId: "6" },
        },
      }),
    ).toMatchObject({ name: "Shared market", status: "stopped" });
    expect(() =>
      tenant.createBundle({
        name: "Same roles",
        config: {
          ...paperConfig,
          markets: [{ marketId: "0x1003", symbol: "THREE" }],
          makerAccountId: "5",
          hedge: { ...paperConfig.hedge, enabled: false, accountId: "5" },
        },
      }),
    ).toThrow("must be different");
    expect(() =>
      tenant.createBundle({
        name: "Beyond envelope",
        config: {
          ...paperConfig,
          markets: [{ marketId: "0x1003", symbol: "THREE" }],
          makerAccountId: "5",
          hedge: { ...paperConfig.hedge, accountId: "6" },
          maxGrossExposureUsd: 41,
        },
      }),
    ).toThrow("exceeds this wallet's confirmed envelope");

    const scoped = databaseStore.forBundle(ownerAddress, paper.id);
    scoped.logEvent({
      category: "paper",
      action: "bundle-only",
      outcome: "ok",
    });
    tenant.logEvent({ category: "paper", action: "core-only", outcome: "ok" });
    expect(scoped.listEvents()).toMatchObject([{ action: "bundle-only" }]);
    expect(tenant.listEvents(10, "before")).toEqual([]);
    expect(tenant.listEvents()).toHaveLength(2);

    tenant.setBundleStatus(paper.id, "running");
    expect(tenant.getStoredBundle(paper.id)?.status).toBe("running");
    const version = tenant.getStoredBundle(paper.id)!.updatedAt;
    const changed = makerConfigSchema.parse({
      ...paperConfig,
      quoteSizeUsd: paperConfig.quoteSizeUsd + 1,
    });
    tenant.updateBundleConfig({
      bundleId: paper.id,
      config: changed,
      expectedUpdatedAt: version,
    });
    expect(() =>
      tenant.updateBundleConfig({
        bundleId: paper.id,
        config: paperConfig,
        expectedUpdatedAt: version,
      }),
    ).toThrow("changed elsewhere");
    expect(databaseStore.forBundle(ownerAddress, paper.id).getConfig()).toEqual(
      changed,
    );

    tenant.archiveBundle(paper.id);
    expect(tenant.getStoredBundle(paper.id)).toMatchObject({
      status: "stopped",
      archivedAt: expect.any(String),
      marketIds: [],
    });
    expect(() => databaseStore.forBundle(ownerAddress, paper.id)).toThrow(
      "not found",
    );
    expect(
      tenant.createBundle({ name: "Released", config: paperConfig }),
    ).toMatchObject({ name: "Released", status: "stopped" });
    databaseStore.close();

    const reopened = new Store(join(directory, "maker.db"));
    expect(
      reopened
        .forTenant(ownerAddress)
        .listBundles()
        .find((bundle) => bundle.name === "Released"),
    ).toMatchObject({ name: "Released", archivedAt: null });
    reopened.close();
  });

  it("edits wallet limits without dropping below running bundle use", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const databaseStore = new Store(join(directory, "maker.db"));
    const tenant = databaseStore.forTenant(`0x${"f".repeat(64)}`);
    tenant.setConfig(
      makerConfigSchema.parse({
        markets: [{ marketId: "0x9001", symbol: "CORE" }],
        maxRunDrawdownUsd: 10,
        maxInventoryUsd: 20,
        maxGrossExposureUsd: 40,
        maxUnrealizedLossUsd: 8,
      }),
    );
    const core = tenant.listBundles()[0]!;
    tenant.confirmWalletLimits();
    tenant.setBundleStatus(core.id, "running");

    expect(() =>
      tenant.updateWalletLimits({
        maxRunDrawdownUsd: 10,
        maxInventoryUsd: 20,
        maxGrossExposureUsd: 39,
        maxUnrealizedLossUsd: 8,
        usage: {
          runDrawdownUsd: 0,
          inventoryUsd: 0,
          grossExposureUsd: 0,
          unrealizedLossUsd: 0,
        },
      }),
    ).toThrow(
      "Gross exposure limit cannot be below $40.00 used by running bundles",
    );

    expect(() =>
      tenant.updateWalletLimits({
        maxRunDrawdownUsd: 12,
        maxInventoryUsd: 26,
        maxGrossExposureUsd: 49,
        maxUnrealizedLossUsd: 10,
        usage: {
          runDrawdownUsd: 12,
          inventoryUsd: 25,
          grossExposureUsd: 50,
          unrealizedLossUsd: 9,
        },
      }),
    ).toThrow(
      "Gross exposure limit cannot be below $50.00 used by running bundles",
    );

    const before = tenant.getWalletLimits()!;
    const updated = tenant.updateWalletLimits({
      maxRunDrawdownUsd: 12,
      maxInventoryUsd: 26,
      maxGrossExposureUsd: 51,
      maxUnrealizedLossUsd: 10,
      usage: {
        runDrawdownUsd: 12,
        inventoryUsd: 25,
        grossExposureUsd: 50,
        unrealizedLossUsd: 9,
      },
    });
    expect(updated).toMatchObject({
      maxRunDrawdownUsd: 12,
      maxInventoryUsd: 26,
      maxGrossExposureUsd: 51,
      maxUnrealizedLossUsd: 10,
      confirmedAt: before.confirmedAt,
    });
    expect(tenant.getWalletLimits()).toEqual(updated);
    databaseStore.close();
  });

  it("caps a wallet at four active bundles and refuses Live outside Core", () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      `aftermath-maker-${randomBytes(8).toString("hex")}`,
    );
    mkdirSync(directory, { recursive: true });
    const databaseStore = new Store(join(directory, "maker.db"));
    const tenant = databaseStore.forTenant(`0x${"b".repeat(64)}`);
    const core = makerConfigSchema.parse({
      markets: [{ marketId: "0x2001", symbol: "CORE" }],
      maxRunDrawdownUsd: 100,
      maxInventoryUsd: 100,
      maxGrossExposureUsd: 100,
      maxUnrealizedLossUsd: 100,
    });
    tenant.setConfig(core);
    tenant.confirmWalletLimits();
    const config = (number: number) =>
      makerConfigSchema.parse({
        ...core,
        markets: [{ marketId: `0x200${number + 1}`, symbol: `P${number}` }],
        makerAccountId: String(number * 2 + 1),
        hedge: {
          enabled: true,
          accountId: String(number * 2 + 2),
          thresholdUsd: 25,
          maxOrderUsd: 100,
          maxSlippageBps: 75,
        },
        mode: "paper",
      });
    for (const number of [1, 2, 3]) {
      tenant.createBundle({ name: `Paper ${number}`, config: config(number) });
    }
    expect(
      tenant.listBundles().filter((bundle) => !bundle.archivedAt),
    ).toHaveLength(4);
    expect(() =>
      tenant.createBundle({ name: "Too many", config: config(4) }),
    ).toThrow("at most four");
    expect(() =>
      tenant.createBundle({
        name: "Live paper",
        config: { ...config(4), mode: "live" },
      }),
    ).toThrow("Paper mode");
    databaseStore.close();
  });
});
