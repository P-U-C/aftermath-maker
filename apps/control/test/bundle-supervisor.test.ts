import { describe, expect, it } from "vitest";
import type { BundleWalletLimits } from "../src/store.js";
import {
  admitBundleProposals,
  calculateBundleGasReserveMist,
  hasBundleGasReserve,
} from "../src/bundle-supervisor.js";

const walletLimits: BundleWalletLimits = {
  maxRunDrawdownUsd: 20,
  maxInventoryUsd: 50,
  maxGrossExposureUsd: 100,
  maxUnrealizedLossUsd: 10,
  updatedAt: "2026-10-28T00:00:00.000Z",
  confirmedAt: "2026-10-28T00:00:00.000Z",
};

describe("bundle wallet supervisor", () => {
  it("rejects a proposal that fits its bundle but crosses every wallet envelope", () => {
    const cases = [
      [
        "grossExposureUsd",
        "worstCaseGrossExposureDeltaUsd",
        "Wallet gross exposure limit",
      ],
      ["inventoryUsd", "worstCaseInventoryDeltaUsd", "Wallet inventory limit"],
      [
        "unrealizedLossUsd",
        "worstCaseUnrealizedLossDeltaUsd",
        "Wallet unrealized-loss limit",
      ],
      [
        "runDrawdownUsd",
        "worstCaseRunDrawdownDeltaUsd",
        "Wallet run-drawdown limit",
      ],
    ] as const;
    for (const [observationKey, proposalKey, reason] of cases) {
      const observations = {
        bundleId: "core",
        grossExposureUsd: 0,
        inventoryUsd: 0,
        unrealizedLossUsd: 0,
        runDrawdownUsd: 0,
        [observationKey]:
          walletLimits[
            observationKey === "grossExposureUsd"
              ? "maxGrossExposureUsd"
              : observationKey === "inventoryUsd"
                ? "maxInventoryUsd"
                : observationKey === "unrealizedLossUsd"
                  ? "maxUnrealizedLossUsd"
                  : "maxRunDrawdownUsd"
          ] - 1,
      };
      const proposal = {
        bundleId: "paper",
        worstCaseGrossExposureDeltaUsd: 0,
        worstCaseInventoryDeltaUsd: 0,
        worstCaseUnrealizedLossDeltaUsd: 0,
        worstCaseRunDrawdownDeltaUsd: 0,
        [proposalKey]: 2,
      };
      expect(
        admitBundleProposals({
          walletLimits,
          observations: [observations],
          proposals: [proposal],
        })[0],
      ).toMatchObject({ bundleId: "paper", accepted: false, reason });
    }
  });

  it("admits simultaneous proposals in bundle-id order against the remaining envelope", () => {
    const decisions = admitBundleProposals({
      walletLimits: { ...walletLimits, maxGrossExposureUsd: 100 },
      observations: [],
      proposals: [
        {
          bundleId: "zeta",
          worstCaseGrossExposureDeltaUsd: 60,
          worstCaseInventoryDeltaUsd: 0,
          worstCaseUnrealizedLossDeltaUsd: 0,
          worstCaseRunDrawdownDeltaUsd: 0,
        },
        {
          bundleId: "alpha",
          worstCaseGrossExposureDeltaUsd: 60,
          worstCaseInventoryDeltaUsd: 0,
          worstCaseUnrealizedLossDeltaUsd: 0,
          worstCaseRunDrawdownDeltaUsd: 0,
        },
      ],
    });
    expect(decisions).toEqual([
      { bundleId: "alpha", accepted: true, reason: null },
      {
        bundleId: "zeta",
        accepted: false,
        reason: "Wallet gross exposure limit",
      },
    ]);
  });

  it("recalculates reserve as running bundles and resting orders change", () => {
    expect(
      calculateBundleGasReserveMist({
        cancelGasEstimateMist: 10,
        hedgeGasBufferMist: 20,
        fixedSafetyBufferMist: 30,
        runningBundleCount: 1,
        restingOrderCount: 0,
      }),
    ).toBe(60);
    const requiredGasMist = calculateBundleGasReserveMist({
      cancelGasEstimateMist: 10,
      hedgeGasBufferMist: 20,
      fixedSafetyBufferMist: 30,
      runningBundleCount: 3,
      restingOrderCount: 4,
    });
    expect(requiredGasMist).toBe(160);
    expect(
      hasBundleGasReserve({ availableGasMist: 159, requiredGasMist }),
    ).toBe(false);
    expect(
      hasBundleGasReserve({ availableGasMist: 160, requiredGasMist }),
    ).toBe(true);
  });
});
