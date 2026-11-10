import { describe, expect, it } from "vitest";
import { makerConfigSchema } from "@puc/core";
import { appHarness, OWNER } from "./helpers/app.js";

describe("preloaded strategy templates", () => {
  it("returns the two executable Paper templates without attaching either to Core", async () => {
    const h = await appHarness();
    try {
      const tenant = h.store.forTenant(OWNER);
      tenant.setConfig(
        makerConfigSchema.parse({
          mode: "paper",
          makerAccountId: "1796",
          markets: [{ marketId: "0x1", symbol: "NEAR" }],
        }),
      );
      const core = tenant.listBundles()[0]!;

      const response = await h.app.inject({
        method: "GET",
        url: "/api/strategies",
        headers: h.signedInAs(),
      });

      expect(response.statusCode).toBe(200);
      const strategies = response.json().strategies;
      expect(strategies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "Inventory recycling",
            usedBy: [],
            markets: [{ marketId: "0x1", symbol: "NEAR" }],
            config: expect.objectContaining({
              strategyObjective: "both",
              strategyProfile: "balanced",
              hedge: expect.objectContaining({ enabled: false }),
            }),
          }),
          expect.objectContaining({
            name: "Fill-driven Aftermath hedge",
            usedBy: [],
            config: expect.objectContaining({
              hedge: expect.objectContaining({
                enabled: true,
                thresholdUsd: 10,
                maxOrderUsd: 10,
              }),
            }),
          }),
        ]),
      );
      expect(tenant.getStoredBundle(core.id)?.strategyName).toBe(
        "Core strategy",
      );
      expect(
        strategies.some(
          (strategy: { name: string }) =>
            strategy.name === "Cross-venue funding arbitrage",
        ),
      ).toBe(false);
    } finally {
      await h.close();
    }
  });
});
