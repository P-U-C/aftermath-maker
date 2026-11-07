import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makerConfigSchema } from "@puc/core";
import {
  envSchema,
  executionBootstrapOperatorAddress,
  executionWhitelistObjectId,
  shadowPaperBootstrapEnabled,
} from "../src/server-app.js";
import { appHarness, CONTROL_TEST_TOKEN, OWNER } from "./helpers/app.js";

describe("injectable control app", () => {
  it("rejects Mainnet secrets in a Testnet process", () => {
    expect(() =>
      envSchema.parse({
        SUI_NETWORK: "testnet",
        MAKER_MASTER_KEY: "not-a-testnet-key",
      }),
    ).toThrow("MAKER_MASTER_KEY is forbidden on Testnet");
    expect(
      envSchema.parse({
        SUI_NETWORK: "testnet",
        TESTNET_MAKER_MASTER_KEY: "test-only-key",
      }).TESTNET_MAKER_MASTER_KEY,
    ).toBe("test-only-key");
    expect(() =>
      envSchema.parse({
        SUI_NETWORK: "testnet",
        SUI_WHITELIST_OBJECT_ID: "0x1",
      }),
    ).toThrow("SUI_WHITELIST_OBJECT_ID is forbidden on Testnet");
    const testnetEnv = envSchema.parse({
      SUI_NETWORK: "testnet",
      TESTNET_SUI_WHITELIST_OBJECT_ID: `0x${"2".repeat(64)}`,
      TESTNET_BOOTSTRAP_OPERATOR_ADDRESS: `0x${"3".repeat(64)}`,
    });
    expect(executionWhitelistObjectId(testnetEnv)).toBe(`0x${"2".repeat(64)}`);
    expect(executionBootstrapOperatorAddress(testnetEnv)).toBe(
      `0x${"3".repeat(64)}`,
    );
  });

  it("allows wallet bootstrap only for the no-key Mainnet Paper shadow", () => {
    const shadow = envSchema.parse({
      SUI_NETWORK: "mainnet",
      SHADOW_PAPER_MODE: "true",
      WALLET_AUTH_BOOTSTRAP: "true",
    });
    expect(shadowPaperBootstrapEnabled(shadow)).toBe(true);
    expect(shadowPaperBootstrapEnabled(envSchema.parse({}))).toBe(false);

    expect(() =>
      envSchema.parse({
        SUI_NETWORK: "mainnet",
        SHADOW_PAPER_MODE: "true",
        MAKER_MASTER_KEY: "not-a-shadow-key",
      }),
    ).toThrow("SHADOW_PAPER_MODE requires Mainnet reads");
    expect(() =>
      envSchema.parse({
        SUI_NETWORK: "testnet",
        SHADOW_PAPER_MODE: "true",
      }),
    ).toThrow("SHADOW_PAPER_MODE requires Mainnet reads");
  });

  it("GET /api/bundles accepts a stored owner session and refuses an anonymous request", async () => {
    const harness = await appHarness();
    try {
      harness.store.forTenant(OWNER).setConfig(
        makerConfigSchema.parse({
          markets: [{ marketId: "0x1", symbol: "NEAR" }],
          mode: "paper",
        }),
      );
      const signed = await harness.app.inject({
        method: "GET",
        url: "/api/bundles",
        headers: harness.signedInAs(),
      });
      expect(signed.statusCode).toBe(200);
      expect(signed.json().bundles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "Core",
            readiness: expect.objectContaining({ ready: false }),
          }),
        ]),
      );
      const anonymous = await harness.app.inject({
        method: "GET",
        url: "/api/bundles",
        headers: { "x-control-token": CONTROL_TEST_TOKEN },
      });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.json().error).not.toContain("Internal server error");
    } finally {
      await harness.close();
    }
  });

  it("provisions and authorizes an agent with only the Testnet key", async () => {
    const harness = await appHarness({
      env: {
        SUI_NETWORK: "testnet",
        TESTNET_MAKER_MASTER_KEY: Buffer.alloc(32).toString("base64"),
      },
    });
    try {
      const headers = harness.signedInAs();
      const setup = {
        ownerAddress: OWNER,
        accountId: "1796",
        accountCapId: `0x${"4".repeat(64)}`,
        collateralCoinType: "0x2::sui::SUI",
      };
      const provision = await harness.app.inject({
        method: "POST",
        url: "/api/setup/provision",
        headers,
        payload: setup,
      });
      expect(provision.statusCode).toBe(200);

      const grant = await harness.app.inject({
        method: "POST",
        url: "/api/setup/grant-transaction",
        headers,
        payload: { accountId: setup.accountId },
      });
      expect(grant.statusCode).toBe(200);
      expect(harness.gateway.calls).toContainEqual(
        expect.objectContaining({
          method: "buildGrantAgentTransaction",
          args: [
            expect.objectContaining({
              builderCode: null,
            }),
          ],
        }),
      );
    } finally {
      await harness.close();
    }
  });

  it("keeps route declarations out of the process boot file", () => {
    const boot = readFileSync(
      new URL("../src/server.ts", import.meta.url),
      "utf8",
    );
    expect(boot).not.toMatch(/\bapp\.(get|post|patch|put|delete|route)\(/);
    expect(boot).toContain("await buildServer(");
  });
});
