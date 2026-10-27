"use client";

import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import { CircleMinus, LockKeyhole, ShieldCheck } from "lucide-react";

import type { VenueDescriptor } from "../lib/venues";
import { SpreadMark } from "./spread-mark";
import { VenueChip } from "./venue-chip";
import { Button } from "./ui/primitives";

const requestAccessUrl =
  "mailto:zeroexzoz@gmail.com?subject=Maker%20access%20request";

type AccessScreenProps = {
  venue: VenueDescriptor;
  connected: boolean;
  denied: boolean;
  busy: boolean;
  notice: string | null;
  onVerify: () => void;
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
  notice,
  onVerify,
}: AccessScreenProps) {
  return (
    <main className="access-shell">
      <header className="access-header">
        <div className="access-brand">
          <SpreadMark state="stopped" />
          <strong>Maker</strong>
        </div>
      </header>

      <div className="access-layout">
        <section className="access-copy">
          <h1>
            {denied
              ? "You're not on the list yet."
              : "Both sides of the market, from your own wallet."}
          </h1>
          <p className="access-lede">
            {denied
              ? "Maker is invite only while the public release is monitored. Request access with the wallet address you signed in with."
              : "Maker keeps a bid and an ask resting on perpetual markets for you, hedges what fills, and stops itself at your limits. It can trade the accounts you connect. It can never withdraw from them."}
          </p>

          <div className="access-actions">
            {denied ? (
              <Button
                variant="primary"
                size="large"
                onClick={() => {
                  window.location.href = requestAccessUrl;
                }}
              >
                Request access
              </Button>
            ) : connected ? (
              <Button
                variant="primary"
                size="large"
                onClick={onVerify}
                disabled={busy}
              >
                <ShieldCheck size={18} aria-hidden="true" />
                {busy ? "Check your wallet…" : "Verify access"}
              </Button>
            ) : (
              <div className="access-connect">
                <ConnectButton>Connect wallet</ConnectButton>
              </div>
            )}
            {!denied && (
              <a className="access-request-link" href={requestAccessUrl}>
                Request access
              </a>
            )}
          </div>

          {notice && !denied && (
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
                  Sign in with a message. Maker never holds your wallet key.
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
