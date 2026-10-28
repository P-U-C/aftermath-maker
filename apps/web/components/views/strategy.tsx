import type { ReactNode } from "react";
import { X } from "lucide-react";

import { formatMoney } from "../../lib/format";
import type { VenueDescriptor } from "../../lib/venues";
import { Button, Sheet } from "../ui/primitives";
import { ViewFrame } from "./view-frame";

export function StrategyView({
  active,
  children,
  onClose,
}: {
  active: boolean;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <ViewFrame active={active} name="strategy">
      <header className="strategy-mobile-sheet-header">
        <strong>Edit strategy</strong>
        <Button
          variant="quiet"
          size="icon"
          onClick={onClose}
          aria-label="Close strategy"
        >
          <X size={20} aria-hidden="true" />
        </Button>
      </header>
      {children}
    </ViewFrame>
  );
}

type GoLiveSheetProps = {
  open: boolean;
  available: boolean;
  venue: VenueDescriptor;
  marketCount: number;
  rotationMode: "portfolio" | "single-slot";
  quoteSizeUsd: number;
  maxGrossExposureUsd: number;
  maxRunDrawdownUsd: number;
  hedgeAccountId: string | null;
  hedgeSlippageBps: number;
  onClose: () => void;
  onConfirm: () => void;
};

export function GoLiveSheet({
  open,
  available,
  venue,
  marketCount,
  rotationMode,
  quoteSizeUsd,
  maxGrossExposureUsd,
  maxRunDrawdownUsd,
  hedgeAccountId,
  hedgeSlippageBps,
  onClose,
  onConfirm,
}: GoLiveSheetProps) {
  return (
    <Sheet
      open={open}
      title="Use Live mode?"
      description="Maker will quote with real funds after you save this strategy and press Start."
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={!available}>
            Use Live mode
          </Button>
        </>
      }
    >
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
      {!available && (
        <p className="go-live-blocked" role="status">
          Live trading is off on this server
        </p>
      )}
    </Sheet>
  );
}
