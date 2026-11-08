import type { BundleReadiness } from "./bundle-readiness";

type VenueAccountMode = "observe" | "paper" | "live" | null;

/**
 * Present the key requirement in the same mode-specific terms as control's
 * readiness result. Paper reads owner account data and never needs a key.
 */
export function venueAccountReadiness(inputs: {
  mode: VenueAccountMode;
  authorized: boolean;
  existingTradingKeyCount?: number | undefined;
  shortfallUsd: number;
  gasSui: number | null;
  readiness: BundleReadiness | null;
}): {
  stage: string;
  ready: boolean;
  tradingKey:
    | "authorized"
    | "not-needed-paper"
    | "optional-live"
    | "existing-other-control"
    | "required";
  needsGas: boolean;
} {
  const needsLiveKey = inputs.mode === "live";
  const needsGas =
    needsLiveKey &&
    inputs.gasSui !== null &&
    inputs.readiness?.stages[3].status === "todo";

  if (needsLiveKey && !inputs.authorized) {
    if ((inputs.existingTradingKeyCount ?? 0) > 0) {
      return {
        stage: "Existing key not connected",
        ready: false,
        tradingKey: "existing-other-control",
        needsGas: false,
      };
    }
    return {
      stage: "Needs trading key",
      ready: false,
      tradingKey: "required",
      needsGas: false,
    };
  }
  if (inputs.shortfallUsd > 0) {
    return {
      stage: `Needs $${inputs.shortfallUsd.toFixed(2)}`,
      ready: false,
      tradingKey: inputs.authorized ? "authorized" : "not-needed-paper",
      needsGas: false,
    };
  }
  if (needsGas) {
    return {
      stage: "Needs gas",
      ready: false,
      tradingKey: "authorized",
      needsGas: true,
    };
  }
  if (inputs.mode === "paper" && !inputs.authorized) {
    return {
      stage: "Paper ready",
      ready: true,
      tradingKey: "not-needed-paper",
      needsGas: false,
    };
  }
  if (!inputs.authorized) {
    return {
      stage: inputs.readiness ? "Ready" : "Available",
      ready: Boolean(inputs.readiness?.ready),
      tradingKey: "optional-live",
      needsGas: false,
    };
  }
  return {
    stage: inputs.readiness ? "Ready" : "Checking",
    ready: Boolean(inputs.readiness?.ready),
    tradingKey: "authorized",
    needsGas: false,
  };
}
