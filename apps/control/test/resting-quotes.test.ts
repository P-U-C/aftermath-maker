import { describe, expect, it } from "vitest";
import { confirmedRestingMarketIds } from "../src/resting-quotes.js";

describe("confirmed live resting order attribution", () => {
  it("only counts venue-visible order IDs owned by this runtime", () => {
    const tracked = [
      { marketId: "0xa", orderId: "101" },
      { marketId: "0xb", orderId: "202" },
    ];
    expect(
      confirmedRestingMarketIds(
        [
          { marketId: "0xa", makerOrderIds: [101n, 999n] },
          { marketId: "0xb", makerOrderIds: [999n] },
          { marketId: "0xc", makerOrderIds: [202n] },
        ],
        tracked,
      ),
    ).toEqual(["0xa"]);
  });
  it("does not treat historical attribution as proof of current orders", () => {
    expect(
      confirmedRestingMarketIds(
        [{ marketId: "0xa", makerOrderIds: [] }],
        [{ marketId: "0xa", orderId: "101" }],
      ),
    ).toEqual([]);
  });
});
