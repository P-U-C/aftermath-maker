export type HttpErrorResponse = {
  status: number;
  publicMessage: string;
  internalMessage: string;
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
      status >= 500
        ? status === 503
          ? "Service unavailable"
          : "Internal server error"
        : internalMessage,
  };
}
