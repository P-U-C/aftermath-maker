import { describe, expect, it } from "vitest";

import { walletSessionMatches } from "../lib/access";

describe("wallet session binding", () => {
  it("accepts the connected wallet that created the session", () => {
    expect(walletSessionMatches("0xABCD", "0xabcd")).toBe(true);
  });

  it("rejects a different connected wallet", () => {
    expect(walletSessionMatches("0x1111", "0x2222")).toBe(false);
  });

  it("waits for wallet restoration before deciding", () => {
    expect(walletSessionMatches("0x1111", null)).toBe(true);
  });
});
