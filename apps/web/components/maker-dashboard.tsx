"use client";

import {
  DAppKitProvider,
  useCurrentAccount,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import { Transaction } from "@mysten/sui/transactions";
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
  ShieldCheck,
  SlidersHorizontal,
  UserPlus,
  WalletCards,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { dAppKit } from "../app/dapp-kit";

type Mode = "observe" | "paper" | "live";

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
    lastExecutionAt: string | null;
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
  strategyProfile: "cautious" | "balanced" | "active";
  quoteSizeUsd: number;
  spreadBps: number;
  refreshMs: number;
  maxQuoteAgeMs: number;
  maxInventoryUsd: number;
  inventoryTargetUsd: number;
  maxGrossExposureUsd: number;
  maxUnrealizedLossUsd: number;
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

type SetupState = {
  setup: {
    ownerAddress: string;
    accountId: string;
    accountCapId: string;
    collateralCoinType: string;
  } | null;
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
  fills: MakerFill[];
  note: string;
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

const defaultConfig: MakerConfig = {
  markets: [],
  collateralCoinType: USDC,
  mode: "observe",
  strategyProfile: "balanced",
  quoteSizeUsd: 10,
  spreadBps: 30,
  refreshMs: 8_000,
  maxQuoteAgeMs: 120_000,
  maxInventoryUsd: 50,
  inventoryTargetUsd: 0,
  maxGrossExposureUsd: 150,
  maxUnrealizedLossUsd: 20,
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

const percent = (value: number | null, digits = 2) =>
  value === null ? "-" : `${value.toFixed(digits)}%`;

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
  const [setup, setSetup] = useState<SetupState>({ setup: null, agent: null });
  const [accounts, setAccounts] = useState<AccountCap[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [performance, setPerformance] = useState<Performance | null>(null);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [busy, setBusy] = useState("");
  const [flattenArmed, setFlattenArmed] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
        request<{ snapshot: Snapshot; builderCode: BuilderCode | null }>(
          "api/status",
        ),
        request<{ config: MakerConfig | null }>("api/config"),
        request<SetupState>("api/setup"),
        request<{ events: AuditEvent[] }>("api/events?limit=12"),
      ]);
    setSnapshot(statusResult.snapshot);
    setBuilderCode(statusResult.builderCode);
    setSetup(setupResult);
    setEvents(eventResult.events);
    if (configResult.config) setConfig(configResult.config);
  }, []);

  const loadPerformance = useCallback(async () => {
    const result = await request<{ performance: Performance }>(
      "api/performance",
    );
    setPerformance(result.performance);
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
    if (
      !identity ||
      !account?.address ||
      account.address.toLowerCase() !== identity.ownerAddress ||
      setup.setup
    ) {
      setAccounts([]);
      return;
    }
    void request<{ accounts: AccountCap[] }>(
      `api/accounts?collateralCoinType=${encodeURIComponent(USDC)}`,
    )
      .then((result) => {
        setAccounts(result.accounts);
        setSelectedAccount(result.accounts[0]?.accountId ?? "");
      })
      .catch((error) => setNotice(error.message));
  }, [account?.address, identity, setup.setup]);

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
      const built = await request<{ transaction: string }>(
        "api/accounts/create-transaction",
        {
          method: "POST",
          body: JSON.stringify({ collateralCoinType: USDC }),
        },
      );
      const result = await wallet.signAndExecuteTransaction({
        transaction: Transaction.from(built.transaction),
      });
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

  async function provision() {
    if (!account?.address || !selectedCap) return;
    await mutate("provision", async () => {
      await request("api/setup/provision", {
        method: "POST",
        body: JSON.stringify({
          ownerAddress: account.address,
          accountId: selectedCap.accountId,
          accountCapId: selectedCap.accountCapId,
          collateralCoinType: selectedCap.collateralCoinType,
        }),
      });
      setNotice("Agent created locally. One owner transaction remains.");
    });
  }

  async function authorizeAgent() {
    await mutate("authorize", async () => {
      const built = await request<{
        transaction: string;
        agentAddress: string;
      }>("api/setup/grant-transaction", {
        method: "POST",
        body: JSON.stringify({ gasMist: "100000000" }),
      });
      const result = await wallet.signAndExecuteTransaction({
        transaction: Transaction.from(built.transaction),
      });
      if (result.$kind === "FailedTransaction") {
        throw new Error(
          result.FailedTransaction.status.error?.message ??
            "Owner transaction failed",
        );
      }
      await request("api/setup/confirm", {
        method: "POST",
        body: JSON.stringify({ digest: result.Transaction.digest }),
      });
      setNotice(
        "Agent authorized and funded. No further wallet prompts are needed.",
      );
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
        if (current.markets.length >= 12) return current;
        nextMarkets = [
          ...current.markets,
          { marketId: market.id, symbol: market.symbol },
        ];
      }
      const minimumQuoteAge =
        current.refreshMs * nextMarkets.length +
        Math.min(10_000, current.refreshMs);
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
      maxQuoteAgeMs: Math.max(
        current.maxQuoteAgeMs,
        values.refreshMs * Math.max(1, current.markets.length) +
          Math.min(10_000, values.refreshMs),
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

  async function saveConfig(event: FormEvent) {
    event.preventDefault();
    await mutate("save", async () => {
      await request("api/config", {
        method: "POST",
        body: JSON.stringify(config),
      });
      setNotice(
        snapshot?.running
          ? "Strategy saved. The next market cycle will use it."
          : "Strategy saved. It will apply when the engine starts.",
      );
    });
  }

  async function toggleRuntime() {
    const action = snapshot?.running ? "stop" : "start";
    await mutate(action, async () => {
      await request(`api/runtime/${action}`, {
        method: "POST",
        body: "{}",
      });
    });
  }

  async function flattenPositions() {
    if (!flattenArmed) {
      setFlattenArmed(true);
      setNotice(
        "Flatten uses reduce-only market orders across selected markets with up to 1% slippage. Review, then confirm.",
      );
      return;
    }
    await mutate("flatten", async () => {
      const response = await request<{
        result: { digest: string | null; flattenedMarketIds: string[] };
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
          ? `Flatten confirmed for ${response.result.flattenedMarketIds.length} market(s): ${compact(response.result.digest)}`
          : "No open positions remained in the selected markets.",
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
        <div className="loading-mark">M</div>
        <span>Checking wallet access...</span>
      </main>
    );
  }

  if (!identity) {
    return (
      <main className="access-shell">
        <header className="access-header">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              M
            </span>
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

  const selectedMarketIds = new Set(
    config.markets.map((market) => market.marketId),
  );
  const activeMarket = markets.find(
    (market) => market.id === snapshot?.market.id,
  );
  const failedChecks = snapshot?.safety.filter((check) => !check.ok) ?? [];
  const onboardingComplete = Boolean(setup.agent?.agentCapId);
  const effectiveRefreshSeconds =
    (config.refreshMs * Math.max(1, config.markets.length)) / 1_000;
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
  const builderFeePerFillUsd =
    config.quoteSizeUsd * (builderCode?.integratorFee ?? 0);
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

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            M
          </span>
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
                          <option value="">No USDC accounts found</option>
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
                        Create agent
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p>
                      Grant trading-only access and seed 0.1 SUI gas in one
                      owner transaction. The agent cannot withdraw.
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
                      onClick={() => void authorizeAgent()}
                      disabled={!builderCode || Boolean(busy)}
                    >
                      <ShieldCheck size={16} />
                      {busy === "authorize"
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
            <strong>Account {setup.setup?.accountId}</strong>
            <span
              className={
                (snapshot?.balances.equityUsd ?? 0) > 0 &&
                (snapshot?.balances.gasSui ?? 0) > 0
                  ? "readiness ready"
                  : "readiness"
              }
            >
              {(snapshot?.balances.equityUsd ?? 0) > 0 &&
              (snapshot?.balances.gasSui ?? 0) > 0
                ? "Ready"
                : "Needs funding"}
            </span>
          </div>
          <div>
            <span>Equity</span>
            <strong>{money(snapshot?.balances.equityUsd ?? null)}</strong>
          </div>
          <div>
            <span>Available</span>
            <strong>
              {money(snapshot?.portfolio.availableCollateralUsd ?? null)}
            </strong>
          </div>
          <div>
            <span>Allocated</span>
            <strong>
              {money(snapshot?.portfolio.allocatedCollateralUsd ?? null)}
            </strong>
          </div>
          <div>
            <span>Withdrawable by owner</span>
            <strong>
              {money(snapshot?.portfolio.withdrawableCollateralUsd ?? null)}
            </strong>
          </div>
          <div>
            <span>Agent gas</span>
            <strong>
              {snapshot?.balances.gasSui === null ||
              snapshot?.balances.gasSui === undefined
                ? "-"
                : `${snapshot.balances.gasSui.toFixed(4)} SUI`}
            </strong>
          </div>
          <div>
            <span>Agent authority</span>
            <strong>Trade / no withdrawals</strong>
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
                    : "No live orders scheduled")}
              </strong>
            </div>
            <div className="engine-buttons">
              <button
                className={snapshot?.running ? "button danger" : "button start"}
                onClick={() => void toggleRuntime()}
                disabled={!config.markets.length || Boolean(busy)}
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
              <span>Execution model</span>
              <strong>Inventory-aware maker</strong>
            </div>
            <div>
              <span>External hedge</span>
              <strong className="unavailable">Not connected</strong>
            </div>
          </div>

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
                      disabled={selected && config.markets.length === 1}
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
                          min="1"
                          max="1000"
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
                          min="1"
                          max={config.maxGrossExposureUsd}
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
                  min="1"
                  max="1000"
                  step="1"
                  value={config.quoteSizeUsd}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      quoteSizeUsd: Number(event.target.value),
                    }))
                  }
                />
              </div>
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
                  min="1"
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
                  value={config.maxGrossExposureUsd}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      maxGrossExposureUsd: Number(event.target.value),
                    }))
                  }
                />
              </div>
            </label>
            <label>
              <span>Loss kill switch</span>
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
              <span>Refresh interval</span>
              <input
                type="range"
                min="2000"
                max="30000"
                step="1000"
                value={config.refreshMs}
                onChange={(event) => {
                  const refreshMs = Number(event.target.value);
                  const minimumQuoteAge =
                    refreshMs * Math.max(1, config.markets.length) +
                    Math.min(10_000, refreshMs);
                  setConfig((current) => ({
                    ...current,
                    refreshMs,
                    maxQuoteAgeMs: Math.max(
                      current.maxQuoteAgeMs,
                      minimumQuoteAge,
                    ),
                  }));
                }}
              />
              <small>
                {config.refreshMs / 1000}s turn / {effectiveRefreshSeconds}s
                full lap
              </small>
            </label>
            <label>
              <span>Stale-quote cutoff</span>
              <div className="input-unit suffix">
                <input
                  type="number"
                  min={Math.ceil(
                    (config.refreshMs * Math.max(1, config.markets.length) +
                      Math.min(10_000, config.refreshMs)) /
                      1_000,
                  )}
                  max="3900"
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
              <small>Independent watchdog cancels every Maker order.</small>
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

      <section className="performance-board">
        <div className="section-heading compact performance-heading">
          <div>
            <span className="eyebrow">Last 24 hours</span>
            <h2>Attributed Maker performance</h2>
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
                {snapshot?.execution.gasRunwayTransactions === null ||
                snapshot?.execution.gasRunwayTransactions === undefined
                  ? "Learning"
                  : `~${Math.floor(snapshot.execution.gasRunwayTransactions)} quotes`}
              </strong>
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
              At 1 bp this exceeds the base 0.5 bp maker rebate before any
              market-share rebate, spread capture, or adverse selection. Maker
              reports it separately from strategy PnL.
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
