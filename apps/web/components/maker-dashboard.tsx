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
  ExternalLink,
  Gauge,
  KeyRound,
  Play,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
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

type Snapshot = {
  mode: Mode;
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
  balances: {
    equityUsd: number | null;
    inventoryUsd: number;
    unrealizedPnlUsd: number;
    gasSui: number | null;
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
};

type MakerConfig = {
  marketId: string;
  symbol: string;
  collateralCoinType: string;
  mode: Mode;
  quoteSizeUsd: number;
  spreadBps: number;
  refreshMs: number;
  maxInventoryUsd: number;
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
  collateral: number;
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

type AuditEvent = {
  id: number;
  occurredAt: string;
  category: string;
  action: string;
  outcome: string;
  detail: Record<string, unknown>;
};

const USDC =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

const defaultConfig: MakerConfig = {
  marketId: "",
  symbol: "",
  collateralCoinType: USDC,
  mode: "observe",
  quoteSizeUsd: 10,
  spreadBps: 30,
  refreshMs: 8_000,
  maxInventoryUsd: 50,
  maxUnrealizedLossUsd: 20,
  maxLeverage: 1,
  maxGasMist: 50_000_000,
  staleBookMs: 15_000,
  inventorySkewBps: 20,
};

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
  if (!response.ok)
    throw new Error(data.error ?? `Request failed: ${response.status}`);
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

function DashboardBody() {
  const account = useCurrentAccount();
  const wallet = useDAppKit();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [config, setConfig] = useState<MakerConfig>(defaultConfig);
  const [setup, setSetup] = useState<SetupState>({ setup: null, agent: null });
  const [accounts, setAccounts] = useState<AccountCap[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [busy, setBusy] = useState("");
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
        request<{ snapshot: Snapshot }>("api/status"),
        request<{ config: MakerConfig | null }>("api/config"),
        request<SetupState>("api/setup"),
        request<{ events: AuditEvent[] }>("api/events?limit=12"),
      ]);
    setSnapshot(statusResult.snapshot);
    setSetup(setupResult);
    setEvents(eventResult.events);
    if (configResult.config) setConfig(configResult.config);
  }, []);

  const loadMarkets = useCallback(async () => {
    const result = await request<{ markets: Market[] }>(
      `api/markets?collateralCoinType=${encodeURIComponent(USDC)}`,
    );
    setMarkets(result.markets);
    if (!config.marketId && result.markets[0]) {
      setConfig((current) => ({
        ...current,
        marketId: result.markets[0]!.id,
        symbol: result.markets[0]!.symbol,
      }));
    }
  }, [config.marketId]);

  useEffect(() => {
    void refresh().catch((error) => setNotice(String(error)));
    void loadMarkets().catch((error) => setNotice(String(error)));
    const timer = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 5_000);
    return () => clearInterval(timer);
  }, [refresh, loadMarkets]);

  useEffect(() => {
    if (!account?.address || setup.setup) {
      setAccounts([]);
      return;
    }
    void request<{ accounts: AccountCap[] }>(
      `api/accounts?walletAddress=${account.address}&collateralCoinType=${encodeURIComponent(USDC)}`,
    )
      .then((result) => {
        setAccounts(result.accounts);
        setSelectedAccount(result.accounts[0]?.accountId ?? "");
      })
      .catch((error) => setNotice(error.message));
  }, [account?.address, setup.setup]);

  const selectedCap = useMemo(
    () => accounts.find((candidate) => candidate.accountId === selectedAccount),
    [accounts, selectedAccount],
  );

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

  async function saveConfig(event: FormEvent) {
    event.preventDefault();
    await mutate("save", async () => {
      await request("api/config", {
        method: "POST",
        body: JSON.stringify(config),
      });
      setNotice("Configuration saved.");
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

  const market = markets.find((item) => item.id === config.marketId);
  const failedChecks = snapshot?.safety.filter((check) => !check.ok) ?? [];
  const onboardingComplete = Boolean(setup.agent?.agentCapId);

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            M
          </span>
          <div>
            <strong>Maker</strong>
            <span>Aftermath / private control plane</span>
          </div>
        </div>
        <div className="topbar-actions">
          <span className={`mode-badge mode-${snapshot?.mode ?? "observe"}`}>
            {snapshot?.mode ?? "observe"}
          </span>
          <ConnectButton>Connect</ConnectButton>
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
                    <p>Select the Aftermath account this maker will operate.</p>
                    <div className="inline-controls">
                      <select
                        value={selectedAccount}
                        onChange={(event) =>
                          setSelectedAccount(event.target.value)
                        }
                        disabled={!accounts.length}
                      >
                        {accounts.map((item) => (
                          <option key={item.accountId} value={item.accountId}>
                            Account {item.accountId} /{" "}
                            {item.collateral.toFixed(2)} USDC
                          </option>
                        ))}
                      </select>
                      <button
                        className="button primary"
                        onClick={() => void provision()}
                        disabled={!selectedCap || Boolean(busy)}
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
                    </p>
                    <button
                      className="button primary"
                      onClick={() => void authorizeAgent()}
                      disabled={Boolean(busy)}
                    >
                      <ShieldCheck size={16} />
                      {busy === "authorize"
                        ? "Waiting for wallet..."
                        : "Authorize agent"}
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

      <section className="workspace">
        <div className="market-console">
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">Live instrument</span>
              <h2>
                {snapshot?.market.symbol ?? market?.symbol ?? "Choose a market"}
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
              <strong>{config.spreadBps} bps</strong>
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
              <span>Equity</span>
              <strong>{money(snapshot?.balances.equityUsd ?? null)}</strong>
            </div>
            <div>
              <span>Inventory</span>
              <strong>{money(snapshot?.balances.inventoryUsd ?? null)}</strong>
            </div>
            <div>
              <span>Unrealized PnL</span>
              <strong>
                {money(snapshot?.balances.unrealizedPnlUsd ?? null)}
              </strong>
            </div>
            <div>
              <span>Quote size</span>
              <strong>
                {money(snapshot?.quote?.sizeUsd ?? config.quoteSizeUsd)}
              </strong>
            </div>
          </div>

          <div className="engine-action">
            <div>
              <span>Cycle {snapshot?.cycle ?? 0}</span>
              <strong>
                {snapshot?.lastError ??
                  (snapshot?.running ? "Engine is active" : "Engine is idle")}
              </strong>
            </div>
            <button
              className={snapshot?.running ? "button danger" : "button start"}
              onClick={() => void toggleRuntime()}
              disabled={!config.marketId || Boolean(busy)}
            >
              {snapshot?.running ? (
                <CircleStop size={17} />
              ) : (
                <Play size={17} />
              )}
              {snapshot?.running ? "Stop engine" : "Start engine"}
            </button>
          </div>
        </div>

        <form className="settings-panel" onSubmit={saveConfig}>
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">Strategy</span>
              <h2>Maker controls</h2>
            </div>
            <Settings2 size={18} />
          </div>

          <label>
            <span>Market</span>
            <select
              value={config.marketId}
              onChange={(event) => {
                const next = markets.find(
                  (item) => item.id === event.target.value,
                );
                setConfig((current) => ({
                  ...current,
                  marketId: event.target.value,
                  symbol: next?.symbol ?? current.symbol,
                }));
              }}
            >
              <option value="">Select market</option>
              {markets.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.symbol} / {money(item.indexPrice, 3)}
                </option>
              ))}
            </select>
          </label>

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

          <div className="field-pair">
            <label>
              <span>Inventory limit</span>
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
              <span>Unrealized loss stop</span>
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
          </div>

          <label>
            <span>Refresh interval</span>
            <input
              type="range"
              min="2000"
              max="30000"
              step="1000"
              value={config.refreshMs}
              onChange={(event) =>
                setConfig((current) => ({
                  ...current,
                  refreshMs: Number(event.target.value),
                }))
              }
            />
            <small>{config.refreshMs / 1000}s</small>
          </label>

          <button
            type="submit"
            className="button primary full"
            disabled={!config.marketId || Boolean(busy)}
          >
            {busy === "save" ? "Saving..." : "Save strategy"}
          </button>
        </form>
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
            The public DegenYok client contains no builder-code fields. That is
            not proof of zero: check a known integrator ID against your account.
            This maker never supplies builder code.
          </p>
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

      <footer>
        <span>
          Maker / internal release / signer encrypted at rest / withdrawals
          unavailable to agent
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
