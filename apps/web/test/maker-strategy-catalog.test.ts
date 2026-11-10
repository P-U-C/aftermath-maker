import { describe, expect, it } from "vitest";

import {
  makerStrategyCatalog,
  makerStrategyPreset,
} from "../lib/maker-strategy-catalog";

describe("Maker strategy bench", () => {
  it("preloads the seven declared strategy families without misrepresenting research as executable", () => {
    expect(makerStrategyCatalog.map((preset) => preset.id)).toEqual([
      "inventory-recycling",
      "fill-driven-aftermath-hedge",
      "selective-rotation",
      "hedged-hold",
      "cross-venue-funding-arbitrage",
      "cross-venue-hedged-market-making",
      "adaptive-quoting",
    ]);
    expect(
      makerStrategyCatalog
        .filter((preset) => preset.state === "ready")
        .map((preset) => [preset.id, preset.mode]),
    ).toEqual([
      ["inventory-recycling", "Paper"],
      ["fill-driven-aftermath-hedge", "Paper"],
    ]);
    expect(
      makerStrategyCatalog
        .filter((preset) => preset.state === "research")
        .every((preset) => preset.mode === "Observe"),
    ).toBe(true);
  });

  it("returns a concrete preset and rejects unknown catalog entries", () => {
    expect(makerStrategyPreset("inventory-recycling").name).toBe(
      "Inventory recycling",
    );
    expect(() => makerStrategyPreset("not-a-strategy" as never)).toThrow(
      "Unknown Maker strategy preset",
    );
  });
});
