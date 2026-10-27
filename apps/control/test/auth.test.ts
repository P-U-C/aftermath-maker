import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { describe, expect, it } from "vitest";
import { WalletAuth } from "../src/auth.js";
import { Store } from "../src/store.js";

function harness() {
  const directory = join(
    process.env.TMPDIR ?? "/tmp",
    "aftermath-maker-auth-" + randomBytes(8).toString("hex"),
  );
  mkdirSync(directory, { recursive: true });
  const store = new Store(join(directory, "maker.db"));
  const allowlist = {
    configured: false,
    isAllowed: async () => false,
  };
  const auth = new WalletAuth(
    store,
    allowlist as never,
    "https://maker.permanentupperclass.com",
    true,
    12,
    0,
  );
  return { store, auth };
}

describe("wallet authentication", () => {
  it("binds a one-time challenge to a wallet and creates a hashed session", async () => {
    const { store, auth } = harness();
    const keypair = new Ed25519Keypair();
    const address = keypair.toSuiAddress();
    const challenge = auth.begin(address);
    const signed = await keypair.signPersonalMessage(
      new TextEncoder().encode(challenge.message),
    );

    const verified = await auth.verify({
      challengeId: challenge.challengeId,
      address,
      message: challenge.message,
      signature: signed.signature,
    });

    expect(verified.sessionToken).toHaveLength(43);
    expect(verified.operator).toBe(true);
    await expect(auth.authenticate(verified.sessionToken)).resolves.toEqual({
      ownerAddress: address,
      operator: true,
    });
    await expect(
      auth.verify({
        challengeId: challenge.challengeId,
        address,
        message: challenge.message,
        signature: signed.signature,
      }),
    ).rejects.toThrow("invalid or expired");
    store.close();
  });

  it("caps unconsumed sign-in challenges per wallet", () => {
    const { store, auth } = harness();
    const address = new Ed25519Keypair().toSuiAddress();

    for (let index = 0; index < 5; index += 1) auth.begin(address);
    expect(() => auth.begin(address)).toThrow(
      "Too many open sign-in challenges",
    );
    store.close();
  });

  it("does not let a second wallet claim bootstrap access", async () => {
    const { store, auth } = harness();
    const first = new Ed25519Keypair();
    const second = new Ed25519Keypair();

    for (const [keypair, shouldPass] of [
      [first, true],
      [second, false],
    ] as const) {
      const address = keypair.toSuiAddress();
      const challenge = auth.begin(address);
      const signed = await keypair.signPersonalMessage(
        new TextEncoder().encode(challenge.message),
      );
      const verification = auth.verify({
        challengeId: challenge.challengeId,
        address,
        message: challenge.message,
        signature: signed.signature,
      });
      if (shouldPass) {
        await expect(verification).resolves.toMatchObject({ operator: true });
      } else {
        await expect(verification).rejects.toThrow("not on the on-chain");
      }
    }
    store.close();
  });

  it("stops a tenant as soon as a refreshed membership check is revoked", async () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      "aftermath-maker-auth-" + randomBytes(8).toString("hex"),
    );
    mkdirSync(directory, { recursive: true });
    const store = new Store(join(directory, "maker.db"));
    let allowed = true;
    const stopped: string[] = [];
    const auth = new WalletAuth(
      store,
      {
        configured: true,
        isAllowed: async () => allowed,
      } as never,
      "https://maker.permanentupperclass.com",
      false,
      12,
      0,
      async (ownerAddress) => {
        stopped.push(ownerAddress);
      },
    );
    const keypair = new Ed25519Keypair();
    const address = keypair.toSuiAddress();
    const challenge = auth.begin(address);
    const signed = await keypair.signPersonalMessage(
      new TextEncoder().encode(challenge.message),
    );
    const verified = await auth.verify({
      challengeId: challenge.challengeId,
      address,
      message: challenge.message,
      signature: signed.signature,
    });

    allowed = false;
    await expect(auth.authenticate(verified.sessionToken)).rejects.toThrow(
      "no longer on the access list",
    );
    expect(stopped).toEqual([address]);
    await expect(auth.authenticate(verified.sessionToken)).rejects.toThrow(
      "session expired",
    );
    store.close();
  });

  it("allows only emergency cleanup routes to use a valid stale session during a registry outage", async () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      "aftermath-maker-auth-" + randomBytes(8).toString("hex"),
    );
    mkdirSync(directory, { recursive: true });
    const store = new Store(join(directory, "maker.db"));
    let registryOnline = true;
    const auth = new WalletAuth(
      store,
      {
        configured: true,
        isAllowed: async () => {
          if (!registryOnline) throw new Error("registry unavailable");
          return true;
        },
      } as never,
      "https://maker.permanentupperclass.com",
      false,
      12,
      0,
    );
    const keypair = new Ed25519Keypair();
    const address = keypair.toSuiAddress();
    const challenge = auth.begin(address);
    const signed = await keypair.signPersonalMessage(
      new TextEncoder().encode(challenge.message),
    );
    const verified = await auth.verify({
      challengeId: challenge.challengeId,
      address,
      message: challenge.message,
      signature: signed.signature,
    });

    registryOnline = false;
    await expect(
      auth.authenticate(verified.sessionToken, {
        allowStaleOnChainError: true,
      }),
    ).resolves.toMatchObject({ ownerAddress: address });
    await expect(auth.authenticate(verified.sessionToken)).rejects.toThrow(
      "registry unavailable",
    );
    store.close();
  });
});
