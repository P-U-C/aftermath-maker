import { describe, expect, it } from "vitest";

import {
  deniedWalletAction,
  shouldBeginWalletSignIn,
  walletSessionMatches,
} from "../lib/access";

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

  it("disconnects a rejected wallet but permits a different wallet", () => {
    expect(deniedWalletAction("0x1111", "0x1111")).toBe("disconnect");
    expect(deniedWalletAction("0x1111", "0x2222")).toBe("try-new");
    expect(deniedWalletAction("0x1111", null)).toBe("none");
  });

  it("starts signing once per newly connected wallet", () => {
    const ready = {
      authChecked: true,
      authenticated: false,
      denied: false,
      busy: false,
      connectedAddress: "0x1111",
      attemptedAddress: null,
    };
    expect(shouldBeginWalletSignIn(ready)).toBe(true);
    expect(
      shouldBeginWalletSignIn({ ...ready, attemptedAddress: "0x1111" }),
    ).toBe(false);
    expect(shouldBeginWalletSignIn({ ...ready, denied: true })).toBe(false);
    expect(shouldBeginWalletSignIn({ ...ready, busy: true })).toBe(false);
  });
});
