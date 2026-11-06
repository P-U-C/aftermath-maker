export const INVENTORY_RECYCLING_NAME = "Inventory recycling";

type StrategyConfig = {
  markets: Array<{ overrides?: object | undefined }>;
  mode: "observe" | "paper" | "live";
  makerAccountId: string | null;
  strategyObjective: "farming" | "profit" | "both" | "volume";
  strategyProfile: "cautious" | "balanced" | "active";
  rotationMode: "portfolio" | "single-slot";
  inventoryTargetUsd: number;
  maxLeverage: number;
  flattenOnRotate: boolean;
  autoRebalanceEnabled: boolean;
  hedge: { enabled: boolean; accountId: string | null };
};

/** A new, unattached Paper strategy. Existing market IDs may be carried over
 * for convenience, but prior market-specific sizing and leverage never are. */
export function inventoryRecyclingDefault<Config extends StrategyConfig>(
  defaults: Config,
  markets: Config["markets"],
): Config {
  return {
    ...defaults,
    markets: markets.map(({ overrides: _overrides, ...market }) => market),
    mode: "paper",
    makerAccountId: null,
    strategyObjective: "both",
    strategyProfile: "balanced",
    rotationMode: "portfolio",
    inventoryTargetUsd: 0,
    maxLeverage: 1,
    flattenOnRotate: false,
    autoRebalanceEnabled: false,
    hedge: {
      ...defaults.hedge,
      enabled: false,
      accountId: null,
    },
  } as Config;
}
