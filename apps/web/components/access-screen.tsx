"use client";

import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import {
  ArrowRight,
  CheckCircle2,
  CircleMinus,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import type { VenueDescriptor } from "../lib/venues";
import { SpreadMark } from "./spread-mark";
import { VenueChip } from "./venue-chip";
import { Button, Input } from "./ui/primitives";
import { WalletControl } from "./wallet-control";

export type AccessRequestInput = {
  accessRequestToken: string;
  twitterHandle: string;
  company: string;
};

type AccessScreenProps = {
  venue: VenueDescriptor;
  connected: boolean;
  denied: boolean;
  busy: boolean;
  requestBusy: boolean;
  requestSubmitted: boolean;
  accessRequestToken: string | null;
  verifiedAddress: string;
  notice: string | null;
  onVerify: () => void;
  onRequestAccess: (input: AccessRequestInput) => void;
};

function SpreadIllustration() {
  return (
    <div className="access-illustration" aria-hidden="true">
      <div className="access-fair-value">
        <span>Fair value</span>
        <i />
      </div>
      <div className="access-spread-line access-spread-bid">
        <span>Your bid</span>
        <i />
      </div>
      <div className="access-spread-line access-spread-ask">
        <span>Your ask</span>
        <i />
      </div>
      <div className="access-spread-brace">
        <i />
        <strong>The spread</strong>
        <i />
      </div>
      <div className="access-spread-caption">
        <span>Sellers fill your bid</span>
        <span>Buyers fill your ask</span>
      </div>
    </div>
  );
}

export function AccessScreen({
  venue,
  connected,
  denied,
  busy,
  requestBusy,
  requestSubmitted,
  accessRequestToken,
  verifiedAddress,
  notice,
  onVerify,
  onRequestAccess,
}: AccessScreenProps) {
  const [requestOpen, setRequestOpen] = useState(
    denied && Boolean(accessRequestToken),
  );
  const [twitterHandle, setTwitterHandle] = useState("");
  const [company, setCompany] = useState("");

  useEffect(() => {
    if (denied && accessRequestToken) {
      setRequestOpen(true);
    } else if (connected) {
      setRequestOpen(false);
    }
  }, [accessRequestToken, connected, denied]);

  function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessRequestToken) return;
    onRequestAccess({ accessRequestToken, twitterHandle, company });
  }

  return (
    <main className="access-shell">
      <header className="access-header">
        <div className="access-brand">
          <SpreadMark state="stopped" />
          <strong>Maker</strong>
        </div>
        {connected && (
          <div className="access-header-wallet">
            <WalletControl />
          </div>
        )}
      </header>

      <div className="access-layout">
        <section className="access-copy">
          <h1>
            {denied
              ? "This wallet is not on the list yet."
              : requestOpen
                ? "Request access to Maker."
                : "Both sides of the market, from your own wallet."}
          </h1>
          <p className="access-lede">
            {denied
              ? connected
                ? "Request access below if this is the address you want to use, or switch wallets from the control in the top right."
                : "Connect another wallet, or request access below if this is the address you want to use."
              : requestOpen
                ? "Send the wallet you will use and your X account. Requests are reviewed before a wallet is added to the on-chain access list."
                : "Maker keeps a bid and an ask resting on perpetual markets for you, hedges what fills, and stops itself at your limits. It can trade the accounts you connect. It can never withdraw from them."}
          </p>

          {requestOpen ? (
            requestSubmitted ? (
              <div className="access-request-receipt" role="status">
                <CheckCircle2 size={22} aria-hidden="true" />
                <div>
                  <strong>Request received</strong>
                  <span>
                    We saved your wallet and X account for review. You can
                    return and sign in after the wallet is approved.
                  </span>
                </div>
              </div>
            ) : (
              <form className="access-request-form" onSubmit={submitRequest}>
                <Input
                  label="Sui wallet address"
                  value={verifiedAddress}
                  readOnly
                  aria-readonly="true"
                  hint="Verified by your wallet signature."
                />
                <Input
                  label="X / Twitter"
                  value={twitterHandle}
                  onChange={(event) => setTwitterHandle(event.target.value)}
                  placeholder="@handle"
                  autoComplete="off"
                  spellCheck={false}
                  pattern="@?[A-Za-z0-9_]{1,15}"
                  required
                />
                <label className="access-honeypot" aria-hidden="true">
                  Company
                  <input
                    value={company}
                    onChange={(event) => setCompany(event.target.value)}
                    autoComplete="off"
                    tabIndex={-1}
                  />
                </label>
                <div className="access-request-actions">
                  <Button
                    variant="primary"
                    size="large"
                    type="submit"
                    disabled={requestBusy}
                  >
                    <ArrowRight size={18} aria-hidden="true" />
                    {requestBusy ? "Sending request..." : "Send request"}
                  </Button>
                  {!denied && (
                    <Button
                      variant="quiet"
                      size="large"
                      onClick={() => setRequestOpen(false)}
                    >
                      Back to sign in
                    </Button>
                  )}
                </div>
              </form>
            )
          ) : (
            <div className="access-actions">
              {connected ? (
                <Button
                  variant="primary"
                  size="large"
                  onClick={onVerify}
                  disabled={busy}
                >
                  <ShieldCheck size={18} aria-hidden="true" />
                  {busy
                    ? "Sign the message in your wallet..."
                    : "Retry sign in"}
                </Button>
              ) : (
                <div className="access-connect">
                  <ConnectButton>Continue with wallet</ConnectButton>
                </div>
              )}
              <button
                className="access-request-link"
                type="button"
                onClick={() => {
                  if (accessRequestToken) {
                    setRequestOpen(true);
                  } else {
                    onVerify();
                  }
                }}
              >
                {accessRequestToken
                  ? "Request access"
                  : "Verify wallet to request access"}
              </button>
            </div>
          )}

          {(denied || requestSubmitted) && !connected && (
            <div className="access-alternate-wallet">
              <span>Already have access with another wallet?</span>
              <div className="access-connect access-connect-secondary">
                <ConnectButton>Choose another wallet</ConnectButton>
              </div>
            </div>
          )}

          {notice && (
            <div className="access-notice" role="alert">
              {notice}
            </div>
          )}

          <div className="access-trust-list">
            <div>
              <span className="access-trust-icon">
                <LockKeyhole size={18} aria-hidden="true" />
              </span>
              <p>
                <strong>Your keys stay with you</strong>
                <span>
                  Connect once, then sign a message. Maker never holds your
                  wallet key.
                </span>
              </p>
            </div>
            <div>
              <span className="access-trust-icon">
                <ShieldCheck size={18} aria-hidden="true" />
              </span>
              <p>
                <strong>Trade-only access per venue</strong>
                <span>
                  Grant a trading key for each account and revoke it any time.
                </span>
              </p>
            </div>
            <div>
              <span className="access-trust-icon">
                <CircleMinus size={18} aria-hidden="true" />
              </span>
              <p>
                <strong>{venue.feeModel}</strong>
                <span>
                  Shown before approval, on top of the venue's own fees.
                </span>
              </p>
            </div>
          </div>

          <div className="access-venue-line">
            <span>Live on</span>
            <VenueChip venue={venue} />
            <span>More venues on the way.</span>
          </div>
        </section>

        <SpreadIllustration />
      </div>

      <p className="access-risk-line">
        Invite only. Perpetuals trading can lose money; Maker's limits reduce
        that risk but do not remove it.
      </p>
    </main>
  );
}
