import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  getZkLoginSignature,
  toZkLoginPublicIdentifier,
} from "@mysten/sui/zklogin";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { describe, expect, it, vi } from "vitest";
import { WalletAuth } from "../src/auth.js";
import { Store } from "../src/store.js";

function harness(verificationClient?: SuiGrpcClient) {
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
    undefined,
    "access-request-test-secret",
    verificationClient,
  );
  return { store, auth };
}

function zkLoginFixture() {
  const issuer = "https://accounts.google.com";
  const inputs = {
    proofPoints: { a: [], b: [], c: [] },
    issBase64Details: {
      value: Buffer.from(`"iss":"${issuer}",`).toString("base64url"),
      indexMod4: 0,
    },
    headerBase64: "",
    addressSeed: "1",
  };
  return {
    address: toZkLoginPublicIdentifier(1n, issuer, {
      legacyAddress: false,
    }).toSuiAddress(),
    signature: getZkLoginSignature({
      inputs,
      maxEpoch: 99,
      userSignature: new Uint8Array([1, 2]),
    }),
  };
}

describe("wallet authentication", () => {
  it("keeps Ed25519 sign-in offline even when a verification client is present", async () => {
    const chainCheck = vi.fn();
    const { store, auth } = harness({
      core: { verifyZkLoginSignature: chainCheck },
    } as unknown as SuiGrpcClient);
    const signer = new Ed25519Keypair();
    const address = signer.toSuiAddress();
    const challenge = auth.begin(address);
    const { signature } = await signer.signPersonalMessage(
      new TextEncoder().encode(challenge.message),
    );
    await expect(
      auth.verify({ ...challenge, address, signature }),
    ).resolves.toMatchObject({ ownerAddress: address });
    expect(chainCheck).not.toHaveBeenCalled();
    store.close();
  });

  it("verifies zkLogin personal messages through the owner-address chain check", async () => {
    const chainCheck = vi.fn(async () => ({ success: true, errors: [] }));
    const { store, auth } = harness({
      core: { verifyZkLoginSignature: chainCheck },
    } as unknown as SuiGrpcClient);
    const { address, signature } = zkLoginFixture();
    const challenge = auth.begin(address);
    await expect(
      auth.verify({ ...challenge, address, signature }),
    ).resolves.toMatchObject({ ownerAddress: address });
    expect(chainCheck).toHaveBeenCalledWith(
      expect.objectContaining({ address, intentScope: "PersonalMessage" }),
    );
    store.close();
  });

  it("returns a retryable 503 for a zkLogin chain/RPC failure", async () => {
    const chainCheck = vi.fn(async () => {
      throw new Error("private RPC diagnostic");
    });
    const { store, auth } = harness({
      core: { verifyZkLoginSignature: chainCheck },
    } as unknown as SuiGrpcClient);
    const { address, signature } = zkLoginFixture();
    const challenge = auth.begin(address);
    await expect(
      auth.verify({ ...challenge, address, signature }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "signature-check-unavailable",
      message:
        "Maker couldn't check your wallet's signature right now. Try again in a minute.",
    });
    store.close();
  });

  it("returns 401 for a zkLogin chain verdict success:false", async () => {
    const chainCheck = vi.fn(async () => ({ success: false, errors: [] }));
    const { store, auth } = harness({
      core: { verifyZkLoginSignature: chainCheck },
    } as unknown as SuiGrpcClient);
    const { address, signature } = zkLoginFixture();
    const challenge = auth.begin(address);
    await expect(
      auth.verify({ ...challenge, address, signature }),
    ).rejects.toMatchObject({ statusCode: 401, code: "signature-invalid" });
    store.close();
  });
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
        await expect(verification).rejects.toMatchObject({
          statusCode: 503,
          code: "access-list-not-configured",
        });
      }
    }
    store.close();
  });

  it("binds access requests to a signed wallet for fifteen minutes", async () => {
    const directory = join(
      process.env.TMPDIR ?? "/tmp",
      "aftermath-maker-auth-" + randomBytes(8).toString("hex"),
    );
    mkdirSync(directory, { recursive: true });
    const store = new Store(join(directory, "maker.db"));
    const auth = new WalletAuth(
      store,
      { configured: true, isAllowed: async () => false } as never,
      "https://maker.permanentupperclass.com",
      false,
      12,
      0,
      undefined,
      "access-request-test-secret",
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

    expect(verified).toMatchObject({ ownerAddress: address });
    expect("sessionToken" in verified).toBe(false);
    if (!("accessRequestToken" in verified)) throw new Error("missing token");

    expect(() => auth.requireAccessRequestToken(undefined)).toThrow(
      "verification is required",
    );
    expect(auth.requireAccessRequestToken(verified.accessRequestToken)).toBe(
      address,
    );
    expect(() =>
      auth.requireAccessRequestToken(`${verified.accessRequestToken}x`),
    ).toThrow("verification is invalid");

    auth.createAccessRequest({
      accessRequestToken: verified.accessRequestToken,
      twitterHandle: "@maker_user",
      company: "",
    });
    expect(store.listAccessRequests()).toMatchObject([
      { walletAddress: address, twitterHandle: "@maker_user" },
    ]);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(verified.accessRequestExpiresAt));
      expect(() =>
        auth.requireAccessRequestToken(verified.accessRequestToken),
      ).toThrow("That check expired. Sign again to request access.");
    } finally {
      vi.useRealTimers();
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
