import { useState, type ReactNode } from "react";
import { CircleHelp, X } from "lucide-react";

import { formatMoney } from "../../lib/format";
import type { BundleReadiness } from "../../lib/bundle-readiness";
import type { RunState } from "../../lib/run-state";
import type { VenueDescriptor } from "../../lib/venues";
import { RunControl } from "../run-control";
import { Button, Sheet } from "../ui/primitives";
import { useMakerExplain } from "../maker-shell";
import { ViewFrame } from "./view-frame";

export function StrategyView({
  active,
  children,
  run,
  stoppedAt,
  onBundleAction,
  onStopAll,
  onManageBundles,
  onOpenVenues,
  onClose,
}: {
  active: boolean;
  children: ReactNode;
  run: RunState;
  stoppedAt: Record<string, string | undefined>;
  onBundleAction: (
    bundleId: string,
    action: "start" | "pause" | "resume",
  ) => void;
  onStopAll: () => void;
  onManageBundles: () => void;
  onOpenVenues: () => void;
  onClose: () => void;
}) {
  const { open: explainOpen, toggle: toggleExplain } = useMakerExplain();
  const [runOpen, setRunOpen] = useState(false);
  return (
    <ViewFrame active={active} name="strategy">
      <header className="strategy-mobile-sheet-header">
        <strong>Edit strategy</strong>
        <div className="strategy-mobile-sheet-actions">
          <button
            className="strategy-mobile-explain"
            type="button"
            aria-label="Explain this page"
            title="Explain this page"
            aria-pressed={explainOpen}
            onClick={toggleExplain}
          >
            <CircleHelp size={19} aria-hidden="true" />
          </button>
          <RunControl
            compact
            run={run}
            open={runOpen}
            selectedBundleId={null}
            stoppedAt={stoppedAt}
            onOpenChange={setRunOpen}
            onBundleAction={onBundleAction}
            onStopAll={onStopAll}
            onManageBundles={onManageBundles}
            onOpenStrategy={() => undefined}
            onOpenVenues={onOpenVenues}
          />
          <Button
            variant="quiet"
            size="icon"
            onClick={onClose}
            aria-label="Close strategy"
          >
            <X size={20} aria-hidden="true" />
          </Button>
        </div>
      </header>
      {children}
    </ViewFrame>
  );
}

type GoLiveSheetProps = {
  open: boolean;
  available: boolean;
  liveReadiness: {
    serverEnabled: boolean;
    signerReady: boolean;
    core: boolean;
    stopped: boolean;
    readiness: BundleReadiness | null;
  } | null;
  operator: boolean;
  ownerAddress: string;
  venue: VenueDescriptor;
  marketCount: number;
  rotationMode: "portfolio" | "single-slot";
  quoteSizeUsd: number;
  maxGrossExposureUsd: number;
  maxRunDrawdownUsd: number;
  hedgeAccountId: string | null;
  makerAccountId: string | null;
  hedgeSlippageBps: number;
  onClose: () => void;
  onConfirm: () => void;
};

export const GO_LIVE_REQUIREMENT_HEADINGS = [
  "Live enabled on this server",
  "Signing key on control",
  "Runs on Core",
  "Core stopped",
  "Live trading key",
  "Live gas reserve",
  "Collateral",
] as const;

export function GoLiveSheet({
  open,
  available,
  liveReadiness,
  operator,
  ownerAddress,
  venue,
  marketCount,
  rotationMode,
  quoteSizeUsd,
  maxGrossExposureUsd,
  maxRunDrawdownUsd,
  hedgeAccountId,
  makerAccountId,
  hedgeSlippageBps,
  onClose,
  onConfirm,
}: GoLiveSheetProps) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <Sheet
      open={open}
      title="Switch Core to Live?"
      description="Core will quote with real funds after you switch and press Start Live."
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            disabled={!available || !confirmed}
          >
            Switch Core to Live
          </Button>
        </>
      }
    >
      <section className="go-live-checklist" aria-label="Live checklist">
        <h3>Before switching Core to Live</h3>
        <ul>
          <li data-ready={liveReadiness?.serverEnabled ? "true" : "false"}>
            <strong>{GO_LIVE_REQUIREMENT_HEADINGS[0]}</strong>
            <span>
              {liveReadiness?.serverEnabled
                ? "Done"
                : operator
                  ? "Needed — Set LIVE_TRADING_ENABLED=true and ALLOW_MAINNET=true in control's .env, then recreate control: docker compose up -d --no-build --force-recreate control."
                  : `Needed — Live is off on this server. The operator wallet can turn it on. You're connected with ${ownerAddress.slice(0, 4)}…${ownerAddress.slice(-2)}, which isn't this server's operator wallet. If you run this server, sign in with the wallet that first set it up.`}
            </span>
          </li>
          <li data-ready={liveReadiness?.signerReady ? "true" : "false"}>
            <strong>{GO_LIVE_REQUIREMENT_HEADINGS[1]}</strong>
            <span>{liveReadiness?.signerReady ? "Done" : "Needed — Add the control signing key, then refresh."}</span>
          </li>
          <li data-ready={liveReadiness?.core ? "true" : "false"}>
            <strong>{GO_LIVE_REQUIREMENT_HEADINGS[2]}</strong>
            <span>{liveReadiness?.core ? "Done" : "Needed — Live runs on Core today. To run this strategy live, attach it to Core in Bundles."}</span>
          </li>
          <li data-ready={liveReadiness?.stopped ? "true" : "false"}>
            <strong>{GO_LIVE_REQUIREMENT_HEADINGS[3]}</strong>
            <span>{liveReadiness?.stopped ? "Done" : "Needed — Stop Core before switching its mode."}</span>
          </li>
          {(liveReadiness?.readiness?.stages ?? []).map((stage) => (
            <li
              key={stage.id}
              data-ready={stage.status === "done" ? "true" : "false"}
            >
              <strong>{stage.id === "tradingKeys" ? GO_LIVE_REQUIREMENT_HEADINGS[4] : stage.id === "gas" ? GO_LIVE_REQUIREMENT_HEADINGS[5] : stage.id === "collateral" ? GO_LIVE_REQUIREMENT_HEADINGS[6] : stage.id}</strong>
              <span>{stage.status === "done" ? "Done" : `Needed — ${stage.detail}`}</span>
            </li>
          ))}
        </ul>
        <p>Last Paper run is informational; switching mode never starts Core.</p>
      </section>
      <dl className="go-live-summary">
        <div>
          <dt>Venues</dt>
          <dd>
            {venue.name} on {venue.network.replace(/ mainnet$/i, "")}
          </dd>
        </div>
        <div>
          <dt>Markets</dt>
          <dd>
            {marketCount},{" "}
            {rotationMode === "single-slot"
              ? "one live pair at a time"
              : "portfolio quotes"}
          </dd>
        </div>
        <div>
          <dt>Size per side</dt>
          <dd>{formatMoney(quoteSizeUsd)}</dd>
        </div>
        <div>
          <dt>Maximum exposure</dt>
          <dd>{formatMoney(maxGrossExposureUsd)} across venues</dd>
        </div>
        <div>
          <dt>Worst case at limits</dt>
          <dd>{formatMoney(maxRunDrawdownUsd)} run drawdown</dd>
        </div>
        <div>
          <dt>Taker</dt>
          <dd>
            {hedgeAccountId
              ? `Account ${hedgeAccountId}, up to ${(hedgeSlippageBps / 100).toFixed(2)}% slippage`
              : "Off"}
          </dd>
        </div>
        <div>
          <dt>Fees</dt>
          <dd>
            Venue maker fee + {venue.feeModel.replace(" on filled orders", "")}
          </dd>
        </div>
        <div>
          <dt>How to stop</dt>
          <dd>Stop cancels Maker orders; Flatten closes positions at market</dd>
        </div>
      </dl>
      <label className="go-live-confirmation">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        Maker will trade real funds on account {makerAccountId ?? "—"}
      </label>
      {!available && (
        <p className="go-live-blocked" role="status">
          Live is not ready on this server. Check the server gates, signing key,
          Core readiness, gas reserve, and collateral in Bundles.
        </p>
      )}
    </Sheet>
  );
}
