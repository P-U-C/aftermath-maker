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
import { MarketMotion } from "./market-motion";
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
  const [illustrationKey, setIllustrationKey] = useState(0);

  useEffect(() => {
    if (denied && accessRequestToken) {
      setRequestOpen(true);
    } else if (connected) {
      setRequestOpen(false);
    }
  }, [accessRequestToken, connected, denied]);

  const landing = !denied && !requestOpen;

  function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessRequestToken) return;
    onRequestAccess({ accessRequestToken, twitterHandle, company });
  }

  function openRequest() {
    if (accessRequestToken) {
      setRequestOpen(true);
    } else {
      onVerify();
    }
  }

  function replayIllustration() {
    setIllustrationKey((current) => current + 1);
    document
      .getElementById("maker-illustration")
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const trustList = (
    <div className="access-trust-list">
      <div>
        <span className="access-trust-icon">
          <LockKeyhole size={18} aria-hidden="true" />
        </span>
        <p>
          <strong>Your keys stay with you</strong>
          <span>
            Connect once, then sign a message. Maker never holds your wallet
            key.
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
          <span>Shown before approval, on top of the venue's own fees.</span>
        </p>
      </div>
    </div>
  );

  const venueLine = (
    <div className="access-venue-line">
      <span>Live on</span>
      <VenueChip venue={venue} />
      <span>More venues on the way.</span>
    </div>
  );

  return (
    <main className="access-shell">
      <header className="access-header">
        <div className="access-brand">
          <SpreadMark state="live" />
          <strong>Maker</strong>
        </div>
        {landing && (
          <nav className="access-landing-nav" aria-label="Landing">
            <a href="#how-it-works">How it works</a>
            <a href="#safety">Safety</a>
            <button type="button" onClick={openRequest}>
              Request access
            </button>
            {connected ? (
              <Button variant="quiet" onClick={onVerify} disabled={busy}>
                Sign in
              </Button>
            ) : (
              <div className="access-header-connect">
                <ConnectButton>Sign in</ConnectButton>
              </div>
            )}
          </nav>
        )}
        {connected && (
          <div className="access-header-wallet">
            <WalletControl />
          </div>
        )}
      </header>

      <div
        className={`access-layout${landing ? " access-layout-landing" : ""}`}
      >
        <section className={`access-copy${landing ? " access-hero" : ""}`}>
          <h1>
            {denied ? (
              "This wallet is not on the list yet."
            ) : requestOpen ? (
              "Request access to Maker."
            ) : (
              <>
                Your own <span className="access-nowrap">market-making</span>{" "}
                desk.{" "}
                <span className="access-hero-quiet">Working for you.</span>
              </>
            )}
          </h1>
          <div className="access-hero-side">
            <p className="access-lede">
              {denied
                ? connected
                  ? "Request access below if this is the address you want to use, or switch wallets from the control in the top right."
                  : "Connect another wallet, or request access below if this is the address you want to use."
                : requestOpen
                  ? "Send the wallet you will use and your X account. Requests are reviewed before a wallet is added to the on-chain access list."
                  : "Maker runs a desk from your own accounts. It keeps a bid and ask resting on the markets you choose, hedges what fills, and stops itself at your limits. You set the strategy; it tells you what it is doing in plain words."}
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
                <div className="access-hero-links">
                  <button
                    className="access-request-link"
                    type="button"
                    onClick={openRequest}
                  >
                    {accessRequestToken
                      ? "Request access"
                      : "Verify wallet to request access"}
                  </button>
                  <button
                    className="access-watch-link"
                    type="button"
                    onClick={replayIllustration}
                  >
                    Watch how it works
                  </button>
                </div>
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
          </div>

          {!landing && trustList}
          {!landing && venueLine}
        </section>

        {(denied || requestOpen) && <SpreadIllustration />}
      </div>

      {landing && (
        <>
          <section
            className="access-landing-stage"
            id="maker-illustration"
            aria-label="How a market is made"
          >
            <MarketMotion
              key={illustrationKey}
              sim
              narrate
              mid={0.021441}
              bid={0.021407}
              ask={0.021475}
              bestBid={0.021398}
              bestAsk={0.021484}
              inventoryUsd={0}
              book={null}
              sizeUsd={100}
              hedgeTriggerUsd={200}
              spreadBps={32}
              seed={31}
              caption="Illustration. Your desk draws the same picture from your real quotes and fills."
            />
          </section>
          <section className="access-landing-moves" id="how-it-works">
            <header>
              <h2>Set up your desk in three moves.</h2>
              <p>
                Pair a Maker and Taker account, choose a goal and markets, then
                run on paper before you go live.
              </p>
            </header>
            <ol>
              <li>
                <span>1</span>
                <strong>Pair two accounts</strong>
                <p>One rests your quotes. The other can reduce inventory.</p>
                <div
                  className="access-mini access-mini-pair"
                  aria-hidden="true"
                >
                  <div>
                    <b>Maker</b>
                    <small>Rests your bid and ask</small>
                  </div>
                  <i>+</i>
                  <div>
                    <b>Taker</b>
                    <small>Hedges at market</small>
                  </div>
                </div>
              </li>
              <li>
                <span>2</span>
                <strong>Pick a goal and markets</strong>
                <p>
                  Choose rewards, profit, or both from the markets you trust.
                </p>
                <div
                  className="access-mini access-mini-picks"
                  aria-hidden="true"
                >
                  <b>Best for rewards</b>
                  <span>Balanced</span>
                  <span>Quiet books</span>
                </div>
              </li>
              <li>
                <span>3</span>
                <strong>Paper first, then live</strong>
                <p>See the same decision-making against the real book first.</p>
                <div
                  className="access-mini access-mini-modes"
                  aria-hidden="true"
                >
                  <span>Observe</span>
                  <b>Paper</b>
                  <span>Live</span>
                </div>
              </li>
            </ol>
          </section>
          <section className="access-landing-away" aria-labelledby="while-away">
            <header>
              <h2 id="while-away">While you&apos;re away.</h2>
              <p>
                The desk works within the limits you set, and keeps a running
                account of why it did each thing.
              </p>
            </header>
            <div className="access-away-grid">
              <article>
                <ArrowRight size={20} aria-hidden="true" />
                <h3>Quotes both sides</h3>
                <p>
                  A bid under the price and an ask over it, refreshed as price
                  moves.
                </p>
              </article>
              <article>
                <ShieldCheck size={20} aria-hidden="true" />
                <h3>Hedges what fills</h3>
                <p>
                  Past your trigger, the Taker account trades the other way.
                </p>
              </article>
              <article>
                <CircleMinus size={20} aria-hidden="true" />
                <h3>Stops at your limits</h3>
                <p>
                  Exposure, inventory, and drawdown caps stop it before
                  they&apos;re crossed.
                </p>
              </article>
              <article>
                <CheckCircle2 size={20} aria-hidden="true" />
                <h3>Explains itself</h3>
                <p>Every number has a line of plain English.</p>
                <q>
                  Your bid at $0.021393 is waiting for a seller. If it fills
                  you&apos;ll hold $1.04 of MON.
                </q>
              </article>
            </div>
          </section>
          <section className="access-landing-trust" id="safety">
            {trustList}
          </section>
          <section className="access-landing-closing">
            <div>
              <h2>Open your desk.</h2>
              <p>
                Invite only for now. Connect a wallet to check, or request
                access.
              </p>
            </div>
            {connected ? (
              <Button
                variant="quiet"
                size="large"
                onClick={onVerify}
                disabled={busy}
              >
                Sign in
              </Button>
            ) : (
              <div className="access-closing-connect">
                <ConnectButton>Continue with wallet</ConnectButton>
              </div>
            )}
          </section>
          <footer className="access-landing-foot">{venueLine}</footer>
        </>
      )}

      <p className="access-risk-line">
        Invite only. Perpetuals trading can lose money; Maker's limits reduce
        that risk but do not remove it.
      </p>
    </main>
  );
}
