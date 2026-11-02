"use client";

import { Check, LoaderCircle } from "lucide-react";
import { createPortal } from "react-dom";
import { useRef, useState } from "react";
import { formatMoney } from "../lib/format";
import { primaryVenue } from "../lib/venues";
import { Button, Sheet } from "./ui/primitives";

export type BundleFundingAccount = {
  accountId: string;
  label: string;
  role: "Maker" | "Taker";
  freeUsd: number;
  requiredUsd: number;
  shortfallUsd: number;
};

export function BundleFundingSheet({
  bundleName,
  accounts,
  walletAddress,
  walletUsdcUsd,
  onClose,
  onConnectWallet,
  onSubmit,
}: {
  bundleName: string;
  accounts: BundleFundingAccount[];
  walletAddress: string;
  walletUsdcUsd: number | null;
  onClose: () => void;
  onConnectWallet: () => void;
  onSubmit: (
    deposits: Array<{ accountId: string; amountUsdc: string }>,
  ) => Promise<string>;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(
    Object.fromEntries(
      accounts.map((account) => [
        account.accountId,
        account.shortfallUsd > 0 ? account.shortfallUsd.toFixed(2) : "0",
      ]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  const submitting = useRef(false);
  const money = (amount: number) => formatMoney(amount);
  const entries = accounts.map((account) => ({
    ...account,
    text: draft[account.accountId] ?? "",
    amount: Number(draft[account.accountId] ?? ""),
  }));
  const total = entries.reduce(
    (sum, entry) => sum + (Number.isFinite(entry.amount) ? entry.amount : 0),
    0,
  );
  const valid =
    walletUsdcUsd !== null &&
    total > 0 &&
    total <= walletUsdcUsd &&
    entries.every(
      (entry) =>
        /^(0|[1-9]\d*)(?:\.\d{1,6})?$/.test(entry.text) &&
        Number.isFinite(entry.amount) &&
        entry.amount >= 0,
    );
  const readyAfter = entries.every(
    (entry) => entry.freeUsd + entry.amount >= entry.requiredUsd,
  );

  async function submit() {
    if (!valid || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const confirmed = await onSubmit(
        entries
          .filter((entry) => entry.amount > 0)
          .map((entry) => ({
            accountId: entry.accountId,
            amountUsdc: entry.text,
          })),
      );
      setDigest(confirmed);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return createPortal(
    <Sheet
      open
      className="venue-funding"
      title={`Fund ${bundleName}`}
      description="Deposit to both accounts with one owner-wallet transaction."
      onClose={() => {
        if (!busy) onClose();
      }}
      initialFocusSelector="input"
      footer={
        digest ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!valid || busy}
              onClick={() => void submit()}
            >
              {busy ? (
                <>
                  <LoaderCircle className="spin" size={14} aria-hidden="true" />
                  Approve in your wallet
                </>
              ) : (
                `Deposit ${money(total)}`
              )}
            </Button>
          </>
        )
      }
    >
      {digest ? (
        <div className="venue-funding-done" role="status">
          <span>
            <Check size={22} aria-hidden="true" />
          </span>
          <h3>Deposited {money(total)}</h3>
          <p>
            {bundleName}'s accounts are being refreshed.{" "}
            {readyAfter
              ? `${bundleName} can start if its other stages remain ready.`
              : "The remaining shortfall is shown in Venues."}
          </p>
          <a
            href={primaryVenue.explorerTxUrl(digest)}
            target="_blank"
            rel="noreferrer"
          >
            View transaction ↗
          </a>
        </div>
      ) : (
        <div className="venue-funding-body">
          {accounts.map((account) => (
            <label key={account.accountId} className="venue-bundle-fund-row">
              <span>
                <strong>
                  {account.label} · {account.role}
                </strong>
                <small>
                  Has {money(account.freeUsd)}, needs{" "}
                  {money(account.requiredUsd)}
                </small>
              </span>
              <span className="venue-bundle-fund-field">
                <span>$</span>
                <input
                  inputMode="decimal"
                  aria-label={`Deposit to account ${account.accountId}`}
                  disabled={busy}
                  value={draft[account.accountId] ?? ""}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      [account.accountId]: event.target.value,
                    }))
                  }
                />
              </span>
            </label>
          ))}
          {walletUsdcUsd === null ? (
            <p>
              Connect your wallet to see its USDC balance.{" "}
              <Button variant="quiet" onClick={onConnectWallet}>
                Connect wallet
              </Button>
            </p>
          ) : (
            <p>Your wallet has {money(walletUsdcUsd)} USDC.</p>
          )}
          <div className="venue-funding-summary">
            <div>
              <span>Total from your wallet</span>
              <strong>{money(total)}</strong>
            </div>
            <div>
              <span>Left in your wallet</span>
              <strong>
                {walletUsdcUsd === null ? "—" : money(walletUsdcUsd - total)}
              </strong>
            </div>
            <p className={readyAfter ? "is-ready" : "is-short"}>
              {readyAfter
                ? `Enough collateral for ${bundleName}`
                : `Still ${money(entries.reduce((sum, entry) => sum + Math.max(0, entry.requiredUsd - entry.freeUsd - entry.amount), 0))} short`}
            </p>
          </div>
          <p>
            Your wallet signs one transaction and pays a small SUI gas fee.
            Deposits are allowed while bundles run.
          </p>
          {busy && (
            <p role="status">
              Approve the deposit in your wallet. {money(total)} from{" "}
              {walletAddress.slice(0, 6)}…{walletAddress.slice(-4)} to{" "}
              {bundleName}'s accounts.
            </p>
          )}
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Sheet>,
    document.body,
  );
}
