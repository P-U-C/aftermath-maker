import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { OnchainAllowlist } from "./allowlist.js";
import { UserFacingError } from "./http-error.js";
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

const ACCESS_REQUEST_TOKEN_TTL_MS = 15 * 60_000;

type AccessRequestTokenPayload = {
  address: string;
  expiresAt: number;
};

type AccessRequestVerification =
  | {
      sessionToken: string;
      expiresAt: string;
      ownerAddress: string;
      operator: boolean;
    }
  | {
      accessRequestToken: string;
      accessRequestExpiresAt: string;
      ownerAddress: string;
    };

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
    private readonly accessRequestTokenSecret?: string,
    private readonly verificationClient?: SuiGrpcClient,
  ) {}

  private signAccessRequestToken(payload: string): string {
    if (!this.accessRequestTokenSecret) {
      throw new AuthError(503, "Access requests are unavailable");
    }
    return createHmac("sha256", this.accessRequestTokenSecret)
      .update(payload)
      .digest("base64url");
  }

  private issueAccessRequestToken(ownerAddress: string): {
    accessRequestToken: string;
    accessRequestExpiresAt: string;
  } {
    const expiresAt = Date.now() + ACCESS_REQUEST_TOKEN_TTL_MS;
    const encodedPayload = Buffer.from(
      JSON.stringify({ address: ownerAddress, expiresAt }),
    ).toString("base64url");
    const payload = `v1.${encodedPayload}`;
    return {
      accessRequestToken: `${payload}.${this.signAccessRequestToken(payload)}`,
      accessRequestExpiresAt: new Date(expiresAt).toISOString(),
    };
  }

  createAccessRequest(inputs: {
    accessRequestToken: string | undefined;
    twitterHandle: string;
    company: string;
  }): void {
    const walletAddress = this.requireAccessRequestToken(
      inputs.accessRequestToken,
    );
    if (inputs.company) return;
    this.store.createAccessRequest({
      walletAddress,
      twitterHandle: inputs.twitterHandle,
    });
  }

  requireAccessRequestToken(token: string | undefined): string {
    if (!token) {
      throw new AuthError(401, "Access request verification is required");
    }
    const [version, encodedPayload, signature, ...extra] = token.split(".");
    if (version !== "v1" || !encodedPayload || !signature || extra.length) {
      throw new AuthError(401, "Access request verification is invalid");
    }
    const payload = `${version}.${encodedPayload}`;
    const expected = this.signAccessRequestToken(payload);
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (
      actualBytes.length !== expectedBytes.length ||
      !timingSafeEqual(actualBytes, expectedBytes)
    ) {
      throw new AuthError(401, "Access request verification is invalid");
    }

    let decoded: AccessRequestTokenPayload;
    try {
      decoded = JSON.parse(
        Buffer.from(encodedPayload, "base64url").toString("utf8"),
      ) as AccessRequestTokenPayload;
    } catch {
      throw new AuthError(401, "Access request verification is invalid");
    }
    if (
      !decoded ||
      typeof decoded.address !== "string" ||
      !Number.isSafeInteger(decoded.expiresAt)
    ) {
      throw new AuthError(401, "Access request verification is invalid");
    }
    const ownerAddress = normalizeAddress(decoded.address);
    if (decoded.expiresAt <= Date.now()) {
      throw new UserFacingError(
        "access-check-expired",
        "That check expired. Sign again to request access.",
        undefined,
        410,
      );
    }
    return ownerAddress;
  }

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
  }): Promise<AccessRequestVerification> {
    const ownerAddress = normalizeAddress(inputs.address);
    this.store.consumeChallenge({
      id: inputs.challengeId,
      ownerAddress,
      message: inputs.message,
    });

    let chainCheckUnavailable = false;
    // The SDK checks zkLogin (including a zkLogin multisig member) through
    // client.core. Mark transport failures without mistaking a chain-level
    // success:false verdict for an invalid network connection.
    const verificationClient = this.verificationClient
      ? ({
          core: {
            verifyZkLoginSignature: async (
              args: Parameters<
                SuiGrpcClient["core"]["verifyZkLoginSignature"]
              >[0],
            ) => {
              try {
                return await this.verificationClient!.core.verifyZkLoginSignature(
                  args,
                );
              } catch {
                chainCheckUnavailable = true;
                throw new Error("Signature chain check unavailable");
              }
            },
          },
        } as unknown as SuiGrpcClient)
      : undefined;
    try {
      await verifyPersonalMessageSignature(
        new TextEncoder().encode(inputs.message),
        inputs.signature,
        {
          address: ownerAddress,
          ...(verificationClient ? { client: verificationClient } : {}),
        },
      );
    } catch {
      throw chainCheckUnavailable
        ? new UserFacingError(
            "signature-check-unavailable",
            "Maker couldn't check your wallet's signature right now. Try again in a minute.",
            undefined,
            503,
          )
        : new UserFacingError(
            "signature-invalid",
            "Your wallet's signature didn't verify. Sign again.",
            undefined,
            401,
          );
    }

    let allowed = false;
    if (this.allowlist.configured) {
      allowed = await this.allowlist.isAllowed(ownerAddress, true);
    } else if (!this.bootstrapEnabled) {
      throw new UserFacingError(
        "access-list-not-configured",
        "The access list isn't set up yet. The operator needs to finish setup.",
        undefined,
        503,
      );
    } else if (this.bootstrapEnabled) {
      const operator = this.store.getOperatorAddress();
      if (!operator || operator === ownerAddress) {
        this.store.claimBootstrapOperator(ownerAddress);
        allowed = true;
      } else {
        throw new UserFacingError(
          "access-list-not-configured",
          "The access list isn't set up yet. The operator needs to finish setup.",
          undefined,
          503,
        );
      }
    }
    if (!allowed) {
      if (!this.accessRequestTokenSecret) {
        throw new AuthError(403, "Requests are closed right now.");
      }
      return {
        ownerAddress,
        ...this.issueAccessRequestToken(ownerAddress),
      };
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
