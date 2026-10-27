"use client";

import {
  DAppKitProvider,
  useCurrentAccount,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import { Transaction } from "@mysten/sui/transactions";
import {
  assertOwnerTransactionIntent,
  deserializeOwnerTransactionIntent,
  type SerializedOwnerTransactionIntent,
} from "@puc/aftermath/owner-transaction-intent";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CircleStop,
  Clock3,
  ExternalLink,
  Coins,
  Fuel,
  Gauge,
  KeyRound,
  LockKeyhole,
  LogOut,
  Play,
  RefreshCw,
  Search,
  Server,
  Settings2,
  Target,
  TimerReset,
  Trophy,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  UserPlus,
  WalletCards,
} from "lucide-react";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { dAppKit } from "../app/dapp-kit";
import { SpreadMark } from "./spread-mark";

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
    throw new Error("Prepared agent recipient does not match this account");
  }
  if (
    expected.gasMist !== undefined &&
    (!("gasMist" in intent) || intent.gasMist !== expected.gasMist)
  ) {
    throw new Error("Prepared agent gas grant does not match this action");
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
  };
  markets: RuntimeMarket[];
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

type AccountCap = {
  accountId: string;
  accountCapId: string;
  collateralCoinType: string;
  equityUsd: number;
  availableCollateralUsd: number;
  allocatedCollateralUsd: number;
  freeMarginUsd: number;
  positionCount: number;
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
};

type Performance = {
  asOf: string;
  period: "1D";
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
  mode: "paper" | "live";
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

const defaultConfig: MakerConfig = {
  markets: [],
  collateralCoinType: USDC,
  mode: "observe",
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

class RequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
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
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new RequestError(
      data.error ?? `Request failed: ${response.status}`,
      response.status,
    );
  }
  return data;
}

const compact = (value: string | null) =>
  value ? `${value.slice(0, 6)}...${value.slice(-4)}` : "Not set";

const money = (value: number | null, digits = 2) =>
  value === null
    ? "-"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(value);

const compactUsd = (value: number | null) =>
  value === null
    ? "-"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value);

const compactNumber = (value: number | null) =>
  value === null
    ? "-"
    : new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(value);

const compactDuration = (milliseconds: number | null) => {
  if (milliseconds === null) return "-";
  const minutes = milliseconds / 60_000;
  if (minutes < 60) return `${Math.max(1, Math.floor(minutes))}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  const days = hours / 24;
  return `${days.toFixed(days < 10 ? 1 : 0)}d`;
};

const percent = (value: number | null, digits = 2) =>
  value === null ? "-" : `${value.toFixed(digits)}%`;

const inventoryCapacityFloor = (
  quoteSizeUsd: number,
  spreadBps: number,
  inventorySkewBps: number,
) =>
  Math.ceil(
    quoteSizeUsd *
      (1 +
        Math.max(0, spreadBps) / 20_000 +
        Math.max(0, inventorySkewBps) / 10_000) *
      100,
  ) / 100;

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
  const [identity, setIdentity] = useState<AccessIdentity | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [builderCode, setBuilderCode] = useState<BuilderCode | null>(null);
  const [operatorStatus, setOperatorStatus] = useState<OperatorStatus | null>(
    null,
  );
  const [memberAddress, setMemberAddress] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [marketQuery, setMarketQuery] = useState("");
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
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [performance, setPerformance] = useState<Performance | null>(null);
  const [rewards, setRewards] = useState<RewardDashboard | null>(null);
  const [liveGates, setLiveGates] = useState<LiveGates>({
    liveTradingEnabled: false,
    mainnetAllowed: false,
  });
  const [trialMode, setTrialMode] = useState<"paper" | "live">("paper");
  const [trialArmed, setTrialArmed] = useState(false);
  const [trialResult, setTrialResult] = useState<StrategyTrialResult | null>(
    null,
  );
  const [rewardMarketCount, setRewardMarketCount] = useState(3);
  const [rewardFocus, setRewardFocus] = useState<"all" | "thin">("all");
  const [selectedAccount, setSelectedAccount] = useState("");
  const [collateralAmounts, setCollateralAmounts] = useState<
    Record<string, string>
  >({});
  const [busy, setBusy] = useState("");
  const [flattenArmed, setFlattenArmed] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [accountManagerOpen, setAccountManagerOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [integratorId, setIntegratorId] = useState("");
  const [inspection, setInspection] = useState<{
    exists: boolean;
    maxIntegratorFee: number | null;
    checkedAt: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    const [statusResult, configResult, setupResult, eventResult] =
      await Promise.all([
        request<{
          snapshot: Snapshot;
          builderCode: BuilderCode | null;
          liveGates: LiveGates;
        }>("api/status"),
        request<{ config: MakerConfig | null }>("api/config"),
        request<SetupState>("api/setup"),
        request<{ events: AuditEvent[] }>("api/events?limit=12"),
      ]);
    setSnapshot(statusResult.snapshot);
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
    const result = await request<{ performance: Performance }>(
      "api/performance",
    );
    setPerformance(result.performance);
  }, []);

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

  useEffect(() => {
    let active = true;
    request<AccessIdentity>("api/auth/me")
      .then((result) => {
        if (active) setIdentity(result);
      })
      .catch((error) => {
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
    if (!identity) return;
    void refresh().catch((error) => setNotice(String(error)));
    void loadMarkets().catch((error) => setNotice(String(error)));
    void loadPerformance().catch(() => undefined);
    if (identity.operator) {
      void request<OperatorStatus>("api/operator/status")
        .then(setOperatorStatus)
        .catch((error) => setNotice(String(error)));
    }
    const timer = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 5_000);
    const performanceTimer = setInterval(() => {
      void loadPerformance().catch(() => undefined);
    }, 30_000);
    return () => {
      clearInterval(timer);
      clearInterval(performanceTimer);
    };
  }, [identity, refresh, loadMarkets, loadPerformance]);

  useEffect(() => {
    if (!identity) return;
    void loadRewards(config.strategyObjective).catch((error) =>
      setNotice(String(error)),
    );
    const rewardsTimer = setInterval(() => {
      void loadRewards(config.strategyObjective).catch(() => undefined);
    }, 60_000);
    return () => clearInterval(rewardsTimer);
  }, [identity, config.strategyObjective, loadRewards]);

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

  const selectedCap = useMemo(
    () => accounts.find((candidate) => candidate.accountId === selectedAccount),
    [accounts, selectedAccount],
  );

  async function signIn() {
    if (!account?.address) return;
    setBusy("sign-in");
    setNotice(null);
    try {
      const challenge = await request<{
        challengeId: string;
        message: string;
      }>("api/auth/challenge", {
        method: "POST",
        body: JSON.stringify({ address: account.address }),
      });
      const signed = await wallet.signPersonalMessage({
        message: new TextEncoder().encode(challenge.message),
      });
      await request("api/auth/verify", {
        method: "POST",
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          address: account.address,
          message: challenge.message,
          signature: signed.signature,
        }),
      });
      const nextIdentity = await request<AccessIdentity>("api/auth/me");
      setIdentity(nextIdentity);
      setNotice("Wallet verified against the Sui access registry.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
      setAuthChecked(true);
    }
  }

  async function logout() {
    await request("api/auth/logout", { method: "POST", body: "{}" }).catch(
      () => undefined,
    );
    configLoaded.current = false;
    setConfig(defaultConfig);
    setSavedConfig(undefined);
    setAccountsLoaded(false);
    setIdentity(null);
    setOperatorStatus(null);
    setSnapshot(null);
  }

  async function deployWhitelist() {
    if (!account?.address) return;
    await mutate("deploy-whitelist", async () => {
      const manifest = (await fetch("/maker-access.json").then((response) =>
        response.json(),
      )) as { modules: string[]; dependencies: string[] };
      const tx = new Transaction();
      const upgradeCap = tx.publish({
        modules: manifest.modules,
        dependencies: manifest.dependencies,
      });
      tx.transferObjects([upgradeCap], account.address);
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
      );
    });
  }

  async function registerBuilderCode() {
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
            "Builder registration failed",
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
        `Builder code #${confirmed.builderCode.integratorId} registered at 1 bp.`,
      );
    });
  }

  async function updateMember(action: "add" | "remove") {
    if (!memberAddress) return;
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
      setNotice(
        action === "add"
          ? "Wallet added on-chain."
          : "Wallet removed on-chain.",
      );
      setMemberAddress("");
    });
  }

  async function mutate(label: string, action: () => Promise<void>) {
    setBusy(label);
    setNotice(null);
    try {
      await action();
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  async function createAftermathAccount() {
    if (!account?.address) return;
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
        sender: account.address,
      });
      const result = await wallet.signAndExecuteTransaction({ transaction });
      if (result.$kind === "FailedTransaction") {
        throw new Error(
          result.FailedTransaction.status.error?.message ??
            "Aftermath account creation failed",
        );
      }

      let discovered: AccountCap[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const response = await request<{ accounts: AccountCap[] }>(
          `api/accounts?collateralCoinType=${encodeURIComponent(USDC)}`,
        );
        discovered = response.accounts;
        if (discovered.length > accounts.length) break;
      }
      setAccounts(discovered);
      setSelectedAccount(discovered.at(-1)?.accountId ?? "");
      setNotice(
        discovered.length
          ? "Aftermath account created. Select it and create the agent."
          : "Account transaction confirmed; refresh account discovery shortly.",
      );
    });
  }

  async function moveCollateral(
    accountId: string,
    direction: "deposit" | "withdraw",
  ) {
    if (!account?.address) return;
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
        sender: account.address,
        amount,
        ...(direction === "withdraw" ? { recipient: account.address } : {}),
      });
      const result = await wallet.signAndExecuteTransaction({ transaction });
      if (result.$kind === "FailedTransaction") {
        throw new Error(
          result.FailedTransaction.status.error?.message ??
            `Aftermath ${direction} failed`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const response = await request<{ accounts: AccountCap[] }>(
        `api/accounts?collateralCoinType=${encodeURIComponent(USDC)}`,
      );
      setAccounts(response.accounts);
      setNotice(
        `${amountUsdc} USDC ${direction === "deposit" ? "deposited into" : "withdrawn from"} account ${accountId}.`,
      );
    });
  }

  async function provision(accountId = selectedAccount) {
    const accountCap = accounts.find(
      (candidate) => candidate.accountId === accountId,
    );
    if (!account?.address || !accountCap) return;
    await mutate(`provision-${accountId}`, async () => {
      await request("api/setup/provision", {
        method: "POST",
        body: JSON.stringify({
          ownerAddress: account.address,
          accountId: accountCap.accountId,
          accountCapId: accountCap.accountCapId,
          collateralCoinType: accountCap.collateralCoinType,
        }),
      });
      setSelectedAccount(accountId);
      setNotice(`Account ${accountId} added. One owner transaction remains.`);
    });
  }

  async function authorizeAgent(accountId = selectedAccount) {
    if (!account?.address || !accountId) return;
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
        sender: account.address,
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
        `Account ${accountId} authorized for trading and funded with agent gas.`,
      );
    });
  }

  async function revokeAgent(accountId: string) {
    if (!account?.address) return;
    await mutate(`revoke-${accountId}`, async () => {
      const built = await request<
        PreparedOwnerTransactionResponse & { agentCapId: string }
      >("api/setup/revoke-transaction", {
        method: "POST",
        body: JSON.stringify({ accountId }),
      });
      const transaction = verifiedOwnerTransaction(built, {
        kind: "revoke-agent",
        sender: account.address,
        agentCapId: built.agentCapId,
      });
      const result = await wallet.signAndExecuteTransaction({ transaction });
      if (result.$kind === "FailedTransaction") {
        throw new Error(
          result.FailedTransaction.status.error?.message ??
            "Agent revocation failed",
        );
      }
      await request("api/setup/revoke-confirm", {
        method: "POST",
        body: JSON.stringify({
          accountId,
          digest: result.Transaction.digest,
        }),
      });
      setNotice(`Account ${accountId} agent and Maker fee approval revoked.`);
    });
  }

  function toggleMarket(market: Market) {
    setConfig((current) => {
      const selected = current.markets.some(
        (item) => item.marketId === market.id,
      );
      let nextMarkets = current.markets;
      if (selected) {
        if (current.markets.length === 1) return current;
        nextMarkets = current.markets.filter(
          (item) => item.marketId !== market.id,
        );
      } else {
        if (current.markets.length >= MAX_SELECTED_MARKETS) return current;
        nextMarkets = [
          ...current.markets,
          { marketId: market.id, symbol: market.symbol },
        ];
      }
      const minimumQuoteAge = minimumObservationWindowMs(
        current.refreshMs,
        nextMarkets.length,
        current.rotationMode,
        current.maxRestingMs,
      );
      return {
        ...current,
        markets: nextMarkets,
        maxQuoteAgeMs: Math.max(current.maxQuoteAgeMs, minimumQuoteAge),
      };
    });
  }

  function applyProfile(profile: MakerConfig["strategyProfile"]) {
    const values = {
      cautious: {
        quoteSizeUsd: 5,
        spreadBps: 50,
        refreshMs: 15_000,
        maxInventoryUsd: 30,
        inventorySkewBps: 35,
      },
      balanced: {
        quoteSizeUsd: 10,
        spreadBps: 30,
        refreshMs: 8_000,
        maxInventoryUsd: 50,
        inventorySkewBps: 20,
      },
      active: {
        quoteSizeUsd: 10,
        spreadBps: 18,
        refreshMs: 4_000,
        maxInventoryUsd: 50,
        inventorySkewBps: 30,
      },
    }[profile];
    setConfig((current) => ({
      ...current,
      ...values,
      strategyProfile: profile,
      marketDwellMs: Math.max(current.marketDwellMs, values.refreshMs),
      maxRestingMs: Math.max(current.maxRestingMs, values.refreshMs),
      maxQuoteAgeMs: Math.max(
        current.maxQuoteAgeMs,
        minimumObservationWindowMs(
          values.refreshMs,
          current.markets.length,
          current.rotationMode,
          Math.max(current.maxRestingMs, values.refreshMs),
        ),
      ),
    }));
  }

  function toggleMarketOverrides(marketId: string) {
    setConfig((current) => ({
      ...current,
      markets: current.markets.map((market) => {
        if (market.marketId !== marketId) return market;
        if (market.overrides) {
          const { overrides: _overrides, ...withoutOverrides } = market;
          return withoutOverrides;
        }
        return {
          ...market,
          overrides: {
            quoteSizeUsd: current.quoteSizeUsd,
            spreadBps: current.spreadBps,
            maxInventoryUsd: current.maxInventoryUsd,
            inventoryTargetUsd: current.inventoryTargetUsd,
            inventorySkewBps: current.inventorySkewBps,
            maxLeverage: current.maxLeverage,
          },
        };
      }),
    }));
  }

  function updateMarketOverride(
    marketId: string,
    key: keyof MarketOverrides,
    value: number,
  ) {
    setConfig((current) => ({
      ...current,
      markets: current.markets.map((market) =>
        market.marketId === marketId
          ? {
              ...market,
              overrides: {
                ...market.overrides,
                [key]: value,
              },
            }
          : market,
      ),
    }));
  }

  function stageRewardRotation() {
    const candidates =
      rewards?.marketModel.opportunities
        .filter(
          (opportunity) =>
            opportunity.objectiveEligible &&
            (rewardFocus === "all" || opportunity.thinActive),
        )
        .slice(0, rewardMarketCount) ?? [];
    if (!candidates.length) {
      setNotice(
        rewardFocus === "thin"
          ? `No thin markets pass the ${config.strategyObjective} objective gates in the latest scan.`
          : `No markets pass the ${config.strategyObjective} objective gates in the latest scan.`,
      );
      return;
    }
    if (snapshot?.running || (snapshot?.portfolio.grossExposureUsd ?? 0) > 0) {
      setNotice(
        "Stop quoting and clear portfolio exposure before changing the market rotation.",
      );
      return;
    }

    const availableCollateral = makerAvailableCollateralUsd;
    const capitalBudget =
      availableCollateral !== null && availableCollateral > 0
        ? Math.min(config.maxGrossExposureUsd, availableCollateral * 0.5)
        : config.maxGrossExposureUsd;
    const marketCapacityFloors = candidates.map((opportunity) =>
      inventoryCapacityFloor(
        opportunity.minimumQuoteSizeUsd,
        opportunity.suggestedSpreadBps,
        config.inventorySkewBps,
      ),
    );
    const minimumQuoteCapital =
      config.rotationMode === "single-slot"
        ? Math.max(...marketCapacityFloors)
        : marketCapacityFloors.reduce((total, value) => total + value, 0);
    if (minimumQuoteCapital > capitalBudget) {
      setNotice(
        `These ${candidates.length} markets need at least ${money(minimumQuoteCapital)} of inventory capacity after venue minimums, lot-size rounding, and quote-price headroom. Reduce the market count or raise the gross exposure limit.`,
      );
      return;
    }

    setConfig((current) => {
      const simultaneousMarkets =
        current.rotationMode === "single-slot" ? 1 : candidates.length;
      const basePerMarketInventory = Math.max(
        1,
        Math.min(current.maxInventoryUsd, capitalBudget / simultaneousMarkets),
      );
      const collateralQuoteCap =
        availableCollateral !== null && availableCollateral > 0
          ? availableCollateral / (4 * simultaneousMarkets)
          : Number.POSITIVE_INFINITY;
      const plannedMarkets = candidates.map((opportunity) => {
        const minimumQuoteSizeUsd = opportunity.minimumQuoteSizeUsd;
        const quoteSizeUsd = Math.max(
          minimumQuoteSizeUsd,
          Math.min(
            opportunity.suggestedQuoteSizeUsd,
            Math.max(minimumQuoteSizeUsd, basePerMarketInventory / 2),
            Math.max(minimumQuoteSizeUsd, collateralQuoteCap),
          ),
        );
        return {
          marketId: opportunity.marketId,
          symbol: opportunity.symbol,
          overrides: {
            quoteSizeUsd,
            spreadBps: opportunity.suggestedSpreadBps,
            maxInventoryUsd: Math.max(
              basePerMarketInventory,
              inventoryCapacityFloor(
                quoteSizeUsd,
                opportunity.suggestedSpreadBps,
                current.inventorySkewBps,
              ),
            ),
            inventoryTargetUsd: 0,
            inventorySkewBps: current.inventorySkewBps,
            maxLeverage: 1,
          },
        };
      });
      const stagedMaxInventory = Math.max(
        ...plannedMarkets.map((market) => market.overrides.maxInventoryUsd),
      );
      const minimumQuoteAge = minimumObservationWindowMs(
        current.refreshMs,
        plannedMarkets.length,
        current.rotationMode,
        current.maxRestingMs,
      );
      return {
        ...current,
        mode: "observe",
        strategyObjective: config.strategyObjective,
        markets: plannedMarkets,
        maxInventoryUsd: stagedMaxInventory,
        maxGrossExposureUsd: Math.max(stagedMaxInventory, capitalBudget),
        maxQuoteAgeMs: Math.max(current.maxQuoteAgeMs, minimumQuoteAge),
      };
    });
    setNotice(
      `${config.strategyObjective[0]?.toUpperCase()}${config.strategyObjective.slice(1)} rotation staged across ${candidates.length} market${candidates.length === 1 ? "" : "s"} in Observe mode using ${config.rotationMode === "single-slot" ? "one live pair" : "portfolio quotes"}. Review, then save.`,
    );
  }

  async function saveConfig(event: FormEvent) {
    event.preventDefault();
    await mutate("save", async () => {
      await request("api/config", {
        method: "POST",
        body: JSON.stringify(config),
      });
      setSavedConfig(config);
      setNotice(
        snapshot?.running
          ? "Strategy saved. The next market cycle will use it."
          : "Strategy saved. It will apply when the engine starts.",
      );
    });
  }

  async function toggleRuntime() {
    const action = snapshot?.running ? "stop" : "start";
    if (action === "start" && configDirty) {
      setNotice("Save strategy changes before starting the engine.");
      return;
    }
    await mutate(action, async () => {
      await request(`api/runtime/${action}`, {
        method: "POST",
        body: "{}",
      });
    });
  }

  async function runStrategyTrial() {
    if (configDirty) {
      setNotice("Save strategy changes before starting the three-cycle trial.");
      return;
    }
    if (snapshot?.running) {
      setNotice("Stop the engine before starting the three-cycle trial.");
      return;
    }
    if (
      trialMode === "live" &&
      (!liveGates.liveTradingEnabled || !liveGates.mainnetAllowed)
    ) {
      setNotice("Both deployment gates must be enabled for a live trial.");
      return;
    }
    if (trialMode === "live" && !trialArmed) {
      setTrialArmed(true);
      setNotice(
        "Live trial will place three short quote rounds, cancel between policies, then stop and flatten both accounts. Confirm to proceed.",
      );
      return;
    }

    await mutate("strategy-trial", async () => {
      const response = await request<{
        result: StrategyTrialResult;
        snapshot: Snapshot;
      }>("api/runtime/strategy-trial", {
        method: "POST",
        body: JSON.stringify({
          mode: trialMode,
          cadenceMs: 2_000,
          maxSlippageBps: 500,
          ...(trialMode === "live"
            ? { confirmation: "RUN 3 LIVE CYCLES AND FLATTEN" }
            : {}),
        }),
      });
      setTrialArmed(false);
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
        `${trialMode === "live" ? "Live" : "Paper"} trial completed: ${response.result.rounds.length} rounds on ${response.result.symbol}${trialMode === "live" ? ", followed by cancellation and reduce-only recovery" : ""}.`,
      );
    });
  }

  async function flattenPositions() {
    if (!flattenArmed) {
      setFlattenArmed(true);
      setNotice(
        "Flatten uses reduce-only market orders across every open position on both the Maker and hedge accounts, with up to 1% slippage. Review, then confirm.",
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
          : "No open positions remained on the Maker or hedge account.",
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

  if (!authChecked) {
    return (
      <main className="loading-shell">
        <SpreadMark state="stopped" size={48} />
        <span>Checking wallet access...</span>
      </main>
    );
  }

  if (!identity) {
    return (
      <main className="access-shell">
        <header className="access-header">
          <div className="brand">
            <SpreadMark state="stopped" />
            <div>
              <strong>Maker</strong>
              <span>Aftermath / autonomous liquidity</span>
            </div>
          </div>
          <ConnectButton>Connect wallet</ConnectButton>
        </header>
        <section className="access-stage">
          <div className="access-seal">
            <LockKeyhole size={26} />
          </div>
          <span className="eyebrow">Sui mainnet access</span>
          <h1>Your wallet is the key.</h1>
          <p>
            Connect and sign a readable login message. Membership is checked
            against the public on-chain registry; signing cannot move funds.
          </p>
          <button
            className="button primary access-button"
            onClick={() => void signIn()}
            disabled={!account?.address || Boolean(busy)}
          >
            <ShieldCheck size={17} />
            {busy === "sign-in"
              ? "Check your wallet..."
              : account?.address
                ? "Verify access"
                : "Connect to continue"}
          </button>
          {notice && <div className="access-notice">{notice}</div>}
          <div className="access-proof">
            <span>Authentication</span>
            <strong>Signed message</strong>
            <span>Membership</span>
            <strong>Sui object</strong>
            <span>Trading keys</span>
            <strong>Per wallet</strong>
          </div>
        </section>
      </main>
    );
  }

  const configDirty =
    savedConfig === undefined ||
    JSON.stringify(config) !== JSON.stringify(savedConfig);
  const selectedMarketIds = new Set(
    config.markets.map((market) => market.marketId),
  );
  const activeMarket = markets.find(
    (market) => market.id === snapshot?.market.id,
  );
  const failedChecks = snapshot?.safety.filter((check) => !check.ok) ?? [];
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
  const makerAllocatedCollateralUsd =
    activeMakerSnapshot?.portfolio.allocatedCollateralUsd ??
    activeMakerCap?.allocatedCollateralUsd ??
    null;
  const makerWithdrawableCollateralUsd =
    activeMakerSnapshot?.portfolio.withdrawableCollateralUsd ??
    activeMakerCap?.availableCollateralUsd ??
    null;
  const agentGasSui = activeMakerSnapshot?.balances.gasSui ?? null;
  const readiness =
    makerEquityUsd === null
      ? { label: "Checking funds", ready: false }
      : makerEquityUsd <= 0
        ? { label: "Needs funding", ready: false }
        : agentGasSui === null
          ? { label: "Funded", ready: true }
          : agentGasSui <= 0
            ? { label: "Needs gas", ready: false }
            : { label: "Ready", ready: true };
  const onboardingComplete = Boolean(
    setup.agent && activeMakerAccount?.agentCapId,
  );
  const activeHedgeAccount = setup.accounts.find(
    (managed) => managed.accountId === config.hedge.accountId,
  );
  const marketTurnMs =
    config.rotationMode === "single-slot"
      ? config.marketDwellMs
      : config.refreshMs;
  const effectiveRefreshSeconds =
    (marketTurnMs * Math.max(1, config.markets.length)) / 1_000;
  const paidActionIntervalMs =
    config.rotationMode === "single-slot"
      ? Math.min(config.marketDwellMs, config.maxRestingMs)
      : config.refreshMs;
  const gasRunwayQuotes = snapshot?.execution.gasRunwayTransactions ?? null;
  const gasRunwayMs =
    gasRunwayQuotes === null ? null : gasRunwayQuotes * paidActionIntervalMs;
  const projectedDailyGasSui =
    snapshot?.execution.averageGasMist === null ||
    snapshot?.execution.averageGasMist === undefined
      ? null
      : (snapshot.execution.averageGasMist / 1_000_000_000) *
        (86_400_000 / paidActionIntervalMs);
  const avoidedTransactions = snapshot?.execution.avoidedTransactions ?? 0;
  const estimatedGasAvoidedSui =
    snapshot?.execution.averageGasMist === null ||
    snapshot?.execution.averageGasMist === undefined
      ? null
      : (avoidedTransactions * snapshot.execution.averageGasMist) /
        1_000_000_000;
  const activeRuntimeMarket = snapshot?.markets.find(
    (market) => market.id === snapshot.market.id,
  );
  const runMinutes = snapshot?.startedAt
    ? Math.max(
        0,
        Math.floor((Date.now() - Date.parse(snapshot.startedAt)) / 60_000),
      )
    : 0;
  const marginCeilingUsd =
    config.maxGrossExposureUsd / Math.max(1, config.maxLeverage);
  const makerEquityShare = (value: number) =>
    makerEquityUsd !== null && makerEquityUsd > 0
      ? (value / makerEquityUsd) * 100
      : null;
  const quoteEquityPct = makerEquityShare(config.quoteSizeUsd);
  const grossCapEquityPct = makerEquityShare(config.maxGrossExposureUsd);
  const rebalanceEquityPct = makerEquityShare(config.rebalanceGrossExposureUsd);
  const drawdownEquityPct = makerEquityShare(config.maxRunDrawdownUsd);
  const builderFeePerFillUsd =
    config.quoteSizeUsd * (builderCode?.integratorFee ?? 0);
  const rewardOpportunities =
    rewards?.marketModel.opportunities
      .filter((opportunity) => opportunity.eligible)
      .slice(0, MAX_SELECTED_MARKETS) ?? [];
  const focusedRewardOpportunities = rewardOpportunities.filter(
    (opportunity) =>
      opportunity.objectiveEligible &&
      (rewardFocus === "all" || opportunity.thinActive),
  );
  const topRewardOpportunity = focusedRewardOpportunities[0] ?? null;
  const rewardQuotePreviewCap =
    makerAvailableCollateralUsd !== null
      ? Math.max(
          1,
          makerAvailableCollateralUsd /
            (4 *
              (config.rotationMode === "single-slot" ? 1 : rewardMarketCount)),
        )
      : Number.POSITIVE_INFINITY;
  const rewardRotationBlocked =
    Boolean(snapshot?.running) ||
    (snapshot?.portfolio.grossExposureUsd ?? 0) > 0;
  const objectiveEvidence =
    config.strategyObjective === "farming"
      ? {
          test: "Rewards per collateral-day rise",
          evidence: rewards
            ? `${rewards.account.makerRewardsSui.toFixed(2)} SUI / ${compactUsd(rewards.account.makerVolumeUsd)} flow`
            : "Awaiting reward data",
          blindSpot: "Reward USD value and pool denominator",
        }
      : config.strategyObjective === "profit"
        ? {
            test: "Complete net trading PnL is positive",
            evidence:
              performance &&
              performance.attributed.fills + performance.hedge.fills > 0
                ? `${money(performance.combinedNetAfterKnownCostsUsd)} known result`
                : "Awaiting attributed fills",
            blindSpot: "Markouts, gas, funding, and carry",
          }
        : {
            test: "Farming and profit tests both pass",
            evidence:
              rewards &&
              performance &&
              performance.attributed.fills + performance.hedge.fills > 0
                ? `${rewards.account.makerRewardsSui.toFixed(2)} SUI + ${money(performance.combinedNetAfterKnownCostsUsd)} known`
                : "Rewards live; attributed fills pending",
            blindSpot: "Reward valuation and complete net costs",
          };
  const visibleMarkets = markets.filter((market) => {
    const query = marketQuery.trim().toLowerCase();
    return (
      !query ||
      market.symbol.toLowerCase().includes(query) ||
      market.displayName.toLowerCase().includes(query)
    );
  });
  const rotationRows = config.markets.map((selected) => {
    const runtimeMarket = snapshot?.markets.find(
      (market) => market.id === selected.marketId,
    );
    const listed = markets.find((market) => market.id === selected.marketId);
    return {
      id: selected.marketId,
      symbol: selected.symbol,
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
      volume24hUsd: runtimeMarket?.volume24hUsd ?? listed?.volume24hUsd ?? null,
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
        config.spreadBps,
      effectiveQuoteSizeUsd:
        runtimeMarket?.effectiveQuoteSizeUsd ??
        selected.overrides?.quoteSizeUsd ??
        config.quoteSizeUsd,
      lastTransactionDigest: runtimeMarket?.lastTransactionDigest ?? null,
      updatedAt: runtimeMarket?.updatedAt ?? null,
      error: runtimeMarket?.error ?? null,
    };
  });

  const markState = !snapshot?.running
    ? "stopped"
    : snapshot.mode === "live"
      ? "live"
      : "paper";

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <SpreadMark
            state={markState}
            label={`Maker is ${snapshot?.running ? snapshot.mode : "stopped"}`}
          />
          <div>
            <strong>Maker</strong>
            <span>Aftermath / autonomous liquidity</span>
          </div>
        </div>
        <div className="topbar-actions">
          <span className={`mode-badge mode-${snapshot?.mode ?? "observe"}`}>
            {snapshot?.mode ?? "observe"}
          </span>
          <ConnectButton>Connect</ConnectButton>
          <button
            className="icon-button"
            onClick={() => void logout()}
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut size={16} />
          </button>
        </div>
      </header>

      {notice && (
        <div className="notice" role="status">
          <AlertTriangle size={16} />
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss notice">
            x
          </button>
        </div>
      )}

      <section className="system-strip" aria-label="System status">
        <div>
          <Server size={16} />
          <span>Node</span>
          <strong>{snapshot?.lastError ? "Degraded" : "Connected"}</strong>
        </div>
        <div>
          <Activity size={16} />
          <span>Engine</span>
          <strong>{snapshot?.running ? "Quoting" : "Stopped"}</strong>
        </div>
        <div>
          <KeyRound size={16} />
          <span>Agent</span>
          <strong>{compact(setup.agent?.address ?? null)}</strong>
        </div>
        <div>
          <ShieldCheck size={16} />
          <span>Checks</span>
          <strong>
            {snapshot?.safety.length
              ? `${snapshot.safety.length - failedChecks.length}/${snapshot.safety.length}`
              : "Pending"}
          </strong>
        </div>
      </section>

      {!onboardingComplete && (
        <section className="onboarding">
          <div className="section-heading">
            <div>
              <span className="eyebrow">One-time setup</span>
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
                  Connect the wallet that holds the Aftermath account
                  capability.
                </p>
              </div>
              {account && (
                <span className="status-ok">{compact(account.address)}</span>
              )}
            </div>

            <div className={setup.agent ? "setup-step complete" : "setup-step"}>
              <span className="step-icon">
                <KeyRound size={19} />
              </span>
              <div className="setup-body">
                <strong>Agent capability</strong>
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
                        aria-label="Aftermath account"
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
                            Account {item.accountId} /{" "}
                            {item.equityUsd.toFixed(2)} equity /{" "}
                            {item.availableCollateralUsd.toFixed(2)} available
                          </option>
                        ))}
                      </select>
                      <button
                        className="button secondary inverse"
                        onClick={() => void createAftermathAccount()}
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
                          : "Create agent"}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p>
                      Grant trading-only access to account{" "}
                      {setup.setup?.accountId ?? selectedAccount} and seed 0.1
                      SUI gas in one owner transaction. The agent cannot
                      withdraw.
                      {builderCode ? (
                        <>
                          {" "}
                          Maker orders carry a disclosed{" "}
                          {(builderCode.integratorFee * 100).toFixed(2)}%
                          builder fee.
                        </>
                      ) : (
                        <> Builder registration must finish first.</>
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
                          ? "Authorize agent"
                          : "Builder setup pending"}
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
        <section className="account-band" aria-label="Account readiness">
          <div className="account-band-title">
            <span className="eyebrow">Account readiness</span>
            <strong>Maker account {activeMakerAccountId}</strong>
            <span className={readiness.ready ? "readiness ready" : "readiness"}>
              {readiness.label}
            </span>
            <button
              type="button"
              className="icon-button account-manager-toggle"
              onClick={() => setAccountManagerOpen((open) => !open)}
              aria-expanded={accountManagerOpen}
              aria-label="Manage Aftermath accounts"
              title="Manage Aftermath accounts"
            >
              <WalletCards size={16} aria-hidden="true" />
            </button>
          </div>
          <div>
            <span>Equity</span>
            <strong>{money(makerEquityUsd)}</strong>
          </div>
          <div>
            <span>Available</span>
            <strong>{money(makerAvailableCollateralUsd)}</strong>
          </div>
          <div>
            <span>Allocated</span>
            <strong>{money(makerAllocatedCollateralUsd)}</strong>
          </div>
          <div>
            <span>Withdrawable by owner</span>
            <strong>{money(makerWithdrawableCollateralUsd)}</strong>
          </div>
          <div>
            <span>Agent gas</span>
            <strong>
              {agentGasSui === null ? "-" : `${agentGasSui.toFixed(4)} SUI`}
            </strong>
          </div>
          <div>
            <span>Agent authority</span>
            <strong>Trade / no withdrawals</strong>
          </div>
        </section>
      )}

      {onboardingComplete && accountManagerOpen && (
        <section className="account-desk" aria-label="Aftermath accounts">
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">Account desk</span>
              <h2>Trading accounts</h2>
            </div>
            <button
              className="button secondary"
              onClick={() => void createAftermathAccount()}
              disabled={!account?.address || Boolean(busy)}
              type="button"
            >
              <UserPlus size={16} aria-hidden="true" />
              {busy === "create-account" ? "Check wallet..." : "New account"}
            </button>
          </div>
          <div className="account-desk-grid">
            {accounts.map((owned) => {
              const managed = setup.accounts.find(
                (candidate) => candidate.accountId === owned.accountId,
              );
              const isMaker = activeMakerAccountId === owned.accountId;
              const isHedge = config.hedge.accountId === owned.accountId;
              return (
                <article className="account-row" key={owned.accountId}>
                  <div className="account-row-id">
                    <strong>Account {owned.accountId}</strong>
                    <span>
                      {isMaker ? "Maker" : isHedge ? "Hedge" : "Available"}
                    </span>
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
                            : "Add agent"}
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
                            Hedge
                          </button>
                          <button
                            className="icon-button revoke-agent"
                            type="button"
                            onClick={() => void revokeAgent(owned.accountId)}
                            disabled={Boolean(busy)}
                            aria-label={`Revoke agent for account ${owned.accountId}`}
                            title="Revoke agent and Maker fee approval"
                          >
                            <ShieldOff size={15} aria-hidden="true" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      <section className="workspace">
        <div className="market-console">
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">Rotation now quoting</span>
              <h2>
                {snapshot?.market.symbol ??
                  activeMarket?.symbol ??
                  "Choose markets"}
              </h2>
            </div>
            <button
              className="icon-button"
              onClick={() =>
                void mutate("refresh", async () => {
                  await request("api/runtime/cycle", {
                    method: "POST",
                    body: "{}",
                  });
                })
              }
              title="Refresh market"
              aria-label="Refresh market"
            >
              <RefreshCw
                size={17}
                className={busy === "refresh" ? "spin" : ""}
              />
            </button>
          </div>

          <div className="price-line">
            <strong>{money(snapshot?.market.indexPrice ?? null, 4)}</strong>
            <span>
              {snapshot?.market.updatedAt
                ? new Date(snapshot.market.updatedAt).toLocaleTimeString()
                : "Awaiting first cycle"}
            </span>
          </div>

          <div className="book">
            <div className="book-side bid">
              <span className="book-label">
                <ArrowDownRight size={16} />
                Bid
              </span>
              <strong>{money(snapshot?.market.bestBid ?? null, 4)}</strong>
              <span className="our-quote">
                ours {money(snapshot?.quote?.bidPrice ?? null, 4)}
              </span>
            </div>
            <div className="book-mid">
              <span>spread</span>
              <strong>
                {activeRuntimeMarket?.effectiveSpreadBps ?? config.spreadBps}{" "}
                bps
              </strong>
              <i aria-hidden="true" />
            </div>
            <div className="book-side ask">
              <span className="book-label">
                <ArrowUpRight size={16} />
                Ask
              </span>
              <strong>{money(snapshot?.market.bestAsk ?? null, 4)}</strong>
              <span className="our-quote">
                ours {money(snapshot?.quote?.askPrice ?? null, 4)}
              </span>
            </div>
          </div>

          <div className="metric-grid">
            <div>
              <span>Account equity</span>
              <strong>{money(snapshot?.balances.equityUsd ?? null)}</strong>
            </div>
            <div>
              <span>Gross exposure</span>
              <strong>
                {money(snapshot?.portfolio.grossExposureUsd ?? null)}
              </strong>
            </div>
            <div>
              <span>Portfolio PnL</span>
              <strong>
                {money(snapshot?.portfolio.unrealizedPnlUsd ?? null)}
              </strong>
            </div>
            <div>
              <span>Market OI</span>
              <strong>
                {money(
                  snapshot?.markets.find(
                    (item) => item.id === snapshot.market.id,
                  )?.openInterestUsd ?? null,
                  0,
                )}
              </strong>
            </div>
          </div>

          <div className="run-timeline" aria-label="Run timeline">
            <div>
              <Clock3 size={15} />
              <span>Runtime</span>
              <strong>
                {snapshot?.running ? `${runMinutes} min` : "Stopped"}
              </strong>
            </div>
            <div>
              <Activity size={15} />
              <span>Last cycle</span>
              <strong>
                {snapshot?.lastSuccessfulCycleAt
                  ? new Date(
                      snapshot.lastSuccessfulCycleAt,
                    ).toLocaleTimeString()
                  : "Waiting"}
              </strong>
            </div>
            <div>
              <ShieldCheck size={15} />
              <span>Watchdog</span>
              <strong>{snapshot?.watchdog.state ?? "idle"}</strong>
            </div>
          </div>

          <div className="engine-action">
            <div>
              <span>Cycle {snapshot?.cycle ?? 0}</span>
              <strong>
                {snapshot?.lastError ??
                  (snapshot?.running
                    ? "Quoting selected markets"
                    : configDirty
                      ? "Save strategy changes before starting"
                      : "No live orders scheduled")}
              </strong>
            </div>
            <div className="engine-buttons">
              <button
                className={snapshot?.running ? "button danger" : "button start"}
                onClick={() => void toggleRuntime()}
                disabled={
                  !config.markets.length ||
                  Boolean(busy) ||
                  (!snapshot?.running && configDirty)
                }
                title={
                  !snapshot?.running && configDirty
                    ? "Save strategy changes before starting"
                    : undefined
                }
              >
                {snapshot?.running ? (
                  <CircleStop size={17} />
                ) : (
                  <Play size={17} />
                )}
                {snapshot?.running ? "Stop quoting" : "Start engine"}
              </button>
              <button
                className={flattenArmed ? "button danger" : "button secondary"}
                onClick={() => void flattenPositions()}
                disabled={
                  config.mode !== "live" ||
                  !onboardingComplete ||
                  (snapshot?.portfolio.grossExposureUsd ?? 0) <= 0 ||
                  Boolean(busy)
                }
                type="button"
              >
                <ArrowDownRight size={17} />
                {busy === "flatten"
                  ? "Flattening..."
                  : flattenArmed
                    ? "Confirm flatten"
                    : "Flatten at market"}
              </button>
              {flattenArmed && (
                <button
                  className="button secondary"
                  onClick={() => setFlattenArmed(false)}
                  disabled={Boolean(busy)}
                  type="button"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        </div>

        <form className="settings-panel" onSubmit={saveConfig}>
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">Strategy</span>
              <h2>Maker controls</h2>
            </div>
            <button
              type="button"
              className="icon-button settings-toggle"
              onClick={() => setAdvancedOpen((open) => !open)}
              aria-expanded={advancedOpen}
              aria-label={
                advancedOpen
                  ? "Hide advanced strategy controls"
                  : "Show advanced strategy controls"
              }
              title={
                advancedOpen
                  ? "Hide advanced strategy controls"
                  : "Show advanced strategy controls"
              }
            >
              <Settings2 size={18} aria-hidden="true" />
            </button>
          </div>

          <div className="execution-model" aria-label="Current execution model">
            <div>
              <span>Maker path</span>
              <strong>
                {activeMakerAccountId
                  ? `Account ${activeMakerAccountId}`
                  : "Select account"}
              </strong>
            </div>
            <div>
              <span>Hedge path</span>
              <strong
                className={config.hedge.enabled ? "available" : "unavailable"}
              >
                {config.hedge.enabled && activeHedgeAccount
                  ? `Account ${activeHedgeAccount.accountId} / ${snapshot?.hedge.state ?? "waiting"}`
                  : "Off"}
              </strong>
            </div>
          </div>

          <fieldset className="objective-control">
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
                    aria-pressed={config.strategyObjective === objective.value}
                    onClick={() =>
                      setConfig((current) => ({
                        ...current,
                        strategyObjective: objective.value,
                      }))
                    }
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

          <fieldset className="rotation-mode-control">
            <legend>Rotation</legend>
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
                    maxQuoteAgeMs: Math.max(
                      current.maxQuoteAgeMs,
                      minimumObservationWindowMs(
                        current.refreshMs,
                        current.markets.length,
                        "portfolio",
                      ),
                    ),
                  }))
                }
              >
                All pairs live
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
                    marketDwellMs: Math.max(
                      current.marketDwellMs,
                      current.refreshMs,
                    ),
                    maxRestingMs: Math.max(
                      current.maxRestingMs,
                      current.refreshMs,
                    ),
                    maxQuoteAgeMs: Math.max(
                      current.maxQuoteAgeMs,
                      minimumObservationWindowMs(
                        current.refreshMs,
                        current.markets.length,
                        "single-slot",
                        Math.max(current.maxRestingMs, current.refreshMs),
                      ),
                    ),
                  }))
                }
              >
                One live pair
              </button>
            </div>
          </fieldset>

          <div
            className="strategy-trial"
            aria-label="Three-cycle strategy trial"
          >
            <div className="strategy-trial-heading">
              <span>3-cycle canary</span>
              <strong>Farming / Profit / Both</strong>
            </div>
            <div className="strategy-trial-actions">
              <div
                className="trial-mode-segments"
                role="group"
                aria-label="Trial mode"
              >
                <button
                  type="button"
                  className={trialMode === "paper" ? "selected" : ""}
                  aria-pressed={trialMode === "paper"}
                  onClick={() => {
                    setTrialMode("paper");
                    setTrialArmed(false);
                  }}
                >
                  Paper
                </button>
                <button
                  type="button"
                  className={trialMode === "live" ? "selected" : ""}
                  aria-pressed={trialMode === "live"}
                  onClick={() => {
                    setTrialMode("live");
                    setTrialArmed(false);
                  }}
                  disabled={
                    !liveGates.liveTradingEnabled || !liveGates.mainnetAllowed
                  }
                >
                  Live
                </button>
              </div>
              <button
                type="button"
                className={trialArmed ? "button danger" : "button secondary"}
                onClick={() => void runStrategyTrial()}
                disabled={
                  Boolean(busy) ||
                  Boolean(snapshot?.running) ||
                  configDirty ||
                  !onboardingComplete
                }
              >
                <TimerReset size={16} aria-hidden="true" />
                {busy === "strategy-trial"
                  ? "Running..."
                  : trialArmed
                    ? "Confirm live"
                    : "Run 3 x 2s"}
              </button>
              {trialArmed && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setTrialArmed(false)}
                  disabled={Boolean(busy)}
                >
                  Cancel
                </button>
              )}
            </div>
            {trialResult && (
              <div className="strategy-trial-results">
                {trialResult.rounds.map((round, index) => (
                  <div key={`${trialResult.completedAt}-${round.objective}`}>
                    <span>{index + 1}</span>
                    <strong>{round.objective}</strong>
                    <small>
                      {round.spreadBps} bp / ${round.quoteSizeUsd.toFixed(2)}
                    </small>
                    <b>
                      {round.digest ? compact(round.digest) : round.outcome}
                    </b>
                  </div>
                ))}
              </div>
            )}
          </div>

          <fieldset className="account-pair-control">
            <legend>Account roles</legend>
            <div className="account-role-grid">
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
                      Account {managed.accountId}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Hedge account</span>
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
                      <option key={managed.accountId} value={managed.accountId}>
                        Account {managed.accountId}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <label className="switch-row">
              <input
                type="checkbox"
                checked={config.hedge.enabled}
                disabled={
                  !activeMakerAccountId || authorizedAccounts.length < 2
                }
                onChange={(event) => {
                  const enabled = event.target.checked;
                  const fallback = authorizedAccounts.find(
                    (managed) => managed.accountId !== activeMakerAccountId,
                  );
                  setConfig((current) => ({
                    ...current,
                    makerAccountId:
                      current.makerAccountId ?? activeMakerAccountId,
                    autoRebalanceEnabled: enabled
                      ? current.autoRebalanceEnabled
                      : false,
                    hedge: {
                      ...current.hedge,
                      enabled,
                      accountId: enabled
                        ? (current.hedge.accountId ??
                          fallback?.accountId ??
                          null)
                        : current.hedge.accountId,
                    },
                  }));
                }}
              />
              <span aria-hidden="true" />
              <strong>Fill-driven same-venue delta hedge</strong>
            </label>
            {config.hedge.enabled && (
              <>
                <div className="hedge-limit-grid">
                  <label>
                    <span>Trigger</span>
                    <div className="input-unit">
                      <b>$</b>
                      <input
                        type="number"
                        min="1"
                        max="10000"
                        value={config.hedge.thresholdUsd}
                        onChange={(event) =>
                          setConfig((current) => ({
                            ...current,
                            hedge: {
                              ...current.hedge,
                              thresholdUsd: Number(event.target.value),
                            },
                          }))
                        }
                      />
                    </div>
                  </label>
                  <label>
                    <span>Max order</span>
                    <div className="input-unit">
                      <b>$</b>
                      <input
                        type="number"
                        min={config.hedge.thresholdUsd}
                        max="10000"
                        value={config.hedge.maxOrderUsd}
                        onChange={(event) =>
                          setConfig((current) => ({
                            ...current,
                            hedge: {
                              ...current.hedge,
                              maxOrderUsd: Number(event.target.value),
                            },
                          }))
                        }
                      />
                    </div>
                  </label>
                  <label>
                    <span>Slippage</span>
                    <div className="input-unit suffix">
                      <input
                        type="number"
                        min="5"
                        max="500"
                        value={config.hedge.maxSlippageBps}
                        onChange={(event) =>
                          setConfig((current) => ({
                            ...current,
                            hedge: {
                              ...current.hedge,
                              maxSlippageBps: Number(event.target.value),
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
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        autoRebalanceEnabled: event.target.checked,
                        rebalanceGrossExposureUsd: Math.min(
                          current.rebalanceGrossExposureUsd,
                          current.maxGrossExposureUsd,
                        ),
                      }))
                    }
                  />
                  <span aria-hidden="true" />
                  <strong>Auto-rebalance dedicated accounts</strong>
                </label>
                {config.autoRebalanceEnabled && (
                  <label>
                    <span>Rebalance before gross exposure reaches</span>
                    <div className="input-unit">
                      <b>$</b>
                      <input
                        type="number"
                        min="1"
                        max={config.maxGrossExposureUsd}
                        step="0.1"
                        value={config.rebalanceGrossExposureUsd}
                        onChange={(event) =>
                          setConfig((current) => ({
                            ...current,
                            rebalanceGrossExposureUsd: Number(
                              event.target.value,
                            ),
                          }))
                        }
                      />
                    </div>
                    <small>
                      {percent(rebalanceEquityPct, 1)} of Maker equity. Cancels
                      quotes and uses reduce-only market orders on both
                      dedicated accounts.
                    </small>
                  </label>
                )}
              </>
            )}
          </fieldset>

          <fieldset>
            <legend>Profile</legend>
            <div className="segments">
              {(["cautious", "balanced", "active"] as const).map((profile) => (
                <button
                  key={profile}
                  type="button"
                  className={
                    config.strategyProfile === profile ? "selected" : ""
                  }
                  onClick={() => applyProfile(profile)}
                >
                  {profile}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="pair-picker">
            <legend>Market rotation</legend>
            <div className="pair-picker-head">
              <strong>{config.markets.length} selected</strong>
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
            <div className="pair-options">
              {!visibleMarkets.length && (
                <p className="pair-empty">No matching markets</p>
              )}
              {visibleMarkets.map((item) => {
                const selected = selectedMarketIds.has(item.id);
                return (
                  <label
                    className={
                      selected ? "pair-option selected" : "pair-option"
                    }
                    key={item.id}
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
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <details
            className={
              advancedOpen
                ? "market-overrides advanced-control visible"
                : "market-overrides advanced-control"
            }
          >
            <summary>
              <SlidersHorizontal size={15} />
              <span>Per-market overrides</span>
              <strong>
                {config.markets.filter((market) => market.overrides).length}
              </strong>
            </summary>
            <div className="override-list">
              {config.markets.map((market) => (
                <div className="override-row" key={market.marketId}>
                  <label className="override-toggle">
                    <input
                      type="checkbox"
                      checked={Boolean(market.overrides)}
                      onChange={() => toggleMarketOverrides(market.marketId)}
                    />
                    <strong>{market.symbol}</strong>
                  </label>
                  {market.overrides ? (
                    <div className="override-fields">
                      <label>
                        <span>Size $</span>
                        <input
                          type="number"
                          min="0.01"
                          max="1000"
                          step="0.01"
                          value={
                            market.overrides.quoteSizeUsd ?? config.quoteSizeUsd
                          }
                          onChange={(event) =>
                            updateMarketOverride(
                              market.marketId,
                              "quoteSizeUsd",
                              Number(event.target.value),
                            )
                          }
                        />
                      </label>
                      <label>
                        <span>Spread bp</span>
                        <input
                          type="number"
                          min="8"
                          max="500"
                          value={market.overrides.spreadBps ?? config.spreadBps}
                          onChange={(event) =>
                            updateMarketOverride(
                              market.marketId,
                              "spreadBps",
                              Number(event.target.value),
                            )
                          }
                        />
                      </label>
                      <label>
                        <span>Inventory cap $</span>
                        <input
                          type="number"
                          min="0.01"
                          max={config.maxGrossExposureUsd}
                          step="0.01"
                          value={
                            market.overrides.maxInventoryUsd ??
                            config.maxInventoryUsd
                          }
                          onChange={(event) =>
                            updateMarketOverride(
                              market.marketId,
                              "maxInventoryUsd",
                              Number(event.target.value),
                            )
                          }
                        />
                      </label>
                      <label>
                        <span>Target $</span>
                        <input
                          type="number"
                          value={
                            market.overrides.inventoryTargetUsd ??
                            config.inventoryTargetUsd
                          }
                          onChange={(event) =>
                            updateMarketOverride(
                              market.marketId,
                              "inventoryTargetUsd",
                              Number(event.target.value),
                            )
                          }
                        />
                      </label>
                      <label>
                        <span>Skew bp</span>
                        <input
                          type="number"
                          min="0"
                          max="250"
                          value={
                            market.overrides.inventorySkewBps ??
                            config.inventorySkewBps
                          }
                          onChange={(event) =>
                            updateMarketOverride(
                              market.marketId,
                              "inventorySkewBps",
                              Number(event.target.value),
                            )
                          }
                        />
                      </label>
                      <label>
                        <span>Leverage</span>
                        <input
                          type="number"
                          min="1"
                          max="3"
                          step="0.1"
                          value={
                            market.overrides.maxLeverage ?? config.maxLeverage
                          }
                          onChange={(event) =>
                            updateMarketOverride(
                              market.marketId,
                              "maxLeverage",
                              Number(event.target.value),
                            )
                          }
                        />
                      </label>
                    </div>
                  ) : (
                    <span className="override-inherited">Global defaults</span>
                  )}
                </div>
              ))}
            </div>
          </details>

          <fieldset>
            <legend>Mode</legend>
            <div className="segments">
              {(["observe", "paper", "live"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={config.mode === mode ? "selected" : ""}
                  onClick={() => setConfig((current) => ({ ...current, mode }))}
                >
                  {mode}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="field-pair">
            <label>
              <span>Quote / side</span>
              <div className="input-unit">
                <b>$</b>
                <input
                  type="number"
                  min="0.01"
                  max="1000"
                  step="0.01"
                  value={config.quoteSizeUsd}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      quoteSizeUsd: Number(event.target.value),
                    }))
                  }
                />
              </div>
              <small>{percent(quoteEquityPct, 1)} of Maker equity</small>
            </label>
            <label>
              <span>Spread</span>
              <div className="input-unit suffix">
                <input
                  type="number"
                  min="8"
                  max="500"
                  value={config.spreadBps}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      spreadBps: Number(event.target.value),
                    }))
                  }
                />
                <b>bps</b>
              </div>
            </label>
          </div>

          <div
            className={
              advancedOpen
                ? "risk-field-grid advanced-control visible"
                : "risk-field-grid advanced-control"
            }
          >
            <label>
              <span>Per-pair inventory</span>
              <div className="input-unit">
                <b>$</b>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={config.maxInventoryUsd}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      maxInventoryUsd: Number(event.target.value),
                    }))
                  }
                />
              </div>
            </label>
            <label>
              <span>Inventory target</span>
              <div className="input-unit">
                <b>$</b>
                <input
                  type="number"
                  value={config.inventoryTargetUsd}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      inventoryTargetUsd: Number(event.target.value),
                    }))
                  }
                />
              </div>
            </label>
            <label>
              <span>Gross exposure</span>
              <div className="input-unit">
                <b>$</b>
                <input
                  type="number"
                  min={config.maxInventoryUsd}
                  step="0.01"
                  value={config.maxGrossExposureUsd}
                  onChange={(event) => {
                    const maxGrossExposureUsd = Number(event.target.value);
                    setConfig((current) => ({
                      ...current,
                      maxGrossExposureUsd,
                      rebalanceGrossExposureUsd: Math.min(
                        current.rebalanceGrossExposureUsd,
                        maxGrossExposureUsd,
                      ),
                    }));
                  }}
                />
              </div>
              <small>{percent(grossCapEquityPct, 1)} of Maker equity</small>
            </label>
            <label>
              <span>Unrealized loss</span>
              <div className="input-unit">
                <b>$</b>
                <input
                  type="number"
                  min="1"
                  value={config.maxUnrealizedLossUsd}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      maxUnrealizedLossUsd: Number(event.target.value),
                    }))
                  }
                />
              </div>
            </label>
            <label>
              <span>Run drawdown</span>
              <div className="input-unit">
                <b>$</b>
                <input
                  type="number"
                  min="1"
                  value={config.maxRunDrawdownUsd}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      maxRunDrawdownUsd: Number(event.target.value),
                    }))
                  }
                />
              </div>
              <small>{percent(drawdownEquityPct, 1)} of Maker equity</small>
            </label>
            <label>
              <span>Book / index limit</span>
              <div className="input-unit suffix">
                <input
                  type="number"
                  min="1"
                  max="5000"
                  value={config.maxBookDivergenceBps}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      maxBookDivergenceBps: Number(event.target.value),
                    }))
                  }
                />
                <b>bps</b>
              </div>
            </label>
            <label>
              <span>Inventory skew</span>
              <div className="input-unit suffix">
                <input
                  type="number"
                  min="0"
                  max="250"
                  value={config.inventorySkewBps}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      inventorySkewBps: Number(event.target.value),
                    }))
                  }
                />
                <b>bps</b>
              </div>
            </label>
            <label>
              <span>Max leverage</span>
              <div className="input-unit suffix">
                <input
                  type="number"
                  min="1"
                  max="3"
                  step="0.1"
                  value={config.maxLeverage}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      maxLeverage: Number(event.target.value),
                    }))
                  }
                />
                <b>x</b>
              </div>
            </label>
          </div>

          <div
            className={
              advancedOpen
                ? "timing-controls advanced-control visible"
                : "timing-controls advanced-control"
            }
          >
            <label>
              <span>Poll interval</span>
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
                    marketDwellMs: Math.max(current.marketDwellMs, refreshMs),
                    maxRestingMs: Math.max(current.maxRestingMs, refreshMs),
                    maxQuoteAgeMs: Math.max(
                      current.maxQuoteAgeMs,
                      minimumObservationWindowMs(
                        refreshMs,
                        current.markets.length,
                        current.rotationMode,
                        Math.max(current.maxRestingMs, refreshMs),
                      ),
                    ),
                  }));
                }}
              />
              <small>{config.refreshMs / 1000}s risk and price checks</small>
            </label>
            <label>
              <span>Market dwell</span>
              <div className="input-unit suffix">
                <input
                  type="number"
                  min={Math.ceil(config.refreshMs / 1_000)}
                  max="3600"
                  step="1"
                  value={config.marketDwellMs / 1_000}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      marketDwellMs: Math.max(
                        current.refreshMs,
                        Number(event.target.value) * 1_000,
                      ),
                    }))
                  }
                />
                <b>sec</b>
              </div>
              <small>Switches the one live pair.</small>
            </label>
            <label>
              <span>Requote movement</span>
              <div className="input-unit suffix">
                <input
                  type="number"
                  min="0"
                  max="500"
                  step="0.5"
                  value={config.requoteThresholdBps}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      requoteThresholdBps: Number(event.target.value),
                    }))
                  }
                />
                <b>bps</b>
              </div>
              <small>Smaller moves keep the resting quote.</small>
            </label>
            <label>
              <span>Forced refresh</span>
              <div className="input-unit suffix">
                <input
                  type="number"
                  min={Math.ceil(config.refreshMs / 1_000)}
                  max="3600"
                  step="1"
                  value={config.maxRestingMs / 1_000}
                  onChange={(event) => {
                    const requestedMs = Number(event.target.value) * 1_000;
                    setConfig((current) => {
                      const maxRestingMs = Math.max(
                        current.refreshMs,
                        requestedMs,
                      );
                      return {
                        ...current,
                        maxRestingMs,
                        maxQuoteAgeMs: Math.max(
                          current.maxQuoteAgeMs,
                          minimumObservationWindowMs(
                            current.refreshMs,
                            current.markets.length,
                            current.rotationMode,
                            maxRestingMs,
                          ),
                        ),
                      };
                    });
                  }}
                />
                <b>sec</b>
              </div>
              <small>Maximum time before a paid requote.</small>
            </label>
            <label>
              <span>Stale-observation cutoff</span>
              <div className="input-unit suffix">
                <input
                  type="number"
                  min={Math.ceil(
                    minimumObservationWindowMs(
                      config.refreshMs,
                      config.markets.length,
                      config.rotationMode,
                      config.maxRestingMs,
                    ) / 1_000,
                  )}
                  max="86400"
                  value={config.maxQuoteAgeMs / 1_000}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      maxQuoteAgeMs: Number(event.target.value) * 1_000,
                    }))
                  }
                />
                <b>sec</b>
              </div>
              <small>Watchdog cancels on missing market observations.</small>
            </label>
          </div>

          <button
            type="submit"
            className="button primary full"
            disabled={!config.markets.length || Boolean(busy)}
          >
            {busy === "save" ? "Saving..." : "Save strategy"}
          </button>
          <p className="apply-note">
            Saved changes apply on the next market cycle.
          </p>
        </form>
      </section>

      <section className="rotation-board">
        <div className="section-heading compact rotation-heading">
          <div>
            <span className="eyebrow">Market book</span>
            <h2>Rotation and exposure</h2>
          </div>
          <span className="rotation-cadence">
            {config.markets.length} pairs / {effectiveRefreshSeconds}s full lap
          </span>
        </div>
        <div className="market-table-wrap">
          <table className="market-table">
            <thead>
              <tr>
                <th>Pair</th>
                <th>State</th>
                <th>Policy</th>
                <th>Index</th>
                <th>Open interest</th>
                <th>OI capacity</th>
                <th>24h volume</th>
                <th>Funding</th>
                <th>Inventory</th>
                <th>Unrealized PnL</th>
                <th>Freshness</th>
              </tr>
            </thead>
            <tbody>
              {rotationRows.map((row) => (
                <tr
                  key={row.id}
                  className={
                    snapshot?.market.id === row.id ? "active-market-row" : ""
                  }
                >
                  <td>
                    <strong>{row.symbol}</strong>
                    <span>{compact(row.id)}</span>
                  </td>
                  <td>
                    <span className={`desk-state state-${row.status}`}>
                      {row.status}
                    </span>
                    {row.lastTransactionDigest && (
                      <a
                        className="tx-link"
                        href={`https://suiscan.xyz/mainnet/tx/${row.lastTransactionDigest}`}
                        target="_blank"
                        rel="noreferrer"
                        title="Open last transaction"
                      >
                        {compact(row.lastTransactionDigest)}
                        <ExternalLink size={10} />
                      </a>
                    )}
                  </td>
                  <td className="dual-value">
                    <strong>{money(row.effectiveQuoteSizeUsd, 0)}</strong>
                    <span>{row.effectiveSpreadBps} bp</span>
                  </td>
                  <td>{money(row.indexPrice, 4)}</td>
                  <td className="dual-value">
                    <strong>{compactNumber(row.openInterestBase)}</strong>
                    <span>{compactUsd(row.openInterestUsd)}</span>
                  </td>
                  <td>{percent(row.openInterestUtilizationPct, 1)}</td>
                  <td>{compactUsd(row.volume24hUsd)}</td>
                  <td>
                    {percent(
                      row.fundingRate === null ? null : row.fundingRate * 100,
                      4,
                    )}
                  </td>
                  <td>{money(row.inventoryUsd)}</td>
                  <td
                    className={
                      row.unrealizedPnlUsd < 0 ? "negative-number" : ""
                    }
                  >
                    {money(row.unrealizedPnlUsd)}
                  </td>
                  <td title={row.error ?? undefined}>
                    {row.updatedAt
                      ? `${Math.max(
                          0,
                          Math.round(
                            (Date.now() - Date.parse(row.updatedAt)) / 1_000,
                          ),
                        )}s`
                      : "waiting"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="board-footnote">
          OI is one-sided and shown first in traded-asset units, then as a USD
          estimate using the displayed index price. Capacity is measured against
          the protocol limit at the data timestamp.
        </p>
      </section>

      <section className="rewards-board">
        <div className="section-heading compact rewards-heading">
          <div>
            <span className="eyebrow">Bi-weekly incentives</span>
            <h2>Reward efficiency</h2>
          </div>
          <div className="reward-heading-actions">
            <div className="reward-cutoff">
              <TimerReset size={16} aria-hidden="true" />
              <span>Next snapshot</span>
              <strong>{timeUntil(rewards?.epoch.cutoffAt ?? null)}</strong>
            </div>
            <a
              className="reward-claim-link"
              href="https://aftermath.finance/rewards"
              target="_blank"
              rel="noreferrer"
            >
              <Coins size={15} aria-hidden="true" />
              Claim rewards
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
            <span>Q-score share</span>
            <strong>
              {rewards ? percent(rewards.account.qScoreShare * 100, 3) : "-"}
            </strong>
          </div>
          <div>
            <span>Qualifying snapshots</span>
            <strong>{rewards?.account.uptime.toLocaleString() ?? "-"}</strong>
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
            <strong>{money(rewards?.account.directRebatesUsd ?? null)}</strong>
          </div>
        </div>

        <div className="objective-evidence">
          <div>
            <span>Active objective</span>
            <strong>
              {config.strategyObjective[0]?.toUpperCase()}
              {config.strategyObjective.slice(1)}
            </strong>
          </div>
          <div>
            <span>Pass condition</span>
            <strong>{objectiveEvidence.test}</strong>
          </div>
          <div>
            <span>Current evidence</span>
            <strong>{objectiveEvidence.evidence}</strong>
          </div>
          <div>
            <span>Still unmeasured</span>
            <strong>{objectiveEvidence.blindSpot}</strong>
          </div>
        </div>

        <div className="reward-command">
          <div className="reward-leader">
            <span>Best {config.strategyObjective} candidate</span>
            <strong>
              {topRewardOpportunity
                ? `#1 ${topRewardOpportunity.symbol} / ${topRewardOpportunity.score}`
                : "Scanning markets"}
            </strong>
            <small>
              {topRewardOpportunity?.reasons[0] ??
                "Live books and account rewards refresh every minute."}
            </small>
          </div>
          <div className="reward-focus" aria-label="Reward rotation focus">
            <span>Focus</span>
            <div role="group" aria-label="Reward rotation focus">
              <button
                type="button"
                className={rewardFocus === "all" ? "selected" : ""}
                aria-pressed={rewardFocus === "all"}
                onClick={() => setRewardFocus("all")}
              >
                All eligible
              </button>
              <button
                type="button"
                className={rewardFocus === "thin" ? "selected" : ""}
                aria-pressed={rewardFocus === "thin"}
                onClick={() => setRewardFocus("thin")}
              >
                Thin books
              </button>
            </div>
          </div>
          <label className="reward-count">
            <span>Markets</span>
            <input
              type="number"
              min="1"
              max={Math.max(1, focusedRewardOpportunities.length)}
              value={rewardMarketCount}
              onChange={(event) =>
                setRewardMarketCount(
                  Math.min(
                    MAX_SELECTED_MARKETS,
                    Math.max(1, Number(event.target.value) || 1),
                  ),
                )
              }
            />
          </label>
          <button
            className="button reward-stage"
            type="button"
            onClick={stageRewardRotation}
            disabled={
              rewardRotationBlocked ||
              focusedRewardOpportunities.length < rewardMarketCount
            }
            title={
              rewardRotationBlocked
                ? "Stop the engine and clear exposure before changing markets"
                : rewardFocus === "thin"
                  ? `Stage thin markets passing the ${config.strategyObjective} gates in Observe mode`
                  : `Stage the highest-ranked ${config.strategyObjective} markets in Observe mode`
            }
          >
            <Target size={16} aria-hidden="true" />
            Stage rotation
          </button>
        </div>

        <div className="reward-table-wrap">
          <table className="reward-table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Pair</th>
                <th>{config.strategyObjective} score</th>
                <th>24h flow</th>
                <th>Depth +/-50bp</th>
                <th>Flow / depth</th>
                <th>Book spread</th>
                <th>Pre-risk edge</th>
                <th>Known fill cost</th>
                <th>Suggested policy</th>
              </tr>
            </thead>
            <tbody>
              {rewardOpportunities.length ? (
                rewardOpportunities.map((opportunity) => (
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
                        <span className="objective-miss">fails objective</span>
                      ) : null}
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
                        : `${opportunity.observedSpreadBps.toFixed(1)} bp`}
                    </td>
                    <td
                      className={
                        (opportunity.preRiskEdgeBps ?? 0) > 0
                          ? "positive-number"
                          : "negative-number"
                      }
                      title="Half of the observed spread less current maker and builder fees; excludes adverse selection, gas, funding, hedging, and inventory carry"
                    >
                      {opportunity.preRiskEdgeBps === null
                        ? "-"
                        : `${opportunity.preRiskEdgeBps.toFixed(1)} bp`}
                    </td>
                    <td
                      className={
                        opportunity.knownCostBps <= 0 ? "positive-number" : ""
                      }
                    >
                      {opportunity.knownCostBps <= 0
                        ? `${Math.abs(opportunity.knownCostBps).toFixed(1)} bp rebate`
                        : `${opportunity.knownCostBps.toFixed(1)} bp`}
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
                        {opportunity.suggestedSpreadBps} bp / min{" "}
                        {money(opportunity.minimumQuoteSizeUsd, 2)}
                      </span>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="empty-fill" colSpan={10}>
                    {rewards?.account.error ??
                      "Scanning live books for eligible markets."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <details className="reward-method">
          <summary>Method and limits</summary>
          <p>{rewards?.marketModel.methodology}</p>
          <p>
            Thin books means $100-$1,000 of balanced depth within 50 bps, at
            least $10,000 of reported 24h volume, positive open interest, and an
            open, two-sided book. Farming can favor high turnover when its
            reported flow per unit of capital is stronger; this is not a reward
            guarantee.
          </p>
          <p>
            Pre-risk edge is half the observed spread less current maker and
            builder fees. It excludes adverse selection, gas, funding, hedge
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
        <div className="section-heading compact performance-heading">
          <div>
            <span className="eyebrow">Last 24 hours</span>
            <h2>Attributed strategy performance</h2>
          </div>
          <span className="coverage-badge">
            {performance?.attributed.makerVolumeCoveragePct === null ||
            performance?.attributed.makerVolumeCoveragePct === undefined
              ? "Awaiting fills"
              : `${performance.attributed.makerVolumeCoveragePct.toFixed(1)}% of maker volume traced`}
          </span>
        </div>
        <div className="performance-metrics">
          <div>
            <span>Maker fills</span>
            <strong>{performance?.attributed.fills ?? 0}</strong>
          </div>
          <div>
            <span>Attributed notional</span>
            <strong>{money(performance?.attributed.notionalUsd ?? 0)}</strong>
          </div>
          <div>
            <span>Realized PnL</span>
            <strong
              className={
                (performance?.attributed.realizedPnlUsd ?? 0) < 0
                  ? "negative-number"
                  : ""
              }
            >
              {money(performance?.attributed.realizedPnlUsd ?? 0)}
            </strong>
          </div>
          <div>
            <span>Protocol fees</span>
            <strong>
              {money(performance?.attributed.protocolFeesUsd ?? 0)}
            </strong>
          </div>
          <div>
            <span>Est. builder fees</span>
            <strong>
              {money(performance?.attributed.estimatedBuilderFeesUsd ?? 0)}
            </strong>
          </div>
          <div>
            <span>Net known result</span>
            <strong
              className={
                (performance?.attributed.netAfterKnownCostsUsd ?? 0) < 0
                  ? "negative-number"
                  : ""
              }
            >
              {money(performance?.attributed.netAfterKnownCostsUsd ?? 0)}
            </strong>
          </div>
        </div>
        <div className="hedge-performance-strip">
          <div>
            <span>Hedge account</span>
            <strong>
              {performance?.hedge.accountId
                ? `Account ${performance.hedge.accountId}`
                : "Off"}
            </strong>
          </div>
          <div>
            <span>Hedge executions / fills</span>
            <strong>
              {performance?.hedge.executions ?? 0} /{" "}
              {performance?.hedge.fills ?? 0}
            </strong>
          </div>
          <div>
            <span>Hedge notional</span>
            <strong>{money(performance?.hedge.notionalUsd ?? 0)}</strong>
          </div>
          <div>
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
        </div>
        <div className="fill-table-wrap">
          <table className="fill-table">
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
                    <td>{new Date(fill.occurredAt).toLocaleTimeString()}</td>
                    <td>{fill.symbol}</td>
                    <td>{fill.side}</td>
                    <td>{money(fill.price, 4)}</td>
                    <td>{money(fill.notionalUsd)}</td>
                    <td
                      className={
                        fill.realizedPnlUsd < 0 ? "negative-number" : ""
                      }
                    >
                      {money(fill.realizedPnlUsd)}
                    </td>
                    <td>
                      {money(
                        fill.protocolFeesUsd + fill.estimatedBuilderFeeUsd,
                      )}
                    </td>
                    <td>
                      <a
                        className="tx-link"
                        href={`https://suiscan.xyz/mainnet/tx/${fill.txDigest}`}
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
          </table>
        </div>
        <div className="performance-note">
          <span>
            Account-wide:{" "}
            {compactUsd(performance?.account?.makerVolumeUsd ?? 0)} maker volume
            / {money(performance?.account?.fundingPnlUsd ?? 0)} funding
          </span>
          <span>
            {performance?.note ??
              "Attribution starts when this release records its first order IDs."}
          </span>
        </div>
      </section>

      <section className="lower-grid">
        <div className="safety-panel">
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">Preflight</span>
              <h2>Safety gates</h2>
            </div>
            <Gauge size={18} />
          </div>
          <div className="preflight-metrics">
            <div>
              <span>Margin ceiling</span>
              <strong>{money(marginCeilingUsd)}</strong>
            </div>
            <div>
              <span>Quote / Maker equity</span>
              <strong>
                {money(config.quoteSizeUsd)} / {percent(quoteEquityPct, 1)}
              </strong>
            </div>
            <div>
              <span>Gross cap / Maker equity</span>
              <strong>
                {money(config.maxGrossExposureUsd)} /{" "}
                {percent(grossCapEquityPct, 1)}
              </strong>
            </div>
            <div>
              <span>Builder fee / fill</span>
              <strong>{money(builderFeePerFillUsd, 4)}</strong>
            </div>
            <div>
              <span>Measured gas / quote</span>
              <strong>
                {snapshot?.execution.averageGasMist === null ||
                snapshot?.execution.averageGasMist === undefined
                  ? "Learning"
                  : `${(
                      snapshot.execution.averageGasMist / 1_000_000_000
                    ).toFixed(5)} SUI`}
              </strong>
            </div>
            <div>
              <span>Gas runway</span>
              <strong>
                {gasRunwayQuotes === null
                  ? "Learning"
                  : `~${Math.floor(gasRunwayQuotes)} quotes / ${compactDuration(gasRunwayMs)}`}
              </strong>
            </div>
            <div>
              <span>Stable gas / 24h</span>
              <strong>
                {projectedDailyGasSui === null
                  ? "Learning"
                  : `~${projectedDailyGasSui.toFixed(2)} SUI`}
              </strong>
            </div>
            <div>
              <span>Paid actions avoided</span>
              <strong>
                {avoidedTransactions}
                {estimatedGasAvoidedSui === null
                  ? ""
                  : ` / ~${estimatedGasAvoidedSui.toFixed(4)} SUI`}
              </strong>
            </div>
            <div>
              <span>Last decision</span>
              <strong>{snapshot?.execution.lastDecision ?? "Waiting"}</strong>
            </div>
          </div>
          <div className="check-list">
            {(snapshot?.safety.length
              ? snapshot.safety
              : [
                  {
                    code: "waiting",
                    label: "First market cycle",
                    ok: false,
                    detail: "Start or refresh the engine",
                  },
                ]
            ).map((check) => (
              <div className="check-row" key={check.code}>
                <span className={check.ok ? "check-dot ok" : "check-dot"} />
                <div>
                  <strong>{check.label}</strong>
                  <span>{check.detail}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="audit-panel">
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">Evidence</span>
              <h2>Control log</h2>
            </div>
            <Activity size={18} />
          </div>
          <div className="event-list">
            {events.length ? (
              events.map((event) => (
                <div className="event-row" key={event.id}>
                  <time>{new Date(event.occurredAt).toLocaleTimeString()}</time>
                  <span>{event.category}</span>
                  <strong>{event.action}</strong>
                  <i className={event.outcome === "error" ? "bad" : ""}>
                    {event.outcome}
                  </i>
                </div>
              ))
            ) : (
              <p className="empty">No control events recorded.</p>
            )}
          </div>
        </div>

        <div className="fee-panel">
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">Account inspection</span>
              <h2>Builder fee</h2>
            </div>
            <Search size={18} />
          </div>
          <p className="panel-copy">
            {builderCode
              ? `Maker code #${builderCode.integratorId} charges ${(builderCode.integratorFee * 10_000).toFixed(1)} bp on filled notional. Your one-time approval caps it at that exact rate and remains revocable.`
              : "Builder incentives are not active. Orders carry no builder code until the operator completes on-chain registration."}
          </p>
          {builderCode && (
            <p className="fee-caveat">
              Each market's current maker fee is included in its known fill
              cost. A 1 bp builder fee can reduce a rebate or turn a narrow
              spread negative. Maker reports it separately from strategy PnL.
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

      {identity.operator && (
        <section className="operator-panel">
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">Operator</span>
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
                <strong>Builder incentive</strong>
                <p>
                  {operatorStatus?.builderCode
                    ? `Code #${operatorStatus.builderCode.integratorId} / 1 bp`
                    : "Register once with Aftermath. Users approve the 1 bp cap."}
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
          </div>
        </section>
      )}

      <footer>
        <span>
          Maker / wallet-gated public release / signer encrypted at rest /
          withdrawals unavailable to agent
        </span>
        <a href="https://aftermath.finance/" target="_blank" rel="noreferrer">
          Aftermath <ExternalLink size={13} />
        </a>
      </footer>
    </main>
  );
}

export function MakerDashboard() {
  return (
    <DAppKitProvider dAppKit={dAppKit}>
      <DashboardBody />
    </DAppKitProvider>
  );
}
