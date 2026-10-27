import type { MakerConfig, QuoteIntent, SafetyCheck } from "./schema.js";

export function aggregatePortfolioQuoteRisk(
  markets: Array<{
    inventoryUsd: number;
    restingQuoteSizeUsd: number;
    maxLeverage: number;
  }>,
): {
  worstCaseGrossExposureUsd: number;
  requiredQuoteCollateralUsd: number;
} {
  return markets.reduce(
    (risk, market) => {
      const quoteSizeUsd = Math.max(0, market.restingQuoteSizeUsd);
      const inventoryUsd = market.inventoryUsd;
      risk.worstCaseGrossExposureUsd +=
        quoteSizeUsd > 0
          ? Math.max(
              Math.abs(inventoryUsd + quoteSizeUsd),
              Math.abs(inventoryUsd - quoteSizeUsd),
            )
          : Math.abs(inventoryUsd);
      risk.requiredQuoteCollateralUsd +=
        quoteSizeUsd > 0
          ? (quoteSizeUsd * 2) / Math.max(1, market.maxLeverage)
          : 0;
      return risk;
    },
    {
      worstCaseGrossExposureUsd: 0,
      requiredQuoteCollateralUsd: 0,
    },
  );
}

export function evaluateQuoteSafety(inputs: {
  config: MakerConfig;
  quote: QuoteIntent | null;
  now?: Date;
  setupComplete: boolean;
  hasAgentKey: boolean;
  liveEnabled: boolean;
  mainnetAllowed: boolean;
  portfolioGrossExposureUsd?: number;
  portfolioWorstCaseExposureUsd?: number;
  portfolioAvailableCollateralUsd: number;
  portfolioRequiredQuoteCollateralUsd?: number;
  agentGasSui: number;
  runDrawdownUsd?: number;
}): SafetyCheck[] {
  const {
    config,
    quote,
    setupComplete,
    hasAgentKey,
    liveEnabled,
    mainnetAllowed,
    portfolioGrossExposureUsd = Math.abs(quote?.inventoryUsd ?? 0),
    portfolioWorstCaseExposureUsd,
    portfolioAvailableCollateralUsd,
    portfolioRequiredQuoteCollateralUsd,
    agentGasSui,
    runDrawdownUsd = 0,
  } = inputs;
  const now = inputs.now ?? new Date();

  const checks: SafetyCheck[] = [
    {
      code: "setup",
      label: "Owner setup",
      ok: setupComplete,
      detail: setupComplete
        ? "Account is linked"
        : "Owner account is not linked",
    },
    {
      code: "signer",
      label: "Agent signer",
      ok: hasAgentKey,
      detail: hasAgentKey
        ? "Encrypted signer is available"
        : "No encrypted agent signer",
    },
    {
      code: "live-gate",
      label: "Mainnet gate",
      ok: config.mode !== "live" || (liveEnabled && mainnetAllowed),
      detail:
        config.mode !== "live"
          ? "Not required outside live mode"
          : liveEnabled && mainnetAllowed
            ? "Both live gates are enabled"
            : "LIVE_TRADING_ENABLED and ALLOW_MAINNET are required",
    },
  ];

  if (!quote) {
    return [
      ...checks,
      {
        code: "quote",
        label: "Fresh quote",
        ok: false,
        detail: "No quote has been calculated",
      },
    ];
  }

  const ageMs = now.getTime() - new Date(quote.observedAt).getTime();
  const worstMarketInventoryUsd = Math.max(
    Math.abs(quote.inventoryUsd + quote.sizeUsd),
    Math.abs(quote.inventoryUsd - quote.sizeUsd),
  );
  const projectedGrossExposureUsd =
    portfolioWorstCaseExposureUsd ??
    Math.max(0, portfolioGrossExposureUsd - Math.abs(quote.inventoryUsd)) +
      worstMarketInventoryUsd;
  const requiredQuoteCollateralUsd =
    portfolioRequiredQuoteCollateralUsd ??
    (quote.sizeUsd * 2) / config.maxLeverage;
  const requiredGasSui = (config.maxGasMist * 3) / 1_000_000_000;
  const bookMid = (quote.bestBid + quote.bestAsk) / 2;
  const bookDivergenceBps =
    (Math.abs(bookMid - quote.indexPrice) / quote.indexPrice) * 10_000;
  const fairValueDivergenceLimitBps = Math.min(
    config.maxBookDivergenceBps,
    config.spreadBps / 2,
  );
  checks.push(
    {
      code: "freshness",
      label: "Book freshness",
      ok: ageMs >= 0 && ageMs <= config.staleBookMs,
      detail: `${Math.max(0, ageMs)} ms old; limit ${config.staleBookMs} ms`,
    },
    {
      code: "spread",
      label: "No crossed quote",
      ok:
        quote.bidPrice < quote.askPrice &&
        quote.bidPrice < quote.bestAsk &&
        quote.askPrice > quote.bestBid,
      detail: `bid ${quote.bidPrice}; ask ${quote.askPrice}`,
    },
    {
      code: "fair-value",
      label: "Book / index divergence",
      ok: bookDivergenceBps <= fairValueDivergenceLimitBps,
      detail: `${bookDivergenceBps.toFixed(1)} bps; limit ${fairValueDivergenceLimitBps.toFixed(1)} bps (no wider than half-spread)`,
    },
    {
      code: "notional",
      label: "Quote notional",
      ok: quote.sizeUsd <= config.quoteSizeUsd,
      detail: `$${quote.sizeUsd.toFixed(2)} of $${config.quoteSizeUsd.toFixed(2)}`,
    },
    {
      code: "inventory",
      label: "Worst post-fill inventory",
      ok: worstMarketInventoryUsd <= config.maxInventoryUsd,
      detail: `$${worstMarketInventoryUsd.toFixed(2)} after one fill; limit $${config.maxInventoryUsd.toFixed(2)}`,
    },
    {
      code: "gross-exposure",
      label: "Worst post-fill gross exposure",
      ok: projectedGrossExposureUsd <= config.maxGrossExposureUsd,
      detail: `$${projectedGrossExposureUsd.toFixed(2)} after one fill; limit $${config.maxGrossExposureUsd.toFixed(2)}`,
    },
    {
      code: "collateral",
      label: "Two-sided quote collateral",
      ok: portfolioAvailableCollateralUsd >= requiredQuoteCollateralUsd,
      detail: `$${portfolioAvailableCollateralUsd.toFixed(2)} available; $${requiredQuoteCollateralUsd.toFixed(2)} conservative requirement`,
    },
    {
      code: "gas",
      label: "Agent gas",
      ok: agentGasSui >= requiredGasSui,
      detail: `${agentGasSui.toFixed(4)} SUI available; ${requiredGasSui.toFixed(4)} SUI reserves quote, cancel, and incident margin`,
    },
    {
      code: "unrealized-loss",
      label: "Unrealized loss limit",
      ok: quote.unrealizedPnlUsd >= -config.maxUnrealizedLossUsd,
      detail: `$${quote.unrealizedPnlUsd.toFixed(2)}; floor -$${config.maxUnrealizedLossUsd.toFixed(2)}`,
    },
    {
      code: "run-drawdown",
      label: "Run equity drawdown",
      ok: runDrawdownUsd <= config.maxRunDrawdownUsd,
      detail: `$${runDrawdownUsd.toFixed(2)} from the run high; limit $${config.maxRunDrawdownUsd.toFixed(2)}`,
    },
  );

  return checks;
}

export function assertSafe(checks: SafetyCheck[]): void {
  const failed = checks.filter((check) => !check.ok);
  if (failed.length) {
    throw new Error(
      `Safety gate failed: ${failed.map((check) => check.code).join(", ")}`,
    );
  }
}
