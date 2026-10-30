import { describe, expect, it } from "vitest";
import {
  readStrategyDraft,
  strategyDraftKey,
  writeStrategyDraft,
} from "../lib/strategy-draft-storage";

describe("wallet-scoped strategy drafts", () => {
  it("isolates owners and strategies and retains the base version", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
    };
    const draft = {
      baseVersion: 4,
      markets: [{ marketId: "0xa", symbol: "A", overrides: { spreadBps: 25 } }],
    };
    writeStrategyDraft(storage, "0xABC", "one", draft);
    expect(readStrategyDraft(storage, "0xabc", "one")).toEqual(draft);
    expect(readStrategyDraft(storage, "0xdef", "one")).toBeNull();
    expect(readStrategyDraft(storage, "0xabc", "two")).toBeNull();
    expect(strategyDraftKey("0xABC", "one")).toBe(
      strategyDraftKey("0xabc", "one"),
    );
  });

  it("treats malformed or unavailable storage as no recoverable draft", () => {
    expect(readStrategyDraft({ getItem: () => "{" }, "0xa", "one")).toBeNull();
    expect(
      readStrategyDraft(
        {
          getItem: () => {
            throw new Error("blocked");
          },
        },
        "0xa",
        "one",
      ),
    ).toBeNull();
  });
});
