export function strategyIssueFromServer(
  message: string,
  markets: readonly { marketId: string }[],
): { message: string; step: number; fieldId: string | null } | null {
  try {
    const issues: unknown = JSON.parse(message);
    if (!Array.isArray(issues) || !issues.length) return null;
    const issue = issues[0];
    if (
      !issue ||
      typeof issue !== "object" ||
      !("path" in issue) ||
      !Array.isArray(issue.path) ||
      !("message" in issue) ||
      typeof issue.message !== "string"
    )
      return null;
    const path = issue.path[0] === "config" ? issue.path.slice(1) : issue.path;
    const first = path[0];
    if (first === "markets") {
      const market = markets[Number(path[1])];
      const override = path[2] === "overrides" ? String(path[3] ?? "") : "";
      return {
        message: `${path.join(".")}: ${issue.message}`,
        step: override ? 2 : 1,
        fieldId:
          market && override ? `market-${market.marketId}-${override}` : null,
      };
    }
    const key = typeof first === "string" ? first : "";
    const fields: Record<string, string> = {
      quoteSizeUsd: "strategy-quote-size",
      spreadBps: "strategy-spread",
      maxInventoryUsd: "strategy-inventory-cap",
      maxGrossExposureUsd: "strategy-gross",
      maxUnrealizedLossUsd: "strategy-unrealized-loss",
      maxRunDrawdownUsd: "strategy-drawdown",
      inventoryTargetUsd: "strategy-inventory-target",
      maxQuoteAgeMs: "strategy-max-quote-age-ms",
      marketDwellMs: "strategy-market-dwell-ms",
      maxRestingMs: "strategy-max-resting-ms",
      rotationMode: "strategy-rotation-mode",
      rebalanceGrossExposureUsd: "strategy-rebalance-gross-exposure-usd",
      maxLeverage: "strategy-max-leverage",
    };
    return {
      message: `${path.join(".")}: ${issue.message}`,
      step:
        key === "hedge" ||
        key === "rebalanceGrossExposureUsd" ||
        key === "autoRebalanceEnabled"
          ? 3
          : 2,
      fieldId:
        key === "hedge"
          ? path[1] === "maxOrderUsd"
            ? "strategy-hedge-max"
            : path[1] === "thresholdUsd"
              ? "strategy-hedge-trigger"
              : "strategy-hedge-slippage"
          : (fields[key] ?? null),
    };
  } catch {
    return null;
  }
}
