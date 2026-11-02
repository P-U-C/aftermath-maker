"use client";

import { Archive, Check, Circle, Pencil, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  activeBundles,
  availableBundleAccounts,
} from "../../lib/bundle-options";
import { formatMoney } from "../../lib/format";
import {
  nextStage,
  stageTitle,
  type BundleReadiness,
  type BundleStageId,
} from "../../lib/bundle-readiness";
import {
  formatPaperBlocker,
  relativeAccountRead,
} from "../../lib/paper-blocker";
import type { RunState } from "../../lib/run-state";
import { parseNumericDraft } from "../../lib/numeric-draft";
import { Button, Card, PageHeader, Sheet } from "../ui/primitives";
import { useMakerRunControls } from "../maker-shell";
import { RunStatusChip } from "../run-control";
import { ViewFrame } from "./view-frame";

export type BundleEditorRequest = {
  token: number;
  kind: "create" | "edit" | "wallet-limits";
  strategyId?: string;
  bundleId?: string;
};

export type BundleCreationResult =
  { ok: true; bundleId: string } | { ok: false; error: string };

export type BundleCard = {
  id: string;
  name: string;
  strategyId: string | null;
  strategyName: string | null;
  needsStrategy: boolean;
  readiness?: BundleReadiness | null;
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
  editorRequest?: BundleEditorRequest | null;
  returnToStrategy?: boolean;
  onReturnToStrategy?: () => void;
  onOpenAccounts?: () => void;
  busy: boolean;
  run: RunState;
  onSelect: (bundleId: string) => void;
  onArchive: (bundleId: string) => void;
  onFixStage: (bundle: BundleCard, stage: BundleStageId) => void;
  onStart: (bundleId: string) => void;
  accounts: Array<{
    accountId: string;
    label: string | null;
    authorized: boolean;
  }>;
  markets: Array<{ id: string; symbol: string }>;
  strategies: Array<{
    id: string;
    name: string;
    marketCount: number;
    cycleIntervalMs?: number;
    requiresHedge: boolean;
  }>;
  onAttachStrategy: (bundleId: string, strategyId: string) => Promise<void>;
  onUpdateAllocation: (
    bundleId: string,
    draft: {
      makerAccountId: string;
      takerAccountId: string;
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
  }) => Promise<BundleCreationResult>;
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

export function BundlesView({
  active,
  bundles,
  walletLimits,
  selectedBundleId,
  editorRequest,
  returnToStrategy = false,
  onReturnToStrategy,
  onOpenAccounts,
  busy,
  run,
  onSelect,
  onArchive,
  onFixStage,
  onStart,
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
  const [createError, setCreateError] = useState<string | null>(null);
  const createSubmitting = useRef(false);
  const handledEditorRequest = useRef<number | null>(null);
  const [makerAccountId, setMakerAccountId] = useState("");
  const [takerAccountId, setTakerAccountId] = useState("");
  const [strategyId, setStrategyId] = useState("");
  const [editingBundle, setEditingBundle] = useState<BundleCard | null>(null);
  const editingBundleRun = editingBundle
    ? (run.bundles.find((bundle) => bundle.id === editingBundle.id) ?? null)
    : null;
  const editingBundleActive =
    editingBundleRun?.phase === "running" ||
    editingBundleRun?.phase === "attention" ||
    editingBundleRun?.phase === "starting" ||
    editingBundleRun?.phase === "pausing" ||
    editingBundleRun?.phase === "stopping";
  const [editMakerAccountId, setEditMakerAccountId] = useState("");
  const [editTakerAccountId, setEditTakerAccountId] = useState("");
  useEffect(
    () => setCreateError(null),
    [name, makerAccountId, takerAccountId, strategyId, walletLimitsDraft],
  );
  const [editStrategyId, setEditStrategyId] = useState("");
  const authorizedAccounts = accounts.filter((account) => account.authorized);
  const availableMakerAccounts = availableBundleAccounts(
    authorizedAccounts,
    visible,
  );
  const availableTakerAccounts = availableBundleAccounts(
    authorizedAccounts,
    visible,
    makerAccountId || null,
  );
  const editAvailableAccounts = editingBundle
    ? accounts.filter(
        (account) =>
          account.accountId === editingBundle.makerAccountId ||
          account.accountId === editingBundle.takerAccountId ||
          availableBundleAccounts(authorizedAccounts, visible).some(
            (available) => available.accountId === account.accountId,
          ),
      )
    : [];
  const chosenCreateStrategy = strategies.find(
    (strategy) => strategy.id === strategyId,
  );
  const canCreate =
    visible.length < 4 &&
    Boolean(
      name.trim() && makerAccountId && makerAccountId !== takerAccountId,
    ) &&
    (!strategyId || Boolean(chosenCreateStrategy?.marketCount)) &&
    (!chosenCreateStrategy?.requiresHedge || Boolean(takerAccountId));
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
    if (!canCreate || createSubmitting.current) return;
    createSubmitting.current = true;
    setCreateError(null);
    try {
      if (confirmWalletLimits && walletLimitsChanged) {
        const saved = await onUpdateWalletLimits(editedWalletLimits);
        if (!saved) {
          setCreateError(
            "Wallet limits could not be confirmed. Review the limit values and try again.",
          );
          return;
        }
      }
      const result = await onCreate({
        name: name.trim(),
        makerAccountId,
        takerAccountId,
        strategyId: strategyId || null,
        confirmWalletLimits,
      });
      if (!result.ok) {
        setCreateError(result.error);
        return;
      }
      setConfirmOpen(false);
      setCreateOpen(false);
    } finally {
      createSubmitting.current = false;
    }
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
  useEffect(() => {
    if (!editorRequest || handledEditorRequest.current === editorRequest.token)
      return;
    handledEditorRequest.current = editorRequest.token;
    if (editorRequest.kind === "create") {
      setStrategyId(editorRequest.strategyId ?? "");
      const chosen = strategies.find(
        (strategy) => strategy.id === editorRequest.strategyId,
      );
      setName((current) =>
        current.trim() ? current : `${chosen?.name ?? "New"} bundle`,
      );
      setCreateError(null);
      setCreateOpen(true);
    } else if (editorRequest.kind === "edit") {
      const target = visible.find(
        (bundle) => bundle.id === editorRequest.bundleId,
      );
      if (target) {
        openEditBundle(target);
        if (editorRequest.strategyId)
          setEditStrategyId(editorRequest.strategyId);
      }
    } else if (walletLimits) {
      openWalletLimitsEditor();
    }
  }, [editorRequest?.token, strategies, visible, walletLimits]);

  return (
    <ViewFrame active={active} name="bundles">
      <section className="bundles-page">
        <PageHeader
          className="bundles-title"
          title="Bundles"
          description="Each bundle has its own accounts and pause control. Markets come from its strategy."
          actions={
            <div className="bundles-heading-actions">
              {returnToStrategy && (
                <Button
                  variant="quiet"
                  size="small"
                  onClick={onReturnToStrategy}
                >
                  Back to Strategy
                </Button>
              )}
              <span className="bundles-count">
                {visible.length} active bundles;{" "}
                {Math.max(0, 4 - visible.length)} slots available.
              </span>
              <Button
                variant="primary"
                size="small"
                onClick={() => {
                  setCreateError(null);
                  setCreateOpen(true);
                }}
                disabled={visible.length >= 4 || busy}
              >
                <Plus size={15} aria-hidden="true" /> New bundle
              </Button>
            </div>
          }
        />

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
            const runBundle = run.bundles.find(
              (candidate) => candidate.id === bundle.id,
            );
            const editing =
              runBundle?.phase === "running" ||
              runBundle?.phase === "attention" ||
              runBundle?.phase === "starting" ||
              runBundle?.phase === "pausing" ||
              runBundle?.phase === "stopping";
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
                  <span
                    className={
                      "bundle-mode mode-" + (runBundle?.mode ?? "paper")
                    }
                  >
                    {runBundle?.mode === "live" ? "Live" : "Paper"}
                  </span>
                </button>
                <div className="bundle-card-heading">
                  <div>
                    <h2>{bundle.name}</h2>
                    <p>
                      {bundle.strategyName
                        ? `${bundle.strategyName}, ${bundle.marketIds.length} markets`
                        : "No strategy attached"}
                    </p>
                  </div>
                  <span
                    className={`bundle-stage-chip ${runBundle?.phase === "running" ? "is-quoting" : bundle.readiness?.ready ? "is-ready" : "is-pending"}`}
                  >
                    {runBundle?.phase === "running"
                      ? "Quoting"
                      : bundle.readiness?.ready
                        ? "Ready to start"
                        : bundle.readiness
                          ? (() => {
                              const remaining = bundle.readiness.stages.filter(
                                (stage) => stage.status !== "done",
                              ).length;
                              return !bundle.strategyId
                                ? "Draft"
                                : `${remaining} ${remaining === 1 ? "step" : "steps"} left`;
                            })()
                          : "Checking readiness…"}
                  </span>
                </div>
                {bundle.readiness && (
                  <ol className="bundle-stage-list">
                    {bundle.readiness.stages.map((stage) => {
                      const fixLabel =
                        stage.id === "collateral"
                          ? `Deposit ${formatMoney(stage.shortfallUsd ?? 0)}`
                          : stage.id === "gas"
                            ? "Add gas"
                            : stage.id === "tradingKeys"
                              ? "Authorize"
                              : stage.id === "strategy"
                                ? "Choose strategy"
                                : "Assign accounts";
                      return (
                        <li
                          key={stage.id}
                          className={`bundle-stage-row is-${stage.status}`}
                        >
                          <span aria-hidden="true">
                            {stage.status === "done" ? (
                              <Check size={17} />
                            ) : (
                              <Circle size={15} />
                            )}
                          </span>
                          <div>
                            <strong>{stageTitle[stage.id]}</strong>
                            <small>{stage.detail}</small>
                          </div>
                          {stage.status === "todo" && (
                            <Button
                              variant="primary"
                              size="small"
                              onClick={() => onFixStage(bundle, stage.id)}
                            >
                              {fixLabel}
                            </Button>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}
                {!bundle.readiness && (
                  <p className="bundle-markets">
                    {bundle.strategyName
                      ? `From ${bundle.strategyName}: ${bundle.marketIds.length ? bundle.marketIds.map((marketId) => markets.find((market) => market.id === marketId)?.symbol ?? marketId).join(", ") : "No markets selected"}`
                      : "No strategy attached"}
                  </p>
                )}
                {runBundle?.phase === "attention" &&
                  (runBundle.snapshot?.paperBlocker || runBundle.lastError) && (
                    <p
                      className="bundle-error"
                      role="status"
                      title={
                        runBundle.snapshot?.paperBlocker
                          ? formatPaperBlocker(runBundle.snapshot.paperBlocker)
                              .sentence
                          : (runBundle.lastError ?? undefined)
                      }
                    >
                      {runBundle.snapshot?.paperBlocker
                        ? formatPaperBlocker(runBundle.snapshot.paperBlocker)
                            .sentence
                        : runBundle.lastError}
                    </p>
                  )}
                {(runBundle?.phase === "running" ||
                  runBundle?.phase === "attention") &&
                  runBundle.snapshot?.accountReadAt &&
                  Date.now() - Date.parse(runBundle.snapshot.accountReadAt) >
                    3 *
                      (strategies.find(
                        (strategy) => strategy.id === bundle.strategyId,
                      )?.cycleIntervalMs ?? 5_000) && (
                    <p className="bundle-stale" role="status">
                      Account data is stale, last read{" "}
                      {relativeAccountRead(
                        runBundle.snapshot.accountReadAt,
                      )?.replace(/^Checked /, "")}
                    </p>
                  )}
                {bundle.readiness && (
                  <p className="bundle-stage-footer-note">
                    {editing
                      ? runBundle?.snapshot?.startedAt
                        ? `Running since ${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(runBundle.snapshot.startedAt))}`
                        : "Bundle is running."
                      : bundle.readiness.ready
                        ? "Ready to start."
                        : bundle.readiness.stages.find(
                              (stage) => stage.status === "todo",
                            )?.id === "collateral"
                          ? "Can start after the deposit."
                          : `${bundle.readiness.stages.filter((stage) => stage.status !== "done").length} steps before it can start.`}
                  </p>
                )}
                <div className="bundle-actions">
                  {runBundle?.needsStrategy ? (
                    <label className="bundle-attach-strategy">
                      <span>Attach strategy</span>
                      <select
                        id={`bundle-attach-${bundle.id}`}
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
                  ) : runBundle && (editing || !bundle.readiness) ? (
                    <RunStatusChip
                      bundle={runBundle}
                      onClick={() => openRunControls(bundle.id)}
                    />
                  ) : null}
                  {bundle.readiness && !editing && (
                    <Button
                      variant="primary"
                      size="small"
                      onClick={() => onStart(bundle.id)}
                      disabled={!bundle.readiness.ready || busy}
                      title={
                        !bundle.readiness.ready
                          ? `${nextStage(bundle.readiness)?.detail ?? "Not ready"} before starting`
                          : undefined
                      }
                    >
                      Start
                    </Button>
                  )}
                  {bundle.name !== "Core" && (
                    <Button
                      variant="secondary"
                      size="small"
                      onClick={() => openEditBundle(bundle)}
                      disabled={busy || editing}
                    >
                      <Pencil size={15} aria-hidden="true" />
                      Edit
                    </Button>
                  )}
                  {bundle.name !== "Core" && (
                    <Button
                      variant="secondary"
                      size="small"
                      onClick={() => onArchive(bundle.id)}
                      disabled={busy || editing}
                    >
                      <Archive size={15} aria-hidden="true" />
                      Archive
                    </Button>
                  )}
                </div>
                <small
                  className="bundle-card-result"
                  title={formatMoney(bundle.resultUsd)}
                >
                  Result {formatMoney(bundle.resultUsd)}
                </small>
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
                disabled={!canCreate || busy || !walletLimits}
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
          {!walletLimits && (
            <div className="bundle-create-note" role="status">
              Finish Core setup and configure wallet limits before creating a
              strategy bundle.
              <Button
                variant="quiet"
                onClick={() => {
                  setCreateOpen(false);
                  onOpenAccounts?.();
                }}
              >
                Open Accounts setup
              </Button>
            </div>
          )}
          {!availableMakerAccounts.length && (
            <div className="bundle-create-note" role="status">
              No authorized unassigned Maker account is available.
              <Button
                variant="quiet"
                onClick={() => {
                  setCreateOpen(false);
                  onOpenAccounts?.();
                }}
              >
                Open Accounts
              </Button>
            </div>
          )}
          {createError && (
            <p className="bundle-create-note" role="alert">
              {createError}
            </p>
          )}
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
              <span>
                Taker account{" "}
                {chosenCreateStrategy?.requiresHedge
                  ? "(required for this strategy)"
                  : "(optional)"}
              </span>
              <select
                aria-label={
                  chosenCreateStrategy?.requiresHedge
                    ? "Taker account (required for this strategy)"
                    : "Taker account (optional)"
                }
                value={takerAccountId}
                onChange={(event) => setTakerAccountId(event.target.value)}
              >
                <option value="">
                  {chosenCreateStrategy?.requiresHedge
                    ? "Choose a distinct authorized hedge account"
                    : "Off"}
                </option>
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
                aria-label="Strategy"
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
          {strategyId && !chosenCreateStrategy?.marketCount && (
            <p className="bundle-create-note" role="status">
              Apply one or more markets to this strategy before creating a
              bundle.
            </p>
          )}
          {chosenCreateStrategy?.requiresHedge && !takerAccountId && (
            <p className="bundle-create-note" role="status">
              This applied strategy offsets fills with a hedge account. Choose a
              distinct authorized Taker account; creating without it would fail
              validation.
            </p>
          )}
          {chosenCreateStrategy?.requiresHedge &&
            !availableTakerAccounts.length && (
              <p className="bundle-create-note" role="status">
                No unassigned authorized hedge account is available. Set one up
                in Accounts before creating this bundle.
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
                  editingBundleActive ||
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
          {editingBundleActive && editingBundle && (
            <p className="bundle-create-note" role="status">
              Accounts change only while {editingBundle.name} is paused.{" "}
              <button
                type="button"
                onClick={() => openRunControls(editingBundle.id)}
              >
                Pause in run status
              </button>
            </p>
          )}
          <div className="bundle-create-fields">
            <label>
              <span>Maker account</span>
              <select
                aria-label="Maker account"
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
                aria-label="Taker account"
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
                aria-label="Strategy"
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
          {createError && (
            <p className="bundle-create-note" role="alert">
              {createError}
            </p>
          )}
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
