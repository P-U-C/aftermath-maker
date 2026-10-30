"use client";

import { Archive, Pencil, Plus } from "lucide-react";
import { useState } from "react";

import {
  activeBundles,
  availableBundleAccounts,
} from "../../lib/bundle-options";
import { formatMoney } from "../../lib/format";
import { parseNumericDraft } from "../../lib/numeric-draft";
import { Button, Card, Sheet } from "../ui/primitives";
import { useMakerRunControls } from "../maker-shell";
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
      mode: "paper";
      strategyId: string | null;
      updatedAt: string;
    },
  ) => Promise<void>;
  onCreate: (draft: {
    name: string;
    makerAccountId: string;
    takerAccountId: string;
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
    ? "Running · verify orders"
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
  const { open: openRunControls } = useMakerRunControls();
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
  const [strategyId, setStrategyId] = useState("");
  const [editingBundle, setEditingBundle] = useState<BundleCard | null>(null);
  const [editMakerAccountId, setEditMakerAccountId] = useState("");
  const [editTakerAccountId, setEditTakerAccountId] = useState("");
  const [editMode] = useState<"paper">("paper");
  const [editStrategyId, setEditStrategyId] = useState("");
  const availableMakerAccounts = availableBundleAccounts(accounts, visible);
  const availableTakerAccounts = availableBundleAccounts(
    accounts,
    visible,
    makerAccountId || null,
  );
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
  const canCreate =
    visible.length < 4 &&
    Boolean(name.trim() && makerAccountId && makerAccountId !== takerAccountId);
  const editedWalletLimits = {
    maxRunDrawdownUsd: Number(walletLimitsDraft.maxRunDrawdownUsd),
    maxInventoryUsd: Number(walletLimitsDraft.maxInventoryUsd),
    maxGrossExposureUsd: Number(walletLimitsDraft.maxGrossExposureUsd),
    maxUnrealizedLossUsd: Number(walletLimitsDraft.maxUnrealizedLossUsd),
  };
  const walletLimitErrors = {
    maxGrossExposureUsd: parseNumericDraft(
      walletLimitsDraft.maxGrossExposureUsd,
      { label: "Wallet gross exposure", unit: "USD", min: 0.01, max: 100_000 },
    ).error,
    maxInventoryUsd: parseNumericDraft(walletLimitsDraft.maxInventoryUsd, {
      label: "Wallet inventory",
      unit: "USD",
      min: 0.01,
      max: 10_000,
    }).error,
    maxRunDrawdownUsd: parseNumericDraft(walletLimitsDraft.maxRunDrawdownUsd, {
      label: "Wallet run drawdown",
      unit: "USD",
      min: 0.01,
      max: 10_000,
    }).error,
    maxUnrealizedLossUsd: parseNumericDraft(
      walletLimitsDraft.maxUnrealizedLossUsd,
      { label: "Wallet unrealized loss", unit: "USD", min: 0.01, max: 10_000 },
    ).error,
  };
  const canConfirmWalletLimitsEdit =
    Object.values(walletLimitErrors).every((error) => error === null) &&
    editedWalletLimits.maxGrossExposureUsd >=
      editedWalletLimits.maxInventoryUsd;
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
    setEditStrategyId(bundle.strategyId ?? "");
  };
  const saveAllocation = async () => {
    if (!editingBundle || !editMakerAccountId) return;
    await onUpdateAllocation(editingBundle.id, {
      makerAccountId: editMakerAccountId,
      takerAccountId: editTakerAccountId,
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
              Each bundle has its own accounts and pause control. Markets come
              from its strategy. Stop all remains available from the desk
              navigation.
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
                  {bundle.strategyName
                    ? `From ${bundle.strategyName}: ${bundle.marketIds.length ? bundle.marketIds.map((marketId) => markets.find((market) => market.id === marketId)?.symbol ?? marketId).join(", ") : "No markets selected"}`
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
                  ) : (
                    <Button
                      variant="primary"
                      onClick={() => openRunControls(bundle.id)}
                    >
                      Run controls · {bundle.name}
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
          description="Choose separate accounts and an optional reusable strategy. A bundle without one stays paused."
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
          </div>
          {!availableMakerAccounts.length && (
            <p className="bundle-create-note" role="status">
              Add or authorize an unassigned account before creating another
              bundle.
            </p>
          )}
        </Sheet>

        <Sheet
          open={Boolean(editingBundle)}
          title={editingBundle ? `Edit ${editingBundle.name}` : "Edit bundle"}
          description="Bundle allocation owns accounts, mode, and strategy. Markets are read-only from the strategy."
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
            {editingBundle?.strategyName && (
              <p className="bundle-create-note">
                From {editingBundle.strategyName}:{" "}
                {editingBundle.marketIds
                  .map(
                    (marketId) =>
                      markets.find((market) => market.id === marketId)
                        ?.symbol ?? marketId,
                  )
                  .join(", ")}
              </p>
            )}
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
                type="text"
                min="0.01"
                max={walletLimits?.maxGrossExposureUsd}
                step="0.01"
                inputMode="decimal"
                id="wallet-confirm-maxGrossExposureUsd"
                aria-invalid={Boolean(walletLimitErrors.maxGrossExposureUsd)}
                aria-describedby={
                  walletLimitErrors.maxGrossExposureUsd
                    ? "wallet-confirm-maxGrossExposureUsd-error"
                    : undefined
                }
                value={walletLimitsDraft.maxGrossExposureUsd}
                onChange={(event) =>
                  setWalletLimitsDraft((current) => ({
                    ...current,
                    maxGrossExposureUsd: event.target.value,
                  }))
                }
              />
              {walletLimitErrors.maxGrossExposureUsd && (
                <small
                  className="field-error"
                  id="wallet-confirm-maxGrossExposureUsd-error"
                  role="alert"
                >
                  {walletLimitErrors.maxGrossExposureUsd}
                </small>
              )}
              {editedWalletLimits.maxGrossExposureUsd <
                editedWalletLimits.maxInventoryUsd && (
                <small className="field-error" role="alert">
                  Wallet gross exposure must cover the wallet inventory ceiling.
                </small>
              )}
            </label>
            <label>
              <span>Inventory</span>
              <input
                type="text"
                min="0.01"
                max={walletLimits?.maxInventoryUsd}
                step="0.01"
                inputMode="decimal"
                id="wallet-confirm-maxInventoryUsd"
                aria-invalid={Boolean(walletLimitErrors.maxInventoryUsd)}
                aria-describedby={
                  walletLimitErrors.maxInventoryUsd
                    ? "wallet-confirm-maxInventoryUsd-error"
                    : undefined
                }
                value={walletLimitsDraft.maxInventoryUsd}
                onChange={(event) =>
                  setWalletLimitsDraft((current) => ({
                    ...current,
                    maxInventoryUsd: event.target.value,
                  }))
                }
              />
              {walletLimitErrors.maxInventoryUsd && (
                <small
                  className="field-error"
                  id="wallet-confirm-maxInventoryUsd-error"
                  role="alert"
                >
                  {walletLimitErrors.maxInventoryUsd}
                </small>
              )}
            </label>
            <label>
              <span>Run drawdown</span>
              <input
                type="text"
                min="0.01"
                max={walletLimits?.maxRunDrawdownUsd}
                step="0.01"
                inputMode="decimal"
                id="wallet-confirm-maxRunDrawdownUsd"
                aria-invalid={Boolean(walletLimitErrors.maxRunDrawdownUsd)}
                aria-describedby={
                  walletLimitErrors.maxRunDrawdownUsd
                    ? "wallet-confirm-maxRunDrawdownUsd-error"
                    : undefined
                }
                value={walletLimitsDraft.maxRunDrawdownUsd}
                onChange={(event) =>
                  setWalletLimitsDraft((current) => ({
                    ...current,
                    maxRunDrawdownUsd: event.target.value,
                  }))
                }
              />
              {walletLimitErrors.maxRunDrawdownUsd && (
                <small
                  className="field-error"
                  id="wallet-confirm-maxRunDrawdownUsd-error"
                  role="alert"
                >
                  {walletLimitErrors.maxRunDrawdownUsd}
                </small>
              )}
            </label>
            <label>
              <span>Unrealized loss</span>
              <input
                type="text"
                min="0.01"
                max={walletLimits?.maxUnrealizedLossUsd}
                step="0.01"
                inputMode="decimal"
                id="wallet-confirm-maxUnrealizedLossUsd"
                aria-invalid={Boolean(walletLimitErrors.maxUnrealizedLossUsd)}
                aria-describedby={
                  walletLimitErrors.maxUnrealizedLossUsd
                    ? "wallet-confirm-maxUnrealizedLossUsd-error"
                    : undefined
                }
                value={walletLimitsDraft.maxUnrealizedLossUsd}
                onChange={(event) =>
                  setWalletLimitsDraft((current) => ({
                    ...current,
                    maxUnrealizedLossUsd: event.target.value,
                  }))
                }
              />
              {walletLimitErrors.maxUnrealizedLossUsd && (
                <small
                  className="field-error"
                  id="wallet-confirm-maxUnrealizedLossUsd-error"
                  role="alert"
                >
                  {walletLimitErrors.maxUnrealizedLossUsd}
                </small>
              )}
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
                type="text"
                min="0.01"
                max="100000"
                step="0.01"
                inputMode="decimal"
                id="wallet-edit-maxGrossExposureUsd"
                aria-invalid={Boolean(walletLimitErrors.maxGrossExposureUsd)}
                aria-describedby={
                  walletLimitErrors.maxGrossExposureUsd
                    ? "wallet-edit-maxGrossExposureUsd-error"
                    : undefined
                }
                value={walletLimitsDraft.maxGrossExposureUsd}
                onChange={(event) =>
                  setWalletLimitsDraft((current) => ({
                    ...current,
                    maxGrossExposureUsd: event.target.value,
                  }))
                }
              />
              {walletLimitErrors.maxGrossExposureUsd && (
                <small
                  className="field-error"
                  id="wallet-edit-maxGrossExposureUsd-error"
                  role="alert"
                >
                  {walletLimitErrors.maxGrossExposureUsd}
                </small>
              )}
              {editedWalletLimits.maxGrossExposureUsd <
                editedWalletLimits.maxInventoryUsd && (
                <small className="field-error" role="alert">
                  Wallet gross exposure must cover the wallet inventory ceiling.
                </small>
              )}
            </label>
            <label>
              <span>Inventory</span>
              <input
                type="text"
                min="0.01"
                max="10000"
                step="0.01"
                inputMode="decimal"
                id="wallet-edit-maxInventoryUsd"
                aria-invalid={Boolean(walletLimitErrors.maxInventoryUsd)}
                aria-describedby={
                  walletLimitErrors.maxInventoryUsd
                    ? "wallet-edit-maxInventoryUsd-error"
                    : undefined
                }
                value={walletLimitsDraft.maxInventoryUsd}
                onChange={(event) =>
                  setWalletLimitsDraft((current) => ({
                    ...current,
                    maxInventoryUsd: event.target.value,
                  }))
                }
              />
              {walletLimitErrors.maxInventoryUsd && (
                <small
                  className="field-error"
                  id="wallet-edit-maxInventoryUsd-error"
                  role="alert"
                >
                  {walletLimitErrors.maxInventoryUsd}
                </small>
              )}
            </label>
            <label>
              <span>Run drawdown</span>
              <input
                type="text"
                min="0.01"
                max="10000"
                step="0.01"
                inputMode="decimal"
                id="wallet-edit-maxRunDrawdownUsd"
                aria-invalid={Boolean(walletLimitErrors.maxRunDrawdownUsd)}
                aria-describedby={
                  walletLimitErrors.maxRunDrawdownUsd
                    ? "wallet-edit-maxRunDrawdownUsd-error"
                    : undefined
                }
                value={walletLimitsDraft.maxRunDrawdownUsd}
                onChange={(event) =>
                  setWalletLimitsDraft((current) => ({
                    ...current,
                    maxRunDrawdownUsd: event.target.value,
                  }))
                }
              />
              {walletLimitErrors.maxRunDrawdownUsd && (
                <small
                  className="field-error"
                  id="wallet-edit-maxRunDrawdownUsd-error"
                  role="alert"
                >
                  {walletLimitErrors.maxRunDrawdownUsd}
                </small>
              )}
            </label>
            <label>
              <span>Unrealized loss</span>
              <input
                type="text"
                min="0.01"
                max="10000"
                step="0.01"
                inputMode="decimal"
                id="wallet-edit-maxUnrealizedLossUsd"
                aria-invalid={Boolean(walletLimitErrors.maxUnrealizedLossUsd)}
                aria-describedby={
                  walletLimitErrors.maxUnrealizedLossUsd
                    ? "wallet-edit-maxUnrealizedLossUsd-error"
                    : undefined
                }
                value={walletLimitsDraft.maxUnrealizedLossUsd}
                onChange={(event) =>
                  setWalletLimitsDraft((current) => ({
                    ...current,
                    maxUnrealizedLossUsd: event.target.value,
                  }))
                }
              />
              {walletLimitErrors.maxUnrealizedLossUsd && (
                <small
                  className="field-error"
                  id="wallet-edit-maxUnrealizedLossUsd-error"
                  role="alert"
                >
                  {walletLimitErrors.maxUnrealizedLossUsd}
                </small>
              )}
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
