"use client";

import { Check, LoaderCircle } from "lucide-react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatMoney } from "../lib/format";
import { primaryVenue } from "../lib/venues";
import { Button, Sheet } from "./ui/primitives";

export type FundingMode = "deposit" | "withdraw" | "gas";
export type FundingTarget = {
  mode: FundingMode;
  accountId: string;
  bundleName: string;
  role: "Maker" | "Taker" | "Available";
  freeUsd: number;
  equityUsd: number;
  withdrawableUsd: number;
  requiredUsd: number;
  shortfallUsd: number;
  bundleRunning: boolean;
  keyGasSui: number;
  paperGasSui: number;
  liveGasSui: number;
};

export function VenueFundingSheet({
  target,
  walletAddress,
  walletUsdcUsd,
  walletSui,
  onClose,
  onSubmit,
  onPause,
  onConnectWallet,
}: {
  target: FundingTarget;
  walletAddress: string;
  walletUsdcUsd: number | null;
  walletSui: number | null;
  onClose: () => void;
  onSubmit: (
    mode: FundingMode,
    accountId: string,
    amount: string,
  ) => Promise<{ digest: string; freeUsd: number | null }>;
  onPause: (bundleName: string) => Promise<void>;
  onConnectWallet: () => void;
}) {
  const [draft, setDraft] = useState(
    target.mode === "deposit"
      ? target.shortfallUsd > 0
        ? target.shortfallUsd.toFixed(2)
        : ""
      : target.mode === "gas"
        ? "0.25"
        : "",
  );
  const [pick, setPick] = useState(
    target.mode === "gas"
      ? "0.25-0"
      : target.mode === "deposit" && target.shortfallUsd > 0
        ? `${target.shortfallUsd.toFixed(2)}-0`
        : "",
  );
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{
    digest: string;
    freeUsd: number | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const amount = Number(draft);
  const max =
    target.mode === "gas"
      ? walletSui
      : target.mode === "deposit"
        ? walletUsdcUsd
        : target.withdrawableUsd;
  const validText =
    target.mode === "gas"
      ? /^(0|[1-9]\d*)(?:\.\d{1,9})?$/.test(draft)
      : /^(0|[1-9]\d*)(?:\.\d{1,6})?$/.test(draft);
  const valid =
    validText &&
    Number.isFinite(amount) &&
    amount > 0 &&
    max !== null &&
    amount <= max &&
    !(target.mode === "withdraw" && target.bundleRunning) &&
    (target.mode !== "gas" || (amount >= 0.01 && amount <= 10));
  const money = (value: number) => formatMoney(value);
  const label =
    target.mode === "gas"
      ? "Add gas"
      : target.mode === "deposit"
        ? "Deposit"
        : "Withdraw";
  const unit = target.mode === "gas" ? "SUI" : "USDC";
  const pretty =
    target.mode === "gas" ? `${amount || 0} SUI` : money(amount || 0);
  const resulting =
    target.mode === "gas"
      ? target.keyGasSui + (amount || 0)
      : target.mode === "deposit"
        ? target.freeUsd + (amount || 0)
        : target.freeUsd - (amount || 0);
  const remaining =
    target.mode === "gas"
      ? Math.max(0, target.paperGasSui - resulting)
      : Math.max(0, target.requiredUsd - resulting);
  const picks =
    target.mode === "gas"
      ? ["0.25", "0.50", "1.00"]
      : target.mode === "deposit"
        ? [
            ...(target.shortfallUsd > 0
              ? [target.shortfallUsd.toFixed(2)]
              : []),
            "100.00",
            "500.00",
            ...(walletUsdcUsd !== null ? [walletUsdcUsd.toFixed(2)] : []),
          ]
        : ["100.00", ...(max !== null ? [max.toFixed(2)] : [])];
  async function submit() {
    if (!valid || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      setDone(await onSubmit(target.mode, target.accountId, draft));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }
  return createPortal(
    <Sheet
      open
      title={`${label} ${target.mode === "gas" ? `to trading key for account ${target.accountId}` : `${target.mode === "withdraw" ? "from" : "to"} account ${target.accountId}`}`}
      description={`${target.bundleName}'s ${target.role.toLowerCase()} account on Aftermath.`}
      className="venue-funding"
      onClose={() => {
        if (!busy) onClose();
      }}
      initialFocusSelector="input"
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
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
                  Approve the {label.toLowerCase()} in your wallet
                </>
              ) : (
                `${label} ${pretty}`
              )}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div className="venue-funding-done" role="status">
          <span>
            <Check size={22} aria-hidden="true" />
          </span>
          <h3>
            {target.mode === "gas"
              ? "Gas added"
              : `${target.mode === "withdraw" ? "Withdrew" : "Deposited"} ${pretty}`}
          </h3>
          <p>
            {target.mode === "gas" ? (
              `Trading key gas for account ${target.accountId} is being refreshed in Venues.`
            ) : (
              <>
                Account {target.accountId} now has{" "}
                {done.freeUsd === null
                  ? "an updated balance"
                  : money(done.freeUsd) + " free"}
                .{" "}
                {target.mode === "deposit" &&
                done.freeUsd !== null &&
                done.freeUsd >= target.requiredUsd
                  ? target.keyGasSui >= target.paperGasSui
                    ? `${target.bundleName} can start if its other stages remain ready.`
                    : "Collateral is covered; check the gas stage."
                  : ""}
              </>
            )}
          </p>
          <a
            href={primaryVenue.explorerTxUrl(done.digest)}
            target="_blank"
            rel="noreferrer"
          >
            View transaction ↗
          </a>
        </div>
      ) : (
        <div className="venue-funding-body">
          {target.mode === "withdraw" && target.bundleRunning && (
            <div className="venue-funding-warning" role="status">
              {target.bundleName} is quoting from this account. Pause{" "}
              {target.bundleName} before you withdraw, so no open order is left
              without collateral.{" "}
              <Button
                variant="secondary"
                onClick={() =>
                  void onPause(target.bundleName).catch((failure) =>
                    setError(
                      failure instanceof Error
                        ? failure.message
                        : String(failure),
                    ),
                  )
                }
              >
                Pause {target.bundleName}
              </Button>
            </div>
          )}
          <label className="venue-funding-amount">
            Amount{" "}
            <span>
              <input
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setPick("");
                }}
                inputMode="decimal"
                aria-label={`${label} amount`}
                disabled={
                  busy || (target.mode === "withdraw" && target.bundleRunning)
                }
              />
              <b>{unit}</b>
            </span>
          </label>
          <small>
            {target.mode === "gas" ? (
              walletSui === null ? (
                <>
                  Connect your wallet to see its SUI balance.{" "}
                  <Button variant="quiet" onClick={onConnectWallet}>
                    Connect wallet
                  </Button>
                </>
              ) : (
                `Your wallet has ${walletSui.toFixed(2)} SUI.`
              )
            ) : walletUsdcUsd === null ? (
              <>
                Connect your wallet to see its USDC balance.{" "}
                <Button variant="quiet" onClick={onConnectWallet}>
                  Connect wallet
                </Button>
              </>
            ) : (
              `Your wallet has ${money(walletUsdcUsd)} USDC.`
            )}
          </small>
          <div className="venue-funding-picks">
            {picks.map((value, index) => (
              <button
                type="button"
                key={`${value}-${index}`}
                className={
                  pick === `${value}-${index}` ? "is-selected" : undefined
                }
                onClick={() => {
                  setDraft(value);
                  setPick(`${value}-${index}`);
                }}
                disabled={
                  busy || (target.mode === "withdraw" && target.bundleRunning)
                }
              >
                {target.mode === "deposit" &&
                target.shortfallUsd > 0 &&
                index === 0
                  ? `Cover ${target.bundleName} (${money(target.shortfallUsd)})`
                  : target.mode !== "gas" && index === picks.length - 1
                    ? "Max"
                    : target.mode === "gas"
                      ? `${value} SUI`
                      : money(Number(value))}
              </button>
            ))}
          </div>
          <div className="venue-funding-summary">
            <div>
              <span>
                {target.mode === "gas"
                  ? "Trading key holds now"
                  : target.mode === "withdraw"
                    ? "Equity"
                    : `Free in account ${target.accountId} now`}
              </span>
              <strong>
                {target.mode === "gas"
                  ? `${target.keyGasSui.toFixed(2)} SUI`
                  : money(
                      target.mode === "withdraw"
                        ? target.equityUsd
                        : target.freeUsd,
                    )}
              </strong>
            </div>
            {target.mode === "withdraw" && (
              <div>
                <span>Withdrawable now</span>
                <strong>{money(target.withdrawableUsd)}</strong>
              </div>
            )}
            <div>
              <span>After this {label.toLowerCase()}</span>
              <strong>
                {target.mode === "gas"
                  ? `${resulting.toFixed(2)} SUI`
                  : money(resulting)}
              </strong>
            </div>
            <div>
              <span>
                {target.bundleName} needs
                {target.mode === "gas"
                  ? " for Paper / Live"
                  : `, for its ${target.requiredUsd > 0 ? "selected markets" : "account"}`}
              </span>
              <strong>
                {target.mode === "gas"
                  ? `${target.paperGasSui.toFixed(2)} / ${target.liveGasSui.toFixed(2)} SUI`
                  : money(target.requiredUsd)}
              </strong>
            </div>
            <p className={remaining <= 0 ? "is-ready" : "is-short"}>
              {remaining <= 0
                ? target.mode === "gas"
                  ? "Enough gas for Paper simulations"
                  : target.mode === "deposit" &&
                      target.keyGasSui < target.paperGasSui
                    ? "Enough collateral; add gas before starting"
                    : `Enough for ${target.bundleName} to quote`
                : `Still ${target.mode === "gas" ? remaining.toFixed(2) + " SUI" : money(remaining)} short`}
            </p>
          </div>
          {target.mode === "withdraw" &&
            !target.bundleRunning &&
            resulting < target.requiredUsd && (
              <p className="venue-funding-warning">
                Withdrawing below {money(target.requiredUsd)} leaves{" "}
                {target.bundleName} unable to quote until you deposit again.
              </p>
            )}
          {target.mode === "deposit" && (
            <p>
              Your wallet signs one transaction and pays a small SUI gas fee.
              Deposits are allowed while bundles run.
            </p>
          )}
          {busy && (
            <p role="status">
              Approve the {label.toLowerCase()} in your wallet. {pretty} from{" "}
              {walletAddress.slice(0, 6)}…{walletAddress.slice(-4)} to account{" "}
              {target.accountId}.
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
