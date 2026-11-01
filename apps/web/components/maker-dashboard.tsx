"use client";

import {
  DAppKitProvider,
  useCurrentAccount,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { ConnectModal } from "@mysten/dapp-kit-react/ui";
import type { DAppKitConnectModal } from "@mysten/dapp-kit-core/web";
import { Transaction } from "@mysten/sui/transactions";
import {
  aggregatePortfolioQuoteRisk,
  makerConfigSchema,
  type MakerMarketOverrides,
} from "@puc/core";
import {
  assertOwnerTransactionIntent,
  deserializeOwnerTransactionIntent,
  type SerializedOwnerTransactionIntent,
} from "@puc/aftermath/owner-transaction-intent";
import {
  ArrowDownRight,
  ArrowUpRight,
  CircleCheck,
  ExternalLink,
  Coins,
  Fuel,
  Gauge,
  KeyRound,
  LockKeyhole,
  Search,
  Tag,
  Target,
  TimerReset,
  Trophy,
  ShieldCheck,
  ShieldOff,
  UserPlus,
  WalletCards,
} from "lucide-react";
import {
  Fragment,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { dAppKit } from "../app/dapp-kit";
import {
  deniedWalletAction,
  shouldBeginWalletSignIn,
  walletSessionMatches,
} from "../lib/access";
import { deskEvent } from "../lib/audit-events";
import { selectedActiveBundleId } from "../lib/bundle-options";
import { configsEqual } from "../lib/config-equality";
import { withMarketPolicyOverride } from "../lib/strategy-market-policy";
import {
  readStrategyAcknowledgement,
  strategyAcknowledgementKey,
  strategyIsComplete,
  type StrategyAcknowledgement,
  type StrategyFields,
} from "../lib/strategy-acknowledgement";
import {
  formatCompactMoney,
  formatEventTimestamp,
  formatExactMoney,
  formatMoney,
  moneyTone,
} from "../lib/format";
import { narrate } from "../lib/narrate";
import { marketActivity } from "../lib/market-activity";
import {
  deriveRunState,
  type RunStartIssue,
  type RunStopState,
} from "../lib/run-state";
import { hedgeSizingSuggestion } from "../lib/hedge-suggestion";
import { strategyIssueFromServer } from "../lib/strategy-validation";
import { mergeStrategyReads } from "../lib/strategy-snapshots";
import {
  suggestMarketIds,
  type MarketSuggestionPreset,
} from "../lib/quick-picks";
import {
  draftMarketsForSave,
  selectDraftMarkets,
} from "../lib/strategy-market-selection";
import {
  readStrategyDraft,
  strategyDraftKey,
  writeStrategyDraft,
} from "../lib/strategy-draft-storage";
import {
  advancedFieldTips,
  type AdvancedFieldTipId,
} from "../lib/strategy-field-tips";
import { primaryVenue } from "../lib/venues";
import { AccessScreen, type AccessRequestInput } from "./access-screen";
import { GlossaryTerm } from "./ui/glossary-term";
import {
  makerViews,
  MakerShell,
  useMakerView,
  type MakerNoticeTone,
  type MakerView,
} from "./maker-shell";
import {
  Button,
  Card,
  KitTable,
  PageHeader,
  SegmentedTabs,
  Sheet,
} from "./ui/primitives";
import { NumericDraftInput } from "./ui/numeric-draft-input";
import { SpreadMark } from "./spread-mark";
import { StrategyPicker } from "./strategy-picker";
import { MarketPolicySheet } from "./market-policy-sheet";
import { VenueChip } from "./venue-chip";
import { AccountsView } from "./views/accounts";
import { BundleDeskLanes } from "./views/bundle-desk-lanes";
import {
  BundlesView,
  type BundleCreationResult,
  type BundleEditorRequest,
} from "./views/bundles";
import { DeskView } from "./views/desk";
import { LearnView } from "./views/learn";
import { MarketsView } from "./views/markets";
import { PerformanceView } from "./views/performance";
import { GoLiveSheet, StrategyView } from "./views/strategy";
import { VenueBoard, VenuesView } from "./views/venues";

type PreparedOwnerTransactionResponse = {
  transaction: string;
  intent: SerializedOwnerTransactionIntent;
};

type ExpectedOwnerIntent = {
  kind: SerializedOwnerTransactionIntent["kind"];
  sender: string;
  amount?: bigint;
  recipient?: string;
  agentAddress?: string;
  gasMist?: bigint;
  agentCapId?: string;
};

function verifiedOwnerTransaction(
  prepared: PreparedOwnerTransactionResponse,
  expected: ExpectedOwnerIntent,
): Transaction {
  const intent = deserializeOwnerTransactionIntent(prepared.intent);
  if (
    intent.kind !== expected.kind ||
    intent.sender.toLowerCase() !== expected.sender.toLowerCase()
  ) {
    throw new Error("Prepared wallet transaction does not match this action");
  }
  if (
    expected.amount !== undefined &&
    (!("amount" in intent) || intent.amount !== expected.amount)
  ) {
    throw new Error("Prepared collateral amount does not match this action");
  }
  if (
    expected.recipient &&
    (!("recipient" in intent) ||
      intent.recipient.toLowerCase() !== expected.recipient.toLowerCase())
  ) {
    throw new Error("Prepared withdrawal recipient does not match this wallet");
  }
  if (
    expected.agentAddress &&
    (!("agentAddress" in intent) ||
      intent.agentAddress.toLowerCase() !== expected.agentAddress.toLowerCase())
  ) {
    throw new Error(
      "Prepared trading key recipient does not match this account",
    );
  }
  if (
    expected.gasMist !== undefined &&
    (!("gasMist" in intent) || intent.gasMist !== expected.gasMist)
  ) {
    throw new Error(
      "Prepared trading key gas grant does not match this action",
    );
  }
  if (
    expected.agentCapId &&
    (!("agentCapId" in intent) ||
      intent.agentCapId.toLowerCase() !== expected.agentCapId.toLowerCase())
  ) {
    throw new Error("Prepared revocation does not match this capability");
  }

  const transaction = Transaction.from(prepared.transaction);
  assertOwnerTransactionIntent(transaction, intent);
  return transaction;
}

function usdcBaseUnits(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

type Mode = "observe" | "paper" | "live";
type StrategyObjective = "farming" | "profit" | "both";

type SafetyCheck = {
  code: string;
  label: string;
  ok: boolean;
  detail: string;
};

type RuntimeMarket = {
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

type Snapshot = {
  mode: Mode;
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
    book: {
      bids: Array<[number, number]>;
      asks: Array<[number, number]>;
      observedAt: string;
    } | null;
  };
  risk: {
    runDrawdownUsd: number | null;
    runHighEquityUsd: number | null;
    measuredAt: string | null;
  };
  markets: RuntimeMarket[];
  restingQuoteMarketIds?: string[];
  restingQuoteVerifiedAt?: string | null;
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
    avoidedTransactions: number;
    lastDecision: "quoted" | "switched" | "held" | "rebalanced" | null;
    lastExecutionAt: string | null;
  };
  paper: {
    estimated: boolean;
    openOrders: number;
    fills: number;
    hedges: number;
    makerInventoryUsd: number;
    hedgeInventoryUsd: number;
    grossExposureUsd: number;
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
  quote: {
    bidPrice: number;
    askPrice: number;
    sizeUsd: number;
  } | null;
  safety: SafetyCheck[];
};

type Market = {
  id: string;
  symbol: string;
  displayName: string;
  indexPrice: number;
  tickSize: number;
  lotSize: number;
  minOrderUsdValue: number;
  openInterestBase: number;
  openInterestUsd: number;
  openInterestUtilizationPct: number | null;
  maxOpenInterestBase: number;
  fundingRate: number;
  makerFee: number;
  volume24hUsd: number | null;
  priceChange24hPct: number | null;
};

type MarketOverrides = {
  quoteSizeUsd?: number;
  spreadBps?: number;
  maxInventoryUsd?: number;
  inventoryTargetUsd?: number;
  inventorySkewBps?: number;
  maxLeverage?: number;
};

type MarketTableSortKey =
  | "symbol"
  | "bundleName"
  | "venue"
  | "status"
  | "effectiveQuoteSizeUsd"
  | "indexPrice"
  | "openInterestUsd"
  | "openInterestUtilizationPct"
  | "volume24hUsd"
  | "fundingRate"
  | "inventoryUsd"
  | "unrealizedPnlUsd"
  | "updatedAt";

type MakerConfig = {
  markets: Array<{
    marketId: string;
    symbol: string;
    overrides?: MarketOverrides;
  }>;
  collateralCoinType: string;
  mode: Mode;
  rotationMode: "portfolio" | "single-slot";
  strategyObjective: StrategyObjective;
  strategyProfile: "cautious" | "balanced" | "active";
  makerAccountId: string | null;
  hedge: {
    enabled: boolean;
    accountId: string | null;
    thresholdUsd: number;
    maxOrderUsd: number;
    maxSlippageBps: number;
  };
  quoteSizeUsd: number;
  spreadBps: number;
  refreshMs: number;
  marketDwellMs: number;
  requoteThresholdBps: number;
  maxRestingMs: number;
  autoRebalanceEnabled: boolean;
  rebalanceGrossExposureUsd: number;
  maxQuoteAgeMs: number;
  maxInventoryUsd: number;
  inventoryTargetUsd: number;
  maxGrossExposureUsd: number;
  maxUnrealizedLossUsd: number;
  maxRunDrawdownUsd: number;
  maxBookDivergenceBps: number;
  maxLeverage: number;
  maxGasMist: number;
  staleBookMs: number;
  inventorySkewBps: number;
};

type StrategySettings = Omit<
  MakerConfig,
  "markets" | "mode" | "makerAccountId" | "hedge"
> & {
  hedge: Omit<MakerConfig["hedge"], "accountId">;
};

type StrategyMarketRule =
  | {
      kind: "quick-pick";
      pick: "rewards" | "balanced" | "quiet" | "steady" | "clear";
    }
  | { kind: "preferred-list"; marketIds: string[] };

type MakerStrategy = {
  id: string;
  name: string;
  config: StrategySettings;
  marketRule: StrategyMarketRule;
  markets: MakerConfig["markets"];
  version: number;
  updatedAt?: string;
  usedBy: Array<{ id: string; name: string }>;
  archivedAt: string | null;
};

const strategySettingsFromConfig = (config: MakerConfig): StrategySettings => {
  const {
    markets: _markets,
    mode: _mode,
    makerAccountId: _makerAccountId,
    hedge,
    ...settings
  } = config;
  const { accountId: _accountId, ...sharedHedge } = hedge;
  return { ...settings, hedge: sharedHedge };
};

const configWithStrategySettings = (
  config: MakerConfig,
  settings: StrategySettings,
): MakerConfig => ({
  ...config,
  ...settings,
  hedge: { ...settings.hedge, accountId: config.hedge.accountId },
});

type StoredStrategyDraft = {
  baseVersion: number;
  name: string;
  settings: StrategySettings;
  markets: MakerConfig["markets"];
  marketRule: StrategyMarketRule;
  savedAt: string;
};

type BundleStatus = "stopped" | "running" | "paused" | "error";

type MakerBundle = {
  id: string;
  name: string;
  strategyId: string | null;
  strategyName: string | null;
  strategyVersionApplied: number | null;
  needsStrategy: boolean;
  makerAccountId: string | null;
  takerAccountId: string | null;
  mode: Mode;
  status: BundleStatus;
  marketIds: string[];
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  archivedAt: string | null;
};

type BundleWalletLimits = {
  maxRunDrawdownUsd: number;
  maxInventoryUsd: number;
  maxGrossExposureUsd: number;
  maxUnrealizedLossUsd: number;
  updatedAt: string;
  confirmedAt: string | null;
};

type BundleSnapshot = {
  bundle: MakerBundle;
  snapshot: Snapshot | null;
};

type AccountCap = {
  accountId: string;
  accountCapId: string;
  collateralCoinType: string;
  equityUsd: number;
  availableCollateralUsd: number;
  allocatedCollateralUsd: number;
  freeMarginUsd: number;
  positionCount: number;
  label: string | null;
  tags: string[];
};

type AccountMetadata = {
  accountId: string;
  label: string | null;
  tags: string[];
  updatedAt: string;
};

type AccountMetadataDraft = {
  label: string;
  tags: string;
};

type ManagedAccount = {
  ownerAddress: string;
  accountId: string;
  accountCapId: string;
  collateralCoinType: string;
  addedAt: string;
  grantDigest: string | null;
  agentCapId: string | null;
};

type SetupState = {
  setup: {
    ownerAddress: string;
    accountId: string;
    accountCapId: string;
    collateralCoinType: string;
  } | null;
  accounts: ManagedAccount[];
  agent: {
    address: string;
    createdAt: string;
    grantDigest: string | null;
    agentCapId: string | null;
  } | null;
};

type MakerFill = {
  occurredAt: string;
  txDigest: string;
  marketId: string;
  symbol: string;
  side: "bid" | "ask";
  price: number;
  size: number;
  notionalUsd: number;
  realizedPnlUsd: number;
  protocolFeesUsd: number;
  estimatedBuilderFeeUsd: number;
  orderId: string;
  estimated: boolean;
};

type PerformancePeriod = "1D" | "EPOCH" | "ALL";

type Performance = {
  asOf: string;
  period: PerformancePeriod;
  periodStartedAt: string | null;
  historyComplete: boolean;
  account: {
    realizedPnlUsd: number;
    fundingPnlUsd: number;
    makerVolumeUsd: number;
    takerVolumeUsd: number;
    makerFeesUsd: number;
    takerFeesUsd: number;
  } | null;
  attributed: {
    fills: number;
    notionalUsd: number;
    realizedPnlUsd: number;
    protocolFeesUsd: number;
    estimatedBuilderFeesUsd: number;
    netAfterKnownCostsUsd: number;
    makerVolumeCoveragePct: number | null;
  };
  hedge: {
    enabled: boolean;
    accountId: string | null;
    executions: number;
    fills: number;
    notionalUsd: number;
    realizedPnlUsd: number;
    protocolFeesUsd: number;
    estimatedBuilderFeesUsd: number;
    netAfterKnownCostsUsd: number;
  };
  combinedNetAfterKnownCostsUsd: number;
  paper: {
    estimated: boolean;
    makerFills: number;
    hedgeFills: number;
    notionalUsd: number;
  };
  volumeByMarket: Array<{
    marketId: string;
    symbol: string;
    makerNotionalUsd: number;
    makerFills: number;
    takerNotionalUsd: number;
    takerFills: number;
    realizedPnlUsd: number;
    feesUsd: number;
  }>;
  fills: MakerFill[];
  note: string;
};

type RewardOpportunity = {
  rank: number;
  marketId: string;
  symbol: string;
  minOrderUsdValue: number;
  minimumQuoteSizeUsd: number;
  objective: StrategyObjective;
  score: number;
  farmingScore: number;
  profitScore: number;
  bothScore: number;
  confidence: "high" | "medium" | "low";
  eligible: boolean;
  objectiveEligible: boolean;
  thinActive: boolean;
  observedSpreadBps: number | null;
  preRiskEdgeBps: number | null;
  balancedDepth50BpsUsd: number;
  volume24hUsd: number | null;
  openInterestUsd: number;
  openInterestUtilizationPct: number | null;
  volumeToDepth: number | null;
  fundingRate: number;
  priceChange24hPct: number | null;
  makerRebateBps: number;
  builderFeeBps: number;
  knownCostBps: number;
  suggestedSpreadBps: number;
  suggestedQuoteSizeUsd: number;
  reasons: string[];
  error: string | null;
};

type RewardDashboard = {
  asOf: string;
  epoch: {
    number: number;
    startedAt: string;
    cutoffAt: string;
  };
  account: {
    trackedAccountIds: string[];
    error: string | null;
    makerRewardsSui: number;
    qScoreShare: number;
    uptime: number;
    makerVolumeUsd: number;
    makerVolumeShare: number;
    directRebatesUsd: number;
    baseMakerFeesUsd: number;
  };
  marketModel: {
    label: "heuristic";
    methodology: string;
    depthBandBps: 50;
    opportunities: RewardOpportunity[];
  };
};

type LiveGates = {
  liveTradingEnabled: boolean;
  mainnetAllowed: boolean;
};

type StrategyTrialResult = {
  mode: "paper";
  marketId: string;
  symbol: string;
  cadenceMs: number;
  startedAt: string;
  completedAt: string;
  rounds: Array<{
    objective: StrategyObjective;
    profile: MakerConfig["strategyProfile"];
    score: number;
    quoteSizeUsd: number;
    spreadBps: number;
    outcome: "simulated" | "confirmed";
    digest: string | null;
    startedAt: string;
    completedAt: string;
  }>;
  recovery: {
    digest: string | null;
    digests: string[];
    flattenedMarketIds: string[];
  } | null;
  restoredConfig: MakerConfig;
};

type AuditEvent = {
  id: number;
  bundleId?: string | null;
  occurredAt: string;
  category: string;
  action: string;
  outcome: string;
  detail: Record<string, unknown>;
};

type AccessIdentity = {
  ownerAddress: string;
  operator: boolean;
  registryConfigured: boolean;
  registryObjectId: string | null;
};

type AccessRequestVerification = {
  accessRequestToken: string;
  accessRequestExpiresAt: string;
  ownerAddress: string;
};

type BuilderCode = {
  integratorId: number;
  integratorFee: number;
};

type OperatorStatus = {
  operatorAddress: string;
  registryObjectId: string | null;
  packageId: string | null;
  adminCapId: string | null;
  builderCode: BuilderCode | null;
  bootstrap: boolean;
};

type AccessRequest = {
  id: number;
  walletAddress: string;
  twitterHandle: string;
  status: "pending" | "approved" | "closed";
  requestedAt: string;
  notifiedAt: string | null;
};

const USDC =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const MAX_SELECTED_MARKETS = 64;

function minimumObservationWindowMs(
  refreshMs: number,
  marketCount: number,
  rotationMode: MakerConfig["rotationMode"],
  maxRestingMs = refreshMs,
) {
  return rotationMode === "single-slot"
    ? Math.max(
        refreshMs * 2 + Math.min(10_000, refreshMs),
        maxRestingMs + 30_000,
      )
    : refreshMs * Math.max(1, marketCount) + Math.min(10_000, refreshMs);
}

const strategyObjectives = [
  {
    value: "farming",
    label: "Farming",
    measure: "Rewards / capital",
    icon: Coins,
  },
  {
    value: "profit",
    label: "Profit",
    measure: "Edge after known costs",
    icon: Gauge,
  },
  {
    value: "both",
    label: "Both",
    measure: "Positive on both tests",
    icon: Target,
  },
] as const;

const strategyProfiles = [
  {
    value: "cautious",
    label: "Cautious",
    summary: "Wider quotes and slower checks",
    quoteSizeUsd: 5,
    spreadBps: 50,
    refreshMs: 15_000,
    maxInventoryUsd: 30,
    inventorySkewBps: 35,
  },
  {
    value: "balanced",
    label: "Balanced",
    summary: "Measured spread and inventory",
    quoteSizeUsd: 10,
    spreadBps: 30,
    refreshMs: 8_000,
    maxInventoryUsd: 50,
    inventorySkewBps: 20,
  },
  {
    value: "active",
    label: "Active",
    summary: "Tighter quotes and faster checks",
    quoteSizeUsd: 10,
    spreadBps: 18,
    refreshMs: 4_000,
    maxInventoryUsd: 50,
    inventorySkewBps: 30,
  },
] as const;

const defaultConfig: MakerConfig = {
  markets: [],
  collateralCoinType: USDC,
  mode: "paper",
  rotationMode: "portfolio",
  strategyObjective: "both",
  strategyProfile: "balanced",
  makerAccountId: null,
  hedge: {
    enabled: false,
    accountId: null,
    thresholdUsd: 25,
    maxOrderUsd: 100,
    maxSlippageBps: 75,
  },
  quoteSizeUsd: 10,
  spreadBps: 30,
  refreshMs: 8_000,
  marketDwellMs: 60_000,
  requoteThresholdBps: 5,
  maxRestingMs: 60_000,
  autoRebalanceEnabled: false,
  rebalanceGrossExposureUsd: 100,
  maxQuoteAgeMs: 120_000,
  maxInventoryUsd: 50,
  inventoryTargetUsd: 0,
  maxGrossExposureUsd: 150,
  maxUnrealizedLossUsd: 20,
  maxRunDrawdownUsd: 20,
  maxBookDivergenceBps: 100,
  maxLeverage: 1,
  maxGasMist: 50_000_000,
  staleBookMs: 15_000,
  inventorySkewBps: 20,
};

function AdvancedTip({ id }: { id: AdvancedFieldTipId }) {
  return (
    <GlossaryTerm
      definition={advancedFieldTips[id]}
      label={`Explain ${id.replaceAll("-", " ")}`}
    >
      <span className="advanced-field-tip" aria-hidden="true">
        ?
      </span>
    </GlossaryTerm>
  );
}

class FieldValidationFailure extends Error {}

class RequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly fix?: RunStartIssue["fix"],
    public readonly requestId?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/control/${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...options?.headers,
    },
    cache: "no-store",
  });
  const payload = await response.text();
  let data: T & {
    error?: string;
    requestId?: string;
    code?: string;
    fix?: RunStartIssue["fix"];
  } = {} as T & {
    error?: string;
    requestId?: string;
    code?: string;
    fix?: RunStartIssue["fix"];
  };
  if (payload) {
    try {
      data = JSON.parse(payload) as T & {
        error?: string;
        requestId?: string;
        code?: string;
        fix?: RunStartIssue["fix"];
      };
    } catch {
      data = { error: payload } as T & {
        error?: string;
        requestId?: string;
        code?: string;
        fix?: RunStartIssue["fix"];
      };
    }
  }
  if (!response.ok) {
    throw new RequestError(
      `${data.error ?? `Request failed: ${response.status}`}${response.status >= 500 && data.requestId ? ` (reference ${data.requestId})` : ""}`,
      response.status,
      data.code,
      data.fix,
      data.requestId,
    );
  }
  return data;
}

const compact = (value: string | null) =>
  value ? `${value.slice(0, 6)}...${value.slice(-4)}` : "Not set";

const money = (value: number | null, digits = 2) =>
  formatMoney(value, {
    table: digits > 2,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

const reviewFieldName = (field: string) =>
  (
    ({
      quoteSizeUsd: "Quote size",
      spreadBps: "Spread",
      maxInventoryUsd: "Largest position",
      inventoryTargetUsd: "Target position",
      inventorySkewBps: "Inventory skew",
      maxLeverage: "Leverage",
      maxGrossExposureUsd: "Total position",
      maxRunDrawdownUsd: "Stop after drawdown",
    }) as Record<string, string>
  )[field] ??
  field
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());

const reviewValue = (field: string, value: unknown): string => {
  if (value === null || value === undefined) return "strategy";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") {
    if (field.endsWith("Usd")) return money(value);
    if (field.endsWith("Bps")) return `${value} bps`;
    if (field.endsWith("Ms")) return `${value / 1_000} s`;
    if (field === "maxLeverage") return `${value}×`;
    return String(value);
  }
  return String(value);
};

const marketPrice = (value: number | null, tickSize: number): string => {
  if (value === null || !Number.isFinite(value)) return "—";
  const digits =
    Number.isFinite(tickSize) && tickSize > 0
      ? Math.max(0, Math.min(8, Math.ceil(-Math.log10(tickSize))))
      : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
};

const compactUsd = (value: number | null) => formatCompactMoney(value);

const compactNumber = (value: number | null) =>
  value === null
    ? "-"
    : new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(value);

const percent = (value: number | null, digits = 2) =>
  value === null ? "-" : `${value.toFixed(digits)}%`;

const updatedAgo = (timestamp: string | null): string => {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp)))
    return "Waiting for first update";
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(timestamp)) / 1_000),
  );
  if (seconds < 60) return `Updated ${seconds} s ago`;
  if (seconds < 3_600) return `Updated ${Math.floor(seconds / 60)} m ago`;
  if (seconds < 86_400) return `Updated ${Math.floor(seconds / 3_600)} h ago`;
  return `Updated ${Math.floor(seconds / 86_400)} d ago`;
};

const timeUntil = (timestamp: string | null) => {
  if (!timestamp) return "Schedule unavailable";
  const remaining = Math.max(0, Date.parse(timestamp) - Date.now());
  const days = Math.floor(remaining / 86_400_000);
  const hours = Math.floor((remaining % 86_400_000) / 3_600_000);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
};

function DashboardBody() {
  const account = useCurrentAccount();
  const wallet = useDAppKit();
  const { activeView, selectView } = useMakerView();
  const [identity, setIdentity] = useState<AccessIdentity | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [deniedAddress, setDeniedAddress] = useState("");
  const [accessRequestVerification, setAccessRequestVerification] =
    useState<AccessRequestVerification | null>(null);
  const [requestSubmitted, setRequestSubmitted] = useState(false);
  const [builderCode, setBuilderCode] = useState<BuilderCode | null>(null);
  const [operatorStatus, setOperatorStatus] = useState<OperatorStatus | null>(
    null,
  );
  const [accessRequests, setAccessRequests] = useState<AccessRequest[]>([]);
  const [memberAddress, setMemberAddress] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [bundleSnapshots, setBundleSnapshots] = useState<BundleSnapshot[]>([]);
  const [bundles, setBundles] = useState<MakerBundle[]>([]);
  const [strategies, setStrategies] = useState<MakerStrategy[]>([]);
  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(
    null,
  );
  const [strategyMarketRule, setStrategyMarketRule] =
    useState<StrategyMarketRule>({ kind: "quick-pick", pick: "balanced" });
  const [strategyNameDraft, setStrategyNameDraft] = useState("");
  const createStrategyInFlight = useRef(false);
  const [newStrategySource, setNewStrategySource] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [acknowledgedStrategies, setAcknowledgedStrategies] = useState<
    Record<string, StrategyAcknowledgement | null>
  >({});
  const [pendingStrategyDelete, setPendingStrategyDelete] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [strategyDeleteError, setStrategyDeleteError] = useState<string | null>(
    null,
  );
  const deleteInFlight = useRef(false);
  const applyInFlight = useRef(false);
  const selectedStrategyIdRef = useRef<string | null>(null);
  const strategyDraftRef = useRef<StrategyFields | null>(null);
  const [pendingMarketSuggestion, setPendingMarketSuggestion] = useState<{
    ids: string[];
    preset: MarketSuggestionPreset;
    focus: "all" | "thin";
    count: number;
    strategyId: string | null;
  } | null>(null);
  const [walletLimits, setWalletLimits] = useState<BundleWalletLimits | null>(
    null,
  );
  const [selectedBundleId, setSelectedBundleId] = useState<string | null>(null);
  const [bundleEditorRequest, setBundleEditorRequest] =
    useState<BundleEditorRequest | null>(null);
  const bundleEditorToken = useRef(0);
  const [strategyReturn, setStrategyReturn] = useState<{
    strategyId: string;
    step: number;
  } | null>(null);
  const [accountFocusId, setAccountFocusId] = useState<string | null>(null);
  const selectedBundleIdRef = useRef<string | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [marketQuery, setMarketQuery] = useState("");
  const [policyEditorTarget, setPolicyEditorTarget] = useState<{
    marketId: string;
    symbol: string;
    strategyId: string;
  } | null>(null);
  const [config, setConfig] = useState<MakerConfig>(defaultConfig);
  const [savedConfig, setSavedConfig] = useState<
    MakerConfig | null | undefined
  >(undefined);
  const configLoaded = useRef(false);
  const [setup, setSetup] = useState<SetupState>({
    setup: null,
    accounts: [],
    agent: null,
  });
  const [accounts, setAccounts] = useState<AccountCap[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  useEffect(() => {
    if (activeView !== "accounts" || !accountFocusId) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(`account-${accountFocusId}`);
      target?.scrollIntoView({ block: "center" });
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeView, accountFocusId, accounts.length]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [performance, setPerformance] = useState<Performance | null>(null);
  const [performancePeriod, setPerformancePeriod] =
    useState<PerformancePeriod>("1D");
  const [performanceBundle, setPerformanceBundle] = useState<string>("all");
  const [expandedPerformanceMarket, setExpandedPerformanceMarket] = useState<
    string | null
  >(null);
  const [rewards, setRewards] = useState<RewardDashboard | null>(null);
  const [liveGates, setLiveGates] = useState<LiveGates>({
    liveTradingEnabled: false,
    mainnetAllowed: false,
  });
  const [strategyStep, setStrategyStep] = useState(0);
  const [strategyEditing, setStrategyEditing] = useState(false);
  const [draftBaseVersion, setDraftBaseVersion] = useState<number | null>(null);
  const loadedStrategyDraft = useRef<string | null>(null);
  const [invalidNumeric, setInvalidNumeric] = useState<Record<string, string>>(
    {},
  );
  const [serverFieldIssue, setServerFieldIssue] = useState<{
    message: string;
    step: number;
    fieldId: string | null;
  } | null>(null);
  const [hedgeSuggestionOpen, setHedgeSuggestionOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [trialResult, setTrialResult] = useState<StrategyTrialResult | null>(
    null,
  );
  const [rewardMarketCount, setRewardMarketCount] = useState(5);
  const [suggestionPreset, setSuggestionPreset] =
    useState<MarketSuggestionPreset>("balanced");
  const [suggestionInputEpoch, setSuggestionInputEpoch] = useState(0);
  const [suggestionCountError, setSuggestionCountError] = useState<
    string | null
  >(null);
  const [rewardFocus, setRewardFocus] = useState<"all" | "thin">("all");
  const [marketVenueFilter, setMarketVenueFilter] = useState<
    "all" | "aftermath"
  >("all");
  const [marketSort, setMarketSort] = useState<
    "rank" | "score" | "volume" | "depth"
  >("rank");
  const [marketTableSort, setMarketTableSort] = useState<{
    key: MarketTableSortKey;
    direction: "asc" | "desc";
  }>({ key: "symbol", direction: "asc" });
  const [selectedAccount, setSelectedAccount] = useState("");
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [accountMetadataDraft, setAccountMetadataDraft] =
    useState<AccountMetadataDraft>({ label: "", tags: "" });
  const [collateralAmounts, setCollateralAmounts] = useState<
    Record<string, string>
  >({});
  const [busy, setBusy] = useState("");
  const bundleCreateInFlight = useRef(false);
  const [flattenArmed, setFlattenArmed] = useState(false);
  const [liveSheetOpen, setLiveSheetOpen] = useState(false);
  const [pendingStrategyExit, setPendingStrategyExit] =
    useState<MakerView | null>(null);
  const [notice, setNoticeMessage] = useState<string | null>(null);
  const [noticeTone, setNoticeTone] = useState<MakerNoticeTone>("error");
  const noticeTimer = useRef<number | null>(null);
  const [controlUnavailable, setControlUnavailable] = useState(false);
  const [lastGoodDataAt, setLastGoodDataAt] = useState<string | null>(null);
  const [lastControlResponseAt, setLastControlResponseAt] = useState<
    string | null
  >(null);
  const [stop, setStop] = useState<RunStopState>({
    phase: "idle",
    targets: [],
    startedAt: null,
  });
  const [bundlePending, setBundlePending] = useState<
    Record<string, "start" | "resume" | "pause" | undefined>
  >({});
  const [startErrors, setStartErrors] = useState<
    Record<string, RunStartIssue | undefined>
  >({});
  const [stoppedAt, setStoppedAt] = useState<
    Record<string, string | undefined>
  >({});
  const lastKnownStoppable = useRef(false);
  const [integratorId, setIntegratorId] = useState("");
  const [inspection, setInspection] = useState<{
    exists: boolean;
    maxIntegratorFee: number | null;
    checkedAt: string;
  } | null>(null);
  const onboardingRouteOwner = useRef<string | null>(null);
  const loginAttemptedAddress = useRef<string | null>(null);
  const walletPickerRef = useRef<DAppKitConnectModal>(null);

  const walletSessionMismatch = !walletSessionMatches(
    identity?.ownerAddress ?? null,
    account?.address ?? null,
  );

  const setNotice = useCallback(
    (message: string | null, tone: MakerNoticeTone = "error") => {
      if (noticeTimer.current !== null) {
        window.clearTimeout(noticeTimer.current);
        noticeTimer.current = null;
      }
      setNoticeMessage(message);
      if (!message) return;
      setNoticeTone(tone);
      if (tone === "success") {
        noticeTimer.current = window.setTimeout(() => {
          setNoticeMessage(null);
          noticeTimer.current = null;
        }, 6_000);
      }
    },
    [],
  );

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) {
        window.clearTimeout(noticeTimer.current);
      }
    },
    [],
  );

  function requestOwnerWallet(action: string): string | null {
    if (account?.address) return account.address;
    setNotice(`Connect your owner wallet to ${action}`, "warning");
    walletPickerRef.current?.show();
    return null;
  }

  const refresh = useCallback(async () => {
    const [
      statusResult,
      configResult,
      setupResult,
      eventResult,
      bundleResult,
      strategyResult,
    ] = await Promise.all([
      request<{
        snapshot: Snapshot;
        builderCode: BuilderCode | null;
        liveGates: LiveGates;
        bundles?: BundleSnapshot[];
      }>("api/status"),
      request<{ config: MakerConfig | null }>("api/config"),
      request<SetupState>("api/setup"),
      request<{ events: AuditEvent[] }>("api/events?limit=12"),
      request<{
        bundles: MakerBundle[];
        walletLimits: BundleWalletLimits | null;
      }>("api/bundles"),
      request<{ strategies: MakerStrategy[] }>("api/strategies"),
    ]);
    setSnapshot(statusResult.snapshot);
    setControlUnavailable(false);
    setLastControlResponseAt(new Date().toISOString());
    setLastGoodDataAt(
      statusResult.snapshot.lastSuccessfulCycleAt ??
        statusResult.snapshot.market.updatedAt ??
        statusResult.snapshot.risk.measuredAt ??
        null,
    );
    setBundleSnapshots(statusResult.bundles ?? []);
    setBundles(bundleResult.bundles);
    setStrategies((current) =>
      mergeStrategyReads(current, strategyResult.strategies),
    );
    setSelectedStrategyId((current) => {
      const next = current ?? strategyResult.strategies[0]?.id ?? null;
      if (next !== current) {
        const strategy = strategyResult.strategies.find(
          (candidate) => candidate.id === next,
        );
        if (strategy) setStrategyMarketRule(strategy.marketRule);
      }
      return next;
    });
    setWalletLimits(bundleResult.walletLimits);
    const previousBundleId = selectedBundleIdRef.current;
    const nextBundleId = selectedActiveBundleId(
      bundleResult.bundles,
      previousBundleId,
    );
    selectedBundleIdRef.current = nextBundleId;
    setSelectedBundleId(nextBundleId);
    if (
      previousBundleId !== null &&
      previousBundleId !== nextBundleId &&
      configResult.config
    ) {
      const loadedConfig = {
        ...configResult.config,
        makerAccountId:
          configResult.config.makerAccountId ??
          setupResult.setup?.accountId ??
          null,
      };
      setConfig(loadedConfig);
      setSavedConfig(loadedConfig);
    }
    setBuilderCode(statusResult.builderCode);
    setLiveGates(statusResult.liveGates);
    setSetup(setupResult);
    setEvents(eventResult.events);
    if (!configLoaded.current) {
      configLoaded.current = true;
      if (configResult.config) {
        const loadedConfig = {
          ...configResult.config,
          makerAccountId:
            configResult.config.makerAccountId ??
            setupResult.setup?.accountId ??
            null,
        };
        setConfig(loadedConfig);
        setSavedConfig(loadedConfig);
      } else {
        setSavedConfig(null);
      }
    }
  }, []);

  const loadPerformance = useCallback(async () => {
    if (performancePeriod === "EPOCH" && !rewards?.epoch.startedAt) return;
    const params = new URLSearchParams({ period: performancePeriod });
    if (performancePeriod === "EPOCH" && rewards?.epoch.startedAt) {
      params.set("since", rewards.epoch.startedAt);
    }
    if (performanceBundle !== "all") params.set("bundle", performanceBundle);
    const result = await request<{ performance: Performance | null }>(
      `api/performance?${params.toString()}`,
    );
    setPerformance(result.performance);
  }, [performancePeriod, performanceBundle, rewards?.epoch.startedAt]);

  useEffect(() => {
    if (performanceBundle === "all" || performanceBundle === "before") return;
    if (
      bundles.some(
        (bundle) =>
          bundle.id === performanceBundle && bundle.archivedAt === null,
      )
    ) {
      return;
    }
    setPerformanceBundle("all");
  }, [bundles, performanceBundle]);

  const loadRewards = useCallback(async (objective: StrategyObjective) => {
    const result = await request<{ rewards: RewardDashboard }>(
      `api/rewards?collateralCoinType=${encodeURIComponent(USDC)}&objective=${objective}`,
    );
    setRewards(result.rewards);
  }, []);

  const loadMarkets = useCallback(async () => {
    const result = await request<{ markets: Market[] }>(
      `api/markets?collateralCoinType=${encodeURIComponent(USDC)}`,
    );
    const ranked = [...result.markets].sort(
      (left, right) =>
        (right.openInterestUsd ?? 0) - (left.openInterestUsd ?? 0),
    );
    setMarkets(ranked);
    setConfig((current) =>
      current.markets.length || !ranked[0]
        ? current
        : {
            ...current,
            markets: [{ marketId: ranked[0].id, symbol: ranked[0].symbol }],
          },
    );
  }, []);

  async function selectBundle(bundleId: string) {
    const selected = bundles.find((bundle) => bundle.id === bundleId);
    if (!selected || selected.archivedAt) return;
    selectedBundleIdRef.current = bundleId;
    setSelectedBundleId(bundleId);
    if (selected.name === "Core") {
      const core = await request<{ config: MakerConfig | null }>("api/config");
      if (core.config) {
        setConfig(core.config);
        setSavedConfig(core.config);
      }
      return;
    }
    const result = await request<{ config: MakerConfig }>(
      `api/bundles/${encodeURIComponent(bundleId)}/config`,
    );
    setConfig(result.config);
    setSavedConfig(result.config);
  }

  const selectedStrategy = strategies.find(
    (strategy) => strategy.id === selectedStrategyId,
  );
  selectedStrategyIdRef.current = selectedStrategyId;
  strategyDraftRef.current = {
    name: strategyNameDraft.trim(),
    config: strategySettingsFromConfig(config),
    marketRule: strategyMarketRule,
    markets: draftMarketsForSave(config.markets),
  };

  useEffect(() => {
    if (!identity?.ownerAddress || !selectedStrategyId) return;
    const key = strategyAcknowledgementKey(
      identity.ownerAddress,
      selectedStrategyId,
    );
    setAcknowledgedStrategies((current) => {
      if (Object.hasOwn(current, key)) return current;
      return {
        ...current,
        [key]: readStrategyAcknowledgement(
          window.localStorage,
          identity.ownerAddress,
          selectedStrategyId,
        ),
      };
    });
  }, [identity?.ownerAddress, selectedStrategyId]);

  useEffect(() => {
    if (!selectedStrategy || !identity?.ownerAddress || !configLoaded.current)
      return;
    const key = strategyDraftKey(identity.ownerAddress, selectedStrategy.id);
    if (loadedStrategyDraft.current === key) return;
    loadedStrategyDraft.current = key;
    setInvalidNumeric({});
    let stored: StoredStrategyDraft | null = null;
    try {
      stored = readStrategyDraft<StoredStrategyDraft>(
        window.localStorage,
        identity.ownerAddress,
        selectedStrategy.id,
      );
    } catch {
      setNotice(
        "Browser storage is unavailable; drafts cannot be restored here.",
        "warning",
      );
    }
    setDraftBaseVersion(stored?.baseVersion ?? selectedStrategy.version);
    if (
      stored &&
      typeof stored.name === "string" &&
      Array.isArray(stored.markets) &&
      stored.settings &&
      stored.marketRule
    ) {
      setStrategyNameDraft(stored.name);
      setStrategyMarketRule(stored.marketRule);
      setConfig((current) => ({
        ...configWithStrategySettings(current, stored.settings),
        markets: stored.markets,
      }));
      if (stored.baseVersion !== selectedStrategy.version)
        setNotice(
          "Draft is based on an older strategy version. Review the conflict before applying.",
          "warning",
        );
      return;
    }
    setStrategyNameDraft(selectedStrategy.name);
    setStrategyMarketRule(selectedStrategy.marketRule);
    setConfig((current) => ({
      ...configWithStrategySettings(current, selectedStrategy.config),
      markets: selectedStrategy.markets,
    }));
  }, [selectedStrategy?.id, selectedStrategy?.version, identity?.ownerAddress]);

  async function selectStrategy(strategyId: string): Promise<boolean> {
    if (selectedStrategy?.id === strategyId) return true;
    if (selectedStrategy && configDirty && !persistStrategyDraft())
      return false;
    let result: { strategy: MakerStrategy };
    try {
      result = await request<{ strategy: MakerStrategy }>(
        `api/strategies/${encodeURIComponent(strategyId)}`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      return false;
    }
    setInvalidNumeric({});
    setServerFieldIssue(null);
    setSelectedStrategyId(result.strategy.id);
    setStrategyStep(0);
    setStrategyEditing(result.strategy.markets.length === 0);
    setDraftBaseVersion(result.strategy.version);
    setStrategyNameDraft(result.strategy.name);
    setStrategyMarketRule(result.strategy.marketRule);
    setPendingMarketSuggestion(null);
    setSuggestionPreset("balanced");
    setRewardFocus("all");
    setRewardMarketCount(5);
    setSuggestionCountError(null);
    setHedgeSuggestionOpen(false);
    setConfig((current) => ({
      ...configWithStrategySettings(current, result.strategy.config),
      markets: result.strategy.markets,
    }));
    return true;
  }

  async function createStrategy() {
    if (createStrategyInFlight.current) return;
    createStrategyInFlight.current = true;
    const names = new Set(
      strategies.map((strategy) => strategy.name.toLowerCase()),
    );
    let sequence = 1;
    while (names.has(`strategy ${sequence}`)) sequence += 1;
    const sourceName = selectedStrategy?.name ?? "your current strategy";
    let createdId: string | null = null;
    try {
      await mutate("create-strategy", async () => {
        let result: { strategy: MakerStrategy } | null = null;
        for (let attempt = 0; attempt < 64 && !result; attempt += 1) {
          try {
            result = await request<{ strategy: MakerStrategy }>(
              "api/strategies",
              {
                method: "POST",
                body: JSON.stringify({
                  name: `Strategy ${sequence}`,
                  config: strategySettingsFromConfig(config),
                  marketRule: {
                    kind: "preferred-list",
                    marketIds: config.markets.map((market) => market.marketId),
                  },
                  markets: config.markets,
                }),
              },
            );
          } catch (error) {
            if (
              !(error instanceof RequestError) ||
              error.code !== "strategy-name-taken"
            )
              throw error;
            sequence += 1;
            while (names.has(`strategy ${sequence}`)) sequence += 1;
          }
        }
        if (!result)
          throw new Error(
            "No unused strategy name was available. Rename an archived strategy before trying again.",
          );
        setStrategies((current) => [result.strategy, ...current]);
        if (!(await selectStrategy(result.strategy.id))) return;
        createdId = result.strategy.id;
        setNewStrategySource({ id: result.strategy.id, name: sourceName });
        setStrategyEditing(true);
        setStrategyStep(0);
        setNotice(
          "Strategy created. Nothing changes for your bundles until you attach it.",
          "success",
        );
      });
      if (createdId)
        window.requestAnimationFrame(() => {
          const name = document.getElementById(
            "strategy-name",
          ) as HTMLInputElement | null;
          name?.focus();
          name?.select();
        });
    } finally {
      createStrategyInFlight.current = false;
    }
  }

  function openStrategyDelete() {
    if (!selectedStrategy) return;
    if (selectedStrategy.usedBy.length) {
      setNotice(
        `Can't delete ${selectedStrategy.name}: it is used by ${selectedStrategy.usedBy.map((bundle) => bundle.name).join(", ")}. Remove it from that bundle first.`,
        "warning",
      );
      return;
    }
    setStrategyDeleteError(null);
    setPendingStrategyDelete({
      id: selectedStrategy.id,
      name: selectedStrategy.name,
    });
  }

  async function deleteStrategy() {
    const target = pendingStrategyDelete;
    if (!target || deleteInFlight.current) return;
    deleteInFlight.current = true;
    setBusy("delete-strategy");
    setStrategyDeleteError(null);
    try {
      // The attachment may have changed since the confirmation was opened.
      const latest = await request<{ strategy: MakerStrategy }>(
        `api/strategies/${encodeURIComponent(target.id)}`,
      );
      if (latest.strategy.usedBy.length) {
        throw new Error(
          `Can't delete ${target.name}: it is used by ${latest.strategy.usedBy.map((bundle) => bundle.name).join(", ")}. Remove it from that bundle first.`,
        );
      }
      await request(`api/strategies/${encodeURIComponent(target.id)}/archive`, {
        method: "POST",
        body: "{}",
      });
      setStrategies((current) =>
        current.filter((strategy) => strategy.id !== target.id),
      );
      if (selectedStrategyIdRef.current === target.id) {
        setSelectedStrategyId((current) =>
          current === target.id ? null : current,
        );
        loadedStrategyDraft.current = null;
      }
      setPendingStrategyDelete(null);
      setNotice("Strategy deleted.", "success");
      void refresh().catch((error) =>
        setNotice(
          `Strategy deleted, but refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        ),
      );
    } catch (error) {
      setStrategyDeleteError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      deleteInFlight.current = false;
      setBusy("");
    }
  }

  async function bundleAction(
    bundleId: string,
    action: "start" | "pause" | "resume" | "archive",
  ) {
    if (action !== "archive") {
      setBundlePending((current) => ({ ...current, [bundleId]: action }));
      setStartErrors((current) => ({ ...current, [bundleId]: undefined }));
    }
    let requestError: RunStartIssue | null = null;
    try {
      const completed = await mutate(
        `bundle-${action}-${bundleId}`,
        async () => {
          try {
            await request(
              `api/bundles/${encodeURIComponent(bundleId)}/${action}`,
              {
                method: "POST",
                body: "{}",
              },
            );
          } catch (error) {
            const bundleName =
              bundles.find((bundle) => bundle.id === bundleId)?.name ??
              "bundle";
            requestError =
              error instanceof RequestError
                ? {
                    message:
                      error.status >= 500
                        ? `Maker couldn't ${action} ${bundleName}. Reference ${error.requestId ?? "unavailable"} is in your control log.`
                        : error.message,
                    ...(error.code ? { code: error.code } : {}),
                    ...(error.fix ? { fix: error.fix } : {}),
                  }
                : {
                    message:
                      error instanceof Error ? error.message : String(error),
                  };
            throw error;
          }
          setNotice(
            action === "archive"
              ? "Bundle archived. Its accounts and markets are available again."
              : action === "pause"
                ? "Bundle paused. Its own orders are being cancelled."
                : action === "resume"
                  ? "Bundle resumed."
                  : "Bundle started.",
            "success",
          );
        },
      );
      if (!completed && (action === "start" || action === "resume")) {
        const issue = requestError ?? {
          message: "Maker could not start this bundle.",
        };
        setStartErrors((current) => ({ ...current, [bundleId]: issue }));
        setNotice(issue.message, "warning");
        window.setTimeout(() => {
          setStartErrors((current) => ({ ...current, [bundleId]: undefined }));
        }, 60_000);
      }
    } finally {
      if (action !== "archive") {
        setBundlePending((current) => ({ ...current, [bundleId]: undefined }));
      }
    }
  }

  async function createBundle(draft: {
    name: string;
    makerAccountId: string;
    takerAccountId: string;
    strategyId: string | null;
    confirmWalletLimits: boolean;
  }): Promise<BundleCreationResult> {
    if (bundleCreateInFlight.current) {
      return { ok: false, error: "Bundle creation is already in progress." };
    }
    if (draft.takerAccountId && draft.takerAccountId === draft.makerAccountId) {
      return {
        ok: false,
        error: "Maker and Taker accounts must be different.",
      };
    }
    bundleCreateInFlight.current = true;
    setBusy("create-bundle");
    setNotice(null);
    try {
      const result = await request<{
        bundle: MakerBundle;
        walletLimits: BundleWalletLimits | null;
      }>("api/bundles", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name,
          makerAccountId: draft.makerAccountId,
          takerAccountId: draft.takerAccountId || null,
          mode: "paper",
          strategyId: draft.strategyId,
          confirmWalletLimits: draft.confirmWalletLimits,
        }),
      });
      // The POST receipt is authoritative. A later GET/refresh failure must
      // not turn this confirmed creation into a retried second POST.
      setBundles((current) =>
        current.some((bundle) => bundle.id === result.bundle.id)
          ? current
          : [...current, result.bundle],
      );
      setWalletLimits(result.walletLimits);
      selectedBundleIdRef.current = result.bundle.id;
      setSelectedBundleId(result.bundle.id);
      let configLoadedAfterCreate = false;
      const readCreatedConfig = async () => {
        try {
          const created = await request<{ config: MakerConfig }>(
            `api/bundles/${encodeURIComponent(result.bundle.id)}/config`,
          );
          setConfig(created.config);
          setSavedConfig(created.config);
          configLoadedAfterCreate = true;
        } catch {
          // Keep the confirmed bundle ID and try again after the list refresh.
        }
      };
      await readCreatedConfig();
      let refreshed = true;
      try {
        await refresh();
      } catch {
        refreshed = false;
      }
      if (!configLoadedAfterCreate) await readCreatedConfig();
      if (!configLoadedAfterCreate || !refreshed) {
        setNotice(
          `Paper bundle ${result.bundle.name} was created, but its latest configuration could not be reloaded. Keep the bundle stopped and refresh the page; do not click Create again.`,
          "warning",
        );
      } else {
        setNotice(
          "Paper bundle created stopped. Review it before starting.",
          "success",
        );
      }
      return { ok: true, bundleId: result.bundle.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof RequestError) || error.status >= 500) {
        setNotice(
          "Bundle creation failed unexpectedly. No success receipt was returned; inspect the bundle list before retrying.",
          "error",
        );
      }
      return { ok: false, error: message };
    } finally {
      bundleCreateInFlight.current = false;
      setBusy("");
    }
  }

  async function attachStrategy(bundleId: string, strategyId: string) {
    await mutate("attach-strategy", async () => {
      const result = await request<{
        bundle: MakerBundle;
        config: MakerConfig;
      }>(`api/bundles/${encodeURIComponent(bundleId)}`, {
        method: "PATCH",
        body: JSON.stringify({ strategyId }),
      });
      setBundles((current) =>
        current.map((bundle) =>
          bundle.id === result.bundle.id ? result.bundle : bundle,
        ),
      );
      if (selectedBundleIdRef.current === result.bundle.id) {
        setConfig(result.config);
        setSavedConfig(result.config);
      }
      setNotice("Strategy attached. The bundle can now be started.", "success");
    });
  }

  async function updateBundleAllocation(
    bundleId: string,
    draft: {
      makerAccountId: string;
      takerAccountId: string;
      strategyId: string | null;
      updatedAt: string;
    },
  ) {
    await mutate("update-bundle-allocation", async () => {
      const result = await request<{
        bundle: MakerBundle;
        config: MakerConfig;
      }>(`api/bundles/${encodeURIComponent(bundleId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          makerAccountId: draft.makerAccountId,
          takerAccountId: draft.takerAccountId || null,
          strategyId: draft.strategyId,
          expectedUpdatedAt: draft.updatedAt,
        }),
      });
      setBundles((current) =>
        current.map((bundle) =>
          bundle.id === result.bundle.id ? result.bundle : bundle,
        ),
      );
      if (selectedBundleIdRef.current === result.bundle.id) {
        setConfig(result.config);
        setSavedConfig(result.config);
      }
      setNotice("Bundle allocation saved.", "success");
    });
  }

  async function updateWalletLimits(limits: {
    maxRunDrawdownUsd: number;
    maxInventoryUsd: number;
    maxGrossExposureUsd: number;
    maxUnrealizedLossUsd: number;
  }) {
    return mutate("update-wallet-limits", async () => {
      const result = await request<{ walletLimits: BundleWalletLimits }>(
        "api/bundles/wallet-limits",
        {
          method: "POST",
          body: JSON.stringify({ ...limits, confirmed: true }),
        },
      );
      setWalletLimits(result.walletLimits);
      setNotice("Wallet limits updated across your bundles.", "success");
    });
  }

  const loadAccessRequests = useCallback(async () => {
    const result = await request<{ accessRequests: AccessRequest[] }>(
      "api/operator/access-requests?limit=50",
    );
    setAccessRequests(result.accessRequests);
  }, []);

  useEffect(() => {
    let active = true;
    request<AccessIdentity>("api/auth/me")
      .then((result) => {
        if (active) {
          setIdentity(result);
          setAccessDenied(false);
        }
      })
      .catch((error) => {
        if (active && error instanceof RequestError && error.status === 403) {
          setAccessDenied(true);
          return;
        }
        if (
          active &&
          !(error instanceof RequestError && error.status === 401)
        ) {
          setNotice(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (active) setAuthChecked(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const connectedAddress = account?.address;
    if (!accessDenied || !connectedAddress) return;

    const action = deniedWalletAction(deniedAddress, connectedAddress);
    if (action === "try-new") {
      setAccessDenied(false);
      setDeniedAddress("");
      setAccessRequestVerification(null);
      setRequestSubmitted(false);
      loginAttemptedAddress.current = null;
      return;
    }

    if (action === "remember") {
      setDeniedAddress(connectedAddress);
    }
  }, [accessDenied, account?.address, deniedAddress, wallet]);

  useEffect(() => {
    const connectedAddress = account?.address;
    if (
      !shouldBeginWalletSignIn({
        authChecked,
        authenticated: Boolean(identity),
        denied: accessDenied,
        busy: Boolean(busy),
        connectedAddress: connectedAddress ?? null,
        attemptedAddress: loginAttemptedAddress.current,
      }) ||
      !connectedAddress
    ) {
      return;
    }
    loginAttemptedAddress.current = connectedAddress.toLowerCase();
    void signIn();
  }, [authChecked, identity, accessDenied, busy, account?.address]);

  useEffect(() => {
    if (!walletSessionMismatch) return;
    void logout().then(() => {
      setNotice(
        "Wallet changed. Verify the connected address before accessing Maker.",
        "warning",
      );
    });
  }, [account?.address, identity?.ownerAddress]);

  useEffect(() => {
    if (!identity || walletSessionMismatch) return;
    void refresh().catch(handlePollingFailure);
    void loadMarkets().catch(handlePollingFailure);
    void loadPerformance().catch(() => undefined);
    if (identity.operator) {
      void Promise.all([
        request<OperatorStatus>("api/operator/status").then(setOperatorStatus),
        loadAccessRequests(),
      ]).catch(handlePollingFailure);
    }
    const timer = setInterval(() => {
      void refresh().catch(handlePollingFailure);
    }, 5_000);
    const performanceTimer = setInterval(() => {
      void loadPerformance().catch(() => undefined);
    }, 30_000);
    return () => {
      clearInterval(timer);
      clearInterval(performanceTimer);
    };
  }, [
    identity,
    walletSessionMismatch,
    refresh,
    loadMarkets,
    loadPerformance,
    loadAccessRequests,
  ]);

  useEffect(() => {
    if (!identity || walletSessionMismatch) return;
    void loadRewards(config.strategyObjective).catch(handlePollingFailure);
    const rewardsTimer = setInterval(() => {
      void loadRewards(config.strategyObjective).catch(handlePollingFailure);
    }, 60_000);
    return () => clearInterval(rewardsTimer);
  }, [identity, walletSessionMismatch, config.strategyObjective, loadRewards]);

  useEffect(() => {
    if (
      !identity ||
      (account?.address &&
        account.address.toLowerCase() !== identity.ownerAddress)
    ) {
      setAccounts([]);
      setAccountsLoaded(false);
      return;
    }
    setAccountsLoaded(false);
    void request<{ accounts: AccountCap[] }>(
      `api/accounts?collateralCoinType=${encodeURIComponent(USDC)}`,
    )
      .then((result) => {
        setAccounts(result.accounts);
        setSelectedAccount((current) =>
          result.accounts.some((candidate) => candidate.accountId === current)
            ? current
            : (config.makerAccountId ??
              setup.setup?.accountId ??
              result.accounts[0]?.accountId ??
              ""),
        );
      })
      .catch((error) => setNotice(error.message))
      .finally(() => setAccountsLoaded(true));
  }, [account?.address, identity]);

  useEffect(() => {
    if (
      !identity ||
      savedConfig === undefined ||
      onboardingRouteOwner.current === identity.ownerAddress
    ) {
      return;
    }
    onboardingRouteOwner.current = identity.ownerAddress;
    const makerAccountId =
      config.makerAccountId ?? setup.setup?.accountId ?? null;
    const onboardingComplete = Boolean(
      setup.agent &&
      setup.accounts.some(
        (managed) =>
          managed.accountId === makerAccountId && Boolean(managed.agentCapId),
      ),
    );
    if (!onboardingComplete && !window.location.hash) {
      selectView("accounts");
    }
  }, [config.makerAccountId, identity, savedConfig, selectView, setup]);

  const selectedCap = useMemo(
    () => accounts.find((candidate) => candidate.accountId === selectedAccount),
    [accounts, selectedAccount],
  );

  async function signIn() {
    const connectedAddress = requestOwnerWallet("sign in");
    if (!connectedAddress) return;
    loginAttemptedAddress.current = connectedAddress.toLowerCase();
    setBusy("sign-in");
    setNotice(null);
    try {
      const challenge = await request<{
        challengeId: string;
        message: string;
      }>("api/auth/challenge", {
        method: "POST",
        body: JSON.stringify({ address: connectedAddress }),
      });
      const signed = await wallet.signPersonalMessage({
        message: new TextEncoder().encode(challenge.message),
      });
      const verification = await request<AccessRequestVerification>(
        "api/auth/verify",
        {
          method: "POST",
          body: JSON.stringify({
            challengeId: challenge.challengeId,
            address: connectedAddress,
            message: challenge.message,
            signature: signed.signature,
          }),
        },
      );
      if ("accessRequestToken" in verification) {
        setAccessRequestVerification(verification);
        setDeniedAddress(verification.ownerAddress);
        setAccessDenied(true);
        setRequestSubmitted(false);
        return;
      }
      const nextIdentity = await request<AccessIdentity>("api/auth/me");
      setIdentity(nextIdentity);
      setAccessDenied(false);
      setDeniedAddress("");
      setAccessRequestVerification(null);
      setRequestSubmitted(false);
      setNotice("Wallet verified against the Sui access registry.", "success");
    } catch (error) {
      if (error instanceof RequestError && error.status === 403) {
        setDeniedAddress(connectedAddress);
        setAccessRequestVerification(null);
        setAccessDenied(true);
        setRequestSubmitted(false);
        setNotice(null);
      } else {
        setNotice(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setBusy("");
      setAuthChecked(true);
    }
  }

  async function submitAccessRequest(input: AccessRequestInput) {
    setBusy("request-access");
    setNotice(null);
    try {
      await request("api/access-requests", {
        method: "POST",
        body: JSON.stringify(input),
      });
      setRequestSubmitted(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  async function logout(disconnectWallet = false) {
    await request("api/auth/logout", { method: "POST", body: "{}" }).catch(
      () => undefined,
    );
    if (disconnectWallet) {
      await wallet.disconnectWallet().catch(() => undefined);
    }
    configLoaded.current = false;
    setConfig(defaultConfig);
    setSavedConfig(undefined);
    setAccountsLoaded(false);
    setIdentity(null);
    setAccessDenied(false);
    setDeniedAddress("");
    setAccessRequestVerification(null);
    setRequestSubmitted(false);
    loginAttemptedAddress.current = null;
    setOperatorStatus(null);
    setAccessRequests([]);
    setSnapshot(null);
    setBundleSnapshots([]);
    setBundles([]);
    setControlUnavailable(false);
  }

  function handlePollingFailure(error: unknown) {
    if (error instanceof RequestError && error.status === 401) {
      void logout().then(() => {
        setNotice("Your session ended. Sign in again,", "warning");
      });
      return;
    }
    if (error instanceof RequestError && error.status === 503) {
      setControlUnavailable(true);
      return;
    }
    setNotice(error instanceof Error ? error.message : String(error));
  }

  async function deployWhitelist() {
    const ownerAddress = requestOwnerWallet("deploy the access registry");
    if (!ownerAddress) return;
    await mutate("deploy-whitelist", async () => {
      const manifest = (await fetch("/maker-access.json").then((response) =>
        response.json(),
      )) as { modules: string[]; dependencies: string[] };
      const tx = new Transaction();
      const upgradeCap = tx.publish({
        modules: manifest.modules,
        dependencies: manifest.dependencies,
      });
      tx.transferObjects([upgradeCap], ownerAddress);
      const result = await wallet.signAndExecuteTransaction({
        transaction: tx,
      });
      if (result.$kind === "FailedTransaction") {
        throw new Error(
          result.FailedTransaction.status.error?.message ??
            "Whitelist deployment failed",
        );
      }
      await request("api/operator/whitelist/confirm-deployment", {
        method: "POST",
        body: JSON.stringify({ digest: result.Transaction.digest }),
      });
      const [nextIdentity, nextOperatorStatus] = await Promise.all([
        request<AccessIdentity>("api/auth/me"),
        request<OperatorStatus>("api/operator/status"),
      ]);
      setIdentity(nextIdentity);
      setOperatorStatus(nextOperatorStatus);
      setNotice(
        "On-chain access registry deployed. Your wallet is member one.",
        "success",
      );
    });
  }

  async function registerBuilderCode() {
    if (!requestOwnerWallet("register the venue fee code")) return;
    await mutate("register-builder", async () => {
      const built = await request<{
        transaction: string;
        expectedIntegratorId: number;
      }>("api/operator/builder/registration-transaction", {
        method: "POST",
        body: "{}",
      });
      const result = await wallet.signAndExecuteTransaction({
        transaction: Transaction.from(built.transaction),
      });
      if (result.$kind === "FailedTransaction") {
        throw new Error(
          result.FailedTransaction.status.error?.message ??
            "Venue fee registration failed",
        );
      }
      const confirmed = await request<{ builderCode: BuilderCode }>(
        "api/operator/builder/confirm-registration",
        {
          method: "POST",
          body: JSON.stringify({
            digest: result.Transaction.digest,
            expectedIntegratorId: built.expectedIntegratorId,
          }),
        },
      );
      setBuilderCode(confirmed.builderCode);
      setOperatorStatus((current) =>
        current ? { ...current, builderCode: confirmed.builderCode } : current,
      );
      setNotice(
        `Venue fee code #${confirmed.builderCode.integratorId} registered at 1 bps.`,
        "success",
      );
    });
  }

  async function updateMember(action: "add" | "remove") {
    if (!memberAddress) return;
    if (!requestOwnerWallet(`${action} a wallet`)) return;
    await mutate(`member-${action}`, async () => {
      const built = await request<{ transaction: string }>(
        "api/operator/whitelist/transaction",
        {
          method: "POST",
          body: JSON.stringify({ action, memberAddress }),
        },
      );
      const result = await wallet.signAndExecuteTransaction({
        transaction: Transaction.from(built.transaction),
      });
      if (result.$kind === "FailedTransaction") {
        throw new Error(
          result.FailedTransaction.status.error?.message ??
            "Membership transaction failed",
        );
      }
      await request("api/operator/whitelist/confirm-member", {
        method: "POST",
        body: JSON.stringify({
          address: memberAddress,
          expected: action === "add",
        }),
      });
      await loadAccessRequests();
      setNotice(
        action === "add"
          ? "Wallet added on-chain."
          : "Wallet removed on-chain.",
        "success",
      );
      setMemberAddress("");
    });
  }

  async function mutate(
    label: string,
    action: () => Promise<void>,
    acknowledgeBeforeRefresh = false,
  ) {
    setBusy(label);
    setNotice(null);
    try {
      await action();
      if (acknowledgeBeforeRefresh) {
        try {
          await refresh();
        } catch (error) {
          setNotice(
            `Strategy applied, but refresh failed: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        }
      } else await refresh();
      return true;
    } catch (error) {
      if (!(error instanceof FieldValidationFailure))
        setNotice(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy("");
    }
  }

  function editAccountMetadata(owned: AccountCap) {
    setEditingAccountId(owned.accountId);
    setAccountMetadataDraft({
      label: owned.label ?? "",
      tags: owned.tags.join(", "),
    });
  }

  async function saveAccountMetadata(accountId: string) {
    const label = accountMetadataDraft.label.trim();
    const tags = Array.from(
      new Map(
        accountMetadataDraft.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
          .map((tag) => [tag.toLowerCase(), tag]),
      ).values(),
    );
    if (label.length > 40) {
      setNotice("Account names can be up to 40 characters.");
      return;
    }
    if (tags.length > 8 || tags.some((tag) => tag.length > 20)) {
      setNotice("Use up to eight tags, with 20 characters per tag.");
      return;
    }

    await mutate(`metadata-${accountId}`, async () => {
      const result = await request<{ metadata: AccountMetadata }>(
        `api/accounts/${accountId}/metadata`,
        {
          method: "PUT",
          body: JSON.stringify({ label: label || null, tags }),
        },
      );
      setAccounts((current) =>
        current.map((owned) =>
          owned.accountId === accountId
            ? {
                ...owned,
                label: result.metadata.label,
                tags: result.metadata.tags,
              }
            : owned,
        ),
      );
      setEditingAccountId(null);
      setNotice("Account name and tags saved.", "success");
    });
  }

  async function createVenueAccount() {
    const ownerAddress = requestOwnerWallet("create an account");
    if (!ownerAddress) return;
    await mutate("create-account", async () => {
      const built = await request<PreparedOwnerTransactionResponse>(
        "api/accounts/create-transaction",
        {
          method: "POST",
          body: JSON.stringify({ collateralCoinType: USDC }),
        },
      );
      const transaction = verifiedOwnerTransaction(built, {
        kind: "create-account",
        sender: ownerAddress,
      });
      const result = await wallet.signAndExecuteTransaction({ transaction });
      if (result.$kind === "FailedTransaction") {
        throw new Error(
          result.FailedTransaction.status.error?.message ??
            `${primaryVenue.name} account creation failed`,
        );
      }

      const existingAccountIds = new Set(
        accounts.map((owned) => owned.accountId),
      );
      let discovered: AccountCap[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const response = await request<{ accounts: AccountCap[] }>(
          `api/accounts?collateralCoinType=${encodeURIComponent(USDC)}`,
        );
        discovered = response.accounts;
        if (discovered.length > accounts.length) break;
      }
      const created = discovered.find(
        (owned) => !existingAccountIds.has(owned.accountId),
      );
      setAccounts(discovered);
      setSelectedAccount(created?.accountId ?? discovered[0]?.accountId ?? "");
      if (created) editAccountMetadata(created);
      setNotice(
        created
          ? `${primaryVenue.name} account created. Name or tag it, then add its trading key.`
          : "Account transaction confirmed; refresh account discovery shortly.",
        "success",
      );
    });
  }

  async function moveCollateral(
    accountId: string,
    direction: "deposit" | "withdraw",
  ) {
    const ownerAddress = requestOwnerWallet(direction);
    if (!ownerAddress) return;
    const amountUsdc = collateralAmounts[accountId] ?? "10";
    if (!/^(0|[1-9]\d*)(?:\.\d{1,6})?$/.test(amountUsdc)) {
      setNotice("Enter a plain USDC amount with no more than six decimals.");
      return;
    }
    if (Number(amountUsdc) <= 0) {
      setNotice("Collateral amount must be greater than zero.");
      return;
    }

    await mutate(`${direction}-${accountId}`, async () => {
      const built = await request<PreparedOwnerTransactionResponse>(
        `api/accounts/${direction}-transaction`,
        {
          method: "POST",
          body: JSON.stringify({ accountId, amountUsdc }),
        },
      );
      const amount = usdcBaseUnits(amountUsdc);
      const transaction = verifiedOwnerTransaction(built, {
        kind: direction,
        sender: ownerAddress,
        amount,
        ...(direction === "withdraw" ? { recipient: ownerAddress } : {}),
      });
      const result = await wallet.signAndExecuteTransaction({ transaction });
      if (result.$kind === "FailedTransaction") {
        throw new Error(
          result.FailedTransaction.status.error?.message ??
            `${primaryVenue.name} ${direction} failed`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const response = await request<{ accounts: AccountCap[] }>(
        `api/accounts?collateralCoinType=${encodeURIComponent(USDC)}`,
      );
      setAccounts(response.accounts);
      setNotice(
        `${amountUsdc} USDC ${direction === "deposit" ? "deposited into" : "withdrawn from"} account ${accountId}.`,
        "success",
      );
    });
  }

  async function provision(accountId = selectedAccount) {
    const ownerAddress = requestOwnerWallet("create a trading key");
    if (!ownerAddress) return;
    const accountCap = accounts.find(
      (candidate) => candidate.accountId === accountId,
    );
    if (!accountCap) return;
    await mutate(`provision-${accountId}`, async () => {
      await request("api/setup/provision", {
        method: "POST",
        body: JSON.stringify({
          ownerAddress,
          accountId: accountCap.accountId,
          accountCapId: accountCap.accountCapId,
          collateralCoinType: accountCap.collateralCoinType,
        }),
      });
      setSelectedAccount(accountId);
      setNotice(
        `Account ${accountId} added. One owner transaction remains.`,
        "success",
      );
    });
  }

  async function authorizeAgent(accountId = selectedAccount) {
    const ownerAddress = requestOwnerWallet("authorize a trading key");
    if (!ownerAddress || !accountId) return;
    await mutate(`authorize-${accountId}`, async () => {
      const built = await request<
        PreparedOwnerTransactionResponse & {
          agentAddress: string;
        }
      >("api/setup/grant-transaction", {
        method: "POST",
        body: JSON.stringify({
          accountId,
          gasMist: "100000000",
        }),
      });
      const transaction = verifiedOwnerTransaction(built, {
        kind: "grant-agent",
        sender: ownerAddress,
        agentAddress: built.agentAddress,
        gasMist: 100_000_000n,
      });
      const result = await wallet.signAndExecuteTransaction({ transaction });
      if (result.$kind === "FailedTransaction") {
        throw new Error(
          result.FailedTransaction.status.error?.message ??
            "Owner transaction failed",
        );
      }
      await request("api/setup/confirm", {
        method: "POST",
        body: JSON.stringify({
          accountId,
          digest: result.Transaction.digest,
        }),
      });
      setConfig((current) => ({
        ...current,
        makerAccountId: current.makerAccountId ?? accountId,
      }));
      setNotice(
        `Account ${accountId} authorized for trading and funded with trading key gas.`,
        "success",
      );
    });
  }

  async function revokeAgent(accountId: string) {
    const ownerAddress = requestOwnerWallet("revoke");
    if (!ownerAddress) return;
    await mutate(`revoke-${accountId}`, async () => {
      const built = await request<
        PreparedOwnerTransactionResponse & { agentCapId: string }
      >("api/setup/revoke-transaction", {
        method: "POST",
        body: JSON.stringify({ accountId }),
      });
      const transaction = verifiedOwnerTransaction(built, {
        kind: "revoke-agent",
        sender: ownerAddress,
        agentCapId: built.agentCapId,
      });
      const result = await wallet.signAndExecuteTransaction({ transaction });
      if (result.$kind === "FailedTransaction") {
        throw new Error(
          result.FailedTransaction.status.error?.message ??
            "Trading key revocation failed",
        );
      }
      await request("api/setup/revoke-confirm", {
        method: "POST",
        body: JSON.stringify({
          accountId,
          digest: result.Transaction.digest,
        }),
      });
      setNotice(
        `Account ${accountId} trading key and venue fee approval revoked.`,
        "success",
      );
    });
  }

  function toggleMarket(market: Market) {
    setServerFieldIssue((current) => (current?.step === 1 ? null : current));
    setPendingMarketSuggestion(null);
    const selected = config.markets.some((item) => item.marketId === market.id);
    const nextMarkets = selected
      ? config.markets.filter((item) => item.marketId !== market.id)
      : config.markets.length >= MAX_SELECTED_MARKETS
        ? config.markets
        : [...config.markets, { marketId: market.id, symbol: market.symbol }];
    setStrategyMarketRule({
      kind: "preferred-list",
      marketIds: nextMarkets.map((item) => item.marketId),
    });
    setConfig((current) => ({ ...current, markets: nextMarkets }));
  }

  function applyProfile(profile: MakerConfig["strategyProfile"]) {
    const values = strategyProfiles.find(
      (candidate) => candidate.value === profile,
    )!;
    setConfig((current) => ({
      ...current,
      quoteSizeUsd: values.quoteSizeUsd,
      spreadBps: values.spreadBps,
      refreshMs: values.refreshMs,
      maxInventoryUsd: values.maxInventoryUsd,
      inventorySkewBps: values.inventorySkewBps,
      strategyProfile: profile,
    }));
  }

  function setNumericValidity(fieldId: string, error: string | null) {
    setServerFieldIssue((current) =>
      current?.fieldId === fieldId ? null : current,
    );
    setInvalidNumeric((current) => {
      const next = { ...current };
      if (error) next[fieldId] = error;
      else delete next[fieldId];
      return next;
    });
  }

  function focusStrategyField(fieldId: string, step: number) {
    setStrategyStep(step);
    setAdvancedOpen(true);
    window.requestAnimationFrame(() => {
      const field = document.getElementById(fieldId) as HTMLInputElement | null;
      field?.scrollIntoView({ block: "center", behavior: "smooth" });
      field?.focus({ preventScroll: true });
    });
  }

  function chooseSuggestionPreset(preset: MarketSuggestionPreset) {
    setSuggestionPreset(preset);
    setRewardMarketCount(preset === "rewards" ? 3 : 5);
    setSuggestionInputEpoch((epoch) => epoch + 1);
    setSuggestionCountError(null);
    setPendingMarketSuggestion(null);
  }

  function acceptMarketSuggestion() {
    setServerFieldIssue((current) => (current?.step === 1 ? null : current));
    if (
      !pendingMarketSuggestion ||
      pendingMarketSuggestion.strategyId !== selectedStrategyId
    )
      return;
    const nextMarkets = selectDraftMarkets(
      pendingMarketSuggestion.ids,
      config.markets,
      markets,
    );
    setConfig((current) => ({ ...current, markets: nextMarkets }));
    const defaultCount = pendingMarketSuggestion.preset === "rewards" ? 3 : 5;
    const compatiblePreset =
      pendingMarketSuggestion.focus === "all" &&
      pendingMarketSuggestion.count === defaultCount &&
      pendingMarketSuggestion.preset !== "ranked";
    setStrategyMarketRule(
      compatiblePreset
        ? {
            kind: "quick-pick",
            pick: pendingMarketSuggestion.preset as
              "rewards" | "balanced" | "steady",
          }
        : {
            kind: "preferred-list",
            marketIds: nextMarkets.map((market) => market.marketId),
          },
    );
    setPendingMarketSuggestion(null);
  }

  function stageRewardRotation() {
    if (suggestionCountError) return;
    const ids = suggestMarketIds(
      rewards?.marketModel.opportunities ?? [],
      suggestionPreset,
      rewardFocus,
      rewardMarketCount,
    );
    if (!ids.length) return;
    setPendingMarketSuggestion({
      ids,
      preset: suggestionPreset,
      focus: rewardFocus,
      count: rewardMarketCount,
      strategyId: selectedStrategyId,
    });
  }

  function persistStrategyDraft(baseVersion?: number) {
    if (!selectedStrategy || !identity) return false;
    const invalid = Object.entries(invalidNumeric)[0];
    if (invalid) {
      focusStrategyField(
        invalid[0],
        invalid[0].startsWith("market-")
          ? 2
          : invalid[0].includes("hedge")
            ? 3
            : 2,
      );
      return false;
    }
    try {
      writeStrategyDraft(
        window.localStorage,
        identity.ownerAddress,
        selectedStrategy.id,
        {
          baseVersion:
            baseVersion ?? draftBaseVersion ?? selectedStrategy.version,
          name: strategyNameDraft,
          settings: strategySettingsFromConfig(config),
          marketRule: strategyMarketRule,
          markets: config.markets,
          savedAt: new Date().toISOString(),
        } satisfies StoredStrategyDraft,
      );
      return true;
    } catch {
      setNotice(
        "Could not save this local draft. Check browser storage; the active strategy was not changed.",
        "error",
      );
      return false;
    }
  }

  function saveAndNextStrategyStep() {
    const issue =
      strategyStep === 0 && !strategyNameDraft.trim()
        ? {
            message: "Name this strategy before continuing.",
            step: 0,
            fieldId: "strategy-name",
          }
        : strategySaveBlocker && strategySaveBlocker.step <= strategyStep
          ? strategySaveBlocker
          : null;
    if (issue) {
      if ("fieldId" in issue && issue.fieldId)
        focusStrategyField(issue.fieldId, issue.step);
      return;
    }
    if (selectedStrategy && !persistStrategyDraft()) return;
    setStrategyStep((step) => Math.min(4, step + 1));
  }

  async function saveConfig(event?: FormEvent) {
    event?.preventDefault();
    if (selectedStrategy && strategyStep !== 4) {
      setNotice(
        "Finish the wizard and apply from Review; navigation only saves a local draft.",
        "warning",
      );
      return false;
    }
    if (strategySaveBlocker) {
      setStrategyStep(strategySaveBlocker.step);
      if ("fieldId" in strategySaveBlocker && strategySaveBlocker.fieldId) {
        focusStrategyField(
          strategySaveBlocker.fieldId,
          strategySaveBlocker.step,
        );
      }
      return false;
    }
    if (selectedStrategy && applyInFlight.current) return false;
    const applyingId = selectedStrategy?.id ?? null;
    const submittedFields = strategyDraftRef.current;
    if (applyingId) applyInFlight.current = true;
    try {
      return await mutate(
        "save",
        async () => {
          if (selectedStrategy) {
            let result: {
              strategy: MakerStrategy;
              affectedBundles: MakerBundle[];
            };
            try {
              result = await request<{
                strategy: MakerStrategy;
                affectedBundles: MakerBundle[];
              }>(`api/strategies/${encodeURIComponent(selectedStrategy.id)}`, {
                method: "PATCH",
                body: JSON.stringify({
                  name: strategyNameDraft.trim(),
                  config: strategySettingsFromConfig(config),
                  marketRule: strategyMarketRule,
                  markets: draftMarketsForSave(config.markets),
                  expectedVersion: draftBaseVersion ?? selectedStrategy.version,
                }),
              });
            } catch (error) {
              if (
                error instanceof RequestError &&
                error.code === "strategy-name-taken"
              ) {
                setServerFieldIssue({
                  message: "Another strategy already uses this name.",
                  step: 0,
                  fieldId: "strategy-name",
                });
                focusStrategyField("strategy-name", 0);
                throw new FieldValidationFailure(
                  "Another strategy already uses this name.",
                );
              }
              const issue =
                error instanceof RequestError && error.status === 400
                  ? strategyIssueFromServer(error.message, config.markets)
                  : null;
              if (issue) {
                setServerFieldIssue(issue);
                if (issue.fieldId)
                  focusStrategyField(issue.fieldId, issue.step);
                else setStrategyStep(issue.step);
                throw new FieldValidationFailure(issue.message);
              }
              if (
                error instanceof RequestError &&
                error.status === 409 &&
                error.message.includes("Strategy changed elsewhere")
              ) {
                const latest = await request<{ strategy: MakerStrategy }>(
                  `api/strategies/${encodeURIComponent(selectedStrategy.id)}`,
                ).catch(() => null);
                if (latest)
                  setStrategies((current) =>
                    current.map((item) =>
                      item.id === latest.strategy.id ? latest.strategy : item,
                    ),
                  );
                throw new Error(
                  "Strategy changed elsewhere. Your draft is preserved; compare the new saved version before explicitly rebasing.",
                );
              }
              throw error;
            }
            setNewStrategySource((current) =>
              current?.id === result.strategy.id ? null : current,
            );
            const appliedFields: StrategyFields = {
              name: result.strategy.name,
              config: result.strategy.config,
              marketRule: result.strategy.marketRule,
              markets: result.strategy.markets,
            };
            const acknowledgement: StrategyAcknowledgement = {
              version: result.strategy.version,
              fields: appliedFields,
            };
            if (identity) {
              const key = strategyAcknowledgementKey(
                identity.ownerAddress,
                result.strategy.id,
              );
              setAcknowledgedStrategies((current) => ({
                ...current,
                [key]: acknowledgement,
              }));
              try {
                window.localStorage.setItem(
                  key,
                  JSON.stringify(acknowledgement),
                );
              } catch {
                /* Keep completion in this tab when storage is unavailable. */
              }
            }
            const draftStillSubmitted =
              selectedStrategyIdRef.current === applyingId &&
              submittedFields !== null &&
              configsEqual(strategyDraftRef.current, submittedFields);
            if (identity) {
              try {
                const stored = readStrategyDraft<StoredStrategyDraft>(
                  window.localStorage,
                  identity.ownerAddress,
                  result.strategy.id,
                );
                // A switch during PATCH can leave behind the now-applied draft.
                // Never clear a later edit saved to local storage instead.
                if (
                  draftStillSubmitted ||
                  (stored &&
                    submittedFields &&
                    configsEqual(submittedFields, {
                      name: stored.name.trim(),
                      config: stored.settings,
                      marketRule: stored.marketRule,
                      markets: draftMarketsForSave(stored.markets),
                    }))
                ) {
                  window.localStorage.removeItem(
                    strategyDraftKey(identity.ownerAddress, result.strategy.id),
                  );
                }
              } catch {
                /* Applied configuration is authoritative. */
              }
            }
            if (selectedStrategyIdRef.current === applyingId)
              setDraftBaseVersion(result.strategy.version);
            setStrategies((current) =>
              current.map((strategy) =>
                strategy.id === result.strategy.id ? result.strategy : strategy,
              ),
            );
            const savedStrategyConfig = {
              ...configWithStrategySettings(config, result.strategy.config),
              markets: result.strategy.markets,
            };
            if (draftStillSubmitted) setConfig(savedStrategyConfig);
            if (
              bundles.find((bundle) => bundle.id === selectedBundleId)
                ?.strategyId === result.strategy.id
            ) {
              setSavedConfig((current) =>
                current
                  ? {
                      ...configWithStrategySettings(
                        current,
                        result.strategy.config,
                      ),
                      markets: result.strategy.markets,
                    }
                  : current,
              );
            }
            if (draftStillSubmitted) {
              setStrategyNameDraft(result.strategy.name);
              setStrategyMarketRule(result.strategy.marketRule);
              setStrategyEditing(false);
            }
            setNotice(
              result.affectedBundles.length > 1
                ? `Strategy saved for ${result.affectedBundles.map((bundle) => bundle.name).join(", ")}.`
                : "Strategy saved.",
              "success",
            );
            return;
          }
          const selected = bundles.find(
            (bundle) => bundle.id === selectedBundleId,
          );
          if (selected && selected.name !== "Core") {
            await request(
              `api/bundles/${encodeURIComponent(selected.id)}/config`,
              {
                method: "POST",
                body: JSON.stringify({ config, updatedAt: selected.updatedAt }),
              },
            );
          } else {
            await request("api/config", {
              method: "POST",
              body: JSON.stringify(config),
            });
          }
          setSavedConfig(config);
          setNotice(
            runState.running.length
              ? "Strategy saved. The next market cycle will use it."
              : "Strategy saved. It will apply when the engine starts.",
            "success",
          );
        },
        Boolean(applyingId),
      );
    } finally {
      if (applyingId) applyInFlight.current = false;
    }
  }

  async function saveMarketPolicy(
    overrides: MakerMarketOverrides,
  ): Promise<void> {
    const target = policyEditorTarget;
    const original =
      target &&
      strategies.find((strategy) => strategy.id === target.strategyId);
    if (!target || !original)
      throw new Error("This strategy is no longer available.");
    const latest = await request<{ strategy: MakerStrategy }>(
      `api/strategies/${encodeURIComponent(original.id)}`,
    );
    if (latest.strategy.version !== original.version)
      throw new Error(
        "Strategy changed elsewhere. Review its saved version before editing this market.",
      );
    const markets = withMarketPolicyOverride(
      latest.strategy.markets,
      target.marketId,
      overrides,
    );
    const result = await request<{
      strategy: MakerStrategy;
      affectedBundles: MakerBundle[];
    }>(`api/strategies/${encodeURIComponent(original.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: latest.strategy.name,
        config: latest.strategy.config,
        marketRule: latest.strategy.marketRule,
        markets: draftMarketsForSave(markets),
        expectedVersion: latest.strategy.version,
      }),
    });
    setStrategies((current) =>
      current.map((strategy) =>
        strategy.id === result.strategy.id ? result.strategy : strategy,
      ),
    );
    if (selectedStrategyIdRef.current === result.strategy.id) {
      setConfig((current) => ({
        ...configWithStrategySettings(current, result.strategy.config),
        markets: result.strategy.markets,
      }));
      setDraftBaseVersion(result.strategy.version);
    }
    setPolicyEditorTarget(null);
    setNotice(
      `Saved ${target.symbol} policy to ${result.strategy.name}.`,
      "success",
    );
    void refresh().catch((error) =>
      setNotice(
        `Policy saved, but refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      ),
    );
  }

  async function saveAccountAssignments() {
    await mutate("save-accounts", async () => {
      const selected = bundles.find((bundle) => bundle.id === selectedBundleId);
      if (selected && selected.name !== "Core") {
        await request(`api/bundles/${encodeURIComponent(selected.id)}/config`, {
          method: "POST",
          body: JSON.stringify({ config, updatedAt: selected.updatedAt }),
        });
      } else {
        await request("api/config", {
          method: "POST",
          body: JSON.stringify(config),
        });
      }
      setSavedConfig(config);
      setNotice(
        runState.running.length
          ? "Account assignments saved for the next market cycle."
          : "Account assignments saved.",
        "success",
      );
    });
  }

  async function stopRuntime() {
    const targets = runState.bundles
      .filter(
        (bundle) =>
          bundle.holdsOrders ||
          bundle.phase === "starting" ||
          bundle.phase === "pausing" ||
          bundle.phase === "stopping",
      )
      .map((bundle) => bundle.id);
    const startedAt = Date.now();
    setStop({ phase: "stopping", targets, startedAt });

    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      const stoppedAtValue = new Date().toISOString();
      // A successful Stop is authoritative even if the following read poll is
      // unavailable. Keep the control honest while preserving the last data.
      setSnapshot((current) =>
        current ? { ...current, running: false, startedAt: null } : current,
      );
      setBundles((current) =>
        current.map((bundle) =>
          targets.includes(bundle.id) &&
          (bundle.status === "running" || bundle.status === "error")
            ? { ...bundle, status: "stopped" }
            : bundle,
        ),
      );
      setStoppedAt((current) =>
        Object.fromEntries(targets.map((id) => [id, stoppedAtValue])),
      );
      setStop({ phase: "idle", targets: [], startedAt: null });
      await refresh().catch((error) => {
        if (error instanceof RequestError && error.status === 503) {
          handlePollingFailure(error);
          return;
        }
        throw error;
      });
    };

    const requestStop = request("api/runtime/stop", {
      method: "POST",
      body: "{}",
    });
    let timeoutId: number | null = null;
    const outcome = await Promise.race([
      requestStop.then(
        () => ({ kind: "success" as const }),
        (error: unknown) => ({ kind: "failure" as const, error }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timeoutId = window.setTimeout(
          () => resolve({ kind: "timeout" }),
          20_000,
        );
      }),
    ]);
    if (timeoutId !== null) window.clearTimeout(timeoutId);

    if (outcome.kind === "success") {
      await finish();
      return;
    }

    const reason =
      outcome.kind === "failure"
        ? outcome.error instanceof Error
          ? outcome.error.message
          : String(outcome.error)
        : "Maker did not confirm within 20 seconds";
    setStop({ phase: "unconfirmed", targets, startedAt, error: reason });
    setNotice(
      `Stop failed or cancellation is uncertain: ${reason}. Inspect the venue and retry Stop all; do not assume positions are flat.`,
      "error",
    );
    if (outcome.kind === "timeout") {
      void requestStop.then(
        () => finish(),
        () => undefined,
      );
    }
  }

  async function runPaperTrial() {
    if (configDirty) {
      setNotice(
        "Save strategy changes before starting the Paper test run.",
        "warning",
      );
      return;
    }

    await mutate("paper-trial", async () => {
      const response = await request<{
        result: StrategyTrialResult;
        snapshot: Snapshot;
      }>("api/runtime/paper-trial", {
        method: "POST",
        body: JSON.stringify({
          cadenceMs: 2_000,
        }),
      });
      setTrialResult(response.result);
      setConfig(response.result.restoredConfig);
      setSavedConfig(response.result.restoredConfig);
      await Promise.all([
        loadPerformance().catch(() => undefined),
        loadRewards(response.result.restoredConfig.strategyObjective).catch(
          () => undefined,
        ),
      ]);
      setNotice(
        `Paper test run completed: ${response.result.rounds.length} dry-run cycles on ${response.result.symbol}.`,
        "success",
      );
    });
  }

  async function flattenPositions() {
    if (!flattenArmed) {
      setFlattenArmed(true);
      setNotice(
        "Flatten uses reduce-only market orders across every open position on both the Maker and Taker accounts, with up to 1% slippage. Review, then confirm.",
        "warning",
      );
      return;
    }
    await mutate("flatten", async () => {
      const response = await request<{
        result: {
          digest: string | null;
          digests: string[];
          flattenedMarketIds: string[];
          transactions: Array<{
            accountId: string;
            digest: string;
            flattenedMarketIds: string[];
          }>;
        };
      }>("api/runtime/flatten", {
        method: "POST",
        body: JSON.stringify({
          confirmation: "FLATTEN",
          maxSlippageBps: 100,
        }),
      });
      setFlattenArmed(false);
      await loadPerformance().catch(() => undefined);
      setNotice(
        response.result.digest
          ? `Flatten confirmed across ${response.result.transactions.length} account(s) and ${response.result.flattenedMarketIds.length} market(s): ${response.result.digests.map(compact).join(", ")}`
          : "No open positions remained on the Maker or Taker account.",
        "success",
      );
    });
  }

  async function inspectFee(event: FormEvent) {
    event.preventDefault();
    if (!setup.setup || !integratorId) return;
    await mutate("inspect", async () => {
      const result = await request<{ inspection: typeof inspection }>(
        "api/inspect/builder-fee",
        {
          method: "POST",
          body: JSON.stringify({
            accountId: setup.setup!.accountId,
            integratorId: Number(integratorId),
          }),
        },
      );
      setInspection(result.inspection);
    });
  }

  const strategyNameDirty =
    Boolean(selectedStrategy) &&
    strategyNameDraft.trim() !== selectedStrategy?.name;
  const strategyRuleDirty =
    Boolean(selectedStrategy) &&
    JSON.stringify(strategyMarketRule) !==
      JSON.stringify(selectedStrategy?.marketRule);
  const configDirty =
    (selectedStrategy
      ? !configsEqual(
          strategySettingsFromConfig(config),
          selectedStrategy.config,
        ) || !configsEqual(config.markets, selectedStrategy.markets)
      : savedConfig === undefined || !configsEqual(config, savedConfig)) ||
    strategyNameDirty ||
    strategyRuleDirty ||
    Object.keys(invalidNumeric).length > 0;

  const stale =
    controlUnavailable ||
    (lastControlResponseAt !== null &&
      Date.now() - Date.parse(lastControlResponseAt) > 15_000);
  const runState = deriveRunState({
    bundles: bundles.filter((bundle) => !bundle.archivedAt),
    snapshots: bundleSnapshots,
    pending: bundlePending,
    stop,
    startErrors,
    configDirty,
    stale,
    lastKnownStoppable: lastKnownStoppable.current,
  });
  if (!runState.stale) lastKnownStoppable.current = runState.stoppable;
  const runBundleById = new Map(
    runState.bundles.map((bundle) => [bundle.id, bundle]),
  );
  const activityStatusFor = (bundleId: string) => {
    const phase = runBundleById.get(bundleId)?.phase;
    if (phase === "running") return "running" as const;
    if (phase === "attention") return "error" as const;
    if (phase === "paused" || phase === "pausing") return "paused" as const;
    return "stopped" as const;
  };

  const strategyComplete = Boolean(
    selectedStrategy &&
    identity &&
    strategyIsComplete(
      acknowledgedStrategies[
        strategyAcknowledgementKey(identity.ownerAddress, selectedStrategy.id)
      ] ?? null,
      selectedStrategy,
      {
        name: strategyNameDraft.trim(),
        config: strategySettingsFromConfig(config),
        marketRule: strategyMarketRule,
        markets: draftMarketsForSave(config.markets),
      },
      Object.keys(invalidNumeric).length > 0 ||
        draftBaseVersion !== selectedStrategy.version,
    ),
  );

  const policyStrategy = policyEditorTarget
    ? strategies.find(
        (strategy) => strategy.id === policyEditorTarget.strategyId,
      )
    : null;
  const policyMarket = policyStrategy?.markets.find(
    (market) => market.marketId === policyEditorTarget?.marketId,
  );
  const storedPolicyDraft =
    policyStrategy && identity && typeof window !== "undefined"
      ? readStrategyDraft<StoredStrategyDraft>(
          window.localStorage,
          identity.ownerAddress,
          policyStrategy.id,
        )
      : null;
  const policyBlocked = Boolean(
    policyStrategy &&
    ((selectedStrategy?.id === policyStrategy.id && configDirty) ||
      (storedPolicyDraft &&
        (storedPolicyDraft.baseVersion !== policyStrategy.version ||
          storedPolicyDraft.name.trim() !== policyStrategy.name ||
          !configsEqual(storedPolicyDraft.settings, policyStrategy.config) ||
          !configsEqual(storedPolicyDraft.markets, policyStrategy.markets) ||
          !configsEqual(
            storedPolicyDraft.marketRule,
            policyStrategy.marketRule,
          )))),
  );

  const requestStrategyExit = (view: MakerView) => {
    if (configDirty && selectedStrategy && !persistStrategyDraft()) return;
    if (configDirty && !selectedStrategy) {
      setPendingStrategyExit(view);
      return;
    }
    selectView(view);
  };

  function openBundleEditorFromStrategy(
    kind: BundleEditorRequest["kind"],
    bundleId?: string,
  ) {
    if (!selectedStrategy) return;
    if (configDirty && !persistStrategyDraft()) return;
    setStrategyReturn({ strategyId: selectedStrategy.id, step: strategyStep });
    bundleEditorToken.current += 1;
    setBundleEditorRequest({
      token: bundleEditorToken.current,
      kind,
      strategyId: selectedStrategy.id,
      ...(bundleId ? { bundleId } : {}),
    });
    selectView("bundles");
  }

  function openAccountFromStrategy(accountId: string | null) {
    if (!selectedStrategy) return;
    if (configDirty && !persistStrategyDraft()) return;
    setStrategyReturn({ strategyId: selectedStrategy.id, step: strategyStep });
    setAccountFocusId(accountId);
    selectView("accounts");
  }

  function returnToStrategy() {
    if (strategyReturn) setStrategyStep(strategyReturn.step);
    setAccountFocusId(null);
    setStrategyReturn(null);
    selectView("strategy");
  }

  const discardStrategyChanges = useCallback(() => {
    const target = pendingStrategyExit;
    if (!target) return;
    if (selectedStrategy)
      setConfig((current) => ({
        ...configWithStrategySettings(current, selectedStrategy.config),
        markets: selectedStrategy.markets,
      }));
    else if (savedConfig) setConfig(savedConfig);
    if (selectedStrategy && identity) {
      try {
        window.localStorage.removeItem(
          strategyDraftKey(identity.ownerAddress, selectedStrategy.id),
        );
      } catch {
        /* Browser storage may be unavailable. */
      }
    }
    if (selectedStrategy) {
      setStrategyNameDraft(selectedStrategy.name);
      setStrategyMarketRule(selectedStrategy.marketRule);
    }
    setPendingStrategyExit(null);
    selectView(target);
  }, [
    pendingStrategyExit,
    savedConfig,
    identity,
    selectView,
    selectedStrategy,
  ]);

  const saveStrategyChangesThenLeave = useCallback(() => {
    const target = pendingStrategyExit;
    if (!target) return;
    if (selectedStrategy) {
      if (persistStrategyDraft()) {
        setPendingStrategyExit(null);
        selectView(target);
      }
      return;
    }
    void saveConfig().then((saved) => {
      if (!saved) return;
      setPendingStrategyExit(null);
      selectView(target);
    });
  }, [pendingStrategyExit, selectView]);

  useEffect(() => {
    if (
      !identity ||
      savedConfig === undefined ||
      savedConfig === null ||
      !configDirty
    )
      return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [configDirty, identity, savedConfig]);

  useEffect(() => {
    if (
      !identity ||
      savedConfig === undefined ||
      savedConfig === null ||
      !configDirty ||
      activeView !== "strategy"
    )
      return;
    const warnBeforeLeavingStrategy = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest<HTMLAnchorElement>('a[href^="#"]');
      const destination = link?.getAttribute("href")?.replace(/^#/, "");
      if (
        !destination ||
        destination === "strategy" ||
        !makerViews.some((view) => view.id === destination)
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (selectedStrategy) {
        if (persistStrategyDraft()) selectView(destination as MakerView);
      } else {
        setPendingStrategyExit(destination as MakerView);
      }
    };
    document.addEventListener("click", warnBeforeLeavingStrategy, true);
    return () =>
      document.removeEventListener("click", warnBeforeLeavingStrategy, true);
  }, [
    activeView,
    configDirty,
    identity,
    savedConfig,
    selectedStrategy,
    config,
    strategyNameDraft,
    strategyMarketRule,
    draftBaseVersion,
    selectView,
  ]);

  if (!authChecked) {
    return (
      <main className="loading-shell">
        <SpreadMark state="stopped" size={48} />
        <span>Checking wallet access...</span>
      </main>
    );
  }

  if (!identity || walletSessionMismatch) {
    return (
      <>
        <AccessScreen
          venue={primaryVenue}
          connected={Boolean(account?.address)}
          denied={accessDenied}
          busy={busy === "sign-in"}
          requestBusy={busy === "request-access"}
          requestSubmitted={requestSubmitted}
          accessRequestToken={
            accessRequestVerification?.accessRequestToken ?? null
          }
          verifiedAddress={accessRequestVerification?.ownerAddress ?? ""}
          notice={notice}
          onVerify={() => void signIn()}
          onRequestAccess={(input) => void submitAccessRequest(input)}
        />
        <ConnectModal ref={walletPickerRef} />
      </>
    );
  }

  // The desk is a report of the strategy the engine can actually use. Keep a
  // draft local to Strategy until its explicit save succeeds.
  const deskConfig = savedConfig ?? defaultConfig;
  const quoteSizeError =
    config.quoteSizeUsd <= 0
      ? "Size must be greater than zero."
      : config.quoteSizeUsd > config.maxInventoryUsd
        ? "Size cannot exceed the per-market inventory limit."
        : null;
  const grossExposureError =
    config.maxGrossExposureUsd < config.maxInventoryUsd
      ? "Gross exposure must cover at least one market's inventory limit."
      : null;
  const strategyValid = !quoteSizeError && !grossExposureError;
  const selectedMarketIds = new Set(
    config.markets.map((market) => market.marketId),
  );
  const activeMarket = markets.find(
    (market) => market.id === snapshot?.market.id,
  );
  const authorizedAccounts = setup.accounts.filter(
    (managed) => managed.agentCapId,
  );
  const activeMakerAccountId =
    config.makerAccountId ?? setup.setup?.accountId ?? null;
  const activeMakerAccount = setup.accounts.find(
    (managed) => managed.accountId === activeMakerAccountId,
  );
  const activeMakerCap = accounts.find(
    (candidate) => candidate.accountId === activeMakerAccountId,
  );
  const accountReference = (accountId: string) => {
    const owned = accounts.find(
      (candidate) => candidate.accountId === accountId,
    );
    return owned?.label
      ? `${owned.label} / #${accountId}`
      : `Account ${accountId}`;
  };
  const activeMakerSnapshot =
    snapshot?.accountId === activeMakerAccountId ? snapshot : null;
  const makerEquityUsd =
    activeMakerSnapshot?.balances.equityUsd ??
    activeMakerCap?.equityUsd ??
    null;
  const makerAvailableCollateralUsd =
    activeMakerSnapshot?.portfolio.availableCollateralUsd ??
    activeMakerCap?.availableCollateralUsd ??
    null;
  const agentGasSui = activeMakerSnapshot?.balances.gasSui ?? null;
  const onboardingComplete = Boolean(
    setup.agent && activeMakerAccount?.agentCapId,
  );
  const trialBlocker = Boolean(busy)
    ? "Maker is finishing another action."
    : configDirty
      ? "Save strategy changes before running the test."
      : !onboardingComplete
        ? "Finish account setup before running the test."
        : null;
  const activeHedgeAccount = setup.accounts.find(
    (managed) => managed.accountId === config.hedge.accountId,
  );
  const marketTurnMs =
    config.rotationMode === "single-slot"
      ? config.marketDwellMs
      : config.refreshMs;
  const effectiveRefreshSeconds =
    (marketTurnMs * Math.max(1, config.markets.length)) / 1_000;
  const activeRuntimeMarket = snapshot?.markets.find(
    (market) => market.id === snapshot.market.id,
  );
  const makerEquityShare = (value: number) =>
    !selectedStrategy && makerEquityUsd !== null && makerEquityUsd > 0
      ? (value / makerEquityUsd) * 100
      : null;
  const quoteEquityPct = makerEquityShare(config.quoteSizeUsd);
  const rebalanceEquityPct = makerEquityShare(config.rebalanceGrossExposureUsd);
  const quoteRiskInputs = config.markets.map((market) => ({
    inventoryUsd: 0,
    restingQuoteSizeUsd: market.overrides?.quoteSizeUsd ?? config.quoteSizeUsd,
    maxLeverage: market.overrides?.maxLeverage ?? config.maxLeverage,
  }));
  const quoteOnlyCollateralUsd =
    config.rotationMode === "portfolio"
      ? aggregatePortfolioQuoteRisk(quoteRiskInputs).requiredQuoteCollateralUsd
      : Math.max(
          0,
          ...quoteRiskInputs.map(
            (input) =>
              aggregatePortfolioQuoteRisk([input]).requiredQuoteCollateralUsd,
          ),
        );
  const hedgeSizing = hedgeSizingSuggestion({
    markets: config.markets.map((market) => ({
      quoteSizeUsd: market.overrides?.quoteSizeUsd ?? config.quoteSizeUsd,
      minimumOrderUsd:
        markets.find((listed) => listed.id === market.marketId)
          ?.minOrderUsdValue ?? null,
    })),
    bundles: (selectedStrategy?.usedBy ?? []).map((used) => {
      const bundle = bundles.find((item) => item.id === used.id);
      const maker = bundle?.makerAccountId ?? null;
      const hedge = bundle?.takerAccountId ?? null;
      return {
        name: used.name,
        makerAccountId: maker,
        hedgeAccountId: hedge,
        authorizedMaker: Boolean(
          setup.accounts.find((item) => item.accountId === maker)?.agentCapId,
        ),
        authorizedHedge: Boolean(
          setup.accounts.find((item) => item.accountId === hedge)?.agentCapId,
        ),
        hedgeAvailableUsd:
          accounts.find((item) => item.accountId === hedge)
            ?.availableCollateralUsd ?? null,
      };
    }),
  });
  const rewardOpportunities =
    rewards?.marketModel.opportunities
      .filter((opportunity) => opportunity.eligible)
      .slice(0, MAX_SELECTED_MARKETS) ?? [];
  const sortedRewardOpportunities = [...rewardOpportunities].sort(
    (left, right) => {
      if (marketSort === "score") return right.score - left.score;
      if (marketSort === "volume")
        return (right.volume24hUsd ?? 0) - (left.volume24hUsd ?? 0);
      if (marketSort === "depth")
        return right.balancedDepth50BpsUsd - left.balancedDepth50BpsUsd;
      return left.rank - right.rank;
    },
  );
  const focusedRewardOpportunities = rewardOpportunities.filter(
    (opportunity) =>
      opportunity.objectiveEligible &&
      (rewardFocus === "all" || opportunity.thinActive),
  );
  const suggestionCandidateIds = suggestMarketIds(
    rewards?.marketModel.opportunities ?? [],
    suggestionPreset,
    rewardFocus,
    64,
  );
  const strategyMarketCount = config.markets.length;
  const duplicateStrategyName = Boolean(
    selectedStrategy &&
    strategies.some(
      (strategy) =>
        strategy.id !== selectedStrategy.id &&
        strategy.name.toLowerCase() === strategyNameDraft.trim().toLowerCase(),
    ),
  );
  const firstNumericError = Object.entries(invalidNumeric)[0];
  // The same core schema protects venue/risk relationships at the review
  // boundary. Account allocation is bundle-owned, so validate with a distinct
  // synthetic pair without persisting those account IDs.
  const schemaResult = makerConfigSchema.safeParse({
    ...config,
    makerAccountId: "1",
    hedge: { ...config.hedge, accountId: "2" },
  });
  const schemaIssue = schemaResult.success
    ? null
    : (schemaResult.error.issues[0] ?? null);
  const mappedSchemaIssue = schemaIssue
    ? strategyIssueFromServer(
        JSON.stringify([
          { path: schemaIssue.path, message: schemaIssue.message },
        ]),
        config.markets,
      )
    : null;
  const schemaIssueStep = schemaIssue
    ? schemaIssue.path[0] === "markets"
      ? schemaIssue.path.length > 2
        ? 2
        : 1
      : schemaIssue.path[0] === "hedge" ||
          schemaIssue.path[0] === "autoRebalanceEnabled" ||
          schemaIssue.path[0] === "rebalanceGrossExposureUsd"
        ? 3
        : 2
    : 2;
  const incompatibleHedgeBundle = config.hedge.enabled
    ? selectedStrategy?.usedBy
        .map((used) => bundles.find((bundle) => bundle.id === used.id))
        .find(
          (bundle) =>
            !bundle?.makerAccountId ||
            !bundle.takerAccountId ||
            bundle.makerAccountId === bundle.takerAccountId ||
            !setup.accounts.some(
              (account) =>
                account.accountId === bundle.makerAccountId &&
                account.agentCapId,
            ) ||
            !setup.accounts.some(
              (account) =>
                account.accountId === bundle.takerAccountId &&
                account.agentCapId,
            ),
        )
    : null;
  const strategySaveBlocker =
    selectedStrategy && !strategyNameDraft.trim()
      ? {
          message: "Strategy name is required (1–80 characters).",
          step: 0,
          fieldId: "strategy-name",
        }
      : duplicateStrategyName
        ? {
            message: "Another strategy already uses that name.",
            step: 0,
            fieldId: "strategy-name",
          }
        : firstNumericError
          ? {
              message: firstNumericError[1],
              fieldId: firstNumericError[0],
              step: firstNumericError[0].includes("top-count")
                ? 1
                : firstNumericError[0].includes("hedge")
                  ? 3
                  : 2,
            }
          : config.hedge.enabled &&
              config.hedge.maxOrderUsd < config.hedge.thresholdUsd
            ? {
                message: "Maximum hedge order must cover the hedge trigger.",
                step: 3,
                fieldId: "strategy-hedge-max",
              }
            : config.autoRebalanceEnabled &&
                config.rebalanceGrossExposureUsd > config.maxGrossExposureUsd
              ? {
                  message: "Rebalance exposure cannot exceed the gross limit.",
                  step: 3,
                  fieldId: "strategy-gross",
                }
              : incompatibleHedgeBundle
                ? {
                    message: `${incompatibleHedgeBundle.name} needs two distinct authorized Maker/hedge accounts before this hedge can be applied. Fix the bundle allocation in Bundles.`,
                    step: 3,
                  }
                : schemaIssue
                  ? {
                      message: `${schemaIssue.path.join(".")}: ${schemaIssue.message}`,
                      step: schemaIssueStep,
                      fieldId: mappedSchemaIssue?.fieldId ?? undefined,
                    }
                  : strategyMarketCount === 0
                    ? {
                        message: "Choose at least one market before saving.",
                        step: 1,
                      }
                    : quoteSizeError
                      ? {
                          message:
                            "Fix quote size in Size and limits before saving.",
                          step: 2,
                        }
                      : grossExposureError
                        ? {
                            message:
                              "Fix gross exposure in Size and limits before saving.",
                            step: 2,
                          }
                        : null;
  const strategySteps = [
    {
      label: "Goal",
      answer:
        strategyObjectives.find(
          (objective) => objective.value === config.strategyObjective,
        )?.label ?? config.strategyObjective,
      complete: Boolean(config.strategyObjective && config.strategyProfile),
    },
    {
      label: "Markets",
      answer: `${strategyMarketCount} selected`,
      complete: strategyMarketCount > 0,
    },
    {
      label: "Size and limits",
      answer: `${money(config.quoteSizeUsd)} / ${money(config.maxInventoryUsd)}`,
      complete: !quoteSizeError && !grossExposureError,
    },
    {
      label: "Hedging",
      answer: config.hedge.enabled ? "Hedge on" : "No hedge",
      complete: true,
    },
    {
      label: "Review",
      answer: selectedStrategy?.usedBy.length
        ? `${selectedStrategy.usedBy.length} bundle${selectedStrategy.usedBy.length === 1 ? "" : "s"}`
        : "Not attached",
      complete: true,
    },
  ];
  const reviewFieldChanges = selectedStrategy
    ? Object.entries(strategySettingsFromConfig(config)).flatMap(
        ([field, value]) => {
          const saved = (selectedStrategy.config as Record<string, unknown>)[
            field
          ];
          if (configsEqual(value, saved)) return [];
          if (
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            saved &&
            typeof saved === "object" &&
            !Array.isArray(saved)
          ) {
            const before = saved as Record<string, unknown>;
            return Object.entries(value).flatMap(([part, draft]) =>
              configsEqual(draft, before[part])
                ? []
                : [{ field: part, saved: before[part], draft }],
            );
          }
          return [{ field, saved, draft: value }];
        },
      )
    : [];
  const reviewMarketChanges = selectedStrategy
    ? config.markets.flatMap((market) => {
        const saved = selectedStrategy.markets.find(
          (item) => item.marketId === market.marketId,
        );
        const before = (saved?.overrides ?? {}) as Record<string, unknown>;
        const after = (market.overrides ?? {}) as Record<string, unknown>;
        const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
        return [...fields].flatMap((field) =>
          configsEqual(before[field], after[field])
            ? []
            : [
                `${market.symbol}: ${reviewFieldName(field)} ${reviewValue(field, before[field])} → ${reviewValue(field, after[field])}.`,
              ],
        );
      })
    : [];
  const reviewCanAttach = Boolean(
    selectedStrategy && !configDirty && selectedStrategy.markets.length > 0,
  );
  const unattachedBundles = bundles.filter(
    (bundle) =>
      !bundle.archivedAt && (!bundle.strategyId || bundle.needsStrategy),
  );
  const activeBundleCount = bundles.filter(
    (bundle) => !bundle.archivedAt,
  ).length;
  const strategyReady = strategySteps.every((step) => step.complete);
  const strategySummaryMode = Boolean(
    selectedStrategy && strategyReady && !configDirty && !strategyEditing,
  );
  const strategyPickerOptions = strategies
    .filter((strategy) => !strategy.archivedAt)
    .map((strategy) => ({
      id: strategy.id,
      name: strategy.name,
      marketCount: strategy.markets.length,
      selection:
        strategy.marketRule.kind === "quick-pick"
          ? `Preset: ${strategy.marketRule.pick}`
          : "Manual selection",
      bundleCount: strategy.usedBy.length,
    }));
  const strategyReadyLabel = !strategyReady
    ? "Finish the highlighted steps"
    : configDirty
      ? "Ready"
      : selectedStrategy?.usedBy.length
        ? `Saved · used by ${selectedStrategy.usedBy.map((bundle) => bundle.name).join(", ")}`
        : "Saved · not used by a bundle";

  const uptimeQualifiedPct =
    rewards &&
    Number.isFinite(rewards.account.uptime) &&
    rewards.account.uptime >= 0 &&
    rewards.account.uptime <= 1
      ? rewards.account.uptime * 100
      : null;
  const rewardQuotePreviewCap =
    makerAvailableCollateralUsd !== null
      ? Math.max(
          1,
          makerAvailableCollateralUsd /
            (4 *
              (config.rotationMode === "single-slot" ? 1 : rewardMarketCount)),
        )
      : Number.POSITIVE_INFINITY;
  const hasAttributedFills =
    (performance?.attributed.fills ?? 0) + (performance?.hedge.fills ?? 0) > 0;
  const objectiveEvidence = [
    {
      name: "Farming",
      mark: rewards ? "✓" : "?",
      headline: "Rewards per collateral-day rise",
      evidence: rewards
        ? `${rewards.account.makerRewardsSui.toFixed(2)} SUI across ${compactUsd(rewards.account.makerVolumeUsd)} of maker flow`
        : "Awaiting reward data",
    },
    {
      name: "Profit",
      mark: hasAttributedFills
        ? (performance?.combinedNetAfterKnownCostsUsd ?? 0) >= 0
          ? "✓"
          : "–"
        : "?",
      headline: "Known result stays positive after known costs",
      evidence: hasAttributedFills
        ? `${money(performance?.combinedNetAfterKnownCostsUsd ?? null)} known result; markouts, gas, funding, and carry remain outside this line`
        : "Awaiting attributed fills",
    },
    {
      name: "Both",
      mark:
        rewards && hasAttributedFills
          ? (performance?.combinedNetAfterKnownCostsUsd ?? 0) >= 0
            ? "✓"
            : "–"
          : "?",
      headline: "Rewards and known result both clear their checks",
      evidence:
        rewards && hasAttributedFills
          ? `${rewards.account.makerRewardsSui.toFixed(2)} SUI and ${money(performance?.combinedNetAfterKnownCostsUsd ?? null)} known result`
          : "Needs both reward and attributed-fill evidence",
    },
  ];
  const performanceVolumeByMarket = (() => {
    const rows = new Map(
      (performance?.volumeByMarket ?? []).map((row) => [row.marketId, row]),
    );
    for (const fill of performance?.fills ?? []) {
      if (rows.has(fill.marketId)) continue;
      rows.set(fill.marketId, {
        marketId: fill.marketId,
        symbol: fill.symbol,
        makerNotionalUsd: Math.abs(fill.notionalUsd),
        makerFills: 1,
        takerNotionalUsd: 0,
        takerFills: 0,
        realizedPnlUsd: fill.realizedPnlUsd,
        feesUsd: fill.protocolFeesUsd + fill.estimatedBuilderFeeUsd,
      });
    }
    return [...rows.values()].sort((left, right) =>
      left.symbol.localeCompare(right.symbol),
    );
  })();
  const visibleMarkets = markets.filter((market) => {
    const query = marketQuery.trim().toLowerCase();
    return (
      !query ||
      market.symbol.toLowerCase().includes(query) ||
      market.displayName.toLowerCase().includes(query)
    );
  });
  const strategyVisibleMarkets = visibleMarkets.filter(
    (market) =>
      rewardFocus === "all" ||
      selectedMarketIds.has(market.id) ||
      rewards?.marketModel.opportunities.some(
        (opportunity) =>
          opportunity.marketId === market.id && opportunity.thinActive,
      ),
  );
  const rotationRowsFor = (strategy: MakerConfig) =>
    strategy.markets.map((selected) => {
      const runtimeMarket = snapshot?.markets.find(
        (market) => market.id === selected.marketId,
      );
      const listed = markets.find((market) => market.id === selected.marketId);
      return {
        id: selected.marketId,
        symbol: selected.symbol,
        customFieldCount: Object.keys(selected.overrides ?? {}).length,
        status: runtimeMarket?.status ?? "queued",
        indexPrice: runtimeMarket?.indexPrice ?? listed?.indexPrice ?? null,
        openInterestBase:
          runtimeMarket?.openInterestBase ?? listed?.openInterestBase ?? null,
        openInterestUsd:
          runtimeMarket?.openInterestUsd ?? listed?.openInterestUsd ?? null,
        openInterestUtilizationPct:
          runtimeMarket?.openInterestUtilizationPct ??
          listed?.openInterestUtilizationPct ??
          null,
        volume24hUsd:
          runtimeMarket?.volume24hUsd ?? listed?.volume24hUsd ?? null,
        fundingRate:
          runtimeMarket?.fundingRate === null ||
          runtimeMarket?.fundingRate === undefined
            ? (listed?.fundingRate ?? null)
            : runtimeMarket.fundingRate,
        inventoryUsd: runtimeMarket?.inventoryUsd ?? 0,
        unrealizedPnlUsd: runtimeMarket?.unrealizedPnlUsd ?? 0,
        effectiveSpreadBps:
          runtimeMarket?.effectiveSpreadBps ??
          selected.overrides?.spreadBps ??
          strategy.spreadBps,
        effectiveQuoteSizeUsd:
          runtimeMarket?.effectiveQuoteSizeUsd ??
          selected.overrides?.quoteSizeUsd ??
          strategy.quoteSizeUsd,
        lastTransactionDigest: runtimeMarket?.lastTransactionDigest ?? null,
        updatedAt: runtimeMarket?.updatedAt ?? null,
        error: runtimeMarket?.error ?? null,
      };
    });
  const bundleRotationRows = bundles
    .filter((bundle) => !bundle.archivedAt)
    .flatMap((bundle) => {
      const runBundle = runBundleById.get(bundle.id);
      const bundleSnapshot = runBundle?.snapshot ?? null;
      const activityStatus = activityStatusFor(bundle.id);
      const savedStrategy = strategies.find(
        (strategy) => strategy.id === bundle.strategyId,
      );
      return bundle.marketIds.map((marketId) => {
        const savedMarket = savedStrategy?.markets.find(
          (market) => market.marketId === marketId,
        );
        const runtimeMarket =
          runBundle?.phase === "running" || runBundle?.phase === "attention"
            ? (bundleSnapshot?.markets.find(
                (market) => market.id === marketId,
              ) ?? null)
            : null;
        const activity = marketActivity({
          mode: runBundle?.mode ?? "paper",
          status: activityStatus,
          marketId,
          marketError: runtimeMarket?.error ?? null,
          snapshot: bundleSnapshot,
          now: Date.now(),
        });
        const listed = markets.find((market) => market.id === marketId);
        return {
          id: marketId,
          symbol: runtimeMarket?.symbol ?? listed?.symbol ?? marketId,
          customFieldCount: Object.keys(savedMarket?.overrides ?? {}).length,
          bundleName: bundle.name,
          activityLabel: activity.label,
          status: (activity.active
            ? "healthy"
            : runBundle?.phase === "attention"
              ? "error"
              : "queued") as "healthy" | "error" | "queued",
          indexPrice: runtimeMarket?.indexPrice ?? listed?.indexPrice ?? null,
          openInterestBase:
            runtimeMarket?.openInterestBase ?? listed?.openInterestBase ?? null,
          openInterestUsd:
            runtimeMarket?.openInterestUsd ?? listed?.openInterestUsd ?? null,
          openInterestUtilizationPct:
            runtimeMarket?.openInterestUtilizationPct ??
            listed?.openInterestUtilizationPct ??
            null,
          volume24hUsd:
            runtimeMarket?.volume24hUsd ?? listed?.volume24hUsd ?? null,
          fundingRate:
            runtimeMarket?.fundingRate ?? listed?.fundingRate ?? null,
          inventoryUsd: runtimeMarket?.inventoryUsd ?? 0,
          unrealizedPnlUsd: runtimeMarket?.unrealizedPnlUsd ?? 0,
          effectiveSpreadBps: savedMarket
            ? (savedMarket.overrides?.spreadBps ??
              savedStrategy!.config.spreadBps)
            : null,
          effectiveQuoteSizeUsd: savedMarket
            ? (savedMarket.overrides?.quoteSizeUsd ??
              savedStrategy!.config.quoteSizeUsd)
            : null,
          lastTransactionDigest: runtimeMarket?.lastTransactionDigest ?? null,
          updatedAt: runtimeMarket?.updatedAt ?? null,
          error: runtimeMarket?.error ?? null,
        };
      });
    });
  const deskRotationRows = bundleRotationRows.length
    ? bundleRotationRows
    : rotationRowsFor(deskConfig).map((row) => ({
        ...row,
        bundleName: null,
        activityLabel: runState.running.length ? "Reading markets" : "Stopped",
      }));
  const marketTableRows = visibleMarkets
    .map((listed) => {
      const assigned = bundles
        .filter(
          (bundle) =>
            !bundle.archivedAt && bundle.marketIds.includes(listed.id),
        )
        .sort((left, right) => {
          const leftActive = runBundleById.get(left.id)?.phase === "running";
          const rightActive = runBundleById.get(right.id)?.phase === "running";
          return Number(rightActive) - Number(leftActive);
        });
      const assignedBundle = assigned[0] ?? null;
      const assignedRun = assignedBundle
        ? (runBundleById.get(assignedBundle.id) ?? null)
        : null;
      const assignedSnapshot = assignedRun?.snapshot ?? null;
      const runtimeMarket =
        assignedRun?.phase === "running" || assignedRun?.phase === "attention"
          ? (assignedSnapshot?.markets.find(
              (market) => market.id === listed.id,
            ) ?? null)
          : null;
      const savedStrategy = strategies.find(
        (strategy) => strategy.id === assignedBundle?.strategyId,
      );
      const savedMarket = savedStrategy?.markets.find(
        (market) => market.marketId === listed.id,
      );
      const bundlePolicies = assigned.flatMap((bundle) => {
        const strategy = strategies.find(
          (item) => item.id === bundle.strategyId,
        );
        const market = strategy?.markets.find(
          (item) => item.marketId === listed.id,
        );
        return strategy && market
          ? [
              {
                bundleName: bundle.name,
                strategyId: strategy.id,
                sizeUsd:
                  market.overrides?.quoteSizeUsd ??
                  strategy.config.quoteSizeUsd,
                spreadBps:
                  market.overrides?.spreadBps ?? strategy.config.spreadBps,
              },
            ]
          : [];
      });
      const activity = assignedBundle
        ? marketActivity({
            mode: assignedRun?.mode ?? "paper",
            status: activityStatusFor(assignedBundle.id),
            marketId: listed.id,
            marketError: runtimeMarket?.error ?? null,
            snapshot: assignedSnapshot,
            now: Date.now(),
          })
        : { label: "Not assigned", active: false, error: null };
      return {
        id: listed.id,
        symbol: listed.symbol,
        displayName: listed.displayName,
        tickSize: listed.tickSize,
        strategyId: savedStrategy?.id ?? null,
        bundleMode: assignedBundle?.mode ?? null,
        customFields: Object.keys(savedMarket?.overrides ?? {}),
        stateLabel: !assignedBundle
          ? "Available"
          : assignedRun?.phase === "attention" || runtimeMarket?.error
            ? "Needs attention"
            : assignedRun?.phase === "paused"
              ? "Paused"
              : assignedRun?.phase === "running" && activity.active
                ? "Quoting"
                : "Waiting for first quote",
        bundleName: assignedBundle?.name ?? "Available",
        bundleLabels: assigned.map((bundle) => {
          const phase = runBundleById.get(bundle.id)?.phase ?? "stopped";
          return `${bundle.name} · ${bundle.mode} · ${phase}`;
        }),
        bundlePolicies,
        activeBundleNames: assigned
          .filter((bundle) => runBundleById.get(bundle.id)?.phase === "running")
          .map((bundle) => `${bundle.name} · ${bundle.mode}`),
        activityLabel: activity.label,
        checkingNow: Boolean(
          (assignedRun?.phase === "running" ||
            assignedRun?.phase === "attention") &&
          assignedSnapshot?.market.id === listed.id,
        ),
        status: (activity.active
          ? "healthy"
          : assignedRun?.phase === "attention"
            ? "error"
            : "queued") as "healthy" | "error" | "queued",
        indexPrice: runtimeMarket?.indexPrice ?? listed.indexPrice,
        openInterestBase:
          runtimeMarket?.openInterestBase ?? listed.openInterestBase,
        openInterestUsd:
          runtimeMarket?.openInterestUsd ?? listed.openInterestUsd,
        openInterestUtilizationPct:
          runtimeMarket?.openInterestUtilizationPct ??
          listed.openInterestUtilizationPct,
        volume24hUsd: runtimeMarket?.volume24hUsd ?? listed.volume24hUsd,
        fundingRate: runtimeMarket?.fundingRate ?? listed.fundingRate,
        inventoryUsd: runtimeMarket?.inventoryUsd ?? 0,
        unrealizedPnlUsd: runtimeMarket?.unrealizedPnlUsd ?? 0,
        effectiveSpreadBps: savedMarket
          ? (savedMarket.overrides?.spreadBps ??
            savedStrategy!.config.spreadBps)
          : null,
        effectiveQuoteSizeUsd: savedMarket
          ? (savedMarket.overrides?.quoteSizeUsd ??
            savedStrategy!.config.quoteSizeUsd)
          : null,
        lastTransactionDigest: runtimeMarket?.lastTransactionDigest ?? null,
        updatedAt: runtimeMarket?.updatedAt ?? null,
        error:
          activity.error ??
          (activity.active ? (runtimeMarket?.error ?? null) : null),
      };
    })
    .sort((left, right) => {
      const leftInUse = left.bundleName !== "Available";
      const rightInUse = right.bundleName !== "Available";
      if (leftInUse !== rightInUse) return leftInUse ? -1 : 1;

      const valueFor = (row: typeof left): string | number => {
        switch (marketTableSort.key) {
          case "venue":
            return primaryVenue.name;
          case "updatedAt":
            return row.updatedAt ? Date.parse(row.updatedAt) : 0;
          default:
            return row[marketTableSort.key] ?? 0;
        }
      };
      const leftValue = valueFor(left);
      const rightValue = valueFor(right);
      const compared =
        typeof leftValue === "string" && typeof rightValue === "string"
          ? leftValue.localeCompare(rightValue)
          : Number(leftValue) - Number(rightValue);
      if (compared !== 0) {
        return marketTableSort.direction === "asc" ? compared : -compared;
      }
      return left.symbol.localeCompare(right.symbol);
    });
  const marketTableGroups = {
    inUse: marketTableRows.filter((row) => row.bundleName !== "Available"),
    available: marketTableRows.filter((row) => row.bundleName === "Available"),
  };
  const sortMarketTable = (key: MarketTableSortKey) =>
    setMarketTableSort((current) => ({
      key,
      direction:
        current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  const marketSortLabel = (key: MarketTableSortKey) =>
    marketTableSort.key === key
      ? marketTableSort.direction === "asc"
        ? "ascending"
        : "descending"
      : "none";
  const marketHeaders: Array<{ key: MarketTableSortKey; label: string }> = [
    { key: "symbol", label: "Market" },
    { key: "bundleName", label: "Bundle" },
    { key: "status", label: "State" },
    { key: "effectiveQuoteSizeUsd", label: "Policy" },
    { key: "indexPrice", label: "Price" },
    { key: "openInterestUsd", label: "Open interest" },
    { key: "volume24hUsd", label: "24h volume" },
    { key: "fundingRate", label: "Funding" },
    { key: "inventoryUsd", label: "Position" },
  ];

  const renderMarketRow = (row: (typeof marketTableRows)[number]) => (
    <tr key={row.id}>
      <td className="market-cell-name">
        <strong>{row.symbol}</strong>
        <small>{row.displayName}</small>
      </td>
      <td>
        {row.bundleName === "Available" ? (
          <span className="market-muted">Not in a bundle</span>
        ) : (
          <span className="market-bundle-label">
            <strong>{row.bundleName}</strong>
            <small
              className={`run-mode-tag is-${row.bundleMode === "live" ? "live" : "paper"}`}
            >
              {row.bundleMode === "live" ? "Live" : "Paper"}
            </small>
          </span>
        )}
      </td>
      <td>
        <span
          className={`market-state-label is-${row.stateLabel.toLowerCase().replaceAll(" ", "-")}`}
        >
          <i aria-hidden="true" />
          {row.stateLabel}
        </span>
      </td>
      <td>
        {!row.strategyId ? (
          <span className="market-muted">—</span>
        ) : row.customFields.length ? (
          <span
            className="market-policy-custom"
            title={row.customFields.map(reviewFieldName).join(", ")}
          >
            {row.customFields.length} custom
          </span>
        ) : (
          <span className="market-muted">Strategy</span>
        )}
      </td>
      <td className="market-number">
        {marketPrice(row.indexPrice, row.tickSize)}
      </td>
      <td className="market-number">
        <span>{compactUsd(row.openInterestUsd)}</span>
        {row.openInterestUtilizationPct !== null && (
          <span
            className="market-capacity-bar"
            role="progressbar"
            aria-label={`${row.symbol} open interest capacity`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.max(
              0,
              Math.min(100, row.openInterestUtilizationPct),
            )}
            aria-valuetext={`${percent(row.openInterestUtilizationPct, 1)} of the venue limit`}
            title={`${percent(row.openInterestUtilizationPct, 1)} of the venue limit`}
          >
            <i
              style={{
                width: `${Math.max(0, Math.min(100, row.openInterestUtilizationPct))}%`,
              }}
            />
          </span>
        )}
      </td>
      <td className="market-number">{compactUsd(row.volume24hUsd)}</td>
      <td
        className={`market-number ${row.fundingRate !== null && row.fundingRate < 0 ? "negative-number" : ""}`}
      >
        {row.fundingRate === null
          ? "—"
          : `${row.fundingRate >= 0 ? "+" : "−"}${Math.abs(row.fundingRate * 100).toFixed(4)}%`}
      </td>
      <td className="market-number">
        {row.inventoryUsd === 0 ? "—" : money(row.inventoryUsd)}
        {row.unrealizedPnlUsd !== 0 && (
          <small
            className={
              row.unrealizedPnlUsd < 0 ? "negative-number" : "positive-number"
            }
          >
            {money(row.unrealizedPnlUsd)} unrealized
          </small>
        )}
      </td>
      <td>
        {row.strategyId && (
          <button
            className="market-policy-edit"
            type="button"
            aria-label={`Edit ${row.symbol} policy`}
            onClick={() =>
              setPolicyEditorTarget({
                marketId: row.id,
                symbol: row.symbol,
                strategyId: row.strategyId!,
              })
            }
          >
            Edit
          </button>
        )}
      </td>
    </tr>
  );

  const deskLatestMarketUpdate = deskRotationRows.reduce<string | null>(
    (latest, row) => {
      if (!row.updatedAt) return latest;
      if (!latest || Date.parse(row.updatedAt) > Date.parse(latest)) {
        return row.updatedAt;
      }
      return latest;
    },
    null,
  );
  const deskRunningRun = runState.running[0] ?? null;
  const deskRunningBundle = deskRunningRun
    ? (bundles.find((bundle) => bundle.id === deskRunningRun.id) ?? null)
    : null;
  const deskRunningSnapshot = deskRunningRun?.snapshot ?? null;
  const deskReportSnapshot = deskRunningBundle ? deskRunningSnapshot : snapshot;
  const deskRunningStrategy = strategies.find(
    (strategy) => strategy.id === deskRunningBundle?.strategyId,
  );
  const deskReportConfig =
    deskRunningBundle && deskRunningStrategy
      ? {
          ...configWithStrategySettings(deskConfig, deskRunningStrategy.config),
          mode: deskRunningBundle.mode,
          makerAccountId: deskRunningBundle.makerAccountId,
          hedge: {
            ...deskRunningStrategy.config.hedge,
            accountId: deskRunningBundle.takerAccountId,
          },
          markets: deskRunningStrategy.markets,
        }
      : deskConfig;
  const deskReportMarket = markets.find(
    (market) => market.id === deskReportSnapshot?.market.id,
  );
  const deskReportRuntimeMarket = deskReportSnapshot?.markets.find(
    (market) => market.id === deskReportSnapshot.market.id,
  );
  const deskSelectedMarketIndex = deskReportConfig.markets.findIndex(
    (market) => market.marketId === deskReportSnapshot?.market.id,
  );
  const deskNextSelectedMarket =
    deskReportConfig.markets.length > 1
      ? deskReportConfig.markets[
          (Math.max(0, deskSelectedMarketIndex) + 1) %
            deskReportConfig.markets.length
        ]
      : null;
  const worstSideFillUsd =
    deskReportSnapshot?.markets
      .filter((market) => market.status === "healthy")
      .reduce((total, market) => total + market.effectiveQuoteSizeUsd, 0) ?? 0;
  const deskFills =
    performance?.fills.map((fill) => ({
      id: `${fill.txDigest}:${fill.orderId}`,
      occurredAt: fill.occurredAt,
      symbol: fill.symbol,
      side: fill.side,
      price: fill.price,
      notionalUsd: fill.notionalUsd,
      realizedPnlUsd: fill.realizedPnlUsd,
      txDigest: fill.txDigest,
      estimated: fill.estimated,
    })) ?? [];
  const deskNarration = narrate({
    name: deskRunningBundle?.name ?? "Maker",
    running: runState.running.length > 0,
    mode:
      deskRunningBundle?.mode ??
      deskReportSnapshot?.mode ??
      deskReportConfig.mode,
    market: {
      symbol:
        deskReportSnapshot?.market.symbol ?? deskReportMarket?.symbol ?? null,
      bid: deskReportSnapshot?.quote?.bidPrice ?? null,
      ask: deskReportSnapshot?.quote?.askPrice ?? null,
      tickSize: deskReportMarket?.tickSize ?? null,
    },
    inventoryUsd: deskReportSnapshot?.balances.inventoryUsd ?? null,
    maxInventoryUsd: deskReportConfig.maxInventoryUsd,
    lastFillAgeSeconds: deskFills[0]?.occurredAt
      ? Math.max(
          0,
          Math.floor(
            (Date.now() - Date.parse(deskFills[0].occurredAt)) / 1_000,
          ),
        )
      : null,
  });
  const venueAccountRows = accounts.map((owned) => {
    const assignedBundle = bundles.find(
      (bundle) =>
        !bundle.archivedAt &&
        (bundle.makerAccountId === owned.accountId ||
          bundle.takerAccountId === owned.accountId),
    );
    return {
      accountId: owned.accountId,
      label: owned.label,
      equityUsd: owned.equityUsd,
      bundle: assignedBundle?.name ?? "Not in a bundle",
      role:
        assignedBundle?.makerAccountId === owned.accountId
          ? ("Maker" as const)
          : assignedBundle?.takerAccountId === owned.accountId
            ? ("Taker" as const)
            : ("Available" as const),
    };
  });
  const venueEquityUsd = accounts.reduce(
    (total, owned) => total + owned.equityUsd,
    0,
  );
  const venueSnapshots = bundleSnapshots
    .map((entry) => entry.snapshot)
    .filter((entry): entry is Snapshot => Boolean(entry));
  const venueGrossExposureUsd = venueSnapshots.reduce(
    (total, entry) => total + Math.abs(entry.portfolio.grossExposureUsd),
    0,
  );
  const venueUnrealizedPnlUsd = venueSnapshots.reduce(
    (total, entry) => total + entry.portfolio.unrealizedPnlUsd,
    0,
  );
  const venueSelectedMarkets = bundles
    .filter((bundle) => !bundle.archivedAt)
    .reduce((total, bundle) => total + bundle.marketIds.length, 0);
  const deskEvents = events.map((event) => {
    const accountId =
      typeof event.detail.accountId === "string"
        ? event.detail.accountId
        : null;
    const namedBundle =
      typeof event.detail.name === "string" ? event.detail.name : null;
    const attributedId =
      event.bundleId ??
      (typeof event.detail.bundleId === "string"
        ? event.detail.bundleId
        : null);
    const bundleForEvent = attributedId
      ? bundles.find((bundle) => bundle.id === attributedId)
      : null;
    const bundleForAccount = accountId
      ? bundles.find(
          (bundle) =>
            !bundle.archivedAt &&
            (bundle.makerAccountId === accountId ||
              bundle.takerAccountId === accountId),
        )
      : null;
    return deskEvent(event, {
      bundleName:
        namedBundle ?? bundleForEvent?.name ?? bundleForAccount?.name ?? null,
      accountId,
    });
  });
  const venueGasText =
    agentGasSui === null
      ? "Not reported"
      : `${agentGasSui.toFixed(2)} ${primaryVenue.gasUnit}${
          snapshot?.execution.gasRunwayTransactions === null ||
          snapshot?.execution.gasRunwayTransactions === undefined
            ? ""
            : `, ${snapshot.execution.gasRunwayTransactions} transactions after reserve`
        }`;
  const liveAvailable =
    liveGates.liveTradingEnabled && liveGates.mainnetAllowed;

  const bundleCards = bundles.map((bundle) => {
    const runtime = bundleSnapshots.find(
      (candidate) => candidate.bundle.id === bundle.id,
    )?.snapshot;
    return {
      ...bundle,
      strategyName:
        strategies.find((strategy) => strategy.id === bundle.strategyId)
          ?.name ?? bundle.strategyName,
      resultUsd: runtime?.portfolio.unrealizedPnlUsd ?? null,
    };
  });
  const activeBundleLanes = runState.bundles.flatMap((bundle) => {
    if (bundle.phase === "stopped") return [];
    const source = bundles.find((candidate) => candidate.id === bundle.id);
    const listed = markets.find((market) =>
      source?.marketIds.includes(market.id),
    );
    const sourceSnapshot = bundleSnapshots.find(
      (entry) => entry.bundle.id === bundle.id,
    )?.snapshot;
    const laneSnapshot =
      sourceSnapshot ??
      ({
        mode: bundle.mode,
        market: {
          symbol: listed?.symbol ?? "Waiting for market data",
          indexPrice: listed?.indexPrice ?? null,
          bestBid: null,
          bestAsk: null,
          book: null,
        },
        quote: null,
        balances: { inventoryUsd: 0 },
        portfolio: { unrealizedPnlUsd: 0 },
      } satisfies Parameters<
        typeof BundleDeskLanes
      >[0]["lanes"][number]["snapshot"]);
    return [{ bundle, snapshot: laneSnapshot }];
  });
  const selectedBundle = bundles.find(
    (bundle) => bundle.id === selectedBundleId,
  );

  const canOperate = onboardingComplete && deskConfig.markets.length > 0;
  const displayedView = activeView;

  return (
    <MakerShell
      activeView={displayedView}
      selectView={selectView}
      run={runState}
      stoppedAt={stoppedAt}
      onBundleAction={(bundleId, action) => {
        if (action !== "pause" && configDirty) {
          setNotice(
            "Apply or discard strategy changes before starting a bundle.",
            "warning",
          );
          return;
        }
        void bundleAction(bundleId, action);
      }}
      canOperate={canOperate}
      serviceUnavailable={controlUnavailable}
      lastGoodDataAt={lastGoodDataAt}
      walletAddress={identity.ownerAddress}
      walletLabel={compact(identity.ownerAddress)}
      walletSummary={{
        enabledVenues: 1,
        runningBundles: runState.running.length,
        totalBundles: bundles.filter((bundle) => !bundle.archivedAt).length,
        authorizedAccounts: authorizedAccounts.length,
      }}
      operator={identity.operator}
      notice={notice}
      noticeTone={noticeTone}
      onDismissNotice={() => setNotice(null)}
      onLogout={() => void logout(true)}
      onStopAll={() => void stopRuntime()}
    >
      <AccountsView active={displayedView === "accounts"}>
        <header className="accounts-title">
          <div>
            <h1>Accounts</h1>
            <p>
              Create, fund, authorize, and assign the accounts Maker operates.
            </p>
          </div>
          {strategyReturn && (
            <button
              className="button secondary"
              type="button"
              onClick={returnToStrategy}
            >
              Back to Strategy
            </button>
          )}
          {onboardingComplete && (
            <button
              className="button secondary"
              onClick={() => void createVenueAccount()}
              disabled={!account?.address || Boolean(busy)}
              type="button"
            >
              <UserPlus size={16} aria-hidden="true" />
              {busy === "create-account" ? "Check wallet..." : "New account"}
            </button>
          )}
        </header>
        {!onboardingComplete && (
          <section className="onboarding">
            <div className="section-heading">
              <div>
                <h1>Authorize once. Run unattended.</h1>
              </div>
              <span className="step-count">
                {setup.agent ? "2 / 2" : account ? "1 / 2" : "0 / 2"}
              </span>
            </div>
            <div className="onboarding-grid">
              <div className={account ? "setup-step complete" : "setup-step"}>
                <span className="step-icon">
                  <WalletCards size={19} />
                </span>
                <div>
                  <strong>Owner wallet</strong>
                  <p>
                    {account
                      ? "Connected and ready for owner confirmations."
                      : `Connect the wallet that holds the ${primaryVenue.name} account capability.`}
                  </p>
                </div>
                {account && (
                  <span className="status-ok">
                    Connected · {compact(account.address)}
                  </span>
                )}
              </div>

              <div
                className={setup.agent ? "setup-step complete" : "setup-step"}
              >
                <span className="step-icon">
                  <KeyRound size={19} />
                </span>
                <div className="setup-body">
                  <strong>Trading key</strong>
                  {!account ? (
                    <p>Connect the owner wallet to continue.</p>
                  ) : !setup.agent ? (
                    <>
                      <p>
                        Use an existing USDC account or create one here without
                        leaving Maker.
                      </p>
                      <div className="inline-controls account-controls">
                        <select
                          value={selectedAccount}
                          onChange={(event) =>
                            setSelectedAccount(event.target.value)
                          }
                          disabled={!accounts.length}
                          aria-label={`${primaryVenue.name} account`}
                        >
                          {!accounts.length && (
                            <option value="">
                              {accountsLoaded
                                ? "No USDC accounts found"
                                : "Discovering USDC accounts..."}
                            </option>
                          )}
                          {accounts.map((item) => (
                            <option key={item.accountId} value={item.accountId}>
                              {accountReference(item.accountId)} /{" "}
                              {item.equityUsd.toFixed(2)} equity /{" "}
                              {item.availableCollateralUsd.toFixed(2)} available
                            </option>
                          ))}
                        </select>
                        <button
                          className="button secondary inverse"
                          onClick={() => void createVenueAccount()}
                          disabled={Boolean(busy)}
                          type="button"
                        >
                          {busy === "create-account"
                            ? "Check wallet..."
                            : "New account"}
                        </button>
                        <button
                          className="button primary"
                          onClick={() => void provision()}
                          disabled={!selectedCap || Boolean(busy)}
                          type="button"
                        >
                          {busy === `provision-${selectedAccount}`
                            ? "Creating..."
                            : "Create trading key"}
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p>
                        Grant trading-only access to account{" "}
                        {setup.setup?.accountId ?? selectedAccount} and seed 0.1{" "}
                        {primaryVenue.gasUnit} gas in one owner transaction. The
                        trading key cannot withdraw.
                        {builderCode ? (
                          <>
                            {" "}
                            Maker orders carry a disclosed{" "}
                            {(builderCode.integratorFee * 100).toFixed(2)}%
                            venue fee.
                          </>
                        ) : (
                          <> Venue fee registration must finish first.</>
                        )}
                      </p>
                      <button
                        className="button primary"
                        onClick={() =>
                          void authorizeAgent(
                            setup.setup?.accountId ?? selectedAccount,
                          )
                        }
                        disabled={!builderCode || Boolean(busy)}
                      >
                        <ShieldCheck size={16} />
                        {busy ===
                        `authorize-${setup.setup?.accountId ?? selectedAccount}`
                          ? "Waiting for wallet..."
                          : builderCode
                            ? "Authorize trading key"
                            : "Venue fee setup pending"}
                      </button>
                    </>
                  )}
                </div>
                {setup.agent?.agentCapId && (
                  <span className="status-ok">Authorized</span>
                )}
              </div>
            </div>
          </section>
        )}

        {onboardingComplete && (
          <section
            className="account-desk"
            aria-label={`${primaryVenue.name} accounts`}
          >
            <div className="section-heading compact">
              <div>
                <h2>Trading accounts</h2>
              </div>
              <span className="account-desk-status">
                {accounts.length} discovered / {authorizedAccounts.length}{" "}
                authorized
              </span>
            </div>
            <div className="account-desk-grid">
              {accounts.map((owned) => {
                const managed = setup.accounts.find(
                  (candidate) => candidate.accountId === owned.accountId,
                );
                const isMaker = activeMakerAccountId === owned.accountId;
                const isHedge = config.hedge.accountId === owned.accountId;
                return (
                  <article
                    className="account-row"
                    key={owned.accountId}
                    id={`account-${owned.accountId}`}
                    tabIndex={-1}
                  >
                    <div className="account-row-id">
                      <div className="account-row-heading">
                        <strong>
                          {owned.label ?? `Account ${owned.accountId}`}
                        </strong>
                        <button
                          className="icon-button account-metadata-toggle"
                          type="button"
                          onClick={() => editAccountMetadata(owned)}
                          aria-label={`Edit name and tags for account ${owned.accountId}`}
                          title="Edit name and tags"
                        >
                          <Tag size={14} aria-hidden="true" />
                        </button>
                      </div>
                      <div className="account-identity-line">
                        <span>
                          {isMaker ? "Maker" : isHedge ? "Taker" : "Available"}
                        </span>
                        <small>Account {owned.accountId}</small>
                      </div>
                      <div
                        className="account-tag-list"
                        aria-label={`Tags for account ${owned.accountId}`}
                      >
                        {owned.tags.length ? (
                          owned.tags.map((tag) => <em key={tag}>{tag}</em>)
                        ) : (
                          <em className="empty">No tags</em>
                        )}
                      </div>
                    </div>
                    <div>
                      <span>Equity</span>
                      <strong>{money(owned.equityUsd)}</strong>
                    </div>
                    <div>
                      <span>Free collateral</span>
                      <strong>{money(owned.availableCollateralUsd)}</strong>
                    </div>
                    <div>
                      <span>Positions</span>
                      <strong>{owned.positionCount}</strong>
                    </div>
                    <div className="account-row-actions">
                      <div className="account-collateral-actions">
                        <label>
                          <span>USDC amount</span>
                          <input
                            type="number"
                            min="0.01"
                            step="0.01"
                            inputMode="decimal"
                            value={collateralAmounts[owned.accountId] ?? "10"}
                            onChange={(event) =>
                              setCollateralAmounts((current) => ({
                                ...current,
                                [owned.accountId]: event.target.value,
                              }))
                            }
                            aria-label={`USDC amount for account ${owned.accountId}`}
                          />
                        </label>
                        <button
                          className="button secondary"
                          type="button"
                          onClick={() =>
                            void moveCollateral(owned.accountId, "deposit")
                          }
                          disabled={Boolean(busy) || Boolean(snapshot?.running)}
                          title="Deposit owner-wallet USDC into this account"
                        >
                          <ArrowDownRight size={15} aria-hidden="true" />
                          {busy === `deposit-${owned.accountId}`
                            ? "Depositing..."
                            : "Deposit"}
                        </button>
                        <button
                          className="button secondary"
                          type="button"
                          onClick={() =>
                            void moveCollateral(owned.accountId, "withdraw")
                          }
                          disabled={
                            Boolean(busy) ||
                            Boolean(snapshot?.running) ||
                            owned.availableCollateralUsd <= 0
                          }
                          title="Withdraw available collateral to the owner wallet"
                        >
                          <ArrowUpRight size={15} aria-hidden="true" />
                          {busy === `withdraw-${owned.accountId}`
                            ? "Withdrawing..."
                            : "Withdraw"}
                        </button>
                      </div>
                      <div className="account-role-actions">
                        {!managed ? (
                          <button
                            className="button secondary"
                            type="button"
                            onClick={() => void provision(owned.accountId)}
                            disabled={Boolean(busy)}
                          >
                            <KeyRound size={15} aria-hidden="true" />
                            {busy === `provision-${owned.accountId}`
                              ? "Adding..."
                              : "Add trading key"}
                          </button>
                        ) : !managed.agentCapId ? (
                          <button
                            className="button primary"
                            type="button"
                            onClick={() => void authorizeAgent(owned.accountId)}
                            disabled={!builderCode || Boolean(busy)}
                          >
                            <ShieldCheck size={15} aria-hidden="true" />
                            {busy === `authorize-${owned.accountId}`
                              ? "Authorizing..."
                              : "Authorize"}
                          </button>
                        ) : (
                          <>
                            <button
                              className={
                                isMaker ? "role-button selected" : "role-button"
                              }
                              type="button"
                              onClick={() =>
                                setConfig((current) => ({
                                  ...current,
                                  makerAccountId: owned.accountId,
                                  hedge:
                                    current.hedge.accountId === owned.accountId
                                      ? {
                                          ...current.hedge,
                                          enabled: false,
                                          accountId: null,
                                        }
                                      : current.hedge,
                                }))
                              }
                            >
                              Maker
                            </button>
                            <button
                              className={
                                isHedge ? "role-button selected" : "role-button"
                              }
                              type="button"
                              disabled={isMaker}
                              onClick={() =>
                                setConfig((current) => ({
                                  ...current,
                                  hedge: {
                                    ...current.hedge,
                                    enabled: true,
                                    accountId: owned.accountId,
                                  },
                                }))
                              }
                            >
                              Taker
                            </button>
                            <button
                              className="icon-button revoke-agent"
                              type="button"
                              onClick={() => void revokeAgent(owned.accountId)}
                              disabled={Boolean(busy)}
                              aria-label={`Revoke trading key for account ${owned.accountId}`}
                              title="Revoke trading key and venue fee approval"
                            >
                              <ShieldOff size={15} aria-hidden="true" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    {editingAccountId === owned.accountId && (
                      <form
                        className="account-metadata-editor"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void saveAccountMetadata(owned.accountId);
                        }}
                      >
                        <label>
                          <span>Name</span>
                          <input
                            autoFocus
                            value={accountMetadataDraft.label}
                            maxLength={40}
                            onChange={(event) =>
                              setAccountMetadataDraft((current) => ({
                                ...current,
                                label: event.target.value,
                              }))
                            }
                            placeholder={`Account ${owned.accountId}`}
                            aria-label={`Name for account ${owned.accountId}`}
                          />
                        </label>
                        <label>
                          <span>Tags</span>
                          <input
                            value={accountMetadataDraft.tags}
                            onChange={(event) =>
                              setAccountMetadataDraft((current) => ({
                                ...current,
                                tags: event.target.value,
                              }))
                            }
                            placeholder="farming, profit, low-risk"
                            aria-label={`Comma-separated tags for account ${owned.accountId}`}
                          />
                        </label>
                        <div className="account-metadata-actions">
                          <button
                            className="button secondary"
                            type="button"
                            onClick={() => setEditingAccountId(null)}
                            disabled={Boolean(busy)}
                          >
                            Cancel
                          </button>
                          <button
                            className="button primary"
                            type="submit"
                            disabled={Boolean(busy)}
                          >
                            {busy === `metadata-${owned.accountId}`
                              ? "Saving..."
                              : "Save details"}
                          </button>
                        </div>
                      </form>
                    )}
                  </article>
                );
              })}
            </div>
            {configDirty && (
              <div className="account-save-bar">
                <span>Account assignments have unsaved changes.</span>
                <button
                  className="button primary"
                  type="button"
                  onClick={() => void saveAccountAssignments()}
                  disabled={Boolean(busy)}
                >
                  {busy === "save-accounts" ? "Saving..." : "Save assignments"}
                </button>
              </div>
            )}
          </section>
        )}
        <section
          className="account-security"
          aria-labelledby="account-security-title"
        >
          <header>
            <h2 id="account-security-title">What Maker can do</h2>
            <p>
              Maker can trade for the accounts you authorize. It cannot withdraw
              collateral, move funds to another wallet, or grant another trading
              key. Only your connected owner wallet can move money in or out.
            </p>
          </header>
          <div className="account-security-grid">
            {setup.accounts
              .filter((managed) => managed.agentCapId)
              .map((managed) => (
                <article key={managed.accountId}>
                  <strong>Account {managed.accountId}</strong>
                  <span>Trading key: trade only · no withdrawals</span>
                  <a
                    href={primaryVenue.explorerObjectUrl(managed.agentCapId!)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View trading-key permission <ExternalLink size={13} />
                  </a>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => void revokeAgent(managed.accountId)}
                    disabled={Boolean(busy)}
                  >
                    Revoke this key
                  </button>
                </article>
              ))}
          </div>
          <footer>
            <span>
              Builder fee approved:{" "}
              {builderCode
                ? `${(builderCode.integratorFee * 10_000).toFixed(1)} bps on filled orders.`
                : "No builder fee is approved."}
            </span>
            <a
              href="https://github.com/P-U-C/aftermath-maker"
              target="_blank"
              rel="noreferrer"
            >
              Read the code <ExternalLink size={13} />
            </a>
          </footer>
        </section>
      </AccountsView>

      <DeskView
        active={displayedView === "desk"}
        venue={primaryVenue}
        run={runState}
        refreshBusy={busy === "refresh"}
        flattenBusy={busy === "flatten"}
        flattenDisabled={
          deskConfig.mode !== "live" ||
          !onboardingComplete ||
          (snapshot?.portfolio.grossExposureUsd ?? 0) <= 0 ||
          Boolean(busy)
        }
        flattenArmed={flattenArmed}
        pnlUsd={performance?.combinedNetAfterKnownCostsUsd ?? null}
        equityUsd={
          deskRunningBundle
            ? (accounts.find(
                (owned) => owned.accountId === deskRunningBundle.makerAccountId,
              )?.equityUsd ?? null)
            : makerEquityUsd
        }
        reportBundleName={deskRunningBundle?.name ?? null}
        grossExposureUsd={
          deskReportSnapshot?.portfolio.grossExposureUsd ?? null
        }
        marketCount={deskRotationRows.length}
        lastFill={deskFills[0] ?? null}
        narration={
          runState.running.length > 0 &&
          deskReportSnapshot?.mode === "paper" &&
          deskReportSnapshot.lastError
            ? `Paper · Reading markets · Simulation blocked: ${deskReportSnapshot.lastError}`
            : deskNarration
        }
        mode={
          runState.running.length
            ? runState.liveCount
              ? "live"
              : "paper"
            : deskReportConfig.mode
        }
        paper={
          deskReportSnapshot?.paper ?? {
            estimated: false,
            openOrders: 0,
            fills: 0,
            hedges: 0,
            makerInventoryUsd: 0,
            hedgeInventoryUsd: 0,
            grossExposureUsd: 0,
          }
        }
        market={{
          symbol:
            deskReportSnapshot?.market.symbol ??
            deskReportMarket?.symbol ??
            "Pick a market",
          tickSize: deskReportMarket?.tickSize ?? null,
          indexPrice: deskReportSnapshot?.market.indexPrice ?? null,
          bestBid: deskReportSnapshot?.market.bestBid ?? null,
          bestAsk: deskReportSnapshot?.market.bestAsk ?? null,
          ourBid: deskReportSnapshot?.quote?.bidPrice ?? null,
          ourAsk: deskReportSnapshot?.quote?.askPrice ?? null,
          spreadBps:
            deskReportRuntimeMarket?.effectiveSpreadBps ??
            deskReportConfig.spreadBps,
          updatedAt: deskReportSnapshot?.market.updatedAt ?? null,
          book: deskReportSnapshot?.market.book ?? null,
          subtitle:
            deskReportConfig.rotationMode === "single-slot"
              ? deskNextSelectedMarket
                ? `One live pair at a time. ${deskNextSelectedMarket.symbol} is next.`
                : "One live pair at a time."
              : "Portfolio checks all saved markets; verify resting orders on the venue.",
        }}
        risk={{
          grossExposureUsd:
            deskReportSnapshot?.portfolio.grossExposureUsd ?? null,
          grossExposureLimitUsd: deskReportConfig.maxGrossExposureUsd,
          hedgeTriggerUsd: deskReportConfig.hedge.enabled
            ? deskReportConfig.hedge.thresholdUsd
            : null,
          worstSideFillUsd,
          runDrawdownUsd: deskReportSnapshot?.risk.runDrawdownUsd ?? null,
          runDrawdownLimitUsd: deskReportConfig.maxRunDrawdownUsd,
          gasRunwayTransactions:
            deskReportSnapshot?.execution.gasRunwayTransactions ?? null,
          updatedAt:
            deskReportSnapshot?.risk.measuredAt ??
            deskReportSnapshot?.lastSuccessfulCycleAt ??
            null,
        }}
        markets={deskRotationRows}
        marketsUpdatedAt={deskLatestMarketUpdate}
        fills={deskFills}
        fillsUpdatedAt={performance?.asOf ?? null}
        events={deskEvents}
        staleAfterMs={deskReportConfig.refreshMs * 2}
        lastHedgeDigest={deskReportSnapshot?.hedge.lastDigest ?? null}
        unavailable={controlUnavailable}
        showMarketLane={activeBundleLanes.length === 0}
        bundleLanes={<BundleDeskLanes lanes={activeBundleLanes} />}
        onRefresh={() =>
          void mutate("refresh", async () => {
            await request("api/runtime/cycle", {
              method: "POST",
              body: "{}",
            });
          })
        }
        onFlatten={() => void flattenPositions()}
        onCancelFlatten={() => setFlattenArmed(false)}
      />

      <StrategyView
        active={displayedView === "strategy"}
        run={runState}
        stoppedAt={stoppedAt}
        onBundleAction={(bundleId, action) =>
          void bundleAction(bundleId, action)
        }
        onStopAll={() => void stopRuntime()}
        onManageBundles={() => selectView("bundles")}
        onOpenVenues={() => selectView("venues")}
        onClose={() => requestStrategyExit("desk")}
      >
        <section className="workspace workspace-strategy">
          {strategySummaryMode && selectedStrategy && (
            <section
              className="strategy-summary"
              aria-label="Saved strategy summary"
            >
              <header className="strategy-summary-header">
                <div>
                  <StrategyPicker
                    variant="menu"
                    strategies={strategyPickerOptions}
                    selectedId={selectedStrategyId}
                    draftName={null}
                    onSelect={selectStrategy}
                  />
                  <h1>
                    {selectedStrategy.name}{" "}
                    <span className="strategy-saved-tag">Saved</span>
                  </h1>
                  <p>
                    Used by{" "}
                    {selectedStrategy.usedBy.length
                      ? selectedStrategy.usedBy
                          .map((used) => used.name)
                          .join(", ")
                      : "no bundles"}
                    . Last saved{" "}
                    {selectedStrategy.updatedAt &&
                    !Number.isNaN(Date.parse(selectedStrategy.updatedAt))
                      ? new Intl.DateTimeFormat("en-US", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(selectedStrategy.updatedAt))
                      : "time unavailable"}
                    .
                  </p>
                </div>
                <div className="strategy-summary-actions">
                  <Button
                    variant="quiet"
                    onClick={() => void createStrategy()}
                    disabled={Boolean(busy)}
                  >
                    New strategy
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => {
                      setStrategyEditing(true);
                      setStrategyStep(0);
                    }}
                  >
                    Edit strategy
                  </Button>
                </div>
              </header>
              <section className="strategy-summary-outcome">
                <h2>What Maker will do</h2>
                <p>
                  Quote {config.markets.length} selected market
                  {config.markets.length === 1 ? "" : "s"} with{" "}
                  {money(config.quoteSizeUsd)} on each side, and stop before{" "}
                  {money(config.maxRunDrawdownUsd)} of run drawdown.
                </p>
              </section>
              <div className="strategy-summary-grid">
                <section>
                  <header>
                    <h2>Goal</h2>
                    <button
                      type="button"
                      onClick={() => {
                        setStrategyEditing(true);
                        setStrategyStep(0);
                      }}
                    >
                      Edit Goal
                    </button>
                  </header>
                  <dl>
                    <div>
                      <dt>Aim for</dt>
                      <dd>{strategySteps[0]?.answer}</dd>
                    </div>
                    <div>
                      <dt>Risk profile</dt>
                      <dd>{config.strategyProfile}</dd>
                    </div>
                  </dl>
                </section>
                <section>
                  <header>
                    <h2>Markets</h2>
                    <button
                      type="button"
                      onClick={() => {
                        setStrategyEditing(true);
                        setStrategyStep(1);
                      }}
                    >
                      Edit Markets
                    </button>
                  </header>
                  <dl>
                    <div>
                      <dt>Chosen</dt>
                      <dd>
                        {config.markets.length},{" "}
                        {strategyMarketRule.kind === "preferred-list"
                          ? "picked by hand"
                          : strategyMarketRule.pick}
                      </dd>
                    </div>
                    <div>
                      <dt>Custom settings</dt>
                      <dd>
                        {config.markets
                          .filter(
                            (market) =>
                              Object.keys(market.overrides ?? {}).length,
                          )
                          .map((market) => market.symbol)
                          .join(", ") || "None"}
                      </dd>
                    </div>
                  </dl>
                  <div className="strategy-summary-chips">
                    {config.markets.map((market) => (
                      <span
                        key={market.marketId}
                        className={
                          market.overrides &&
                          Object.keys(market.overrides).length
                            ? "is-custom"
                            : ""
                        }
                      >
                        {market.symbol}
                        {market.overrides &&
                        Object.keys(market.overrides).length
                          ? `, ${Object.keys(market.overrides).length} custom`
                          : ""}
                      </span>
                    ))}
                  </div>
                </section>
                <section>
                  <header>
                    <h2>Size and limits</h2>
                    <button
                      type="button"
                      onClick={() => {
                        setStrategyEditing(true);
                        setStrategyStep(2);
                      }}
                    >
                      Edit Size and limits
                    </button>
                  </header>
                  <dl>
                    <div>
                      <dt>Quote size per side</dt>
                      <dd>{money(config.quoteSizeUsd)}</dd>
                    </div>
                    <div>
                      <dt>Spread</dt>
                      <dd>{config.spreadBps} bps</dd>
                    </div>
                    <div>
                      <dt>Largest position in one market</dt>
                      <dd>{money(config.maxInventoryUsd)}</dd>
                    </div>
                    <div>
                      <dt>Total position</dt>
                      <dd>{money(config.maxGrossExposureUsd)}</dd>
                    </div>
                    <div>
                      <dt>Stop after drawdown</dt>
                      <dd>{money(config.maxRunDrawdownUsd)}</dd>
                    </div>
                  </dl>
                </section>
                <section>
                  <header>
                    <h2>Hedging</h2>
                    <button
                      type="button"
                      onClick={() => {
                        setStrategyEditing(true);
                        setStrategyStep(3);
                      }}
                    >
                      Edit Hedging
                    </button>
                  </header>
                  <dl>
                    <div>
                      <dt>Status</dt>
                      <dd>{config.hedge.enabled ? "On" : "Off"}</dd>
                    </div>
                    <div>
                      <dt>Where</dt>
                      <dd>
                        {config.hedge.enabled
                          ? "The hedge account chosen by each bundle"
                          : "No hedge account"}
                      </dd>
                    </div>
                  </dl>
                </section>
              </div>
              <section className="strategy-summary-bundles">
                <h2>Bundles using it</h2>
                {selectedStrategy.usedBy.length ? (
                  <ul>
                    {selectedStrategy.usedBy.map((used) => {
                      const bundle = bundles.find(
                        (item) => item.id === used.id,
                      );
                      return (
                        <li key={used.id}>
                          <strong>{used.name}</strong>
                          <span
                            className={`run-mode-tag is-${bundle?.mode === "live" ? "live" : "paper"}`}
                          >
                            {bundle?.mode === "live" ? "Live" : "Paper"}
                          </span>
                          <span className="strategy-bundle-state">
                            {bundle?.status ?? "Stopped"}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p>No bundles use this strategy yet.</p>
                )}
                <p>
                  A saved change reaches each bundle the next time it starts.
                </p>
              </section>
              <footer className="strategy-summary-footer">
                <button
                  type="button"
                  className="button secondary"
                  onClick={openStrategyDelete}
                  disabled={Boolean(busy) || selectedStrategy.usedBy.length > 0}
                >
                  Delete strategy
                </button>
                {selectedStrategy.usedBy.length > 0 && (
                  <span>Detach it from its bundles before deleting.</span>
                )}
              </footer>
            </section>
          )}
          <form
            hidden={strategySummaryMode}
            className="settings-panel"
            data-strategy-step={strategyStep}
            onSubmit={saveConfig}
          >
            <div className="strategy-select-row">
              <StrategyPicker
                strategies={strategyPickerOptions}
                variant="menu"
                selectedId={selectedStrategyId}
                draftName={
                  selectedStrategy && strategyNameDirty
                    ? strategyNameDraft
                    : null
                }
                onSelect={selectStrategy}
              />
              <button
                className="strategy-new-button"
                type="button"
                onClick={() => void createStrategy()}
                disabled={Boolean(busy)}
              >
                New strategy
              </button>
            </div>

            <p className="strategy-intro">
              Reusable settings for how bundles quote, control inventory, hedge,
              and manage risk.
              {selectedStrategy?.usedBy.length
                ? ` Used by ${selectedStrategy.usedBy.map((bundle) => bundle.name).join(", ")}.`
                : " Not attached to a bundle yet."}
            </p>
            <header className="strategy-title">
              <div className="strategy-name-column">
                {newStrategySource?.id === selectedStrategyId && (
                  <span className="strategy-new-label">New strategy</span>
                )}
                <div className="strategy-name-edit">
                  <label className="strategy-name-input">
                    <span className="sr-only">Strategy name</span>
                    <input
                      id="strategy-name"
                      value={strategyNameDraft}
                      onChange={(event) => {
                        setStrategyNameDraft(event.target.value);
                        setServerFieldIssue((current) =>
                          current?.fieldId === "strategy-name" ? null : current,
                        );
                      }}
                      maxLength={80}
                      placeholder="Name this strategy"
                      aria-label="Strategy name"
                      aria-invalid={Boolean(
                        selectedStrategy &&
                        (!strategyNameDraft.trim() ||
                          duplicateStrategyName ||
                          serverFieldIssue?.fieldId === "strategy-name"),
                      )}
                      aria-describedby={
                        selectedStrategy &&
                        (!strategyNameDraft.trim() ||
                          duplicateStrategyName ||
                          serverFieldIssue?.fieldId === "strategy-name")
                          ? "strategy-name-error"
                          : undefined
                      }
                      disabled={!selectedStrategy || Boolean(busy)}
                    />
                  </label>
                </div>
                {selectedStrategy &&
                  (!strategyNameDraft.trim() ||
                    duplicateStrategyName ||
                    serverFieldIssue?.fieldId === "strategy-name") && (
                    <small
                      id="strategy-name-error"
                      className="field-error"
                      role="alert"
                    >
                      {duplicateStrategyName
                        ? "Another strategy already uses this name."
                        : serverFieldIssue?.fieldId === "strategy-name"
                          ? serverFieldIssue.message
                          : "Name this strategy before continuing."}
                    </small>
                  )}
                {newStrategySource?.id === selectedStrategyId && (
                  <p className="strategy-new-context">
                    Starts from {newStrategySource.name}&apos;s settings.
                    Nothing changes for your bundles until you attach it.
                  </p>
                )}
              </div>
              {newStrategySource?.id === selectedStrategyId && (
                <button
                  className="button secondary strategy-delete-button"
                  type="button"
                  onClick={openStrategyDelete}
                  disabled={Boolean(busy)}
                >
                  Discard
                </button>
              )}
            </header>

            {selectedStrategy && (
              <p className="strategy-section-copy strategy-step strategy-step-markets">
                Saved market membership is fixed until you accept a suggestion
                or change the selection below. A ranking refresh never changes
                this strategy or its attached bundles.
              </p>
            )}

            <section className="strategy-builder" aria-label="Strategy builder">
              <ol>
                {strategySteps.map(({ label }, index) => (
                  <li key={label}>
                    <div
                      className={
                        strategyStep === index
                          ? "step-progress is-active"
                          : "step-progress"
                      }
                      aria-current={strategyStep === index ? "step" : undefined}
                    >
                      <span>{index + 1}</span>
                      <strong>{label}</strong>
                    </div>
                  </li>
                ))}
              </ol>
              <aside>
                <span>What Maker will do</span>
                <strong className="strategy-ready-state">
                  {strategyReadyLabel}
                </strong>
                <p>
                  {strategyMarketCount
                    ? `Quote ${strategyMarketCount} selected market${strategyMarketCount === 1 ? "" : "s"} with ${money(config.quoteSizeUsd)} on each side, and stop before ${money(config.maxRunDrawdownUsd)} of run drawdown.`
                    : "Choose one or more markets before saving this strategy."}
                </p>
                {strategyStep === 4 && selectedStrategy && (
                  <div className="strategy-review-changes" role="status">
                    <p>
                      {strategyComplete ? "Applied as" : "Apply once to"}{" "}
                      {selectedStrategy.name} (version{" "}
                      {draftBaseVersion ?? selectedStrategy.version}); affects{" "}
                      {selectedStrategy.usedBy.length
                        ? selectedStrategy.usedBy
                            .map((used) => used.name)
                            .join(", ")
                        : "no attached bundles"}
                      .
                    </p>
                    {draftBaseVersion !== null &&
                      draftBaseVersion !== selectedStrategy.version && (
                        <div className="field-error">
                          <p>
                            The saved version changed elsewhere. Compare the
                            fields below before accepting a new base version;
                            your draft is unchanged.
                          </p>
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() => {
                              if (
                                persistStrategyDraft(selectedStrategy.version)
                              ) {
                                setDraftBaseVersion(selectedStrategy.version);
                                setNotice(
                                  "Draft rebased on the latest saved strategy. Recheck every changed field before Apply.",
                                  "warning",
                                );
                              }
                            }}
                          >
                            Rebase draft after review
                          </button>
                        </div>
                      )}
                    <ul>
                      {strategyNameDirty && (
                        <li>
                          Name: {selectedStrategy.name} → {strategyNameDraft}
                        </li>
                      )}
                      {!configsEqual(
                        config.markets.map((market) => market.marketId),
                        selectedStrategy.markets.map(
                          (market) => market.marketId,
                        ),
                      ) && (
                        <li>
                          Markets:{" "}
                          {selectedStrategy.markets
                            .map((market) => market.symbol)
                            .join(", ")}{" "}
                          →{" "}
                          {config.markets
                            .map((market) => market.symbol)
                            .join(", ")}
                        </li>
                      )}
                      {reviewFieldChanges.map(({ field, saved, draft }) => (
                        <li key={field}>
                          {reviewFieldName(field)}: {reviewValue(field, saved)}{" "}
                          → {reviewValue(field, draft)}.
                        </li>
                      ))}
                      {reviewMarketChanges.map((change) => (
                        <li key={change}>{change}</li>
                      ))}
                      {!configDirty && <li>No active strategy changes.</li>}
                    </ul>
                  </div>
                )}
                <div className="strategy-step-nav">
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() =>
                      setStrategyStep((step) => Math.max(0, step - 1))
                    }
                    disabled={strategyStep === 0}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => {
                      if (strategyStep === 4) {
                        if (strategyComplete) setStrategyEditing(false);
                        else void saveConfig();
                      } else saveAndNextStrategyStep();
                    }}
                    disabled={busy === "save"}
                  >
                    {strategyStep === 4
                      ? busy === "save"
                        ? "Saving…"
                        : "Save and finish"
                      : `Save and continue to ${strategySteps[strategyStep + 1]?.label ?? "Review"}`}
                  </button>
                </div>
                {strategySaveBlocker &&
                  strategySaveBlocker.step <= strategyStep && (
                    <p className="strategy-save-reason" role="status">
                      {"fieldId" in strategySaveBlocker &&
                      strategySaveBlocker.fieldId
                        ? `Fix the highlighted field in ${strategySteps[strategySaveBlocker.step]?.label ?? "Strategy"}.`
                        : strategySaveBlocker.message}{" "}
                      <button
                        type="button"
                        onClick={() =>
                          "fieldId" in strategySaveBlocker &&
                          strategySaveBlocker.fieldId
                            ? focusStrategyField(
                                strategySaveBlocker.fieldId,
                                strategySaveBlocker.step,
                              )
                            : setStrategyStep(strategySaveBlocker.step)
                        }
                      >
                        Go to that step
                      </button>
                    </p>
                  )}
                {serverFieldIssue && serverFieldIssue.step <= strategyStep && (
                  <p className="strategy-save-reason field-error" role="alert">
                    {serverFieldIssue.message}{" "}
                    <button
                      type="button"
                      onClick={() =>
                        serverFieldIssue.fieldId
                          ? focusStrategyField(
                              serverFieldIssue.fieldId,
                              serverFieldIssue.step,
                            )
                          : setStrategyStep(serverFieldIssue.step)
                      }
                    >
                      Go to field
                    </button>
                  </p>
                )}
              </aside>
            </section>

            <section className="strategy-review-step strategy-step strategy-step-review">
              <h2>Review</h2>
              <p className="strategy-section-copy">
                A strategy is reusable policy. Each bundle chooses its own Paper
                or Live mode, accounts and lifecycle.
              </p>
              {selectedStrategy && (
                <div
                  className="strategy-bundle-modes"
                  aria-label="Bundle attachment"
                >
                  {selectedStrategy.usedBy.length ? (
                    selectedStrategy.usedBy.map((usage) => {
                      const bundle = bundles.find(
                        (item) => item.id === usage.id,
                      );
                      return (
                        <div key={usage.id}>
                          <strong>{usage.name}</strong>
                          <span>
                            {bundle?.mode === "live" ? "Live" : "Paper"} ·{" "}
                            {bundle?.status ?? "status unknown"}
                          </span>
                          <button
                            className="button secondary"
                            type="button"
                            onClick={() =>
                              openBundleEditorFromStrategy("edit", usage.id)
                            }
                          >
                            Edit {usage.name} bundle
                          </button>
                        </div>
                      );
                    })
                  ) : (
                    <p>This strategy is not attached to a bundle yet.</p>
                  )}
                  {!reviewCanAttach && (
                    <p className="strategy-save-reason" role="status">
                      {selectedStrategy.markets.length === 0
                        ? "Apply at least one market in this strategy before attaching or creating a bundle."
                        : "Apply or discard the Strategy draft before using it in a bundle. Save and next does not change the applied strategy."}
                    </p>
                  )}
                  {unattachedBundles.length > 0 && (
                    <button
                      className="button secondary"
                      type="button"
                      disabled={!reviewCanAttach}
                      onClick={() =>
                        openBundleEditorFromStrategy(
                          "edit",
                          unattachedBundles[0]!.id,
                        )
                      }
                    >
                      Attach to {unattachedBundles[0]!.name}
                    </button>
                  )}
                  <button
                    className="button secondary"
                    type="button"
                    disabled={!reviewCanAttach || activeBundleCount >= 4}
                    onClick={() => openBundleEditorFromStrategy("create")}
                  >
                    {selectedStrategy.usedBy.length || unattachedBundles.length
                      ? "Create another Paper bundle"
                      : "Create bundle"}
                  </button>
                  {activeBundleCount >= 4 && (
                    <small>
                      Archive or edit an existing bundle before creating
                      another.
                    </small>
                  )}
                </div>
              )}
              <fieldset
                className={
                  selectedStrategy
                    ? "strategy-mode-fieldset strategy-allocation-owned"
                    : "strategy-mode-fieldset"
                }
              >
                <legend>Mode</legend>
                <div className="segments">
                  {(["paper", "live"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={config.mode === mode ? "selected" : ""}
                      aria-pressed={config.mode === mode}
                      disabled={mode === "live" && !liveAvailable}
                      title={
                        mode === "live" && !liveAvailable
                          ? "Live trading is off on this server"
                          : undefined
                      }
                      onClick={() => {
                        if (mode === "live") {
                          setLiveSheetOpen(true);
                        } else {
                          setConfig((current) => ({ ...current, mode }));
                        }
                      }}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
                {!liveAvailable && (
                  <small>Live trading is off on this server</small>
                )}
                <button
                  className="strategy-live-review"
                  type="button"
                  onClick={() => setLiveSheetOpen(true)}
                >
                  Review live setup
                </button>
              </fieldset>
              <dl className="strategy-review-summary">
                <div>
                  <dt>Goal</dt>
                  <dd>
                    {`${config.strategyObjective[0]?.toUpperCase()}${config.strategyObjective.slice(1)}`}
                  </dd>
                </div>
                <div>
                  <dt>Markets</dt>
                  <dd>{config.markets.length} selected</dd>
                </div>
                <div>
                  <dt>Size</dt>
                  <dd>{money(config.quoteSizeUsd)} per side</dd>
                </div>
                <div>
                  <dt>Limits</dt>
                  <dd>{money(config.maxRunDrawdownUsd)} drawdown</dd>
                </div>
              </dl>
            </section>

            <fieldset className="objective-control strategy-step strategy-step-goal">
              <legend>Objective</legend>
              <div
                className="objective-segments"
                role="group"
                aria-label="Strategy objective"
              >
                {strategyObjectives.map((objective) => {
                  const ObjectiveIcon = objective.icon;
                  return (
                    <button
                      key={objective.value}
                      type="button"
                      className={
                        config.strategyObjective === objective.value
                          ? "selected"
                          : ""
                      }
                      aria-pressed={
                        config.strategyObjective === objective.value
                      }
                      onClick={() => {
                        setPendingMarketSuggestion(null);
                        setConfig((current) => ({
                          ...current,
                          strategyObjective: objective.value,
                        }));
                      }}
                    >
                      <ObjectiveIcon size={15} aria-hidden="true" />
                      <span>
                        <strong>{objective.label}</strong>
                        <small>{objective.measure}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <div
              className="strategy-trial strategy-step strategy-step-review"
              aria-label="Three-cycle strategy trial"
            >
              <div className="strategy-trial-heading">
                <span>Paper test run: 3 cycles</span>
                <strong>Farming / profit / both · estimated</strong>
              </div>
              <div className="strategy-trial-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void runPaperTrial()}
                  disabled={Boolean(trialBlocker)}
                >
                  <TimerReset size={16} aria-hidden="true" />
                  {busy === "paper-trial"
                    ? "Running..."
                    : "Paper test run: 3 cycles"}
                </button>
              </div>
              {trialBlocker && (
                <p className="trial-blocker" role="status">
                  {trialBlocker}{" "}
                  {configDirty && !selectedStrategy ? (
                    <button
                      type="button"
                      onClick={() => void saveConfig()}
                      disabled={!strategyValid || busy === "save"}
                    >
                      Save
                    </button>
                  ) : !onboardingComplete ? (
                    <button
                      type="button"
                      onClick={() => selectView("accounts")}
                    >
                      Finish setup
                    </button>
                  ) : null}
                </p>
              )}
              {trialResult && (
                <div className="strategy-trial-results">
                  {trialResult.rounds.map((round, index) => (
                    <div key={`${trialResult.completedAt}-${round.objective}`}>
                      <span>{index + 1}</span>
                      <strong>{round.objective}</strong>
                      <small>
                        {round.spreadBps} bps / ${round.quoteSizeUsd.toFixed(2)}
                      </small>
                      <b>
                        {round.digest ? compact(round.digest) : round.outcome}
                      </b>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <fieldset className="account-pair-control strategy-section strategy-hedging strategy-step strategy-step-hedging">
              <legend>Hedging</legend>
              <p className="strategy-section-copy">
                Use a separate account to offset fills without giving either
                trading key withdrawal authority.
              </p>
              <div
                className={
                  selectedStrategy
                    ? "account-role-grid strategy-allocation-owned"
                    : "account-role-grid"
                }
              >
                <label>
                  <span>Maker</span>
                  <select
                    value={activeMakerAccountId ?? ""}
                    onChange={(event) => {
                      const makerAccountId = event.target.value || null;
                      setConfig((current) => ({
                        ...current,
                        makerAccountId,
                        hedge:
                          current.hedge.accountId === makerAccountId
                            ? {
                                ...current.hedge,
                                enabled: false,
                                accountId: null,
                              }
                            : current.hedge,
                      }));
                    }}
                  >
                    <option value="">Select account</option>
                    {authorizedAccounts.map((managed) => (
                      <option key={managed.accountId} value={managed.accountId}>
                        {accountReference(managed.accountId)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Taker account</span>
                  <select
                    value={config.hedge.accountId ?? ""}
                    disabled={!config.hedge.enabled}
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        hedge: {
                          ...current.hedge,
                          accountId: event.target.value || null,
                        },
                      }))
                    }
                  >
                    <option value="">Select account</option>
                    {authorizedAccounts
                      .filter(
                        (managed) => managed.accountId !== activeMakerAccountId,
                      )
                      .map((managed) => (
                        <option
                          key={managed.accountId}
                          value={managed.accountId}
                        >
                          {accountReference(managed.accountId)}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              {selectedStrategy && (
                <p className="strategy-section-copy">
                  Bundle accounts stay with the bundle. Shared hedging settings
                  below apply only where that bundle has compatible accounts.
                </p>
              )}
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={config.hedge.enabled}
                  disabled={
                    !selectedStrategy &&
                    (!activeMakerAccountId || authorizedAccounts.length < 2)
                  }
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    if (!enabled)
                      setInvalidNumeric((current) =>
                        Object.fromEntries(
                          Object.entries(current).filter(
                            ([id]) =>
                              !id.startsWith("strategy-hedge") &&
                              id !== "strategy-rebalance-gross-exposure-usd",
                          ),
                        ),
                      );
                    setConfig((current) => ({
                      ...current,
                      autoRebalanceEnabled: enabled
                        ? current.autoRebalanceEnabled
                        : false,
                      hedge: {
                        ...current.hedge,
                        enabled,
                      },
                    }));
                  }}
                />
                <span aria-hidden="true" />
                <strong>
                  Offset filled exposure · optional for new drafts
                </strong>
              </label>
              {config.hedge.enabled && (
                <>
                  <p className="strategy-section-copy">
                    Maker acts only after attributed fills reach the trigger: it
                    cancels its quotes, then the distinct hedge account sends a
                    capped opposite market order. Partial fills can leave
                    residual net exposure; the two accounts still hold gross
                    positions and each needs margin. This does not guarantee
                    delta neutrality, profitability or rewards.
                  </p>
                  {selectedStrategy?.usedBy.map((used) => {
                    const bundle = bundles.find((item) => item.id === used.id);
                    const maker = bundle?.makerAccountId ?? null;
                    const hedge = bundle?.takerAccountId ?? null;
                    const lane = bundleSnapshots.find(
                      (entry) => entry.bundle.id === used.id,
                    )?.snapshot;
                    const hedgeBalance =
                      accounts.find((item) => item.accountId === hedge)
                        ?.availableCollateralUsd ?? null;
                    return (
                      <p className="strategy-section-copy" key={used.id}>
                        {used.name}: Maker{" "}
                        {maker ? `account ${maker}` : "account missing"} → hedge{" "}
                        {hedge ? `account ${hedge}` : "account missing"};{" "}
                        {maker && hedge && maker !== hedge
                          ? "confirm collateral and authorization in Bundles"
                          : "cannot activate without two distinct authorized accounts"}
                        . Hedge available collateral: {money(hedgeBalance)}{" "}
                        (latest loaded; timestamp not provided). Last observed
                        combined net exposure:{" "}
                        {lane?.hedge.combinedDeltaUsd === null ||
                        lane?.hedge.combinedDeltaUsd === undefined
                          ? "unknown"
                          : `${bundle?.mode === "paper" ? "Paper estimate " : ""}${money(lane.hedge.combinedDeltaUsd)} at ${lane.hedge.lastHedgeAt ?? "unspecified time"}`}
                        .
                      </p>
                    );
                  })}
                  <p className="strategy-section-copy">
                    Trigger {money(config.hedge.thresholdUsd)} of accumulated
                    fills; maximum {money(config.hedge.maxOrderUsd)} per hedge
                    order; slippage ceiling {config.hedge.maxSlippageBps} bps.
                    Quote size is {money(config.quoteSizeUsd)} per side before
                    per-market overrides.
                  </p>
                  {selectedStrategy && (
                    <div className="hedge-suggestion">
                      <button
                        type="button"
                        className="button secondary"
                        disabled={"blocker" in hedgeSizing}
                        onClick={() => setHedgeSuggestionOpen(true)}
                      >
                        Preview hedge sizing from effective quote settings
                      </button>
                      {"blocker" in hedgeSizing ? (
                        <p role="status">
                          {hedgeSizing.blocker} Existing settings remain
                          unchanged.
                        </p>
                      ) : (
                        <p>
                          Draft estimate from the latest loaded order minimums
                          and each attached hedge account’s available
                          collateral. Recheck venue and account state before
                          activation; this is not proof of readiness.
                        </p>
                      )}
                      {hedgeSuggestionOpen && !("blocker" in hedgeSizing) && (
                        <div className="strategy-rule-preview" role="status">
                          <strong>Review proposed hedge amounts</strong>
                          <span>
                            Trigger: {money(config.hedge.thresholdUsd)} →{" "}
                            {money(hedgeSizing.thresholdUsd)}. Maximum order:{" "}
                            {money(config.hedge.maxOrderUsd)} →{" "}
                            {money(hedgeSizing.maxOrderUsd)}. Slippage stays{" "}
                            {config.hedge.maxSlippageBps} bps. This does not
                            apply to running bundles until Apply strategy.
                          </span>
                          <button
                            className="button secondary"
                            type="button"
                            onClick={() => {
                              setConfig((current) => ({
                                ...current,
                                hedge: {
                                  ...current.hedge,
                                  thresholdUsd: hedgeSizing.thresholdUsd,
                                  maxOrderUsd: hedgeSizing.maxOrderUsd,
                                },
                              }));
                              setHedgeSuggestionOpen(false);
                            }}
                          >
                            Accept amounts in draft
                          </button>
                          <button
                            className="button secondary"
                            type="button"
                            onClick={() => setHedgeSuggestionOpen(false)}
                          >
                            Dismiss
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="hedge-limit-grid">
                    <label>
                      <span>Trigger</span>
                      <div className="input-unit">
                        <b>$</b>
                        <NumericDraftInput
                          key={selectedStrategyId ?? "core"}
                          id="strategy-hedge-trigger"
                          label="Hedge trigger"
                          unit="USD"
                          value={config.hedge.thresholdUsd}
                          min={0.01}
                          max={10000}
                          onValidity={setNumericValidity}
                          onValue={(value) =>
                            setConfig((current) => ({
                              ...current,
                              hedge: { ...current.hedge, thresholdUsd: value },
                            }))
                          }
                        />
                      </div>
                    </label>
                    <label>
                      <span>Max order</span>
                      <div className="input-unit">
                        <b>$</b>
                        <NumericDraftInput
                          key={selectedStrategyId ?? "core"}
                          id="strategy-hedge-max"
                          label="Maximum hedge order"
                          unit="USD"
                          value={config.hedge.maxOrderUsd}
                          min={0.01}
                          max={10000}
                          onValidity={setNumericValidity}
                          onValue={(value) =>
                            setConfig((current) => ({
                              ...current,
                              hedge: { ...current.hedge, maxOrderUsd: value },
                            }))
                          }
                        />
                      </div>
                    </label>
                    <label>
                      <span>Slippage</span>
                      <div className="input-unit suffix">
                        <NumericDraftInput
                          key={selectedStrategyId ?? "core"}
                          id="strategy-hedge-slippage"
                          label="Hedge slippage"
                          unit="bps"
                          value={config.hedge.maxSlippageBps}
                          min={5}
                          max={500}
                          integer
                          onValidity={setNumericValidity}
                          onValue={(value) =>
                            setConfig((current) => ({
                              ...current,
                              hedge: {
                                ...current.hedge,
                                maxSlippageBps: value,
                              },
                            }))
                          }
                        />
                        <b>bps</b>
                      </div>
                    </label>
                  </div>
                  <label className="switch-row">
                    <input
                      type="checkbox"
                      checked={config.autoRebalanceEnabled}
                      onChange={(event) => {
                        if (!event.target.checked)
                          setNumericValidity(
                            "strategy-rebalance-gross-exposure-usd",
                            null,
                          );
                        setConfig((current) => ({
                          ...current,
                          autoRebalanceEnabled: event.target.checked,
                        }));
                      }}
                    />
                    <span aria-hidden="true" />
                    <strong>Auto-rebalance dedicated accounts</strong>
                  </label>
                  {config.autoRebalanceEnabled && (
                    <label>
                      <span>Rebalance before gross exposure reaches</span>
                      <div className="input-unit">
                        <b>$</b>
                        <NumericDraftInput
                          key={selectedStrategyId ?? "core"}
                          id="strategy-rebalance-gross-exposure-usd"
                          label="Rebalance gross threshold"
                          unit="USD"
                          value={config.rebalanceGrossExposureUsd}
                          min={0.01}
                          max={Math.min(config.maxGrossExposureUsd, 100000)}
                          onValidity={setNumericValidity}
                          onValue={(value) =>
                            setConfig((current) => ({
                              ...current,
                              rebalanceGrossExposureUsd: value,
                            }))
                          }
                        />
                      </div>
                      <small>
                        {percent(rebalanceEquityPct, 1)} of Maker equity.
                        Cancels quotes and uses{" "}
                        <GlossaryTerm definition="Reduce-only orders can shrink or close a position, but cannot increase it.">
                          reduce-only
                        </GlossaryTerm>{" "}
                        market orders on both dedicated accounts.
                      </small>
                    </label>
                  )}
                </>
              )}
            </fieldset>

            <fieldset className="strategy-section strategy-profile-section strategy-step strategy-step-goal">
              <legend>Risk profile</legend>
              <p className="strategy-section-copy">
                A profile only sets starting values for quote size, spread,
                check speed, and inventory. Change quote size and spread in Size
                and limits; check speed in Advanced; and inventory in Advanced
                limits.
              </p>
              <div className="strategy-profile-cards">
                {strategyProfiles.map((profile) => (
                  <button
                    key={profile.value}
                    type="button"
                    className={
                      config.strategyProfile === profile.value
                        ? "strategy-profile-card is-selected"
                        : "strategy-profile-card"
                    }
                    aria-pressed={config.strategyProfile === profile.value}
                    onClick={() => applyProfile(profile.value)}
                  >
                    <span>
                      <strong>{profile.label}</strong>
                      <small>{profile.summary}</small>
                    </span>
                    <dl>
                      <div>
                        <dt>Size</dt>
                        <dd>{money(profile.quoteSizeUsd)}</dd>
                      </div>
                      <div>
                        <dt>Spread</dt>
                        <dd>{profile.spreadBps} bps</dd>
                      </div>
                      <div>
                        <dt>Checks</dt>
                        <dd>{profile.refreshMs / 1_000}s</dd>
                      </div>
                      <div>
                        <dt>Inventory</dt>
                        <dd>{money(profile.maxInventoryUsd)}</dd>
                      </div>
                    </dl>
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="pair-picker strategy-section strategy-markets-section strategy-step strategy-step-markets">
              <legend>Markets</legend>
              <p className="strategy-section-copy">
                Choose the venue markets this strategy may quote.
              </p>
              <section
                className="strategy-suggestion-panel"
                aria-label="Suggest markets"
              >
                <header>
                  <strong>Suggest markets</strong>
                  <span>
                    Current rankings are advisory. Only Use these markets
                    changes the draft.
                  </span>
                </header>
                <div
                  className="strategy-quick-picks"
                  role="group"
                  aria-label="Suggestion ranking"
                >
                  {(
                    [
                      ["rewards", "Best for rewards"],
                      ["balanced", "Balanced"],
                      ["steady", "Smallest 24h move"],
                      ["ranked", "Top ranked"],
                    ] as const
                  ).map(([preset, label]) => (
                    <button
                      key={preset}
                      type="button"
                      className={
                        suggestionPreset === preset ? "is-selected" : undefined
                      }
                      aria-pressed={suggestionPreset === preset}
                      onClick={() => chooseSuggestionPreset(preset)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="strategy-rotation-stage">
                  <div className="strategy-suggestion-fields">
                    <div
                      className="reward-focus"
                      aria-label="Market suggestion focus"
                    >
                      <span>Focus</span>
                      <div role="group" aria-label="Market suggestion focus">
                        <button
                          type="button"
                          className={rewardFocus === "all" ? "selected" : ""}
                          aria-pressed={rewardFocus === "all"}
                          onClick={() => {
                            setRewardFocus("all");
                            setPendingMarketSuggestion(null);
                          }}
                        >
                          All eligible
                        </button>
                        <button
                          type="button"
                          className={rewardFocus === "thin" ? "selected" : ""}
                          aria-pressed={rewardFocus === "thin"}
                          onClick={() => {
                            setRewardFocus("thin");
                            setPendingMarketSuggestion(null);
                          }}
                        >
                          Thin books
                        </button>
                      </div>
                    </div>
                    <label className="reward-count">
                      <span>Markets</span>
                      <NumericDraftInput
                        key={`${selectedStrategyId ?? "core"}:${suggestionInputEpoch}`}
                        id="strategy-top-count"
                        label="Markets"
                        accessibleLabel="Markets"
                        unit="markets"
                        value={rewardMarketCount}
                        min={1}
                        max={64}
                        integer
                        onValidity={(_, error) => {
                          setSuggestionCountError(error);
                          setPendingMarketSuggestion(null);
                        }}
                        onValue={(value) => {
                          setRewardMarketCount(value);
                          setPendingMarketSuggestion(null);
                        }}
                      />
                    </label>
                  </div>
                  <div className="strategy-suggestion-actions">
                    <button
                      className="button reward-stage"
                      type="button"
                      onClick={stageRewardRotation}
                      disabled={
                        Boolean(suggestionCountError) ||
                        suggestionCandidateIds.length === 0
                      }
                    >
                      Preview selection
                    </button>
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() =>
                        void loadRewards(config.strategyObjective).catch(
                          (error) =>
                            setNotice(
                              error instanceof Error
                                ? error.message
                                : String(error),
                            ),
                        )
                      }
                    >
                      Refresh suggestions
                    </button>
                  </div>
                </div>
                <p className="strategy-suggestion-hint" role="status">
                  {suggestionCandidateIds.length === 0
                    ? "No current candidates pass this preset and focus. Your accepted markets remain unchanged."
                    : suggestionCandidateIds.length < rewardMarketCount
                      ? `${suggestionCandidateIds.length} candidates available; Preview will propose all ${suggestionCandidateIds.length}, not block saved policy.`
                      : `${suggestionCandidateIds.length} candidates available; Preview proposes up to ${rewardMarketCount}.`}{" "}
                  Rewards ranking favors measured farming score; Balanced ranks
                  both-score; smallest move uses absolute 24h change, not
                  volatility. Thin focus is $100–$1,000 balanced depth within 50
                  bps. Markets previews up to the chosen count (1–64); fewer
                  eligible markets means fewer proposed.
                </p>
              </section>
              <p className="strategy-quick-preview" aria-live="polite">
                Accepted draft selection ({strategyMarketCount}/64):{" "}
                {config.markets.map((market) => market.symbol).join(", ") ||
                  "none yet"}
                .
                {strategyMarketRule.kind === "quick-pick" && (
                  <>
                    {" "}
                    Last applied preset: {strategyMarketRule.pick}; rankings
                    never auto-refresh it.
                  </>
                )}
              </p>
              {config.markets.length === 0 && (
                <p className="field-error" role="alert">
                  Choose at least one market before saving this strategy.
                </p>
              )}
              {pendingMarketSuggestion?.strategyId === selectedStrategyId && (
                <div className="strategy-rule-preview" role="status">
                  <strong>
                    Proposed {pendingMarketSuggestion.ids.length} market
                    {pendingMarketSuggestion.ids.length === 1 ? "" : "s"} — not
                    yet used
                  </strong>
                  <span>
                    {pendingMarketSuggestion.ids
                      .map(
                        (id) =>
                          markets.find((market) => market.id === id)?.symbol ??
                          id,
                      )
                      .join(", ")}
                  </span>
                  <span>
                    Adding:{" "}
                    {pendingMarketSuggestion.ids
                      .filter(
                        (id) =>
                          !config.markets.some(
                            (market) => market.marketId === id,
                          ),
                      )
                      .map(
                        (id) =>
                          markets.find((market) => market.id === id)?.symbol ??
                          id,
                      )
                      .join(", ") || "none"}
                    . Removing:{" "}
                    {config.markets
                      .filter(
                        (market) =>
                          !pendingMarketSuggestion.ids.includes(
                            market.marketId,
                          ),
                      )
                      .map((market) => market.symbol)
                      .join(", ") || "none"}
                    . Retained markets keep their overrides.
                  </span>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={acceptMarketSuggestion}
                  >
                    Use these markets
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setPendingMarketSuggestion(null)}
                  >
                    Dismiss
                  </button>
                </div>
              )}
              <button
                type="button"
                className="button secondary strategy-clear-selection"
                onClick={() => {
                  setConfig((current) => ({ ...current, markets: [] }));
                  setStrategyMarketRule({
                    kind: "preferred-list",
                    marketIds: [],
                  });
                  setPendingMarketSuggestion(null);
                }}
              >
                Clear selected markets
              </button>
              <details className="strategy-market-legend">
                <summary>What the market evidence means</summary>
                <p>
                  Score is a 0–100 heuristic for the selected objective, not a
                  payoff forecast. Edge is estimated pre-risk basis points after
                  known fees. 24h shows reported traded volume, not volatility.
                  Open a market’s evidence for full reasons.
                </p>
              </details>
              <div
                className="strategy-venue-filters"
                aria-label="Market venue filter"
              >
                <button
                  type="button"
                  className={marketVenueFilter === "all" ? "is-selected" : ""}
                  aria-pressed={marketVenueFilter === "all"}
                  onClick={() => setMarketVenueFilter("all")}
                >
                  All venues
                </button>
                <button
                  type="button"
                  className={
                    marketVenueFilter === primaryVenue.id ? "is-selected" : ""
                  }
                  aria-pressed={marketVenueFilter === primaryVenue.id}
                  onClick={() => setMarketVenueFilter("aftermath")}
                >
                  <VenueChip venue={primaryVenue} />
                </button>
              </div>
              <div className="pair-picker-head">
                <strong>{config.markets.length}/64 selected</strong>
                <span>each pair every {effectiveRefreshSeconds}s</span>
              </div>
              <label className="pair-search">
                <Search size={14} aria-hidden="true" />
                <input
                  type="search"
                  value={marketQuery}
                  onChange={(event) => setMarketQuery(event.target.value)}
                  placeholder="Find a pair"
                  aria-label="Find a market pair"
                />
              </label>
              <div className="pair-venue-heading">
                <VenueChip venue={primaryVenue} />
                <span>{primaryVenue.network}</span>
              </div>
              <div className="strategy-market-key" aria-label="Market card key">
                <div className="strategy-market-key-title">
                  <strong>Market name</strong>
                  <small>Open interest (OI)</small>
                </div>
                <div className="strategy-market-evidence">
                  <span>Score</span>
                  <span>Edge</span>
                  <span>24h volume</span>
                  <span>Depth within 50 bps</span>
                </div>
              </div>
              <div className="pair-options strategy-market-table" role="list">
                {!strategyVisibleMarkets.length && (
                  <p className="pair-empty">
                    No matching markets for this focus. Try All eligible or
                    change your search.
                  </p>
                )}
                {strategyVisibleMarkets.map((item) => {
                  const selected = selectedMarketIds.has(item.id);
                  const opportunity = rewards?.marketModel.opportunities.find(
                    (candidate) => candidate.marketId === item.id,
                  );
                  return (
                    <div
                      className="market-select-item"
                      key={item.id}
                      role="listitem"
                    >
                      <label
                        className={
                          selected
                            ? "pair-option strategy-market-row selected"
                            : "pair-option strategy-market-row"
                        }
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleMarket(item)}
                          disabled={
                            (selected && config.markets.length === 1) ||
                            (!selected &&
                              config.markets.length >= MAX_SELECTED_MARKETS)
                          }
                        />
                        <span>
                          <strong>{item.symbol}</strong>
                          <small>{money(item.openInterestUsd, 0)} OI</small>
                          <small className="strategy-market-evidence">
                            <span
                              role="group"
                              aria-label={`Score: ${opportunity ? `${Math.round(opportunity.score)} out of 100` : "unavailable"}`}
                            >
                              {opportunity
                                ? `${Math.round(opportunity.score)} / 100`
                                : "—"}
                            </span>
                            <span
                              role="group"
                              aria-label={`Edge: ${opportunity?.preRiskEdgeBps != null ? `${opportunity.preRiskEdgeBps.toFixed(1)} basis points` : "unavailable"}`}
                            >
                              {opportunity?.preRiskEdgeBps != null
                                ? `${opportunity.preRiskEdgeBps.toFixed(1)} bps`
                                : "—"}
                            </span>
                            <span
                              role="group"
                              aria-label={`24h volume: ${opportunity?.volume24hUsd != null ? compactUsd(opportunity.volume24hUsd) : "unavailable"}`}
                            >
                              {compactUsd(opportunity?.volume24hUsd ?? null)}
                            </span>
                            <span
                              role="group"
                              aria-label={`Depth within 50 bps: ${opportunity?.balancedDepth50BpsUsd != null ? compactUsd(opportunity.balancedDepth50BpsUsd) : "unavailable"}`}
                            >
                              {compactUsd(
                                opportunity?.balancedDepth50BpsUsd ?? null,
                              )}
                            </span>
                          </small>
                        </span>
                      </label>
                      {selected && selectedStrategy && (
                        <button
                          type="button"
                          className="market-policy-edit market-card-policy-edit"
                          aria-label={`Edit ${item.symbol} policy`}
                          onClick={() =>
                            setPolicyEditorTarget({
                              marketId: item.id,
                              symbol: item.symbol,
                              strategyId: selectedStrategy.id,
                            })
                          }
                        >
                          Edit policy
                        </button>
                      )}
                      {selected &&
                        rewardFocus === "thin" &&
                        !opportunity?.thinActive && (
                          <small className="strategy-outside-focus">
                            Selected outside Thin focus; still included in the
                            draft.
                          </small>
                        )}
                      {opportunity && (
                        <details className="strategy-market-reasons">
                          <summary>Why {item.symbol} ranks here</summary>
                          <p>
                            {opportunity.reasons.length
                              ? opportunity.reasons.join(" · ")
                              : "No evidence reasons were reported."}
                          </p>
                        </details>
                      )}
                    </div>
                  );
                })}
              </div>
            </fieldset>

            <section className="strategy-market-ranks strategy-step strategy-step-markets">
              <header>
                <div>
                  <h2>Eligible pairs</h2>
                </div>
                <span>
                  {
                    sortedRewardOpportunities.filter(
                      (item) => rewardFocus === "all" || item.thinActive,
                    ).length
                  }{" "}
                  ranked
                </span>
              </header>
              <div className="strategy-market-ranks-wrap">
                <KitTable>
                  <thead>
                    <tr>
                      <th>Rank</th>
                      <th>Pair</th>
                      <th>Score</th>
                      <th>24h flow</th>
                      <th>Depth</th>
                      <th>Suggested quote settings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRewardOpportunities
                      .filter(
                        (item) => rewardFocus === "all" || item.thinActive,
                      )
                      .map((opportunity, index) => (
                        <tr key={opportunity.marketId}>
                          <td>{index + 1}</td>
                          <td>{opportunity.symbol}</td>
                          <td>{opportunity.score}</td>
                          <td>{compactUsd(opportunity.volume24hUsd)}</td>
                          <td>
                            {compactUsd(opportunity.balancedDepth50BpsUsd)}
                          </td>
                          <td>
                            {money(opportunity.suggestedQuoteSizeUsd)} /{" "}
                            {opportunity.suggestedSpreadBps} bps
                            {config.markets.some(
                              (market) =>
                                market.marketId === opportunity.marketId,
                            ) && (
                              <>
                                {" "}
                                ·{" "}
                                <button
                                  type="button"
                                  className="market-policy-edit"
                                  aria-label={`Edit ${opportunity.symbol} policy`}
                                  disabled={!selectedStrategy}
                                  onClick={() =>
                                    selectedStrategy &&
                                    setPolicyEditorTarget({
                                      marketId: opportunity.marketId,
                                      symbol: opportunity.symbol,
                                      strategyId: selectedStrategy.id,
                                    })
                                  }
                                >
                                  Edit policy
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </KitTable>
              </div>
            </section>

            <section className="strategy-limit-sentences strategy-step strategy-step-size">
              <h2>Size and limits</h2>
              <p className="strategy-section-copy">
                Wallet maximum across all bundles:{" "}
                {walletLimits
                  ? `${money(walletLimits.maxGrossExposureUsd)} gross exposure, ${money(walletLimits.maxRunDrawdownUsd)} run drawdown`
                  : "not available"}
                . This strategy’s limits apply per running bundle and do not
                edit the shared wallet ceiling. Account equity percentages need
                an attached bundle’s actual Maker account; no Core balance is
                assumed for a shared strategy.{" "}
                <button
                  type="button"
                  className="strategy-context-link"
                  onClick={() =>
                    walletLimits
                      ? openBundleEditorFromStrategy("wallet-limits")
                      : openAccountFromStrategy(null)
                  }
                >
                  {walletLimits
                    ? "Edit wallet limits"
                    : "Finish Core setup in Accounts"}
                </button>
              </p>
              <p className="strategy-section-copy">
                Quote-only collateral estimate: {money(quoteOnlyCollateralUsd)}{" "}
                at the saved size and leverage,{" "}
                {config.rotationMode === "portfolio"
                  ? "summing all selected markets"
                  : "one market at a time"}
                . This excludes existing positions and other bundles; the live
                risk gate still uses the full account state.{" "}
                <button
                  type="button"
                  className="strategy-context-link"
                  onClick={() => focusStrategyField("strategy-quote-size", 2)}
                >
                  Edit quote size
                </button>
              </p>
              {selectedStrategy?.usedBy.map((used) => {
                const bundle = bundles.find((item) => item.id === used.id);
                const account = accounts.find(
                  (item) => item.accountId === bundle?.makerAccountId,
                );
                return (
                  <p className="strategy-section-copy" key={used.id}>
                    {used.name}: Maker{" "}
                    {bundle?.makerAccountId
                      ? `account ${bundle.makerAccountId}`
                      : "account unassigned"}
                    , hedge{" "}
                    {bundle?.takerAccountId
                      ? `account ${bundle.takerAccountId}`
                      : "off"}{" "}
                    · available collateral{" "}
                    {account
                      ? money(account.availableCollateralUsd)
                      : "unavailable"}{" "}
                    (latest loaded account read; timestamp not provided).{" "}
                    <button
                      type="button"
                      className="strategy-context-link"
                      onClick={() =>
                        openBundleEditorFromStrategy("edit", used.id)
                      }
                    >
                      Edit {used.name} bundle
                    </button>{" "}
                    <button
                      type="button"
                      className="strategy-context-link"
                      onClick={() =>
                        openAccountFromStrategy(bundle?.makerAccountId ?? null)
                      }
                    >
                      {bundle?.makerAccountId
                        ? `View Maker account ${bundle.makerAccountId}`
                        : "Set up Maker account"}
                    </button>
                    {bundle?.takerAccountId && (
                      <>
                        {" "}
                        <button
                          type="button"
                          className="strategy-context-link"
                          onClick={() =>
                            openAccountFromStrategy(bundle.takerAccountId)
                          }
                        >
                          View hedge account {bundle.takerAccountId}
                        </button>
                      </>
                    )}
                  </p>
                );
              })}
              <p>
                Stop everything if equity falls ${" "}
                <label>
                  <span className="sr-only">Maximum run drawdown in USD</span>
                  <NumericDraftInput
                    key={selectedStrategyId ?? "core"}
                    id="strategy-drawdown"
                    label="Maximum run drawdown"
                    unit="USD"
                    value={config.maxRunDrawdownUsd}
                    min={0.01}
                    max={10000}
                    onValidity={setNumericValidity}
                    onValue={(value) =>
                      setConfig((current) => ({
                        ...current,
                        maxRunDrawdownUsd: value,
                      }))
                    }
                  />
                </label>
                from its highest point this run{" "}
                <AdvancedTip id="run-drawdown" />
              </p>
              <p>
                In any one market, hold at most ${" "}
                <label>
                  <span className="sr-only">Maximum inventory in USD</span>
                  <NumericDraftInput
                    key={selectedStrategyId ?? "core"}
                    id="strategy-inventory-cap"
                    label="Maximum per-market inventory"
                    unit="USD"
                    value={config.maxInventoryUsd}
                    min={0.01}
                    max={10000}
                    onValidity={setNumericValidity}
                    onValue={(value) =>
                      setConfig((current) => ({
                        ...current,
                        maxInventoryUsd: value,
                      }))
                    }
                  />
                </label>
                of position, long or short{" "}
                <AdvancedTip id="per-pair-inventory" />
              </p>
              <p>
                Across all markets, keep the total position value under ${" "}
                <label>
                  <span className="sr-only">Maximum gross exposure in USD</span>
                  <NumericDraftInput
                    key={selectedStrategyId ?? "core"}
                    id="strategy-gross"
                    label="Gross exposure"
                    unit="USD"
                    value={config.maxGrossExposureUsd}
                    min={0.01}
                    max={100000}
                    onValidity={setNumericValidity}
                    onValue={(value) =>
                      setConfig((current) => ({
                        ...current,
                        maxGrossExposureUsd: value,
                      }))
                    }
                  />
                </label>
                <AdvancedTip id="gross-exposure" />
              </p>
              {grossExposureError && (
                <p className="field-error" role="alert">
                  Gross exposure must cover the per-market inventory limit.
                  Raise the gross cap or lower the inventory cap.
                </p>
              )}
              <p>
                Pause quoting a market when its open position is down ${" "}
                <label>
                  <span className="sr-only">
                    Maximum unrealized loss in USD
                  </span>
                  <NumericDraftInput
                    key={selectedStrategyId ?? "core"}
                    id="strategy-unrealized-loss"
                    label="Maximum unrealized loss"
                    unit="USD"
                    value={config.maxUnrealizedLossUsd}
                    min={0.01}
                    max={10000}
                    onValidity={setNumericValidity}
                    onValue={(value) =>
                      setConfig((current) => ({
                        ...current,
                        maxUnrealizedLossUsd: value,
                      }))
                    }
                  />
                </label>
                <AdvancedTip id="unrealized-loss" />
              </p>
            </section>

            <section className="strategy-section strategy-capital-section strategy-step strategy-step-size">
              <h2>Capital</h2>
              <p className="strategy-section-copy">
                Set order size and the minimum edge quoted on each side. Each
                bundle chooses whether it runs in Paper or Live.
              </p>
              <div className="field-pair">
                <label>
                  <span>Quote {money(config.quoteSizeUsd)} on each side</span>
                  <div className="input-unit">
                    <b>$</b>
                    <NumericDraftInput
                      key={selectedStrategyId ?? "core"}
                      id="strategy-quote-size"
                      label="Quote size"
                      unit="USD"
                      value={config.quoteSizeUsd}
                      min={0.01}
                      max={1000}
                      onValidity={setNumericValidity}
                      onValue={(value) =>
                        setConfig((current) => ({
                          ...current,
                          quoteSizeUsd: value,
                        }))
                      }
                    />
                  </div>
                  {quoteSizeError ? (
                    <small className="field-error">
                      {config.quoteSizeUsd <= 0 ? (
                        <>Enter a quote size above $0.00.</>
                      ) : (
                        <>
                          Quote size {money(config.quoteSizeUsd)} is above the{" "}
                          {money(config.maxInventoryUsd)} you allow per market.
                          Lower the quote size, or{" "}
                          <button
                            type="button"
                            onClick={() =>
                              focusStrategyField("strategy-inventory-cap", 2)
                            }
                          >
                            raise “hold at most” above it.
                          </button>
                        </>
                      )}
                    </small>
                  ) : (
                    <small>{percent(quoteEquityPct, 1)} of Maker equity</small>
                  )}
                </label>
                <label>
                  <span>
                    Spread{" "}
                    <GlossaryTerm definition="Basis points. One basis point is 0.01%.">
                      bps
                    </GlossaryTerm>
                  </span>
                  <div className="input-unit suffix">
                    <NumericDraftInput
                      key={selectedStrategyId ?? "core"}
                      id="strategy-spread"
                      label="Spread"
                      unit="bps"
                      value={config.spreadBps}
                      min={8}
                      max={500}
                      onValidity={setNumericValidity}
                      onValue={(value) =>
                        setConfig((current) => ({
                          ...current,
                          spreadBps: value,
                        }))
                      }
                    />
                    <b>bps</b>
                  </div>
                </label>
              </div>
            </section>

            <fieldset
              id="strategy-rotation-mode"
              className="rotation-mode-control strategy-step strategy-step-size"
            >
              <legend>Rotation and concurrent collateral</legend>
              <p className="strategy-section-copy">
                Portfolio can leave a pair on every selected market and needs
                collateral for all concurrent two-sided quotes; one live pair
                requires collateral for one market at a time. These are strategy
                settings, not separate wallet allowances.
              </p>
              <div
                className="rotation-mode-segments"
                role="group"
                aria-label="Market rotation mode"
              >
                <button
                  type="button"
                  className={
                    config.rotationMode === "portfolio" ? "selected" : ""
                  }
                  aria-pressed={config.rotationMode === "portfolio"}
                  onClick={() =>
                    setConfig((current) => ({
                      ...current,
                      rotationMode: "portfolio",
                    }))
                  }
                >
                  All selected markets at once
                </button>
                <button
                  type="button"
                  className={
                    config.rotationMode === "single-slot" ? "selected" : ""
                  }
                  aria-pressed={config.rotationMode === "single-slot"}
                  onClick={() =>
                    setConfig((current) => ({
                      ...current,
                      rotationMode: "single-slot",
                    }))
                  }
                >
                  {`One market at a time, moving to the next every ${config.marketDwellMs / 1_000} s`}
                </button>
              </div>
            </fieldset>

            <details
              className="strategy-section strategy-advanced strategy-step strategy-step-size"
              open={advancedOpen}
              onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
            >
              <summary>Advanced</summary>
              <p className="strategy-section-copy">
                Portfolio limits, quote guards, and timing controls.
              </p>
              <div className="risk-field-grid">
                <label>
                  <span>
                    Inventory target <AdvancedTip id="inventory-target" />
                  </span>
                  <div className="input-unit">
                    <b>$</b>
                    <NumericDraftInput
                      key={selectedStrategyId ?? "core"}
                      id="strategy-inventory-target"
                      label="Inventory target"
                      unit="USD"
                      value={config.inventoryTargetUsd}
                      min={-10000}
                      max={10000}
                      onValidity={setNumericValidity}
                      onValue={(value) =>
                        setConfig((current) => ({
                          ...current,
                          inventoryTargetUsd: value,
                        }))
                      }
                    />
                  </div>
                </label>
                <label>
                  <span>
                    Book / index{" "}
                    <GlossaryTerm definition="Divergence is the distance between the venue book and index price.">
                      divergence
                    </GlossaryTerm>{" "}
                    <AdvancedTip id="book-index-divergence" />
                  </span>
                  <div className="input-unit suffix">
                    <NumericDraftInput
                      key={selectedStrategyId ?? "core"}
                      id="strategy-max-book-divergence-bps"
                      label="Book / index divergence"
                      unit="bps"
                      value={config.maxBookDivergenceBps}
                      min={1}
                      max={5000}
                      onValidity={setNumericValidity}
                      onValue={(value) =>
                        setConfig((current) => ({
                          ...current,
                          maxBookDivergenceBps: value,
                        }))
                      }
                    />
                    <b>bps</b>
                  </div>
                </label>
                <label>
                  <span>
                    Inventory{" "}
                    <GlossaryTerm definition="Skew shifts quotes to encourage fills that move inventory toward its target.">
                      skew
                    </GlossaryTerm>{" "}
                    <AdvancedTip id="inventory-skew" />
                  </span>
                  <div className="input-unit suffix">
                    <NumericDraftInput
                      key={selectedStrategyId ?? "core"}
                      id="strategy-inventory-skew-bps"
                      label="Inventory skew"
                      unit="bps"
                      value={config.inventorySkewBps}
                      min={0}
                      max={250}
                      onValidity={setNumericValidity}
                      onValue={(value) =>
                        setConfig((current) => ({
                          ...current,
                          inventorySkewBps: value,
                        }))
                      }
                    />
                    <b>bps</b>
                  </div>
                </label>
                <label>
                  <span>
                    Max leverage <AdvancedTip id="max-leverage" />
                  </span>
                  <div className="input-unit suffix">
                    <NumericDraftInput
                      key={selectedStrategyId ?? "core"}
                      id="strategy-max-leverage"
                      label="Maximum leverage"
                      unit="x"
                      value={config.maxLeverage}
                      min={1}
                      max={3}
                      onValidity={setNumericValidity}
                      onValue={(value) =>
                        setConfig((current) => ({
                          ...current,
                          maxLeverage: value,
                        }))
                      }
                    />
                    <b>x</b>
                  </div>
                </label>
              </div>

              <div className="timing-controls">
                <label>
                  <span>
                    Poll interval <AdvancedTip id="poll-interval" />
                  </span>
                  <input
                    type="range"
                    min="2000"
                    max="30000"
                    step="1000"
                    value={config.refreshMs}
                    onChange={(event) => {
                      const refreshMs = Number(event.target.value);
                      setConfig((current) => ({
                        ...current,
                        refreshMs,
                      }));
                    }}
                  />
                  <small>
                    {config.refreshMs / 1000}s risk and price checks
                  </small>
                </label>
                <label>
                  <span>
                    Market dwell <AdvancedTip id="market-dwell" />
                  </span>
                  <div className="input-unit suffix">
                    <NumericDraftInput
                      key={selectedStrategyId ?? "core"}
                      id="strategy-market-dwell-ms"
                      label="Market dwell"
                      unit="seconds"
                      value={config.marketDwellMs / 1_000}
                      min={Math.max(2, Math.ceil(config.refreshMs / 1000))}
                      max={3600}
                      integer
                      onValidity={setNumericValidity}
                      onValue={(value) =>
                        setConfig((current) => ({
                          ...current,
                          marketDwellMs: value * 1000,
                        }))
                      }
                    />
                    <b>sec</b>
                  </div>
                  <small>Switches the one live pair.</small>
                </label>
                <label>
                  <span>
                    Requote movement <AdvancedTip id="requote-movement" />
                  </span>
                  <div className="input-unit suffix">
                    <NumericDraftInput
                      key={selectedStrategyId ?? "core"}
                      id="strategy-requote-threshold-bps"
                      label="Requote movement"
                      unit="bps"
                      value={config.requoteThresholdBps}
                      min={0}
                      max={500}
                      onValidity={setNumericValidity}
                      onValue={(value) =>
                        setConfig((current) => ({
                          ...current,
                          requoteThresholdBps: value,
                        }))
                      }
                    />
                    <b>bps</b>
                  </div>
                  <small>Smaller moves keep the resting quote.</small>
                </label>
                <label>
                  <span>
                    Forced refresh <AdvancedTip id="forced-refresh" />
                  </span>
                  <div className="input-unit suffix">
                    <NumericDraftInput
                      key={selectedStrategyId ?? "core"}
                      id="strategy-max-resting-ms"
                      label="Forced refresh"
                      unit="seconds"
                      value={config.maxRestingMs / 1_000}
                      min={Math.max(5, Math.ceil(config.refreshMs / 1000))}
                      max={3600}
                      integer
                      onValidity={setNumericValidity}
                      onValue={(value) =>
                        setConfig((current) => ({
                          ...current,
                          maxRestingMs: value * 1000,
                        }))
                      }
                    />
                    <b>sec</b>
                  </div>
                  <small>Maximum time before a paid requote.</small>
                </label>
                <label>
                  <span>
                    Stale-observation cutoff{" "}
                    <AdvancedTip id="stale-observation-cutoff" />
                  </span>
                  <div className="input-unit suffix">
                    <NumericDraftInput
                      key={selectedStrategyId ?? "core"}
                      id="strategy-max-quote-age-ms"
                      label="Stale observation cutoff"
                      unit="seconds"
                      value={config.maxQuoteAgeMs / 1_000}
                      min={Math.ceil(
                        minimumObservationWindowMs(
                          config.refreshMs,
                          config.markets.length,
                          config.rotationMode,
                          config.maxRestingMs,
                        ) / 1000,
                      )}
                      max={86400}
                      integer
                      onValidity={setNumericValidity}
                      onValue={(value) =>
                        setConfig((current) => ({
                          ...current,
                          maxQuoteAgeMs: value * 1000,
                        }))
                      }
                    />
                    <b>sec</b>
                  </div>
                  <small>
                    Watchdog cancels on missing market observations.
                  </small>
                </label>
              </div>
            </details>

            {configDirty && !selectedStrategy && (
              <div className="strategy-save-bar" role="status">
                <span>Unsaved changes, review and save</span>
                <div>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() =>
                      setConfig(
                        savedConfig ?? {
                          ...defaultConfig,
                          makerAccountId: activeMakerAccountId,
                        },
                      )
                    }
                    disabled={Boolean(busy)}
                  >
                    Discard
                  </button>
                  <button
                    type="submit"
                    className="button primary"
                    disabled={Boolean(strategySaveBlocker) || Boolean(busy)}
                  >
                    {busy === "save" ? "Saving..." : "Save strategy"}
                  </button>
                </div>
                <small>
                  {strategySaveBlocker ? (
                    <>
                      {strategySaveBlocker.message}{" "}
                      <button
                        type="button"
                        onClick={() =>
                          setStrategyStep(strategySaveBlocker.step)
                        }
                      >
                        Go to that step
                      </button>
                    </>
                  ) : (
                    "Saved changes apply on the next market cycle."
                  )}
                </small>
              </div>
            )}
          </form>
        </section>
      </StrategyView>

      <BundlesView
        active={displayedView === "bundles"}
        bundles={bundleCards}
        walletLimits={walletLimits}
        selectedBundleId={selectedBundleId}
        editorRequest={bundleEditorRequest}
        returnToStrategy={strategyReturn !== null}
        onReturnToStrategy={returnToStrategy}
        onOpenAccounts={() => selectView("accounts")}
        busy={Boolean(busy)}
        run={runState}
        onSelect={(bundleId) => void selectBundle(bundleId)}
        onArchive={(bundleId) => void bundleAction(bundleId, "archive")}
        accounts={accounts.map((account) => ({
          accountId: account.accountId,
          label: account.label,
          authorized: Boolean(
            setup.accounts.find(
              (managed) => managed.accountId === account.accountId,
            )?.agentCapId,
          ),
        }))}
        markets={markets.map((market) => ({
          id: market.id,
          symbol: market.symbol,
        }))}
        strategies={strategies.map((strategy) => ({
          id: strategy.id,
          name: strategy.name,
          marketCount: strategy.markets.length,
          requiresHedge: strategy.config.hedge.enabled,
        }))}
        onAttachStrategy={attachStrategy}
        onUpdateAllocation={updateBundleAllocation}
        onCreate={createBundle}
        onUpdateWalletLimits={updateWalletLimits}
      />

      <MarketsView active={displayedView === "markets"}>
        <PageHeader
          className="markets-title"
          title="Markets"
          description="See which markets your bundles use, and edit each market's strategy policy."
        />
        <section className="rotation-board market-clean-board">
          <header className="market-clean-heading">
            <div>
              <h2>Aftermath markets</h2>
              <p>
                {marketTableGroups.inUse.length} in use by your bundles,{" "}
                {marketTableGroups.available.length} available.
              </p>
            </div>
            <span className="market-last-update">
              <i aria-hidden="true" />
              {updatedAgo(deskLatestMarketUpdate)}
            </span>
          </header>
          <div
            className="market-table-wrap"
            tabIndex={0}
            role="region"
            aria-label="Aftermath market table, scroll horizontally for more columns"
          >
            <KitTable className="market-table market-clean-table">
              <thead>
                <tr>
                  {marketHeaders.map(({ key, label }) => (
                    <th key={key} aria-sort={marketSortLabel(key)}>
                      <button
                        type="button"
                        onClick={() => sortMarketTable(key)}
                        aria-label={`Sort ${label}: ${marketSortLabel(key)}`}
                      >
                        {label}{" "}
                        <span aria-hidden="true">
                          {marketTableSort.key === key
                            ? marketTableSort.direction === "asc"
                              ? "↑"
                              : "↓"
                            : "↕"}
                        </span>
                      </button>
                    </th>
                  ))}
                  <th scope="col">
                    <span className="sr-only">Edit policy</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {marketTableGroups.inUse.length > 0 && (
                  <tr className="market-group-heading">
                    <th colSpan={marketHeaders.length + 1}>
                      In use <span>{marketTableGroups.inUse.length}</span>
                    </th>
                  </tr>
                )}
                {marketTableGroups.inUse.map(renderMarketRow)}
                {marketTableGroups.available.length > 0 && (
                  <tr className="market-group-heading">
                    <th colSpan={marketHeaders.length + 1}>
                      Available{" "}
                      <span>{marketTableGroups.available.length}</span>
                    </th>
                  </tr>
                )}
                {marketTableGroups.available.map(renderMarketRow)}
              </tbody>
            </KitTable>
          </div>
        </section>
      </MarketsView>

      {policyEditorTarget && policyStrategy && policyMarket && (
        <MarketPolicySheet
          key={`${policyEditorTarget.strategyId}:${policyEditorTarget.marketId}`}
          symbol={policyEditorTarget.symbol}
          strategyName={policyStrategy.name}
          bundleNames={policyStrategy.usedBy.map((used) => used.name)}
          defaults={policyStrategy.config}
          current={policyMarket.overrides ?? {}}
          blocked={policyBlocked}
          onClose={() => setPolicyEditorTarget(null)}
          onOpenStrategy={() => {
            const strategyId = policyStrategy.id;
            setPolicyEditorTarget(null);
            void selectStrategy(strategyId).then((selected) => {
              if (!selected) return;
              setStrategyEditing(true);
              setStrategyStep(1);
              selectView("strategy");
            });
          }}
          onSave={saveMarketPolicy}
        />
      )}

      <PerformanceView active={displayedView === "performance"}>
        <PageHeader
          title="Performance"
          className="performance-page-header"
          description="Results from Maker's own fills, after known costs."
          actions={
            <>
              <SegmentedTabs
                label="Performance period"
                value={performancePeriod}
                options={[
                  { value: "1D", label: "24h" },
                  { value: "EPOCH", label: "Epoch" },
                  { value: "ALL", label: "All time" },
                ]}
                onChange={(period) => {
                  setPerformance(null);
                  setPerformancePeriod(period);
                }}
              />
              <select
                className="kit-menu"
                aria-label="Performance bundle"
                value={performanceBundle}
                onChange={(event) => {
                  setPerformance(null);
                  setPerformanceBundle(event.target.value);
                }}
              >
                <option value="all">All bundles</option>
                {bundles
                  .filter((bundle) => !bundle.archivedAt)
                  .map((bundle) => (
                    <option key={bundle.id} value={bundle.id}>
                      {bundle.name}
                    </option>
                  ))}
                <option value="before">Before bundles</option>
              </select>
            </>
          }
        />
        <section className="rewards-board">
          <div className="section-heading compact rewards-heading">
            <div>
              <h2>Reward efficiency</h2>
            </div>
            <div className="reward-heading-actions">
              <div className="reward-cutoff">
                <TimerReset size={16} aria-hidden="true" />
                <span>Next snapshot</span>
                <strong>{timeUntil(rewards?.epoch.cutoffAt ?? null)}</strong>
              </div>
              <a
                className="ui-button ui-button-secondary ui-button-medium reward-claim-link"
                href={primaryVenue.rewardsUrl}
                target="_blank"
                rel="noreferrer"
              >
                <Coins size={15} aria-hidden="true" />
                Claim on Aftermath
                <ExternalLink size={13} aria-hidden="true" />
              </a>
            </div>
          </div>

          <div className="reward-metrics">
            <div>
              <Trophy size={16} aria-hidden="true" />
              <span>Est. maker rewards</span>
              <strong>
                {rewards
                  ? `${rewards.account.makerRewardsSui.toFixed(2)} SUI`
                  : "Loading"}
              </strong>
            </div>
            <div>
              <span>
                <GlossaryTerm definition="Q-score share estimates this account's share of qualifying maker liquidity.">
                  Q-score share
                </GlossaryTerm>
              </span>
              <strong>
                {rewards ? percent(rewards.account.qScoreShare * 100, 3) : "-"}
              </strong>
            </div>
            <div>
              <span>Time your quotes qualified</span>
              <strong>
                {uptimeQualifiedPct === null
                  ? "Not reported"
                  : percent(uptimeQualifiedPct, 1)}
              </strong>
            </div>
            <div>
              <span>Maker volume share</span>
              <strong>
                {rewards
                  ? percent(rewards.account.makerVolumeShare * 100, 3)
                  : "-"}
              </strong>
            </div>
            <div>
              <span>Maker fee result</span>
              <strong
                className={
                  (rewards?.account.baseMakerFeesUsd ?? 0) > 0
                    ? "negative-number"
                    : (rewards?.account.baseMakerFeesUsd ?? 0) < 0
                      ? "positive-number"
                      : ""
                }
              >
                {money(rewards ? -rewards.account.baseMakerFeesUsd : null)}
              </strong>
            </div>
            <div>
              <span>Direct rebates</span>
              <strong>
                {money(rewards?.account.directRebatesUsd ?? null)}
              </strong>
            </div>
          </div>

          <section
            className="objective-evidence"
            aria-label="Is the goal working?"
          >
            <header>
              <h3>Is the goal working?</h3>
              <p>
                Each goal keeps its measured evidence separate from what still
                needs a longer observation window.
              </p>
            </header>
            {objectiveEvidence.map((objective) => (
              <div
                key={objective.name}
                className={
                  config.strategyObjective === objective.name.toLowerCase()
                    ? "is-active"
                    : undefined
                }
              >
                <b aria-hidden="true">{objective.mark}</b>
                <span>
                  {objective.name}
                  {config.strategyObjective ===
                    objective.name.toLowerCase() && (
                    <small className="objective-goal-tag">Your goal</small>
                  )}
                </span>
                <strong>{objective.headline}</strong>
                <p>{objective.evidence}</p>
              </div>
            ))}
          </section>

          <div className="reward-table-wrap">
            <KitTable className="reward-table">
              <thead>
                <tr>
                  <th>
                    <button
                      type="button"
                      aria-pressed={marketSort === "rank"}
                      onClick={() => setMarketSort("rank")}
                    >
                      Rank
                    </button>
                  </th>
                  <th>Pair</th>
                  <th>Venue</th>
                  <th>
                    <button
                      type="button"
                      aria-pressed={marketSort === "score"}
                      onClick={() => setMarketSort("score")}
                    >
                      {config.strategyObjective} score
                    </button>
                  </th>
                  <th>
                    <button
                      type="button"
                      aria-pressed={marketSort === "volume"}
                      onClick={() => setMarketSort("volume")}
                    >
                      24h flow
                    </button>
                  </th>
                  <th>
                    <button
                      type="button"
                      aria-pressed={marketSort === "depth"}
                      onClick={() => setMarketSort("depth")}
                    >
                      Depth +/-50 bps
                    </button>
                  </th>
                  <th>Flow / depth</th>
                  <th>Book spread</th>
                  <th>Pre-risk edge</th>
                  <th>Known fill cost</th>
                  <th>Suggested policy</th>
                </tr>
              </thead>
              <tbody>
                {sortedRewardOpportunities.length ? (
                  sortedRewardOpportunities.map((opportunity) => (
                    <tr
                      key={opportunity.marketId}
                      title={opportunity.reasons.join(". ")}
                    >
                      <td>{opportunity.rank}</td>
                      <td>
                        <strong>{opportunity.symbol}</strong>
                        <span
                          className={`confidence confidence-${opportunity.confidence}`}
                        >
                          {opportunity.confidence}
                        </span>
                        {opportunity.thinActive ? (
                          <span className="thin-active">thin + active</span>
                        ) : null}
                        {!opportunity.objectiveEligible ? (
                          <span className="objective-miss">
                            fails objective
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <VenueChip venue={primaryVenue} />
                      </td>
                      <td>
                        <div className="score-cell">
                          <strong>{opportunity.score}</strong>
                          <span aria-hidden="true">
                            <i style={{ width: `${opportunity.score}%` }} />
                          </span>
                        </div>
                      </td>
                      <td>{compactUsd(opportunity.volume24hUsd)}</td>
                      <td>{compactUsd(opportunity.balancedDepth50BpsUsd)}</td>
                      <td>
                        {opportunity.volumeToDepth === null
                          ? "-"
                          : `${opportunity.volumeToDepth.toFixed(1)}x`}
                      </td>
                      <td>
                        {opportunity.observedSpreadBps === null
                          ? "-"
                          : `${opportunity.observedSpreadBps.toFixed(1)} bps`}
                      </td>
                      <td
                        className={
                          (opportunity.preRiskEdgeBps ?? 0) > 0
                            ? "positive-number"
                            : "negative-number"
                        }
                        title="Half of the observed spread less current maker and venue fees; excludes adverse selection, gas, funding, hedging, and inventory carry"
                      >
                        {opportunity.preRiskEdgeBps === null
                          ? "-"
                          : `${opportunity.preRiskEdgeBps.toFixed(1)} bps`}
                      </td>
                      <td
                        className={
                          opportunity.knownCostBps <= 0 ? "positive-number" : ""
                        }
                      >
                        {opportunity.knownCostBps <= 0
                          ? `${Math.abs(opportunity.knownCostBps).toFixed(1)} bps rebate`
                          : `${opportunity.knownCostBps.toFixed(1)} bps`}
                      </td>
                      <td className="dual-value">
                        <strong>
                          {money(
                            Math.max(
                              opportunity.minimumQuoteSizeUsd,
                              Math.min(
                                opportunity.suggestedQuoteSizeUsd,
                                rewardQuotePreviewCap,
                              ),
                            ),
                            2,
                          )}
                        </strong>
                        <span>
                          {opportunity.suggestedSpreadBps} bps / min{" "}
                          {money(opportunity.minimumQuoteSizeUsd, 2)}
                        </span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="empty-fill" colSpan={11}>
                      {rewards?.account.error ??
                        "Scanning live books for eligible markets."}
                    </td>
                  </tr>
                )}
              </tbody>
            </KitTable>
          </div>
          <details className="reward-method">
            <summary>How these numbers are measured</summary>
            <p>{rewards?.marketModel.methodology}</p>
            <p>
              Thin books means $100-$1,000 of balanced depth within 50 bps, at
              least $10,000 of reported 24h volume, positive open interest, and
              an open, two-sided book. Farming can favor high turnover when its
              reported flow per unit of capital is stronger; this is not a
              reward guarantee.
            </p>
            <p>
              Pre-risk edge is half the observed spread less current maker and
              venue fees. It excludes adverse selection, gas, funding, hedge
              slippage, markouts, inventory carry, and reward-rule changes.
            </p>
            <p>
              Staging only changes the draft strategy and forces Observe mode.
              Self-matched volume is not modeled as eligible flow. Save after
              review; starting Live remains a separate action.
            </p>
          </details>
        </section>

        <section className="performance-board">
          <p className="performance-coverage">
            <CircleCheck size={16} aria-hidden="true" />
            {performance?.attributed.makerVolumeCoveragePct === 100
              ? "Every maker fill in this period is traced to a bundle."
              : performance?.attributed.makerVolumeCoveragePct === null ||
                  performance?.attributed.makerVolumeCoveragePct === undefined
                ? "Awaiting maker fills for coverage."
                : `${performance.attributed.makerVolumeCoveragePct.toFixed(1)}% of maker volume is traced to a bundle.`}
          </p>
          {performanceBundle === "before" && (
            <p className="performance-before-bundles" role="status">
              Before bundles: this unassigned history counts in wallet totals,
              never in an individual bundle.
            </p>
          )}
          {performance?.paper.estimated && (
            <p className="performance-before-bundles" role="status">
              Paper estimates: {performance.paper.makerFills} Maker fills and{" "}
              {performance.paper.hedgeFills} hedges across{" "}
              {money(performance.paper.notionalUsd)}. They are sampled
              book-crossing estimates, not exchange executions.
            </p>
          )}
          <div className="performance-v3-stats">
            <div>
              <span>Net known result</span>
              <strong
                className={
                  moneyTone(performance?.combinedNetAfterKnownCostsUsd ?? 0) ===
                  "loss"
                    ? "negative-number"
                    : moneyTone(
                          performance?.combinedNetAfterKnownCostsUsd ?? 0,
                        ) === "gain"
                      ? "positive-number"
                      : ""
                }
                title={formatExactMoney(
                  performance?.combinedNetAfterKnownCostsUsd ?? 0,
                )}
              >
                {money(performance?.combinedNetAfterKnownCostsUsd ?? 0)}
              </strong>
            </div>
            <div>
              <span>Volume</span>
              <strong>
                {money(
                  (performance?.attributed.notionalUsd ?? 0) +
                    (performance?.hedge.notionalUsd ?? 0),
                )}
              </strong>
            </div>
            <div>
              <span>Fills</span>
              <strong>
                {(performance?.attributed.fills ?? 0) +
                  (performance?.hedge.fills ?? 0)}
              </strong>
            </div>
            <div>
              <span>Estimated rewards</span>
              <strong>
                {rewards
                  ? `${rewards.account.makerRewardsSui.toFixed(2)} SUI`
                  : "Not reported"}
              </strong>
            </div>
          </div>
          <section className="performance-breakdown">
            <h3>Maker side</h3>
            <dl>
              <div>
                <dt>Maker fills</dt>
                <dd>{performance?.attributed.fills ?? 0}</dd>
              </div>
              <div>
                <dt>Attributed notional</dt>
                <dd>{money(performance?.attributed.notionalUsd ?? 0)}</dd>
              </div>
              <div>
                <dt>Realized PnL</dt>
                <dd
                  className={
                    (performance?.attributed.realizedPnlUsd ?? 0) < 0
                      ? "negative-number"
                      : ""
                  }
                >
                  {money(performance?.attributed.realizedPnlUsd ?? 0)}
                </dd>
              </div>
              <div>
                <dt>Known fees</dt>
                <dd>
                  {money(
                    (performance?.attributed.protocolFeesUsd ?? 0) +
                      (performance?.attributed.estimatedBuilderFeesUsd ?? 0),
                  )}
                </dd>
              </div>
              <div>
                <dt>Net known result</dt>
                <dd
                  className={
                    (performance?.attributed.netAfterKnownCostsUsd ?? 0) < 0
                      ? "negative-number"
                      : ""
                  }
                >
                  {money(performance?.attributed.netAfterKnownCostsUsd ?? 0)}
                </dd>
              </div>
            </dl>
          </section>
          <section className="performance-breakdown">
            <h3>Hedge side</h3>
            <dl>
              <div>
                <dt>Account</dt>
                <dd>
                  {performance?.hedge.accountId
                    ? accountReference(performance.hedge.accountId)
                    : "Off"}
                </dd>
              </div>
              <div>
                <dt>Orders filled</dt>
                <dd>{performance?.hedge.fills ?? 0}</dd>
              </div>
              <div>
                <dt>Notional</dt>
                <dd>{money(performance?.hedge.notionalUsd ?? 0)}</dd>
              </div>
              <div>
                <dt>Hedge result</dt>
                <dd
                  className={
                    (performance?.hedge.netAfterKnownCostsUsd ?? 0) < 0
                      ? "negative-number"
                      : ""
                  }
                >
                  {money(performance?.hedge.netAfterKnownCostsUsd ?? 0)}
                </dd>
              </div>
            </dl>
          </section>
          <div className="performance-combined">
            <span>Combined known result</span>
            <strong
              className={
                (performance?.combinedNetAfterKnownCostsUsd ?? 0) < 0
                  ? "negative-number"
                  : ""
              }
            >
              {money(performance?.combinedNetAfterKnownCostsUsd ?? 0)}
            </strong>
          </div>
          <div className="performance-note">
            <span>
              Account-wide:{" "}
              {compactUsd(performance?.account?.makerVolumeUsd ?? 0)} maker
              volume / {money(performance?.account?.fundingPnlUsd ?? 0)} funding
            </span>
            <span>
              {performance && !performance.historyComplete
                ? `History covers ${performance.fills.length} attributed fills; account totals remain complete.`
                : (performance?.note ??
                  "Attribution starts when this release records its first order IDs.")}
            </span>
          </div>
        </section>
        <Card
          className="performance-volume-by-market"
          data-padding-check="performance-volume"
          title="By market"
          subtitle="Maker and Taker activity reconciled from account history."
        >
          <div className="performance-volume-table-wrap">
            <KitTable>
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Maker volume / fills</th>
                  <th>Taker volume / fills</th>
                  <th>Share of volume</th>
                  <th>Net</th>
                </tr>
              </thead>
              <tbody>
                {performanceVolumeByMarket.length ? (
                  performanceVolumeByMarket.map((row) => {
                    const totalVolume =
                      performanceVolumeByMarket.reduce(
                        (sum, value) =>
                          sum + value.makerNotionalUsd + value.takerNotionalUsd,
                        0,
                      ) || 1;
                    const rowVolume =
                      row.makerNotionalUsd + row.takerNotionalUsd;
                    const expanded = expandedPerformanceMarket === row.marketId;
                    return (
                      <Fragment key={row.marketId}>
                        <tr>
                          <td>
                            <button
                              type="button"
                              className="performance-market-expand"
                              aria-expanded={expanded}
                              onClick={() =>
                                setExpandedPerformanceMarket(
                                  expanded ? null : row.marketId,
                                )
                              }
                            >
                              {row.symbol}
                            </button>
                          </td>
                          <td>
                            {money(row.makerNotionalUsd)} / {row.makerFills}
                          </td>
                          <td>
                            {money(row.takerNotionalUsd)} / {row.takerFills}
                          </td>
                          <td>{percent((rowVolume / totalVolume) * 100, 1)}</td>
                          <td>{money(row.realizedPnlUsd - row.feesUsd)}</td>
                        </tr>
                        {expanded && (
                          <tr className="performance-market-fills">
                            <td colSpan={5}>
                              {(performance?.fills ?? [])
                                .filter(
                                  (fill) => fill.marketId === row.marketId,
                                )
                                .map((fill) => (
                                  <span
                                    key={`${fill.txDigest}:${fill.orderId}`}
                                  >
                                    {formatEventTimestamp(fill.occurredAt)} ·{" "}
                                    {fill.estimated ? "Estimated " : ""}
                                    {fill.side === "bid"
                                      ? "Bought"
                                      : "Sold"}{" "}
                                    {money(fill.notionalUsd)}
                                  </span>
                                ))}
                              {!(performance?.fills ?? []).some(
                                (fill) => fill.marketId === row.marketId,
                              ) && (
                                <span>
                                  Maker fills are not attributed for this market
                                  in the selected period.
                                </span>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={5}>
                      Taker volume is shown in the account total until market
                      history is available.
                    </td>
                  </tr>
                )}
              </tbody>
            </KitTable>
          </div>
        </Card>
        <Card
          className="performance-recent-fills"
          title="Recent fills"
          subtitle="Maker and hedge fills, with known costs and transaction receipts."
        >
          <div className="fill-table-wrap">
            <KitTable className="fill-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Pair</th>
                  <th>Side</th>
                  <th>Price</th>
                  <th>Notional</th>
                  <th>Realized</th>
                  <th>Known fees</th>
                  <th>Transaction</th>
                </tr>
              </thead>
              <tbody>
                {performance?.fills.length ? (
                  performance.fills.slice(0, 20).map((fill) => (
                    <tr key={`${fill.txDigest}:${fill.orderId}`}>
                      <td>{formatEventTimestamp(fill.occurredAt)}</td>
                      <td>{fill.symbol}</td>
                      <td>{fill.side === "bid" ? "Bought" : "Sold"}</td>
                      <td>{money(fill.price, 4)}</td>
                      <td>{money(fill.notionalUsd)}</td>
                      <td
                        className={
                          fill.realizedPnlUsd < 0 ? "negative-number" : ""
                        }
                      >
                        {formatMoney(fill.realizedPnlUsd, { table: true })}
                      </td>
                      <td>
                        {money(
                          fill.protocolFeesUsd + fill.estimatedBuilderFeeUsd,
                        )}
                      </td>
                      <td>
                        <a
                          className="tx-link"
                          href={primaryVenue.explorerTxUrl(fill.txDigest)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {compact(fill.txDigest)}
                          <ExternalLink size={10} />
                        </a>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="empty-fill" colSpan={8}>
                      Confirmed fills from Maker-tagged orders will appear here.
                    </td>
                  </tr>
                )}
              </tbody>
            </KitTable>
          </div>
        </Card>
      </PerformanceView>

      <VenuesView active={displayedView === "venues"}>
        <VenueBoard
          venue={primaryVenue}
          connected
          quoting={runState.running.length > 0}
          tradingKeyReady={authorizedAccounts.length > 0}
          feeText={
            builderCode
              ? `${(builderCode.integratorFee * 10_000).toFixed(0)} bps on filled orders`
              : "Not approved"
          }
          gasText={venueGasText}
          selectedMarkets={venueSelectedMarkets}
          eligibleMarkets={markets.length}
          accounts={venueAccountRows}
          totalEquityUsd={venueEquityUsd}
          grossExposureUsd={venueGrossExposureUsd}
          grossExposureLimitUsd={walletLimits?.maxGrossExposureUsd ?? 0}
          unrealizedPnlUsd={venueUnrealizedPnlUsd}
          onManage={() => selectView("accounts")}
          onNewAccount={() => void createVenueAccount()}
          {...(activeMakerAccountId
            ? {
                onRevoke: () => {
                  void revokeAgent(activeMakerAccountId);
                },
              }
            : {})}
        />

        {identity.operator && (
          <section className="lower-grid lower-grid-venues">
            <div className="fee-panel">
              <div className="section-heading compact">
                <div>
                  <h2>Venue fee</h2>
                </div>
                <Search size={18} />
              </div>
              <p className="panel-copy">
                {builderCode
                  ? `Venue code #${builderCode.integratorId} charges ${(builderCode.integratorFee * 10_000).toFixed(1)} bps on filled notional. Your one-time approval caps it at that exact rate and remains revocable.`
                  : "Venue incentives are not active. Orders carry no venue fee code until the operator completes on-chain registration."}
              </p>
              {builderCode && (
                <p className="fee-caveat">
                  Each market's current maker fee is included in its known fill
                  cost. A 1 bps venue fee can reduce a rebate or turn a narrow
                  spread negative. Maker reports it separately from strategy
                  PnL.
                </p>
              )}
              <form className="fee-form" onSubmit={inspectFee}>
                <input
                  aria-label="Integrator ID"
                  type="number"
                  min="0"
                  placeholder="Integrator ID"
                  value={integratorId}
                  onChange={(event) => setIntegratorId(event.target.value)}
                />
                <button
                  className="button secondary"
                  disabled={!setup.setup || !integratorId || Boolean(busy)}
                >
                  Inspect
                </button>
              </form>
              {inspection && (
                <div
                  className={
                    inspection.exists ? "fee-result warning" : "fee-result"
                  }
                >
                  <strong>
                    {inspection.exists
                      ? `Approved up to ${((inspection.maxIntegratorFee ?? 0) * 100).toFixed(3)}%`
                      : "No approval found"}
                  </strong>
                  <span>{new Date(inspection.checkedAt).toLocaleString()}</span>
                </div>
              )}
            </div>
          </section>
        )}

        {identity.operator && (
          <section className="operator-panel">
            <div className="section-heading compact">
              <div>
                <h2>Public access rail</h2>
              </div>
              <ShieldCheck size={18} />
            </div>
            <div className="operator-grid">
              <div className="operator-action">
                <span className="step-icon">
                  <LockKeyhole size={18} />
                </span>
                <div>
                  <strong>On-chain registry</strong>
                  <p>
                    {operatorStatus?.registryObjectId
                      ? compact(operatorStatus.registryObjectId)
                      : "Deploy the immutable package and shared member list."}
                  </p>
                </div>
                {!operatorStatus?.registryObjectId && (
                  <button
                    className="button primary"
                    onClick={() => void deployWhitelist()}
                    disabled={Boolean(busy)}
                  >
                    Deploy
                  </button>
                )}
              </div>

              <div className="operator-action">
                <span className="step-icon">
                  <Coins size={18} />
                </span>
                <div>
                  <strong>Venue incentive</strong>
                  <p>
                    {operatorStatus?.builderCode
                      ? `Code #${operatorStatus.builderCode.integratorId} / 1 bps`
                      : `Register once with ${primaryVenue.name}. Users approve the 1 bps cap.`}
                  </p>
                </div>
                {!operatorStatus?.builderCode && (
                  <button
                    className="button secondary"
                    onClick={() => void registerBuilderCode()}
                    disabled={Boolean(busy)}
                  >
                    Register
                  </button>
                )}
              </div>

              <div className="operator-action member-action">
                <span className="step-icon">
                  <UserPlus size={18} />
                </span>
                <div>
                  <strong>Wallet membership</strong>
                  <p>
                    Each change is public, signed, and independently revocable.
                  </p>
                  <input
                    aria-label="Sui wallet address"
                    placeholder="0x... wallet address"
                    value={memberAddress}
                    onChange={(event) => setMemberAddress(event.target.value)}
                  />
                </div>
                <div className="member-buttons">
                  <button
                    className="button primary"
                    onClick={() => void updateMember("add")}
                    disabled={
                      !operatorStatus?.registryObjectId ||
                      !/^0x[0-9a-fA-F]{64}$/.test(memberAddress) ||
                      Boolean(busy)
                    }
                  >
                    Add
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => void updateMember("remove")}
                    disabled={
                      !operatorStatus?.registryObjectId ||
                      !/^0x[0-9a-fA-F]{64}$/.test(memberAddress) ||
                      Boolean(busy)
                    }
                  >
                    Remove
                  </button>
                </div>
              </div>

              <div className="operator-requests">
                <div className="operator-requests-heading">
                  <div>
                    <strong>Access requests</strong>
                    <p>Stored wallet and X details from the public form.</p>
                  </div>
                  <span>
                    {
                      accessRequests.filter(
                        (candidate) => candidate.status === "pending",
                      ).length
                    }{" "}
                    pending
                  </span>
                </div>
                {accessRequests.length ? (
                  <div className="operator-request-list">
                    {accessRequests.map((candidate) => (
                      <div className="operator-request" key={candidate.id}>
                        <button
                          type="button"
                          title={candidate.walletAddress}
                          onClick={() =>
                            setMemberAddress(candidate.walletAddress)
                          }
                        >
                          {compact(candidate.walletAddress)}
                        </button>
                        <a
                          href={`https://x.com/${candidate.twitterHandle.replace(/^@/, "")}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {candidate.twitterHandle}
                          <ExternalLink size={10} aria-hidden="true" />
                        </a>
                        <time dateTime={candidate.requestedAt}>
                          {new Date(candidate.requestedAt).toLocaleDateString()}
                        </time>
                        <span className={`request-status ${candidate.status}`}>
                          {candidate.status}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="operator-requests-empty">
                    No access requests yet.
                  </p>
                )}
              </div>
            </div>
          </section>
        )}
      </VenuesView>

      <Sheet
        open={pendingStrategyDelete !== null}
        title={`Delete “${pendingStrategyDelete?.name ?? "strategy"}”?`}
        description="This archives the strategy and removes it from the strategy picker."
        onClose={() => {
          if (deleteInFlight.current) return;
          setPendingStrategyDelete(null);
          setStrategyDeleteError(null);
        }}
        initialFocusSelector="[data-delete-cancel]"
        footer={
          <>
            <Button
              variant="quiet"
              data-delete-cancel
              disabled={busy === "delete-strategy"}
              onClick={() => {
                setPendingStrategyDelete(null);
                setStrategyDeleteError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="stop"
              disabled={busy === "delete-strategy"}
              onClick={() => void deleteStrategy()}
            >
              {busy === "delete-strategy" ? "Deleting…" : "Delete strategy"}
            </Button>
          </>
        }
      >
        {strategyDeleteError && (
          <p className="field-error" role="alert">
            {strategyDeleteError}
          </p>
        )}
      </Sheet>

      <Sheet
        open={pendingStrategyExit !== null}
        title="Save strategy changes?"
        description="You have unsaved strategy changes. Choose what to do before leaving this view."
        onClose={() => setPendingStrategyExit(null)}
        footer={
          <>
            <Button
              variant="quiet"
              onClick={() => setPendingStrategyExit(null)}
              disabled={busy === "save"}
            >
              Keep editing
            </Button>
            <Button
              variant="quiet"
              onClick={discardStrategyChanges}
              disabled={busy === "save"}
            >
              Discard
            </Button>
            <Button
              variant="primary"
              onClick={saveStrategyChangesThenLeave}
              disabled={busy === "save" || !strategyValid}
            >
              {busy === "save" ? "Saving..." : "Save"}
            </Button>
          </>
        }
      >
        <p className="sheet-copy">
          Saving writes this bundle&apos;s strategy before you leave. Discarding
          restores the last saved strategy.
        </p>
      </Sheet>

      <GoLiveSheet
        open={liveSheetOpen}
        available={liveAvailable}
        venue={primaryVenue}
        marketCount={config.markets.length}
        rotationMode={config.rotationMode}
        quoteSizeUsd={config.quoteSizeUsd}
        maxGrossExposureUsd={config.maxGrossExposureUsd}
        maxRunDrawdownUsd={config.maxRunDrawdownUsd}
        hedgeAccountId={config.hedge.enabled ? config.hedge.accountId : null}
        hedgeSlippageBps={config.hedge.maxSlippageBps}
        onClose={() => setLiveSheetOpen(false)}
        onConfirm={() => {
          if (!liveAvailable) return;
          setConfig((current) => ({ ...current, mode: "live" }));
          setLiveSheetOpen(false);
        }}
      />

      <LearnView active={displayedView === "learn"} />

      <footer>
        <span>
          Maker can trade for you. Only your wallet can move money in or out.
        </span>
        <a href={primaryVenue.homeUrl} target="_blank" rel="noreferrer">
          {primaryVenue.name} <ExternalLink size={13} />
        </a>
      </footer>
      <ConnectModal ref={walletPickerRef} />
    </MakerShell>
  );
}

export function MakerDashboard() {
  return (
    <DAppKitProvider dAppKit={dAppKit}>
      <DashboardBody />
    </DAppKitProvider>
  );
}
