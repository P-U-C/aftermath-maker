import type { PaperBlocker } from "./paper-blocker";

import type { BundleReadiness } from "./bundle-readiness";

export type RunStartIssue = {
  message: string;
  code?: string;
  fix?: {
    kind: "venues" | "strategy" | "bundles" | "accounts" | "copy";
    value?: string;
  };
};

export type RunMode = "paper" | "live";
export type RunPhase =
  | "stopping"
  | "pausing"
  | "starting"
  | "attention"
  | "running"
  | "paused"
  | "stopped";
export type RunIndicator = "tide" | "ember" | "amber" | "hollow" | "spinner";
export type RunTone = "default" | "amber";

export type RunBundleInput = {
  id: string;
  name: string;
  mode: string;
  status: "stopped" | "running" | "paused" | "error" | string;
  lastError?: string | null;
  needsStrategy?: boolean;
  readiness?: BundleReadiness | null;
};

export type RunSnapshotInput = {
  running?: boolean;
  startedAt?: string | null;
  lastError?: string | null;
  paperBlocker?: PaperBlocker | null;
  accountReadAt?: string | null;
  restingQuoteMarketIds?: string[] | null;
  paper?: { openOrders?: number | null } | null;
  markets?: Array<{ symbol?: string | null }> | null;
};

export type RunSnapshotEntry<
  TSnapshot extends RunSnapshotInput = RunSnapshotInput,
> = {
  bundle: { id: string };
  snapshot: TSnapshot | null;
};

export type RunStopState = {
  phase: "idle" | "stopping" | "unconfirmed";
  targets: string[];
  startedAt: number | null;
  error?: string | null;
};

export type RunBundle<TSnapshot extends RunSnapshotInput = RunSnapshotInput> =
  RunBundleInput & {
    mode: RunMode;
    phase: RunPhase;
    snapshot: TSnapshot | null;
    holdsOrders: boolean;
    startError: RunStartIssue | null;
  };

export type RunState<TSnapshot extends RunSnapshotInput = RunSnapshotInput> = {
  bundles: RunBundle<TSnapshot>[];
  running: RunBundle<TSnapshot>[];
  liveCount: number;
  paperCount: number;
  stoppable: boolean;
  since: string | null;
  markState: "stopped" | "paper" | "live";
  liveRail: boolean;
  label: string;
  indicator: RunIndicator;
  tone: RunTone;
  stale: boolean;
  stop: RunStopState;
  configDirty: boolean;
};

export type DeriveRunStateInputs<
  TSnapshot extends RunSnapshotInput = RunSnapshotInput,
> = {
  bundles: RunBundleInput[];
  snapshots: RunSnapshotEntry<TSnapshot>[];
  pending: Record<string, "start" | "resume" | "pause" | undefined>;
  stop: RunStopState;
  startErrors: Record<string, RunStartIssue | string | undefined>;
  configDirty: boolean;
  stale: boolean;
  /** Retained by the caller while polling is unavailable. */
  lastKnownStoppable?: boolean;
};

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
}

function earliestStartedAt(bundles: RunBundle[]): string | null {
  const timestamps = bundles
    .map((bundle) => bundle.snapshot?.startedAt ?? null)
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter(({ time }) => Number.isFinite(time));
  if (!timestamps.length) return null;
  timestamps.sort((left, right) => left.time - right.time);
  return timestamps[0]?.value ?? null;
}

/**
 * Derives the complete user-facing run state from the last control response.
 * It deliberately has no React or request-layer dependencies so every surface
 * presents the same answer for the same data.
 */
export function deriveRunState<TSnapshot extends RunSnapshotInput>({
  bundles: inputBundles,
  snapshots,
  pending,
  stop,
  startErrors,
  configDirty,
  stale,
  lastKnownStoppable = false,
}: DeriveRunStateInputs<TSnapshot>): RunState<TSnapshot> {
  const snapshotsByBundle = new Map(
    snapshots.map((entry) => [entry.bundle.id, entry.snapshot]),
  );

  const bundles = inputBundles.map((input) => {
    const snapshot = snapshotsByBundle.get(input.id) ?? null;
    const rawHoldsOrders =
      Boolean(snapshot?.running) ||
      Boolean(snapshot?.restingQuoteMarketIds?.length) ||
      (snapshot?.paper?.openOrders ?? 0) > 0;
    const action = pending[input.id];
    let phase: RunPhase;
    if (
      stop.phase === "stopping" &&
      stop.targets.includes(input.id) &&
      rawHoldsOrders
    ) {
      phase = "stopping";
    } else if (action === "pause") {
      phase = "pausing";
    } else if (action === "start" || action === "resume") {
      phase = "starting";
    } else if (
      input.status === "error" ||
      (input.status === "running" &&
        Boolean(snapshot?.paperBlocker || snapshot?.lastError))
    ) {
      phase = "attention";
    } else if (input.status === "running") {
      phase = "running";
    } else if (input.status === "paused") {
      phase = "paused";
    } else {
      phase = "stopped";
    }

    const startError = startErrors[input.id];
    return {
      ...input,
      mode: input.mode === "live" ? "live" : "paper",
      phase,
      snapshot,
      holdsOrders:
        rawHoldsOrders || phase === "running" || phase === "attention",
      startError:
        typeof startError === "string"
          ? { message: startError }
          : (startError ?? null),
    } satisfies RunBundle<TSnapshot>;
  });

  const running = bundles.filter(
    (bundle) => bundle.phase === "running" || bundle.phase === "attention",
  );
  const liveCount = running.filter((bundle) => bundle.mode === "live").length;
  const paperCount = running.length - liveCount;
  const hasPending = bundles.some(
    (bundle) =>
      bundle.phase === "starting" ||
      bundle.phase === "pausing" ||
      bundle.phase === "stopping",
  );
  const currentlyStoppable = bundles.some((bundle) => bundle.holdsOrders);
  const stoppable =
    currentlyStoppable ||
    hasPending ||
    stop.phase === "unconfirmed" ||
    (stale && lastKnownStoppable);
  const attention = sortByName(
    bundles.filter((bundle) => bundle.phase === "attention"),
  )[0];
  const starting = sortByName(
    bundles.filter((bundle) => bundle.phase === "starting"),
  )[0];
  const paused = bundles.some((bundle) => bundle.phase === "paused");

  let label = "Stopped";
  let indicator: RunIndicator = "hollow";
  let tone: RunTone = "default";
  if (stop.phase === "unconfirmed") {
    label = "Stop not confirmed";
    indicator = "amber";
    tone = "amber";
  } else if (stop.phase === "stopping") {
    label = "Stopping…";
    indicator = "spinner";
  } else if (stale) {
    label = "Can't reach Maker";
    indicator = "hollow";
    tone = "amber";
  } else if (attention) {
    label = `${attention.name} needs attention`;
    indicator = "amber";
  } else if (starting && running.length === 0) {
    label = `Starting ${starting.name}…`;
    indicator = "spinner";
  } else if (running.length === 1) {
    const bundle = running[0]!;
    label = `${bundle.name} ${bundle.mode === "live" ? "live" : "on paper"}`;
    indicator = bundle.mode === "live" ? "ember" : "tide";
  } else if (running.length > 1 && liveCount === 0) {
    label = `${running.length} on paper`;
    indicator = "tide";
  } else if (running.length > 1 && liveCount === running.length) {
    label = `${running.length} live`;
    indicator = "ember";
  } else if (running.length > 1) {
    label = `${running.length} running, ${liveCount} live`;
    indicator = "ember";
  } else if (paused) {
    label = "Paused";
  }

  return {
    bundles,
    running,
    liveCount,
    paperCount,
    stoppable,
    since: earliestStartedAt(running),
    markState:
      liveCount > 0
        ? "live"
        : running.length > 0 || starting
          ? "paper"
          : "stopped",
    liveRail: liveCount > 0,
    label,
    indicator,
    tone,
    stale,
    stop,
    configDirty,
  };
}
