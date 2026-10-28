"use client";

import { Archive, Pause, Play, Plus, RotateCcw } from "lucide-react";
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
  mode: "observe" | "paper" | "live";
  status: "stopped" | "running" | "paused" | "error";
  makerAccountId: string | null;
  takerAccountId: string | null;
  marketIds: string[];
  lastError: string | null;
  resultUsd: number | null;
  archivedAt: string | null;
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
  onCreate: (draft: {
    name: string;
    makerAccountId: string;
    takerAccountId: string;
    marketId: string;
    confirmWalletLimits: boolean;
  }) => void;
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
  onCreate,
}: BundlesViewProps) {
  const visible = activeBundles(bundles);
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [name, setName] = useState("");
  const [makerAccountId, setMakerAccountId] = useState("");
  const [takerAccountId, setTakerAccountId] = useState("");
  const [marketId, setMarketId] = useState("");
  const availableMakerAccounts = availableBundleAccounts(accounts, visible);
  const availableTakerAccounts = availableBundleAccounts(
    accounts,
    visible,
    makerAccountId || null,
  );
  const availableMarkets = availableBundleMarkets(markets, visible);
  const canCreate =
    visible.length < 4 &&
    Boolean(
      name.trim() &&
      makerAccountId &&
      marketId &&
      makerAccountId !== takerAccountId,
    );
  const submitCreate = (confirmWalletLimits: boolean) => {
    if (!canCreate) return;
    onCreate({
      name: name.trim(),
      makerAccountId,
      takerAccountId,
      marketId,
      confirmWalletLimits,
    });
    setConfirmOpen(false);
    setCreateOpen(false);
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
            <div>
              <span>Wallet limits</span>
              <strong>
                {walletLimits.confirmedAt
                  ? "Confirmed"
                  : "Confirm before a second bundle"}
              </strong>
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
            const resumable =
              bundle.status === "paused" || bundle.status === "error";
            return (
              <Card
                key={bundle.id}
                className={selected ? "bundle-card is-selected" : "bundle-card"}
              >
                <button
                  className="bundle-card-select"
                  type="button"
                  onClick={() => onSelect(bundle.id)}
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
                {bundle.lastError && (
                  <p className="bundle-error" role="status">
                    {bundle.lastError}
                  </p>
                )}
                <div className="bundle-actions">
                  {bundle.status === "running" ? (
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
          description="Choose separate accounts and one market. You can refine its strategy after it is created."
          onClose={() => setCreateOpen(false)}
          footer={
            <>
              <Button variant="quiet" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!canCreate || busy}
                onClick={() =>
                  walletLimits?.confirmedAt
                    ? submitCreate(false)
                    : setConfirmOpen(true)
                }
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
          open={confirmOpen}
          title="Confirm wallet limits"
          description="These limits apply across every bundle in this wallet. A new bundle cannot raise them."
          onClose={() => setConfirmOpen(false)}
          footer={
            <>
              <Button variant="quiet" onClick={() => setConfirmOpen(false)}>
                Back
              </Button>
              <Button variant="primary" onClick={() => submitCreate(true)}>
                Confirm limits and create
              </Button>
            </>
          }
        >
          <dl className="bundle-confirm-limits">
            <div>
              <dt>Gross exposure</dt>
              <dd>{formatMoney(walletLimits?.maxGrossExposureUsd ?? null)}</dd>
            </div>
            <div>
              <dt>Inventory</dt>
              <dd>{formatMoney(walletLimits?.maxInventoryUsd ?? null)}</dd>
            </div>
            <div>
              <dt>Run drawdown</dt>
              <dd>{formatMoney(walletLimits?.maxRunDrawdownUsd ?? null)}</dd>
            </div>
            <div>
              <dt>Unrealized loss</dt>
              <dd>{formatMoney(walletLimits?.maxUnrealizedLossUsd ?? null)}</dd>
            </div>
          </dl>
        </Sheet>
      </section>
    </ViewFrame>
  );
}
