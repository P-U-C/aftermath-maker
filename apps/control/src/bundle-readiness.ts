import { requiredMakerCollateralUsd, type MakerConfig } from "@puc/core";
import { requiredBundleGasMist } from "./bundle-supervisor.js";
import { UserFacingError } from "./http-error.js";
import type { StoredBundle } from "./store.js";

type AccountRead = { accountId: string; availableCollateralUsd: number };
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

/** The same first actionable stage that the bundle card and run status show. */
export function assertBundleReadyToStart(
  bundle: Pick<StoredBundle, "name"> | null,
  readiness: BundleReadiness | undefined,
): void {
  if (!bundle || !readiness || readiness.ready) return;
  const first = readiness.stages.find((stage) => stage.status !== "done")!;
  const kind = first.id === "strategy" ? "bundles" : "venues";
  const instruction =
    first.id === "collateral" && first.accountId
      ? `Deposit $${first.shortfallUsd?.toFixed(2)} to account ${first.accountId} before starting ${bundle.name}.`
      : first.id === "gas"
        ? `Add gas to ${bundle.name}'s trading key before starting it.`
        : `${first.detail} before starting ${bundle.name}.`;
  switch (first.id) {
    case "strategy":
      throw new UserFacingError(
        "bundle-not-ready-strategy",
        instruction,
        { kind },
        409,
      );
    case "accounts":
      throw new UserFacingError(
        "bundle-not-ready-accounts",
        instruction,
        { kind },
        409,
      );
    case "tradingKeys":
      throw new UserFacingError(
        "bundle-not-ready-trading-keys",
        instruction,
        { kind },
        409,
      );
    case "gas":
      throw new UserFacingError(
        "bundle-not-ready-gas",
        instruction,
        { kind },
        409,
      );
    case "collateral":
      throw new UserFacingError(
        "bundle-not-ready-collateral",
        instruction,
        { kind },
        409,
      );
  }
}

/** One deterministic stage model for Start, the bundle card and account funding. */
export function deriveBundleReadiness(inputs: {
  bundle: Pick<
    StoredBundle,
    "strategyId" | "makerAccountId" | "takerAccountId"
  >;
  config: MakerConfig | null;
  accounts: AccountRead[] | null;
  authorizedAccountIds: ReadonlySet<string>;
  gasSui: number | null;
  liveConfigs: MakerConfig[];
}): BundleReadiness {
  const {
    bundle,
    config,
    accounts,
    authorizedAccountIds,
    gasSui,
    liveConfigs,
  } = inputs;
  const strategy: BundleStage =
    bundle.strategyId && config?.markets.length
      ? {
          id: "strategy",
          status: "done",
          detail: `${config.markets.length} markets selected`,
        }
      : {
          id: "strategy",
          status: "todo",
          detail: "Attach a strategy in Bundles",
        };
  const accountIds = [
    bundle.makerAccountId,
    ...(config?.hedge.enabled ? [bundle.takerAccountId] : []),
  ];
  const assigned = accountIds.every((id) => Boolean(id));
  const found =
    assigned &&
    accounts !== null &&
    accountIds.every((id) =>
      accounts.some((account) => account.accountId === id),
    );
  const accountStage: BundleStage =
    strategy.status !== "done"
      ? {
          id: "accounts",
          status: "waiting",
          detail: "After a strategy is chosen",
        }
      : !assigned
        ? { id: "accounts", status: "todo", detail: "Assign accounts" }
        : accounts === null
          ? {
              id: "accounts",
              status: "waiting",
              detail: "Checking owner accounts",
            }
          : found
            ? {
                id: "accounts",
                status: "done",
                detail: `${accountIds.length} assigned`,
              }
            : {
                id: "accounts",
                status: "todo",
                detail: "Choose accounts owned by this wallet",
              };
  const authorized =
    found && accountIds.every((id) => authorizedAccountIds.has(id!));
  const tradingKeys: BundleStage =
    accountStage.status !== "done"
      ? {
          id: "tradingKeys",
          status: "waiting",
          detail: "After accounts are assigned",
        }
      : authorized
        ? {
            id: "tradingKeys",
            status: "done",
            detail: `${accountIds.length} authorized`,
          }
        : {
            id: "tradingKeys",
            status: "todo",
            detail: "Authorize trading key",
          };
  const requiredGasSui = config
    ? requiredBundleGasMist(liveConfigs, config) / 1_000_000_000
    : 0;
  const requiredGasPaperSui = config
    ? requiredBundleGasMist([], { ...config, mode: "paper" }) / 1_000_000_000
    : 0;
  const requiredGasLiveSui = config
    ? requiredBundleGasMist([{ ...config, mode: "live" }], {
        ...config,
        mode: "live",
      }) / 1_000_000_000
    : 0;
  const gas: BundleStage =
    tradingKeys.status !== "done"
      ? {
          id: "gas",
          status: "waiting",
          detail: "After the trading key is authorized",
          requiredGasSui,
        }
      : gasSui === null
        ? {
            id: "gas",
            status: "waiting",
            detail: "Checking trading key gas",
            requiredGasSui,
          }
        : gasSui >= requiredGasSui
          ? {
              id: "gas",
              status: "done",
              detail: `${gasSui.toFixed(2)} SUI available`,
              requiredGasSui,
              availableGasSui: gasSui,
            }
          : {
              id: "gas",
              status: "todo",
              detail: `Needs ${(requiredGasSui - gasSui).toFixed(2)} SUI gas`,
              requiredGasSui,
              availableGasSui: gasSui,
            };
  gas.requiredGasPaperSui = requiredGasPaperSui;
  gas.requiredGasLiveSui = requiredGasLiveSui;
  const requiredUsd = config ? requiredMakerCollateralUsd(config) : 0;
  const maker = accounts?.find(
    (account) => account.accountId === bundle.makerAccountId,
  );
  const hedge = config?.hedge.enabled
    ? accounts?.find((account) => account.accountId === bundle.takerAccountId)
    : null;
  const free = maker?.availableCollateralUsd ?? 0;
  // Proposal: any positive hedge collateral is enough until an owner agrees on
  // a size-derived hedge reserve. Zero requires the smallest six-decimal top-up.
  const hedgeShort =
    config?.hedge.enabled && hedge && hedge.availableCollateralUsd <= 0
      ? 0.01
      : 0;
  const shortfallUsd = Math.max(0, requiredUsd - free);
  const collateral: BundleStage =
    accountStage.status !== "done"
      ? {
          id: "collateral",
          status: "waiting",
          detail: "After accounts are assigned",
          requiredUsd,
        }
      : shortfallUsd > 0 || hedgeShort > 0
        ? {
            id: "collateral",
            status: "todo",
            detail: `Needs $${(shortfallUsd || hedgeShort).toFixed(2)} collateral`,
            requiredUsd: hedgeShort ? 0.01 : requiredUsd,
            availableUsd: hedgeShort
              ? (hedge?.availableCollateralUsd ?? 0)
              : free,
            shortfallUsd: shortfallUsd || hedgeShort,
            accountId: hedgeShort
              ? bundle.takerAccountId!
              : bundle.makerAccountId!,
          }
        : {
            id: "collateral",
            status: "done",
            detail: `$${free.toFixed(2)} free`,
            requiredUsd,
            availableUsd: free,
            shortfallUsd: 0,
            accountId: bundle.makerAccountId!,
          };
  const stages: BundleReadiness["stages"] = [
    strategy,
    accountStage,
    tradingKeys,
    gas,
    collateral,
  ];
  return { ready: stages.every((stage) => stage.status === "done"), stages };
}
