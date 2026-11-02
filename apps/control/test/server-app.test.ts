import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makerConfigSchema } from "@puc/core";
import { appHarness, CONTROL_TEST_TOKEN, OWNER } from "./helpers/app.js";

describe("injectable control app", () => {
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

  it("keeps route declarations out of the process boot file", () => {
    const boot = readFileSync(
      new URL("../src/server.ts", import.meta.url),
      "utf8",
    );
    expect(boot).not.toMatch(/\bapp\.(get|post|patch|put|delete|route)\(/);
    expect(boot).toContain("await buildServer(");
  });
});
