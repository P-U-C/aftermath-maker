import type { ReactNode } from "react";

import { formatMoney } from "../../lib/format";
import type { VenueDescriptor } from "../../lib/venues";
import { VenueChip } from "../venue-chip";
import { Button, Card, ListRow } from "../ui/primitives";
import { ViewFrame } from "./view-frame";

export function VenuesView({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <ViewFrame active={active} name="venues">
      {children}
    </ViewFrame>
  );
}

export type VenueAccountRow = {
  accountId: string;
  equityUsd: number;
  role: "Maker" | "Hedge" | "Available";
};

type VenueBoardProps = {
  venue: VenueDescriptor;
  connected: boolean;
  quoting: boolean;
  tradingKeyReady: boolean;
  feeText: string;
  gasText: string;
  selectedMarkets: number;
  eligibleMarkets: number;
  accounts: VenueAccountRow[];
  totalEquityUsd: number;
  grossExposureUsd: number;
  grossExposureLimitUsd: number;
  unrealizedPnlUsd: number;
  onManage: () => void;
  onRevoke?: () => void;
};

export function VenueBoard({
  venue,
  connected,
  quoting,
  tradingKeyReady,
  feeText,
  gasText,
  selectedMarkets,
  eligibleMarkets,
  accounts,
  totalEquityUsd,
  grossExposureUsd,
  grossExposureLimitUsd,
  unrealizedPnlUsd,
  onManage,
  onRevoke,
}: VenueBoardProps) {
  const state = !connected
    ? "Setup required"
    : quoting
      ? "Connected, quoting"
      : "Connected, ready";
  const pnlClass =
    unrealizedPnlUsd < 0
      ? "is-loss"
      : unrealizedPnlUsd > 0
        ? "is-profit"
        : undefined;

  return (
    <div className="venues-board">
      <header className="venues-title">
        <div>
          <h1>Venues</h1>
          <p>
            Inspect execution connectivity, delegated authority, fees, and
            portfolio exposure for every supported venue.
          </p>
        </div>
      </header>

      <div className="venues-grid">
        <Card className="venue-card">
          <div className="venue-card-heading">
            <span className="venue-card-glyph" aria-hidden="true">
              {venue.glyph}
            </span>
            <div>
              <h2>{venue.name}</h2>
              <span
                className={connected ? "venue-state is-ready" : "venue-state"}
              >
                <i aria-hidden="true" />
                {state}
              </span>
            </div>
          </div>

          <dl className="venue-facts">
            <div>
              <dt>Network</dt>
              <dd>{venue.network}</dd>
            </div>
            <div>
              <dt>Collateral</dt>
              <dd>{venue.collateral}</dd>
            </div>
            <div>
              <dt>Trading key</dt>
              <dd>
                {tradingKeyReady
                  ? "Trade only, no withdrawals"
                  : "Not authorized"}
              </dd>
            </div>
            <div>
              <dt>Venue fee you approved</dt>
              <dd>{feeText}</dd>
            </div>
            <div>
              <dt>Gas</dt>
              <dd>{gasText}</dd>
            </div>
            <div>
              <dt>Markets selected</dt>
              <dd>
                {selectedMarkets} of {eligibleMarkets} eligible
              </dd>
            </div>
          </dl>

          <div
            className="venue-accounts"
            role="table"
            aria-label={`${venue.name} accounts`}
          >
            <div className="venue-account-row is-header" role="row">
              <span role="columnheader">Account</span>
              <span role="columnheader">Equity</span>
              <span role="columnheader">Role</span>
            </div>
            {accounts.map((account) => (
              <div
                className="venue-account-row"
                role="row"
                key={account.accountId}
              >
                <strong role="cell">{account.accountId}</strong>
                <span role="cell">{formatMoney(account.equityUsd)}</span>
                <span role="cell">{account.role}</span>
              </div>
            ))}
          </div>

          <div className="venue-card-actions">
            <Button variant="quiet" size="small" onClick={onManage}>
              Manage accounts
            </Button>
            {onRevoke && (
              <Button variant="quiet" size="small" onClick={onRevoke}>
                Revoke trading key
              </Button>
            )}
          </div>
        </Card>

        <Card className="venue-add-card" title="Execution boundary">
          <p>
            Aftermath is the only active venue integration. Maker reads market
            state, signs through a trading-only key, and keeps withdrawals with
            the owner wallet.
          </p>
          <ol>
            <li>Market data and account state come from Aftermath</li>
            <li>The delegated key can quote, cancel, and reduce positions</li>
            <li>Deposits, withdrawals, and permissions stay owner-signed</li>
          </ol>
          <span>
            Additional venues will appear only after their controls are live.
          </span>
        </Card>
      </div>

      <Card
        className="venue-exposure-card"
        title="Exposure by venue"
        subtitle="Gross limits are shared across venues; equity counts Maker and hedge accounts."
      >
        <div
          className="venue-exposure-table"
          role="table"
          aria-label="Exposure by venue"
        >
          <ListRow className="venue-exposure-head">
            <span>Venue</span>
            <span>Equity</span>
            <span>Gross exposure</span>
            <span>Unrealized</span>
            <span>Accounts</span>
          </ListRow>
          <ListRow>
            <VenueChip venue={venue} />
            <span>{formatMoney(totalEquityUsd)}</span>
            <span>{formatMoney(grossExposureUsd)}</span>
            <span className={pnlClass}>{formatMoney(unrealizedPnlUsd)}</span>
            <span>{accounts.length}</span>
          </ListRow>
          <ListRow>
            <strong>Portfolio total</strong>
            <span>{formatMoney(totalEquityUsd)}</span>
            <span>
              {formatMoney(grossExposureUsd)} of{" "}
              {formatMoney(grossExposureLimitUsd)}
            </span>
            <span className={pnlClass}>{formatMoney(unrealizedPnlUsd)}</span>
            <span>{accounts.length}</span>
          </ListRow>
        </div>
      </Card>
    </div>
  );
}
