import { UserFacingError } from "./http-error.js";

type AccountBundle = {
  name: string;
  status: string;
  makerAccountId: string | null;
  takerAccountId: string | null;
};

/** Owner-scoped account state is fetched before this guard is called. */
export function assertCollateralWithdrawalAllowed(inputs: {
  accountId: string;
  bundles: AccountBundle[];
  openMakerOrderCount: number;
  amountUsdc: string;
  withdrawableCollateralUsd: number;
}): void {
  const attached = inputs.bundles.find(
    (bundle) =>
      bundle.makerAccountId === inputs.accountId ||
      bundle.takerAccountId === inputs.accountId,
  );
  const running = inputs.bundles.find(
    (bundle) =>
      (bundle.status === "running" || bundle.status === "starting") &&
      (bundle.makerAccountId === inputs.accountId ||
        bundle.takerAccountId === inputs.accountId),
  );
  if (running) {
    throw new UserFacingError(
      "account-in-use",
      `Pause ${running.name} before you withdraw from account ${inputs.accountId}.`,
      { kind: "bundles" },
    );
  }
  if (inputs.openMakerOrderCount > 0) {
    throw new UserFacingError(
      "account-in-use",
      `Cancel open Maker orders${attached ? ` in ${attached.name}` : ""} before you withdraw from account ${inputs.accountId}.`,
      { kind: "bundles" },
    );
  }
  if (
    Number(inputs.amountUsdc) >
    inputs.withdrawableCollateralUsd + 0.0000001
  ) {
    throw new UserFacingError(
      "withdraw-exceeds-available",
      `Account ${inputs.accountId} has $${inputs.withdrawableCollateralUsd.toFixed(2)} withdrawable now. Enter a smaller amount.`,
      { kind: "venues" },
    );
  }
}
