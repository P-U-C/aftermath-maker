import { describe, expect, it } from "vitest";

import {
  deriveRunState,
  type DeriveRunStateInputs,
  type RunBundleInput,
} from "../lib/run-state";

const core: RunBundleInput = {
  id: "core",
  name: "Core",
  mode: "paper",
  status: "stopped",
};

function inputs(
  overrides: Partial<DeriveRunStateInputs> = {},
): DeriveRunStateInputs {
  return {
    bundles: [core],
    snapshots: [],
    pending: {},
    stop: { phase: "idle", targets: [], startedAt: null },
    startErrors: {},
    configDirty: false,
    stale: false,
    ...overrides,
  };
}

function snapshot(
  id: string,
  values: NonNullable<
    DeriveRunStateInputs["snapshots"][number]["snapshot"]
  > = {},
): DeriveRunStateInputs["snapshots"][number] {
  return { bundle: { id }, snapshot: values };
}

describe("deriveRunState", () => {
  it.each([
    {
      name: "an unconfirmed stop",
      values: inputs({
        stop: {
          phase: "unconfirmed",
          targets: ["core"],
          startedAt: 1,
          error: "Timeout",
        },
      }),
      label: "Stop not confirmed",
      indicator: "amber",
    },
    {
      name: "a stop in progress",
      values: inputs({
        bundles: [{ ...core, status: "running" }],
        snapshots: [snapshot("core", { running: true })],
        stop: { phase: "stopping", targets: ["core"], startedAt: 1 },
      }),
      label: "Stopping…",
      indicator: "spinner",
    },
    {
      name: "a stale control response",
      values: inputs({ stale: true, lastKnownStoppable: true }),
      label: "Can't reach Maker",
      indicator: "hollow",
    },
    {
      name: "a bundle needing attention",
      values: inputs({ bundles: [{ ...core, status: "error" }] }),
      label: "Core needs attention",
      indicator: "amber",
    },
    {
      name: "a start before anything runs",
      values: inputs({ pending: { core: "start" } }),
      label: "Starting Core…",
      indicator: "spinner",
    },
    {
      name: "one paper bundle",
      values: inputs({ bundles: [{ ...core, status: "running" }] }),
      label: "Core on paper",
      indicator: "tide",
    },
    {
      name: "one live bundle",
      values: inputs({
        bundles: [{ ...core, mode: "live", status: "running" }],
      }),
      label: "Core live",
      indicator: "ember",
    },
    {
      name: "multiple paper bundles",
      values: inputs({
        bundles: [
          { ...core, status: "running" },
          { id: "rewards", name: "Rewards", mode: "paper", status: "running" },
        ],
      }),
      label: "2 on paper",
      indicator: "tide",
    },
    {
      name: "multiple live bundles",
      values: inputs({
        bundles: [
          { ...core, mode: "live", status: "running" },
          { id: "rewards", name: "Rewards", mode: "live", status: "running" },
        ],
      }),
      label: "2 live",
      indicator: "ember",
    },
    {
      name: "mixed running bundles",
      values: inputs({
        bundles: [
          { ...core, status: "running" },
          { id: "rewards", name: "Rewards", mode: "live", status: "running" },
        ],
      }),
      label: "2 running, 1 live",
      indicator: "ember",
    },
    {
      name: "a paused bundle",
      values: inputs({ bundles: [{ ...core, status: "paused" }] }),
      label: "Paused",
      indicator: "hollow",
    },
    {
      name: "nothing active",
      values: inputs(),
      label: "Stopped",
      indicator: "hollow",
    },
  ])("maps $name to the nav label", ({ values, label, indicator }) => {
    const state = deriveRunState(values);
    expect(state.label).toBe(label);
    expect(state.indicator).toBe(indicator);
  });

  it("keeps Stop available for paper open orders after a bundle stopped", () => {
    const state = deriveRunState(
      inputs({
        snapshots: [snapshot("core", { paper: { openOrders: 2 } })],
      }),
    );
    expect(state.stoppable).toBe(true);
  });

  it("keeps Stop available for resting live orders after a bundle paused", () => {
    const state = deriveRunState(
      inputs({
        bundles: [{ ...core, mode: "live", status: "paused" }],
        snapshots: [snapshot("core", { restingQuoteMarketIds: ["mon"] })],
      }),
    );
    expect(state.stoppable).toBe(true);
  });

  it("keeps Stop available when running data becomes stale", () => {
    const state = deriveRunState(
      inputs({
        bundles: [{ ...core, status: "running" }],
        stale: true,
      }),
    );
    expect(state.stoppable).toBe(true);
  });

  it("does not show Stop for stale stopped data", () => {
    const state = deriveRunState(inputs({ stale: true }));
    expect(state.stoppable).toBe(false);
  });

  it("uses a live mark when Core is paper and another bundle is live", () => {
    const state = deriveRunState(
      inputs({
        bundles: [
          { ...core, status: "running" },
          { id: "rewards", name: "Rewards", mode: "live", status: "running" },
        ],
      }),
    );
    expect(state.markState).toBe("live");
    expect(state.liveRail).toBe(true);
  });

  it("takes the earliest running start time", () => {
    const state = deriveRunState(
      inputs({
        bundles: [
          { ...core, status: "running" },
          { id: "rewards", name: "Rewards", mode: "paper", status: "running" },
        ],
        snapshots: [
          snapshot("core", { startedAt: "2026-10-27T17:00:00.000Z" }),
          snapshot("rewards", { startedAt: "2026-10-27T16:00:00.000Z" }),
        ],
      }),
    );
    expect(state.since).toBe("2026-10-27T16:00:00.000Z");
  });
});
