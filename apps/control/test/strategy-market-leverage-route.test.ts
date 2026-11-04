import { describe, expect, it } from "vitest";
import { makerConfigSchema } from "@puc/core";
import { appHarness } from "./helpers/app.js";

describe("strategy market leverage metadata", () => {
  it("accepts and preserves maximum leverage metadata for every selected market", async () => {
    const h = await appHarness();
    const maker = makerConfigSchema.parse({
      mode: "paper",
      markets: [
        { marketId: "0x1", symbol: "NEAR", marketMaxLeverage: 10 },
        { marketId: "0x2", symbol: "DRAM", marketMaxLeverage: 20 },
      ],
    });
    const { markets, mode: _mode, makerAccountId: _makerAccountId, hedge, ...config } = maker;
    const { accountId: _accountId, ...sharedHedge } = hedge;
    const result = await h.app.inject({
      method: "POST",
      url: "/api/strategies",
      headers: h.signedInAs(),
      payload: {
        name: "Leverage-safe draft",
        config: { ...config, hedge: sharedHedge },
        marketRule: { kind: "preferred-list", marketIds: ["0x1", "0x2"] },
        markets,
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      strategy: {
        markets: [
          { marketId: "0x1", marketMaxLeverage: 10 },
          { marketId: "0x2", marketMaxLeverage: 20 },
        ],
      },
    });
    await h.close();
  });
});
