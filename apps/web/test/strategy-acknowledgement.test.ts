import { describe, expect, it } from "vitest";
import {
  readStrategyAcknowledgement,
  strategyAcknowledgementKey,
  strategyIsComplete,
  type StrategyAcknowledgement,
} from "../lib/strategy-acknowledgement";

const saved = {
  version: 3,
  name: "Core",
  config: { quoteSizeUsd: 2 },
  marketRule: { kind: "preferred-list", marketIds: ["MON"] },
  markets: [{ marketId: "MON", overrides: { quoteSizeUsd: 2 } }],
};
const fields = {
  name: saved.name,
  config: saved.config,
  marketRule: saved.marketRule,
  markets: saved.markets,
};
const receipt: StrategyAcknowledgement = { version: 3, fields };

describe("versioned strategy completion", () => {
  it("requires an acknowledged PATCH and a matching saved version and fields", () => {
    expect(strategyIsComplete(null, saved, fields, false)).toBe(false);
    expect(strategyIsComplete(receipt, saved, fields, false)).toBe(true);
    expect(
      strategyIsComplete(receipt, { ...saved, version: 4 }, fields, false),
    ).toBe(false);
    expect(
      strategyIsComplete(
        receipt,
        { ...saved, name: "Remote edit" },
        fields,
        false,
      ),
    ).toBe(false);
    expect(strategyIsComplete(receipt, saved, fields, true)).toBe(false);
  });

  it("detects every persisted field, but reverting restores completion", () => {
    for (const changed of [
      { ...fields, name: "Renamed" },
      { ...fields, config: { quoteSizeUsd: 3 } },
      { ...fields, marketRule: { kind: "quick-pick", pick: "balanced" } },
      {
        ...fields,
        markets: [{ marketId: "MON", overrides: { quoteSizeUsd: 3 } }],
      },
      { ...fields, markets: [{ marketId: "BTC" }] },
    ])
      expect(strategyIsComplete(receipt, saved, changed, false)).toBe(false);
    expect(
      strategyIsComplete(receipt, saved, structuredClone(fields), false),
    ).toBe(true);
  });

  it("scopes the receipt to wallet and strategy and rejects damaged storage", () => {
    const storage = new Map([
      [strategyAcknowledgementKey("0xABC", "one"), JSON.stringify(receipt)],
    ]);
    const read = (owner: string, id: string) =>
      readStrategyAcknowledgement(
        { getItem: (key) => storage.get(key) ?? null },
        owner,
        id,
      );
    expect(read("0xabc", "one")).toEqual(receipt);
    expect(read("0xabc", "two")).toBeNull();
    expect(read("0xdef", "one")).toBeNull();
    storage.set(strategyAcknowledgementKey("0xabc", "one"), "{invalid");
    expect(read("0xabc", "one")).toBeNull();
  });
});
