import { createHash, randomBytes, randomUUID } from "node:crypto";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import type { OnchainAllowlist } from "./allowlist.js";
import type { Store } from "./store.js";

const SUI_ADDRESS = /^0x[0-9a-fA-F]{64}$/;

function normalizeAddress(address: string): string {
  if (!SUI_ADDRESS.test(address))
    throw new AuthError(400, "Invalid Sui address");
  return address.toLowerCase();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class AuthError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export class WalletAuth {
  constructor(
    private readonly store: Store,
    private readonly allowlist: OnchainAllowlist,
    private readonly origin: string,
    private readonly bootstrapEnabled: boolean,
    private readonly sessionHours = 12,
    private readonly chainRefreshMs = 30_000,
    private readonly onAccessRevoked?: (ownerAddress: string) => Promise<void>,
  ) {}

  begin(address: string): {
    challengeId: string;
    message: string;
    expiresAt: string;
  } {
    const ownerAddress = normalizeAddress(address);
    if (this.store.countOpenChallenges(ownerAddress) >= 5) {
      throw new AuthError(
        429,
        "Too many open sign-in challenges for this wallet",
      );
    }
    const challengeId = randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 5 * 60_000);
    const nonce = randomBytes(24).toString("base64url");
    const message = [
      "Maker access",
      `URI: ${this.origin}`,
      "Network: Sui Mainnet",
      `Address: ${ownerAddress}`,
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt.toISOString()}`,
      `Expiration Time: ${expiresAt.toISOString()}`,
      "",
      "Sign in only. This does not authorize a transaction or spend funds.",
    ].join("\n");

    this.store.createChallenge({
      id: challengeId,
      ownerAddress,
      message,
      expiresAt: expiresAt.toISOString(),
      consumedAt: null,
    });
    return {
      challengeId,
      message,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async verify(inputs: {
    challengeId: string;
    address: string;
    message: string;
    signature: string;
  }): Promise<{
    sessionToken: string;
    expiresAt: string;
    ownerAddress: string;
    operator: boolean;
  }> {
    const ownerAddress = normalizeAddress(inputs.address);
    this.store.consumeChallenge({
      id: inputs.challengeId,
      ownerAddress,
      message: inputs.message,
    });

    try {
      await verifyPersonalMessageSignature(
        new TextEncoder().encode(inputs.message),
        inputs.signature,
        { address: ownerAddress },
      );
    } catch {
      throw new AuthError(401, "Wallet signature could not be verified");
    }

    let allowed = false;
    if (this.allowlist.configured) {
      allowed = await this.allowlist.isAllowed(ownerAddress, true);
    } else if (this.bootstrapEnabled) {
      const operator = this.store.getOperatorAddress();
      if (!operator || operator === ownerAddress) {
        this.store.claimBootstrapOperator(ownerAddress);
        allowed = true;
      }
    }
    if (!allowed) {
      throw new AuthError(
        403,
        "This wallet is not on the on-chain access list",
      );
    }

    const sessionToken = randomBytes(32).toString("base64url");
    const checkedAt = new Date().toISOString();
    const expiresAt = new Date(
      Date.now() + this.sessionHours * 60 * 60_000,
    ).toISOString();
    this.store.createSession({
      tokenHash: hashToken(sessionToken),
      ownerAddress,
      expiresAt,
      chainCheckedAt: checkedAt,
    });
    return {
      sessionToken,
      expiresAt,
      ownerAddress,
      operator: this.isOperator(ownerAddress),
    };
  }

  async authenticate(
    token: string | undefined,
    options: { allowStaleOnChainError?: boolean } = {},
  ): Promise<{
    ownerAddress: string;
    operator: boolean;
  }> {
    if (!token) throw new AuthError(401, "Wallet session required");
    const tokenHash = hashToken(token);
    const session = this.store.getSession(tokenHash);
    if (!session) throw new AuthError(401, "Wallet session expired");

    const lastCheck = session.chainCheckedAt
      ? Date.parse(session.chainCheckedAt)
      : 0;
    if (Date.now() - lastCheck >= this.chainRefreshMs) {
      let allowed: boolean;
      try {
        allowed = this.allowlist.configured
          ? await this.allowlist.isAllowed(session.ownerAddress)
          : this.bootstrapEnabled && this.isOperator(session.ownerAddress);
      } catch (error) {
        if (!options.allowStaleOnChainError) throw error;
        return {
          ownerAddress: session.ownerAddress,
          operator: this.isOperator(session.ownerAddress),
        };
      }
      if (!allowed) {
        this.store.revokeSession(tokenHash);
        await this.onAccessRevoked?.(session.ownerAddress);
        throw new AuthError(403, "Wallet is no longer on the access list");
      }
      this.store.markSessionChainChecked(tokenHash, new Date().toISOString());
    }

    return {
      ownerAddress: session.ownerAddress,
      operator: this.isOperator(session.ownerAddress),
    };
  }

  logout(token: string | undefined): void {
    if (token) this.store.revokeSession(hashToken(token));
  }

  isOperator(address: string): boolean {
    return this.store.getOperatorAddress() === normalizeAddress(address);
  }
}
