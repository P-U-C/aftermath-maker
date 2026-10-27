import { z } from "zod";

export const USDC_COIN_TYPE =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

export const runtimeModeSchema = z.enum(["observe", "paper", "live"]);
export type RuntimeMode = z.infer<typeof runtimeModeSchema>;

export const hedgeConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    accountId: z.string().regex(/^\d+$/).nullable().default(null),
    thresholdUsd: z.number().positive().max(10_000).default(25),
    maxOrderUsd: z.number().positive().max(10_000).default(100),
    maxSlippageBps: z.number().int().min(5).max(500).default(75),
  })
  .strict();

export type HedgeConfig = z.infer<typeof hedgeConfigSchema>;

export const makerMarketOverridesSchema = z
  .object({
    quoteSizeUsd: z.number().positive().max(1_000).optional(),
    spreadBps: z.number().min(8).max(500).optional(),
    maxInventoryUsd: z.number().positive().max(10_000).optional(),
    inventoryTargetUsd: z.number().min(-10_000).max(10_000).optional(),
    inventorySkewBps: z.number().min(0).max(250).optional(),
    maxLeverage: z.number().min(1).max(3).optional(),
  })
  .strict();

export type MakerMarketOverrides = z.infer<typeof makerMarketOverridesSchema>;

export const makerMarketSchema = z
  .object({
    marketId: z.string().regex(/^0x[0-9a-fA-F]+$/, "Expected a Sui object ID"),
    symbol: z.string().min(1).max(24),
    overrides: makerMarketOverridesSchema.optional(),
  })
  .strict();

export type MakerMarket = z.infer<typeof makerMarketSchema>;

export const makerConfigSchema = z
  .object({
    markets: z.array(makerMarketSchema).min(1).max(12),
    collateralCoinType: z.string().min(8).default(USDC_COIN_TYPE),
    mode: runtimeModeSchema.default("observe"),
    strategyProfile: z
      .enum(["cautious", "balanced", "active"])
      .default("balanced"),
    makerAccountId: z.string().regex(/^\d+$/).nullable().default(null),
    hedge: hedgeConfigSchema.default({
      enabled: false,
      accountId: null,
      thresholdUsd: 25,
      maxOrderUsd: 100,
      maxSlippageBps: 75,
    }),
    quoteSizeUsd: z.number().positive().max(1_000).default(10),
    spreadBps: z.number().min(8).max(500).default(30),
    refreshMs: z.number().int().min(2_000).max(300_000).default(8_000),
    maxQuoteAgeMs: z.number().int().min(10_000).max(3_900_000).default(120_000),
    maxInventoryUsd: z.number().positive().max(10_000).default(50),
    inventoryTargetUsd: z.number().min(-10_000).max(10_000).default(0),
    maxGrossExposureUsd: z.number().positive().max(100_000).default(150),
    maxUnrealizedLossUsd: z.number().positive().max(10_000).default(20),
    maxRunDrawdownUsd: z.number().positive().max(10_000).default(20),
    maxBookDivergenceBps: z.number().positive().max(5_000).default(100),
    maxLeverage: z.number().min(1).max(3).default(1),
    maxGasMist: z
      .number()
      .int()
      .positive()
      .max(500_000_000)
      .default(50_000_000),
    staleBookMs: z.number().int().min(3_000).max(120_000).default(15_000),
    inventorySkewBps: z.number().min(0).max(250).default(20),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = config.markets.map((market) => market.marketId.toLowerCase());
    if (config.hedge.enabled) {
      if (!config.makerAccountId || !config.hedge.accountId) {
        context.addIssue({
          code: "custom",
          path: ["hedge", "accountId"],
          message: "Hedging requires authorized Maker and hedge accounts",
        });
      } else if (config.makerAccountId === config.hedge.accountId) {
        context.addIssue({
          code: "custom",
          path: ["hedge", "accountId"],
          message: "Maker and hedge accounts must be different",
        });
      }
      if (config.hedge.maxOrderUsd < config.hedge.thresholdUsd) {
        context.addIssue({
          code: "custom",
          path: ["hedge", "maxOrderUsd"],
          message: "Maximum hedge order must cover the hedge threshold",
        });
      }
    }
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["markets"],
        message: "Each selected market must be unique",
      });
    }
    const maximumMarketInventory = Math.max(
      config.maxInventoryUsd,
      ...config.markets.map(
        (market) => market.overrides?.maxInventoryUsd ?? config.maxInventoryUsd,
      ),
    );
    if (config.maxGrossExposureUsd < maximumMarketInventory) {
      context.addIssue({
        code: "custom",
        path: ["maxGrossExposureUsd"],
        message: "Gross exposure limit cannot be below a per-market limit",
      });
    }

    const minimumQuoteAgeMs =
      config.refreshMs * config.markets.length +
      Math.min(10_000, config.refreshMs);
    if (config.maxQuoteAgeMs < minimumQuoteAgeMs) {
      context.addIssue({
        code: "custom",
        path: ["maxQuoteAgeMs"],
        message: `Quote age limit must cover one full rotation (${minimumQuoteAgeMs} ms)`,
      });
    }

    for (const [index, market] of config.markets.entries()) {
      const inventoryLimit =
        market.overrides?.maxInventoryUsd ?? config.maxInventoryUsd;
      const inventoryTarget =
        market.overrides?.inventoryTargetUsd ?? config.inventoryTargetUsd;
      if (Math.abs(inventoryTarget) > inventoryLimit) {
        context.addIssue({
          code: "custom",
          path: ["markets", index, "overrides", "inventoryTargetUsd"],
          message:
            "Inventory target must fit inside the market inventory limit",
        });
      }
    }
  });

export type MakerConfig = z.infer<typeof makerConfigSchema>;

export const setupSchema = z
  .object({
    ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    accountId: z.string().regex(/^\d+$/),
    accountCapId: z.string().regex(/^0x[0-9a-fA-F]+$/),
    collateralCoinType: z.string().min(8).default(USDC_COIN_TYPE),
  })
  .strict();

export type Setup = z.infer<typeof setupSchema>;

export const quoteIntentSchema = z
  .object({
    marketId: z.string(),
    observedAt: z.string().datetime(),
    bestBid: z.number().positive(),
    bestAsk: z.number().positive(),
    indexPrice: z.number().positive(),
    bidPrice: z.number().positive(),
    askPrice: z.number().positive(),
    sizeBase: z.number().positive(),
    sizeUsd: z.number().positive(),
    inventoryUsd: z.number(),
    unrealizedPnlUsd: z.number(),
  })
  .strict();

export type QuoteIntent = z.infer<typeof quoteIntentSchema>;

export type SafetyCheck = {
  code: string;
  label: string;
  ok: boolean;
  detail: string;
};

export type RuntimeMarketSnapshot = {
  id: string;
  symbol: string;
  status: "queued" | "healthy" | "error";
  indexPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  openInterestBase: number | null;
  openInterestUsd: number | null;
  openInterestUtilizationPct: number | null;
  volume24hUsd: number | null;
  fundingRate: number | null;
  inventoryUsd: number;
  unrealizedPnlUsd: number;
  bidPrice: number | null;
  askPrice: number | null;
  effectiveSpreadBps: number;
  effectiveQuoteSizeUsd: number;
  effectiveMaxInventoryUsd: number;
  inventoryTargetUsd: number;
  lastTransactionDigest: string | null;
  updatedAt: string | null;
  error: string | null;
};

export type RuntimeSnapshot = {
  mode: RuntimeMode;
  running: boolean;
  cycle: number;
  startedAt: string | null;
  lastCycleAt: string | null;
  lastSuccessfulCycleAt: string | null;
  lastError: string | null;
  setupComplete: boolean;
  agentAddress: string | null;
  accountId: string | null;
  market: {
    id: string;
    symbol: string;
    indexPrice: number | null;
    bestBid: number | null;
    bestAsk: number | null;
    updatedAt: string | null;
  };
  markets: RuntimeMarketSnapshot[];
  portfolio: {
    selectedMarkets: number;
    grossExposureUsd: number;
    unrealizedPnlUsd: number;
    availableCollateralUsd: number | null;
    allocatedCollateralUsd: number | null;
    freeMarginUsd: number | null;
    withdrawableCollateralUsd: number | null;
  };
  balances: {
    equityUsd: number | null;
    inventoryUsd: number;
    unrealizedPnlUsd: number;
    gasSui: number | null;
  };
  watchdog: {
    state: "idle" | "armed" | "tripped";
    checkedAt: string | null;
    maxQuoteAgeMs: number | null;
  };
  execution: {
    confirmedLiveQuotes: number;
    averageGasMist: number | null;
    gasRunwayTransactions: number | null;
    lastExecutionAt: string | null;
  };
  hedge: {
    enabled: boolean;
    state: "off" | "waiting" | "ready" | "hedging" | "error";
    accountId: string | null;
    combinedDeltaUsd: number | null;
    lastHedgeAt: string | null;
    lastDigest: string | null;
    error: string | null;
  };
  quote: QuoteIntent | null;
  safety: SafetyCheck[];
};

export const integratorInspectionSchema = z
  .object({
    accountId: z.string().regex(/^\d+$/),
    integratorId: z.number().int().nonnegative(),
  })
  .strict();
