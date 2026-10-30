import type { BuilderFeePolicy } from "@puc/core";

/**
 * A confirmed registration is persisted after the owner completes the venue
 * flow. Environment configuration is bootstrap-only, so it must not replace a
 * newer confirmed registration on a later restart.
 */
export function activeBuilderCode(inputs: {
  confirmedIntegratorId: number | null;
  configuredIntegratorId: number | undefined;
  feeBps: number;
}): BuilderFeePolicy | null {
  const integratorId =
    inputs.confirmedIntegratorId ?? inputs.configuredIntegratorId;
  if (integratorId === undefined || integratorId === null) return null;
  return {
    integratorId,
    integratorFee: inputs.feeBps / 10_000,
  };
}
