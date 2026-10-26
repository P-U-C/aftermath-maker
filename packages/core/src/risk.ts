import type { MakerConfig, QuoteIntent, SafetyCheck } from "./schema.js";

export function evaluateQuoteSafety(inputs: {
  config: MakerConfig;
  quote: QuoteIntent | null;
  now?: Date;
  setupComplete: boolean;
  hasAgentKey: boolean;
  liveEnabled: boolean;
  mainnetAllowed: boolean;
  portfolioGrossExposureUsd?: number;
}): SafetyCheck[] {
  const {
    config,
    quote,
    setupComplete,
    hasAgentKey,
    liveEnabled,
    mainnetAllowed,
    portfolioGrossExposureUsd = Math.abs(quote?.inventoryUsd ?? 0),
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
      code: "notional",
      label: "Quote notional",
      ok: quote.sizeUsd <= config.quoteSizeUsd,
      detail: `$${quote.sizeUsd.toFixed(2)} of $${config.quoteSizeUsd.toFixed(2)}`,
    },
    {
      code: "inventory",
      label: "Per-market inventory",
      ok: Math.abs(quote.inventoryUsd) <= config.maxInventoryUsd,
      detail: `$${quote.inventoryUsd.toFixed(2)} of $${config.maxInventoryUsd.toFixed(2)}`,
    },
    {
      code: "gross-exposure",
      label: "Portfolio gross exposure",
      ok: portfolioGrossExposureUsd <= config.maxGrossExposureUsd,
      detail: `$${portfolioGrossExposureUsd.toFixed(2)} of $${config.maxGrossExposureUsd.toFixed(2)}`,
    },
    {
      code: "unrealized-loss",
      label: "Unrealized loss limit",
      ok: quote.unrealizedPnlUsd >= -config.maxUnrealizedLossUsd,
      detail: `$${quote.unrealizedPnlUsd.toFixed(2)}; floor -$${config.maxUnrealizedLossUsd.toFixed(2)}`,
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
