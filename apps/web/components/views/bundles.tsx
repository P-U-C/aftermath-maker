"use client";

import { Archive, Pencil, Pause, Play, Plus, RotateCcw } from "lucide-react";
import { useState } from "react";

import {
  activeBundles,
  availableBundleAccounts,
  availableBundleMarkets,
} from "../../lib/bundle-options";
import { formatMoney } from "../../lib/format";
import { Button, Card, Sheet } from "../ui/primitives";
import { ViewFrame } from "./view-frame";

export type BundleCard = {
  id: string;
  name: string;
  strategyId: string | null;
  strategyName: string | null;
  needsStrategy: boolean;
  mode: "observe" | "paper" | "live";
  status: "stopped" | "running" | "paused" | "error";
  makerAccountId: string | null;
  takerAccountId: string | null;
  marketIds: string[];
  lastError: string | null;
  resultUsd: number | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type BundlesViewProps = {
  active: boolean;
  bundles: BundleCard[];
  walletLimits: {
    maxRunDrawdownUsd: number;
    maxInventoryUsd: number;
    maxGrossExposureUsd: number;
    maxUnrealizedLossUsd: number;
    confirmedAt: string | null;
  } | null;
  selectedBundleId: string | null;
  busy: boolean;
  onSelect: (bundleId: string) => void;
  onStart: (bundleId: string) => void;
  onPause: (bundleId: string) => void;
  onResume: (bundleId: string) => void;
  onArchive: (bundleId: string) => void;
  accounts: Array<{ accountId: string; label: string | null }>;
  markets: Array<{ id: string; symbol: string }>;
  strategies: Array<{ id: string; name: string }>;
  onAttachStrategy: (bundleId: string, strategyId: string) => Promise<void>;
  onUpdateAllocation: (
    bundleId: string,
    draft: {
      makerAccountId: string;
      takerAccountId: string;
      marketId: string;
      mode: "observe" | "paper";
      strategyId: string | null;
      updatedAt: string;
    },
  ) => Promise<void>;
  onCreate: (draft: {
    name: string;
    makerAccountId: string;
    takerAccountId: string;
    marketId: string;
    strategyId: string | null;
    confirmWalletLimits: boolean;
  }) => Promise<void>;
  onUpdateWalletLimits: (limits: {
    maxRunDrawdownUsd: number;
    maxInventoryUsd: number;
    maxGrossExposureUsd: number;
    maxUnrealizedLossUsd: number;
  }) => Promise<boolean>;
};

type WalletLimitsDraft = {
  maxRunDrawdownUsd: string;
  maxInventoryUsd: string;
  maxGrossExposureUsd: string;
  maxUnrealizedLossUsd: string;
};

const plainStatus = (status: BundleCard["status"]) =>
  status === "running"
    ? "Quoting now"
    : status === "paused"
      ? "Paused"
      : status === "error"
        ? "Paused — needs review"
        : "Waiting its turn";

export function BundlesView({
  active,
  bundles,
  walletLimits,
  selectedBundleId,
  busy,
  onSelect,
  onStart,
  onPause,
  onResume,
  onArchive,
  accounts,
  markets,
  strategies,
  onAttachStrategy,
  onUpdateAllocation,
  onCreate,
  onUpdateWalletLimits,
}: BundlesViewProps) {
  const visible = activeBundles(bundles);
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editLimitsOpen, setEditLimitsOpen] = useState(false);
  const [confirmLimitsEditOpen, setConfirmLimitsEditOpen] = useState(false);
  const [walletLimitsDraft, setWalletLimitsDraft] = useState<WalletLimitsDraft>(
    {
      maxRunDrawdownUsd: "",
      maxInventoryUsd: "",
      maxGrossExposureUsd: "",
      maxUnrealizedLossUsd: "",
    },
  );
  const [name, setName] = useState("");
  const [makerAccountId, setMakerAccountId] = useState("");
  const [takerAccountId, setTakerAccountId] = useState("");
  const [marketId, setMarketId] = useState("");
  const [strategyId, setStrategyId] = useState("");
  const [editingBundle, setEditingBundle] = useState<BundleCard | null>(null);
  const [editMakerAccountId, setEditMakerAccountId] = useState("");
  const [editTakerAccountId, setEditTakerAccountId] = useState("");
  const [editMarketId, setEditMarketId] = useState("");
  const [editMode, setEditMode] = useState<"observe" | "paper">("paper");
  const [editStrategyId, setEditStrategyId] = useState("");
  const availableMakerAccounts = availableBundleAccounts(accounts, visible);
  const availableTakerAccounts = availableBundleAccounts(
    accounts,
    visible,
    makerAccountId || null,
  );
  const availableMarkets = availableBundleMarkets(markets, visible);
  const editAvailableAccounts = editingBundle
    ? accounts.filter(
        (account) =>
          account.accountId === editingBundle.makerAccountId ||
          account.accountId === editingBundle.takerAccountId ||
          availableBundleAccounts(accounts, visible).some(
            (available) => available.accountId === account.accountId,
          ),
      )
    : [];
  const editAvailableMarkets = editingBundle
    ? markets.filter(
        (market) =>
          editingBundle.marketIds.includes(market.id) ||
          availableMarkets.some((available) => available.id === market.id),
      )
    : [];
  const canCreate =
    visible.length < 4 &&
    Boolean(
      name.trim() &&
      makerAccountId &&
      marketId &&
      makerAccountId !== takerAccountId,
    );
  const editedWalletLimits = {
    maxRunDrawdownUsd: Number(walletLimitsDraft.maxRunDrawdownUsd),
    maxInventoryUsd: Number(walletLimitsDraft.maxInventoryUsd),
    maxGrossExposureUsd: Number(walletLimitsDraft.maxGrossExposureUsd),
    maxUnrealizedLossUsd: Number(walletLimitsDraft.maxUnrealizedLossUsd),
  };
  const canConfirmWalletLimitsEdit = Object.values(editedWalletLimits).every(
    (value) => Number.isFinite(value) && value > 0,
  );
  const walletLimitsOnlyLowered =
    walletLimits !== null &&
    editedWalletLimits.maxRunDrawdownUsd <= walletLimits.maxRunDrawdownUsd &&
    editedWalletLimits.maxInventoryUsd <= walletLimits.maxInventoryUsd &&
    editedWalletLimits.maxGrossExposureUsd <=
      walletLimits.maxGrossExposureUsd &&
    editedWalletLimits.maxUnrealizedLossUsd <=
      walletLimits.maxUnrealizedLossUsd;
  const walletLimitsChanged =
    walletLimits !== null &&
    (editedWalletLimits.maxRunDrawdownUsd !== walletLimits.maxRunDrawdownUsd ||
      editedWalletLimits.maxInventoryUsd !== walletLimits.maxInventoryUsd ||
      editedWalletLimits.maxGrossExposureUsd !==
        walletLimits.maxGrossExposureUsd ||
      editedWalletLimits.maxUnrealizedLossUsd !==
        walletLimits.maxUnrealizedLossUsd);
  const seedWalletLimitsDraft = () => {
    if (!walletLimits) return;
    setWalletLimitsDraft({
      maxRunDrawdownUsd: String(walletLimits.maxRunDrawdownUsd),
      maxInventoryUsd: String(walletLimits.maxInventoryUsd),
      maxGrossExposureUsd: String(walletLimits.maxGrossExposureUsd),
      maxUnrealizedLossUsd: String(walletLimits.maxUnrealizedLossUsd),
    });
  };
  const submitCreate = async (confirmWalletLimits: boolean) => {
    if (!canCreate) return;
    if (confirmWalletLimits && walletLimitsChanged) {
      const saved = await onUpdateWalletLimits(editedWalletLimits);
      if (!saved) return;
    }
    await onCreate({
      name: name.trim(),
      makerAccountId,
      takerAccountId,
      marketId,
      strategyId: strategyId || null,
      confirmWalletLimits,
    });
    setConfirmOpen(false);
    setCreateOpen(false);
  };
  const openWalletLimitsEditor = () => {
    if (!walletLimits) return;
    seedWalletLimitsDraft();
    setEditLimitsOpen(true);
  };
  const openEditBundle = (bundle: BundleCard) => {
    setEditingBundle(bundle);
    setEditMakerAccountId(bundle.makerAccountId ?? "");
    setEditTakerAccountId(bundle.takerAccountId ?? "");
    setEditMarketId(bundle.marketIds[0] ?? "");
    setEditMode(bundle.mode === "observe" ? "observe" : "paper");
    setEditStrategyId(bundle.strategyId ?? "");
  };
  const saveAllocation = async () => {
    if (!editingBundle || !editMakerAccountId || !editMarketId) return;
    await onUpdateAllocation(editingBundle.id, {
      makerAccountId: editMakerAccountId,
      takerAccountId: editTakerAccountId,
      marketId: editMarketId,
      mode: editMode,
      strategyId: editStrategyId || null,
      updatedAt: editingBundle.updatedAt,
    });
    setEditingBundle(null);
  };
  const submitWalletLimitsEdit = async () => {
    if (!canConfirmWalletLimitsEdit) return;
    const saved = await onUpdateWalletLimits(editedWalletLimits);
    if (!saved) return;
    setConfirmLimitsEditOpen(false);
    setEditLimitsOpen(false);
  };
  return (
    <ViewFrame active={active} name="bundles">
      <section className="bundles-page">
        <header className="bundles-title">
          <div>
            <span className="eyebrow">Wallet desk</span>
            <h1>Bundles</h1>
            <p>
              Each bundle has its own accounts, markets, and pause control. Stop
              all remains available from the desk navigation.
            </p>
          </div>
          <div className="bundles-heading-actions">
            <span className="bundles-count">{visible.length} of 4 active</span>
            <Button
              variant="primary"
              size="small"
              onClick={() => setCreateOpen(true)}
              disabled={visible.length >= 4 || busy}
            >
              <Plus size={15} aria-hidden="true" />
              New bundle
            </Button>
          </div>
        </header>

        {walletLimits && (
          <section className="bundle-wallet-limits" aria-label="Wallet limits">
            <div className="bundle-wallet-limit-heading">
              <div className="bundle-wallet-limit-copy">
                <span>Wallet limits</span>
                <strong>
                  {walletLimits.confirmedAt
                    ? "Confirmed"
                    : "Confirm before a second bundle"}
                </strong>
              </div>
              <Button
                variant="quiet"
                size="small"
                onClick={openWalletLimitsEditor}
                disabled={busy}
              >
                <Pencil size={14} aria-hidden="true" />
                Edit wallet limits
              </Button>
            </div>
            <dl>
              <div>
                <dt>Gross exposure</dt>
                <dd>{formatMoney(walletLimits.maxGrossExposureUsd)}</dd>
              </div>
              <div>
                <dt>Inventory</dt>
                <dd>{formatMoney(walletLimits.maxInventoryUsd)}</dd>
              </div>
              <div>
                <dt>Run drawdown</dt>
                <dd>{formatMoney(walletLimits.maxRunDrawdownUsd)}</dd>
              </div>
              <div>
                <dt>Unrealized loss</dt>
                <dd>{formatMoney(walletLimits.maxUnrealizedLossUsd)}</dd>
              </div>
            </dl>
          </section>
        )}

        <div className="bundle-card-grid">
          {visible.map((bundle) => {
            const selected = selectedBundleId === bundle.id;
            const hasRun =
              bundle.status !== "paused" ||
              bundle.updatedAt !== bundle.createdAt;
            const resumable =
              bundle.status === "error" ||
              (bundle.status === "paused" && hasRun);
            return (
              <Card
                key={bundle.id}
                className={selected ? "bundle-card is-selected" : "bundle-card"}
              >
                <button
                  className="bundle-card-select"
                  type="button"
                  onClick={() => onSelect(bundle.id)}
                  aria-label={`Select ${bundle.name}`}
                  aria-pressed={selected}
                >
                  <span className={"bundle-mode mode-" + bundle.mode}>
                    {bundle.mode === "observe"
                      ? "Observe"
                      : bundle.mode === "paper"
                        ? "Paper"
                        : "Live"}
                  </span>
                  <span className={"bundle-status status-" + bundle.status}>
                    {plainStatus(bundle.status)}
                  </span>
                </button>
                <div className="bundle-card-heading">
                  <div>
                    <h2>{bundle.name}</h2>
                    <p>
                      Maker account {bundle.makerAccountId ?? "Not assigned"} ·
                      Taker account {bundle.takerAccountId ?? "Off"}
                    </p>
                  </div>
                  <strong title={formatMoney(bundle.resultUsd)}>
                    {formatMoney(bundle.resultUsd)}
                  </strong>
                </div>
                <p className="bundle-markets">
                  {bundle.marketIds.length
                    ? bundle.marketIds
                        .map(
                          (marketId) =>
                            markets.find((market) => market.id === marketId)
                              ?.symbol ?? marketId,
                        )
                        .join(", ")
                    : "No markets selected"}
                </p>
                <p className="bundle-strategy">
                  {bundle.strategyName
                    ? `Strategy: ${bundle.strategyName}`
                    : "No strategy attached"}
                </p>
                {bundle.lastError && (
                  <p className="bundle-error" role="status">
                    {bundle.lastError}
                  </p>
                )}
                <div className="bundle-actions">
                  {bundle.needsStrategy ? (
                    <label className="bundle-attach-strategy">
                      <span>Attach strategy</span>
                      <select
                        value=""
                        disabled={busy || !strategies.length}
                        onChange={(event) => {
                          if (event.target.value) {
                            void onAttachStrategy(
                              bundle.id,
                              event.target.value,
                            );
                          }
                        }}
                      >
                        <option value="">
                          {strategies.length
                            ? "Choose a strategy"
                            : "No strategies yet"}
                        </option>
                        {strategies.map((strategy) => (
                          <option key={strategy.id} value={strategy.id}>
                            {strategy.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : bundle.status === "running" ? (
                    <Button
                      variant="quiet"
                      onClick={() => onPause(bundle.id)}
                      disabled={busy}
                    >
                      <Pause size={15} aria-hidden="true" />
                      Pause
                    </Button>
                  ) : resumable ? (
                    <Button
                      variant="primary"
                      onClick={() => onResume(bundle.id)}
                      disabled={busy}
                    >
                      <RotateCcw size={15} aria-hidden="true" />
                      Resume
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      onClick={() => onStart(bundle.id)}
                      disabled={busy}
                    >
                      <Play size={15} aria-hidden="true" />
                      Start
                    </Button>
                  )}
                  {bundle.name !== "Core" && (
                    <Button
                      variant="quiet"
                      onClick={() => openEditBundle(bundle)}
                      disabled={busy || bundle.status === "running"}
                    >
                      <Pencil size={15} aria-hidden="true" />
                      Edit
                    </Button>
                  )}
                  {bundle.name !== "Core" && (
                    <Button
                      variant="quiet"
                      onClick={() => onArchive(bundle.id)}
                      disabled={busy || bundle.status === "running"}
                    >
                      <Archive size={15} aria-hidden="true" />
                      Archive
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>

        <Sheet
          open={createOpen}
          title="New Paper bundle"
          description="Choose separate accounts, a free market, and an optional reusable strategy. A bundle without one stays paused."
          onClose={() => setCreateOpen(false)}
          footer={
            <>
              <Button variant="quiet" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!canCreate || busy}
                onClick={() => {
                  if (walletLimits?.confirmedAt) {
                    void submitCreate(false);
                    return;
                  }
                  seedWalletLimitsDraft();
                  setCreateOpen(false);
                  setConfirmOpen(true);
                }}
              >
                Continue
              </Button>
            </>
          }
        >
          <div className="bundle-create-fields">
            <label>
              <span>Name</span>
              <input
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                placeholder="Rewards"
              />
            </label>
            <label>
              <span>Maker account</span>
              <select
                value={makerAccountId}
                onChange={(event) => {
                  const nextMakerAccountId = event.target.value;
                  setMakerAccountId(nextMakerAccountId);
                  setTakerAccountId((current) =>
                    current === nextMakerAccountId ? "" : current,
                  );
                }}
              >
                <option value="">Choose an available account</option>
                {availableMakerAccounts.map((account) => (
                  <option key={account.accountId} value={account.accountId}>
                    {account.label ?? `Account ${account.accountId}`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Taker account (optional)</span>
              <select
                value={takerAccountId}
                onChange={(event) => setTakerAccountId(event.target.value)}
              >
                <option value="">Off</option>
                {availableTakerAccounts.map((account) => (
                  <option key={account.accountId} value={account.accountId}>
                    {account.label ?? `Account ${account.accountId}`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Strategy</span>
              <select
                value={strategyId}
                onChange={(event) => setStrategyId(event.target.value)}
              >
                <option value="">
                  {strategies.length
                    ? "No strategy yet (bundle stays paused)"
                    : "No strategies yet. Create one first."}
                </option>
                {strategies.map((strategy) => (
                  <option key={strategy.id} value={strategy.id}>
                    {strategy.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Market</span>
              <select
                value={marketId}
                onChange={(event) => setMarketId(event.target.value)}
              >
                <option value="">Choose an available market</option>
                {availableMarkets.map((market) => (
                  <option key={market.id} value={market.id}>
                    {market.symbol}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {(!availableMakerAccounts.length || !availableMarkets.length) && (
            <p className="bundle-create-note" role="status">
              {!availableMakerAccounts.length
                ? "Add or authorize an unassigned account before creating another bundle."
                : "Every available market is already assigned to a bundle."}
            </p>
          )}
        </Sheet>

        <Sheet
          open={Boolean(editingBundle)}
          title={editingBundle ? `Edit ${editingBundle.name}` : "Edit bundle"}
          description="Bundle allocation owns its accounts, actual markets, mode, and attached strategy."
          onClose={() => setEditingBundle(null)}
          footer={
            <>
              <Button variant="quiet" onClick={() => setEditingBundle(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={
                  busy ||
                  !editMakerAccountId ||
                  !editMarketId ||
                  editMakerAccountId === editTakerAccountId
                }
                onClick={() => void saveAllocation()}
              >
                Save allocation
              </Button>
            </>
          }
        >
          <div className="bundle-create-fields">
            <label>
              <span>Maker account</span>
              <select
                value={editMakerAccountId}
                onChange={(event) => setEditMakerAccountId(event.target.value)}
              >
                <option value="">Choose an available account</option>
                {editAvailableAccounts.map((account) => (
                  <option key={account.accountId} value={account.accountId}>
                    {account.label ?? `Account ${account.accountId}`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Taker account</span>
              <select
                value={editTakerAccountId}
                onChange={(event) => setEditTakerAccountId(event.target.value)}
              >
                <option value="">Off</option>
                {editAvailableAccounts
                  .filter((account) => account.accountId !== editMakerAccountId)
                  .map((account) => (
                    <option key={account.accountId} value={account.accountId}>
                      {account.label ?? `Account ${account.accountId}`}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <span>Mode</span>
              <select
                value={editMode}
                onChange={(event) =>
                  setEditMode(event.target.value as "observe" | "paper")
                }
              >
                <option value="observe">Observe</option>
                <option value="paper">Paper</option>
              </select>
            </label>
            <label>
              <span>Strategy</span>
              <select
                value={editStrategyId}
                onChange={(event) => setEditStrategyId(event.target.value)}
              >
                <option value="">No strategy (bundle stays paused)</option>
                {strategies.map((strategy) => (
                  <option key={strategy.id} value={strategy.id}>
                    {strategy.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Market</span>
              <select
                value={editMarketId}
                onChange={(event) => setEditMarketId(event.target.value)}
              >
                <option value="">Choose an available market</option>
                {editAvailableMarkets.map((market) => (
                  <option key={market.id} value={market.id}>
                    {market.symbol}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </Sheet>

        <Sheet
          open={confirmOpen}
          title="Confirm wallet limits"
          description="These limits apply across every bundle. You can lower them here. To raise them, edit wallet limits."
          onClose={() => {
            setConfirmOpen(false);
            setCreateOpen(true);
          }}
          footer={
            <>
              <Button
                variant="quiet"
                onClick={() => {
                  setConfirmOpen(false);
                  setCreateOpen(true);
                }}
              >
                Back
              </Button>
              <Button
                variant="quiet"
                onClick={() => {
                  setConfirmOpen(false);
                  openWalletLimitsEditor();
                }}
              >
                Edit wallet limits
              </Button>
              <Button
                variant="primary"
                disabled={
                  !canConfirmWalletLimitsEdit ||
                  !walletLimitsOnlyLowered ||
                  busy
                }
                onClick={() => void submitCreate(true)}
              >
                Confirm limits and create
              </Button>
            </>
          }
        >
          <p className="bundle-confirm-copy">
            Lowering a limit applies it to every bundle before this new bundle
            is created.
          </p>
          <div className="bundle-create-fields bundle-wallet-limit-fields">
            <label>
              <span>Gross exposure</span>
              <input
                type="number"
                min="0.01"
                max={walletLimits?.maxGrossExposureUsd}
                step="0.01"
                inputMode="decimal"
                value={walletLimitsDraft.maxGrossExposureUsd}
                onChange={(event) =>
                  setWalletLimitsDraft((current) => ({
                    ...current,
                    maxGrossExposureUsd: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>Inventory</span>
              <input
                type="number"
                min="0.01"
                max={walletLimits?.maxInventoryUsd}
                step="0.01"
                inputMode="decimal"
                value={walletLimitsDraft.maxInventoryUsd}
                onChange={(event) =>
                  setWalletLimitsDraft((current) => ({
                    ...current,
                    maxInventoryUsd: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>Run drawdown</span>
              <input
                type="number"
                min="0.01"
                max={walletLimits?.maxRunDrawdownUsd}
                step="0.01"
                inputMode="decimal"
                value={walletLimitsDraft.maxRunDrawdownUsd}
                onChange={(event) =>
                  setWalletLimitsDraft((current) => ({
                    ...current,
                    maxRunDrawdownUsd: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>Unrealized loss</span>
              <input
                type="number"
                min="0.01"
                max={walletLimits?.maxUnrealizedLossUsd}
                step="0.01"
                inputMode="decimal"
                value={walletLimitsDraft.maxUnrealizedLossUsd}
                onChange={(event) =>
                  setWalletLimitsDraft((current) => ({
                    ...current,
                    maxUnrealizedLossUsd: event.target.value,
                  }))
                }
              />
            </label>
          </div>
          {!walletLimitsOnlyLowered && (
            <p className="bundle-create-note" role="status">
              This sheet can only lower limits. Use Edit wallet limits to raise
              one.
            </p>
          )}
        </Sheet>

        <Sheet
          open={editLimitsOpen}
          title="Edit wallet limits"
          description="Set the envelope shared by every running bundle in this wallet. You will review the change before it applies."
          onClose={() => setEditLimitsOpen(false)}
          footer={
            <>
              <Button variant="quiet" onClick={() => setEditLimitsOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!canConfirmWalletLimitsEdit || busy}
                onClick={() => {
                  setEditLimitsOpen(false);
                  setConfirmLimitsEditOpen(true);
                }}
              >
                Continue
              </Button>
            </>
          }
        >
          <div className="bundle-create-fields bundle-wallet-limit-fields">
            <label>
              <span>Gross exposure</span>
              <input
                type="number"
                min="0.01"
                max="100000"
                step="0.01"
                inputMode="decimal"
                value={walletLimitsDraft.maxGrossExposureUsd}
                onChange={(event) =>
                  setWalletLimitsDraft((current) => ({
                    ...current,
                    maxGrossExposureUsd: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>Inventory</span>
              <input
                type="number"
                min="0.01"
                max="10000"
                step="0.01"
                inputMode="decimal"
                value={walletLimitsDraft.maxInventoryUsd}
                onChange={(event) =>
                  setWalletLimitsDraft((current) => ({
                    ...current,
                    maxInventoryUsd: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>Run drawdown</span>
              <input
                type="number"
                min="0.01"
                max="10000"
                step="0.01"
                inputMode="decimal"
                value={walletLimitsDraft.maxRunDrawdownUsd}
                onChange={(event) =>
                  setWalletLimitsDraft((current) => ({
                    ...current,
                    maxRunDrawdownUsd: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>Unrealized loss</span>
              <input
                type="number"
                min="0.01"
                max="10000"
                step="0.01"
                inputMode="decimal"
                value={walletLimitsDraft.maxUnrealizedLossUsd}
                onChange={(event) =>
                  setWalletLimitsDraft((current) => ({
                    ...current,
                    maxUnrealizedLossUsd: event.target.value,
                  }))
                }
              />
            </label>
          </div>
        </Sheet>

        <Sheet
          open={confirmLimitsEditOpen}
          title="Confirm wallet limits"
          description="These limits apply across every running bundle. Limits below a running bundle's current use cannot be saved."
          onClose={() => setConfirmLimitsEditOpen(false)}
          footer={
            <>
              <Button
                variant="quiet"
                onClick={() => {
                  setConfirmLimitsEditOpen(false);
                  setEditLimitsOpen(true);
                }}
              >
                Back
              </Button>
              <Button
                variant="primary"
                disabled={!canConfirmWalletLimitsEdit || busy}
                onClick={submitWalletLimitsEdit}
              >
                Confirm changes
              </Button>
            </>
          }
        >
          <dl className="bundle-confirm-limits">
            <div>
              <dt>Gross exposure</dt>
              <dd>{formatMoney(editedWalletLimits.maxGrossExposureUsd)}</dd>
            </div>
            <div>
              <dt>Inventory</dt>
              <dd>{formatMoney(editedWalletLimits.maxInventoryUsd)}</dd>
            </div>
            <div>
              <dt>Run drawdown</dt>
              <dd>{formatMoney(editedWalletLimits.maxRunDrawdownUsd)}</dd>
            </div>
            <div>
              <dt>Unrealized loss</dt>
              <dd>{formatMoney(editedWalletLimits.maxUnrealizedLossUsd)}</dd>
            </div>
          </dl>
        </Sheet>
      </section>
    </ViewFrame>
  );
}
