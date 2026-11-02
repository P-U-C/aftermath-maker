import type { MakerConfig } from "@puc/core";
import type { BundleWalletLimits } from "./store.js";

/** Shared by the Start guard and each bundle's readiness/gas stage. */
export function requiredBundleGasMist(
  liveConfigs: MakerConfig[],
  candidate: MakerConfig,
  paperTrial = false,
): number {
  const liveRequiredMist = liveConfigs.length
    ? (() => {
        const conservativeGasMist = Math.max(
          ...liveConfigs.map((config) => config.maxGasMist),
        );
        const restingOrderCount = liveConfigs.reduce(
          (total, config) =>
            total +
            (config.rotationMode === "portfolio"
              ? config.markets.length * 2
              : Math.min(config.markets.length, 1) * 2),
          0,
        );
        return calculateBundleGasReserveMist({
          cancelGasEstimateMist: conservativeGasMist,
          hedgeGasBufferMist: conservativeGasMist,
          fixedSafetyBufferMist: conservativeGasMist,
          runningBundleCount: liveConfigs.length,
          restingOrderCount,
        });
      })()
    : 0;
  return Math.max(
    liveRequiredMist,
    paperTrial || candidate.mode === "paper" ? candidate.maxGasMist : 0,
  );
}

export type BundleWalletObservation = {
  bundleId: string;
  grossExposureUsd: number;
  inventoryUsd: number;
  unrealizedLossUsd: number;
  runDrawdownUsd: number;
};

export type BundleRiskProposal = {
  bundleId: string;
  worstCaseGrossExposureDeltaUsd: number;
  worstCaseInventoryDeltaUsd: number;
  worstCaseUnrealizedLossDeltaUsd: number;
  worstCaseRunDrawdownDeltaUsd: number;
};

export type BundleRiskDecision = {
  bundleId: string;
  accepted: boolean;
  reason: string | null;
};

const absolute = (value: number) =>
  Math.abs(Number.isFinite(value) ? value : 0);

export function admitBundleProposals(inputs: {
  walletLimits: BundleWalletLimits;
  observations: BundleWalletObservation[];
  proposals: BundleRiskProposal[];
}): BundleRiskDecision[] {
  const totals = inputs.observations.reduce(
    (current, observation) => ({
      grossExposureUsd:
        current.grossExposureUsd + absolute(observation.grossExposureUsd),
      inventoryUsd: current.inventoryUsd + absolute(observation.inventoryUsd),
      unrealizedLossUsd:
        current.unrealizedLossUsd + absolute(observation.unrealizedLossUsd),
      runDrawdownUsd:
        current.runDrawdownUsd + absolute(observation.runDrawdownUsd),
    }),
    {
      grossExposureUsd: 0,
      inventoryUsd: 0,
      unrealizedLossUsd: 0,
      runDrawdownUsd: 0,
    },
  );
  const decisions: BundleRiskDecision[] = [];
  for (const proposal of [...inputs.proposals].sort((left, right) =>
    left.bundleId.localeCompare(right.bundleId),
  )) {
    const next = {
      grossExposureUsd:
        totals.grossExposureUsd +
        absolute(proposal.worstCaseGrossExposureDeltaUsd),
      inventoryUsd:
        totals.inventoryUsd + absolute(proposal.worstCaseInventoryDeltaUsd),
      unrealizedLossUsd:
        totals.unrealizedLossUsd +
        absolute(proposal.worstCaseUnrealizedLossDeltaUsd),
      runDrawdownUsd:
        totals.runDrawdownUsd + absolute(proposal.worstCaseRunDrawdownDeltaUsd),
    };
    const reason =
      next.grossExposureUsd > inputs.walletLimits.maxGrossExposureUsd
        ? "Wallet gross exposure limit"
        : next.inventoryUsd > inputs.walletLimits.maxInventoryUsd
          ? "Wallet inventory limit"
          : next.unrealizedLossUsd > inputs.walletLimits.maxUnrealizedLossUsd
            ? "Wallet unrealized-loss limit"
            : next.runDrawdownUsd > inputs.walletLimits.maxRunDrawdownUsd
              ? "Wallet run-drawdown limit"
              : null;
    decisions.push({
      bundleId: proposal.bundleId,
      accepted: reason === null,
      reason,
    });
    if (!reason) Object.assign(totals, next);
  }
  return decisions;
}

export function calculateBundleGasReserveMist(inputs: {
  cancelGasEstimateMist: number;
  hedgeGasBufferMist: number;
  fixedSafetyBufferMist: number;
  runningBundleCount: number;
  restingOrderCount: number;
}): number {
  const bundles = Math.max(0, Math.floor(inputs.runningBundleCount));
  const orders = Math.max(0, Math.floor(inputs.restingOrderCount));
  const cancel = Math.max(0, Math.floor(inputs.cancelGasEstimateMist));
  const hedge = Math.max(0, Math.floor(inputs.hedgeGasBufferMist));
  const fixed = Math.max(0, Math.floor(inputs.fixedSafetyBufferMist));
  return cancel * (orders + bundles) + hedge * bundles + fixed;
}

export function hasBundleGasReserve(inputs: {
  availableGasMist: number | null;
  requiredGasMist: number;
}): boolean {
  return (
    inputs.availableGasMist !== null &&
    Number.isFinite(inputs.availableGasMist) &&
    inputs.availableGasMist >= inputs.requiredGasMist
  );
}
