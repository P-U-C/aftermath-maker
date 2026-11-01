import type { HttpErrorResponse } from "./http-error.js";

export type RequestFailureEvent = {
  category: "request";
  action: string;
  outcome: "rejected" | "error";
  detail: {
    status: number;
    code?: string;
    message: string;
    reference: string;
    bundleId?: string;
    strategyId?: string;
  };
};

/** Only stable opaque bundle/strategy IDs are safe to copy into audit detail. */
export const safeAuditId = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value)
    ? value
    : null;

const routes: Record<string, string> = {
  "/api/bundles/:bundleId/start": "bundle-start",
  "/api/bundles/:bundleId/resume": "bundle-resume",
  "/api/bundles/:bundleId/pause": "bundle-pause",
  "/api/bundles/:bundleId/config": "bundle-config",
  "/api/bundles/:bundleId": "bundle-edit",
  "/api/bundles/:bundleId/archive": "bundle-archive",
  "/api/bundles/wallet-limits": "wallet-limits",
  "/api/bundles": "bundle-create",
  "/api/strategies/:strategyId/archive": "strategy-archive",
  "/api/strategies/:strategyId/duplicate": "strategy-duplicate",
  "/api/strategies/:strategyId": "strategy-save",
  "/api/strategies": "strategy-create",
  "/api/setup/provision": "account-setup",
  "/api/setup/grant-transaction": "account-grant",
  "/api/setup/confirm": "account-confirm",
  "/api/setup/revoke-transaction": "account-revoke",
  "/api/runtime/paper-trial": "paper-trial",
  "/api/runtime/start": "runtime-start",
  "/api/runtime/stop": "runtime-stop",
};
export const REQUEST_ERROR_ACTIONS = [
  ...new Set([...Object.values(routes), "other-request"]),
] as const;

function routeAction(path: string): string {
  const cleaned = path.split("?")[0] ?? path;
  const normalized = cleaned
    .replace(
      /^\/api\/bundles\/(?!wallet-limits(?:\/|$))[^/]+/,
      "/api/bundles/:bundleId",
    )
    .replace(/^\/api\/strategies\/[^/]+/, "/api/strategies/:strategyId");
  return routes[normalized] ?? "other-request";
}

/** Owner-local throttling; only the already-public response enters the audit table. */
export function createRequestErrorRecorder(
  write: (owner: string, event: RequestFailureEvent) => void,
  now: () => number = Date.now,
) {
  const recent = new Map<string, number>();
  return (inputs: {
    owner: string | null;
    path: string;
    reference: string;
    response: HttpErrorResponse;
    bundleId?: string;
    strategyId?: string;
  }): boolean => {
    const { owner, response } = inputs;
    if (!owner || response.status === 401 || response.status === 403)
      return false;
    const action = routeAction(inputs.path);
    const key = `${owner.toLowerCase()}:\0${action}:\0${response.code ?? response.publicMessage}`;
    const time = now();
    if (time - (recent.get(key) ?? -Infinity) < 60_000) return false;
    if (recent.size > 4096) {
      for (const [entry, seenAt] of recent) {
        if (time - seenAt >= 60_000) recent.delete(entry);
      }
    }
    recent.set(key, time);
    write(owner, {
      category: "request",
      action,
      outcome: response.status < 500 ? "rejected" : "error",
      detail: {
        status: response.status,
        ...(response.code ? { code: response.code } : {}),
        message: response.publicMessage,
        reference: inputs.reference,
        ...(inputs.bundleId ? { bundleId: inputs.bundleId } : {}),
        ...(inputs.strategyId ? { strategyId: inputs.strategyId } : {}),
      },
    });
    return true;
  };
}
