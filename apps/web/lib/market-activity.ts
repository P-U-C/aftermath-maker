/** Snapshot health is market-data health, never proof that an order is resting. */
export function marketActivity(inputs: {
  mode: "observe" | "paper" | "live";
  status: "stopped" | "paused" | "running" | "error";
  marketId: string;
  marketError?: string | null;
  now: number;
  snapshot: {
    running: boolean;
    market: { id: string };
    lastCycleAt: string | null;
    lastError: string | null;
    startedAt?: string | null;
    restingQuoteMarketIds?: string[];
    restingQuoteVerifiedAt?: string | null;
    execution: { lastDecision: string | null };
  } | null;
}): { label: string; active: boolean; error: string | null } {
  const { mode, status, marketId, marketError, snapshot, now } = inputs;
  if (status !== "running")
    return {
      label:
        status === "error"
          ? "Needs attention"
          : status === "paused"
            ? "Paused"
            : "Stopped",
      active: false,
      error: null,
    };
  if (!snapshot?.running)
    return { label: "State unknown · refresh", active: false, error: null };
  const observedAt = snapshot.lastCycleAt
    ? Date.parse(snapshot.lastCycleAt)
    : NaN;
  if (
    !Number.isFinite(observedAt) ||
    now - observedAt > 120_000 ||
    observedAt > now + 5_000
  )
    return {
      label: `${mode === "live" ? "Live" : mode === "paper" ? "Paper" : "Observe"} · Stale observation`,
      active: false,
      error: null,
    };
  const checking = snapshot.market.id === marketId;
  const prefix =
    mode === "live" ? "Live" : mode === "paper" ? "Paper" : "Observe";
  const verifiedAt = snapshot.restingQuoteVerifiedAt
    ? Date.parse(snapshot.restingQuoteVerifiedAt)
    : NaN;
  const startedAt = snapshot.startedAt ? Date.parse(snapshot.startedAt) : NaN;
  if (
    mode === "live" &&
    snapshot.restingQuoteMarketIds?.includes(marketId) &&
    Number.isFinite(verifiedAt) &&
    Number.isFinite(startedAt) &&
    verifiedAt >= startedAt &&
    verifiedAt <= now + 5_000 &&
    now - verifiedAt <= 120_000
  )
    return {
      label: "Live · Venue reported owned resting order",
      active: true,
      error: null,
    };
  if (checking && mode === "paper" && (marketError || snapshot.lastError))
    return {
      label: "Paper · Reading markets · Simulation blocked",
      active: true,
      error: marketError ?? snapshot.lastError,
    };
  if (
    checking &&
    mode === "paper" &&
    snapshot.execution.lastDecision === "quoted"
  )
    return {
      label: "Paper · Dry run succeeded (no real order)",
      active: true,
      error: null,
    };
  return {
    label: `${prefix} · ${checking ? "Reading this market" : "Assigned; awaiting observation"}`,
    active: checking,
    error: null,
  };
}
