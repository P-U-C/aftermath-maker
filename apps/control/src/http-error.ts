export type UserErrorFix = {
  kind: "venues" | "strategy" | "bundles" | "accounts" | "copy";
  value?: string;
};

/** Safe, actionable precondition. Unknown failures must never be shown verbatim. */
export class UserFacingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly fix?: UserErrorFix,
    public readonly statusCode = 409,
  ) {
    super(message);
    this.name = "UserFacingError";
  }
}

export type HttpErrorResponse = {
  status: number;
  publicMessage: string;
  internalMessage: string;
  code?: string;
  fix?: UserErrorFix;
};

export function classifyHttpError(error: unknown): HttpErrorResponse {
  const internalMessage =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : String(error);
  const explicitStatus =
    error && typeof error === "object" && "statusCode" in error
      ? Number(error.statusCode)
      : Number.NaN;
  const name =
    error && typeof error === "object" && "name" in error
      ? String(error.name)
      : "";

  const status =
    Number.isInteger(explicitStatus) &&
    explicitStatus >= 400 &&
    explicitStatus <= 599
      ? explicitStatus
      : name === "ZodError"
        ? 400
        : internalMessage.includes("not configured")
          ? 503
          : 500;

  return {
    status,
    internalMessage,
    publicMessage:
      error instanceof UserFacingError
        ? error.message
        : status >= 500
          ? status === 503
            ? "Service unavailable"
            : "Internal server error"
          : internalMessage,
    ...(status < 500 || error instanceof UserFacingError
      ? {
          code:
            error instanceof UserFacingError
              ? error.code
              : status === 401
                ? "auth-required"
                : status === 403
                  ? "access-denied"
                  : status === 429
                    ? "rate-limited"
                    : "invalid-request",
          ...(error instanceof UserFacingError && error.fix
            ? { fix: error.fix }
            : {}),
        }
      : {}),
  };
}
