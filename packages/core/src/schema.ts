import { z } from "zod";

export const USDC_COIN_TYPE =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

export const runtimeModeSchema = z.enum(["observe", "paper", "live"]);
export type RuntimeMode = z.infer<typeof runtimeModeSchema>;

export const makerMarketSchema = z
  .object({
    marketId: z.string().regex(/^0x[0-9a-fA-F]+$/, "Expected a Sui object ID"),
    symbol: z.string().min(1).max(24),
  })
  .strict();

export type MakerMarket = z.infer<typeof makerMarketSchema>;

export const makerConfigSchema = z
  .object({
    markets: z.array(makerMarketSchema).min(1).max(12),
    collateralCoinType: z.string().min(8).default(USDC_COIN_TYPE),
    mode: runtimeModeSchema.default("observe"),
    quoteSizeUsd: z.number().positive().max(1_000).default(10),
    spreadBps: z.number().min(8).max(500).default(30),
    refreshMs: z.number().int().min(2_000).max(300_000).default(8_000),
    maxInventoryUsd: z.number().positive().max(10_000).default(50),
    maxGrossExposureUsd: z.number().positive().max(100_000).default(150),
    maxUnrealizedLossUsd: z.number().positive().max(10_000).default(20),
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
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["markets"],
        message: "Each selected market must be unique",
      });
    }
    if (config.maxGrossExposureUsd < config.maxInventoryUsd) {
      context.addIssue({
        code: "custom",
        path: ["maxGrossExposureUsd"],
        message: "Gross exposure limit cannot be below the per-market limit",
      });
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
  updatedAt: string | null;
  error: string | null;
};

export type RuntimeSnapshot = {
  mode: RuntimeMode;
  running: boolean;
  cycle: number;
  lastCycleAt: string | null;
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
  };
  balances: {
    equityUsd: number | null;
    inventoryUsd: number;
    unrealizedPnlUsd: number;
    gasSui: number | null;
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
