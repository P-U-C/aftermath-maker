/** Wire shape returned by the control service; readiness logic lives server-side. */
export type BundleStageId =
  "strategy" | "accounts" | "tradingKeys" | "gas" | "collateral";
export type BundleStage = {
  id: BundleStageId;
  status: "done" | "todo" | "waiting";
  detail: string;
  requiredUsd?: number;
  availableUsd?: number;
  shortfallUsd?: number;
  requiredGasSui?: number;
  requiredGasPaperSui?: number;
  requiredGasLiveSui?: number;
  availableGasSui?: number;
  accountId?: string;
};
export type BundleReadiness = {
  ready: boolean;
  stages: [BundleStage, BundleStage, BundleStage, BundleStage, BundleStage];
};
export const stageTitle: Record<BundleStageId, string> = {
  strategy: "Strategy",
  accounts: "Accounts",
  tradingKeys: "Trading keys",
  gas: "Gas",
  collateral: "Collateral",
};
export function nextStage(
  readiness: BundleReadiness | null | undefined,
): BundleStage | null {
  return readiness?.stages.find((stage) => stage.status !== "done") ?? null;
}
