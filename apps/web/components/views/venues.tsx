import { Fragment, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";

import { formatMoney } from "../../lib/format";
import type { VenueDescriptor } from "../../lib/venues";
import { Button, Card, KitTable, PageHeader, Sheet } from "../ui/primitives";
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
  label: string | null;
  equityUsd: number;
  exposureUsd?: number | undefined;
  unrealizedPnlUsd?: number | undefined;
  role: "Maker" | "Taker" | "Available";
  bundle: string;
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
  onNewAccount: () => void;
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
  onNewAccount,
  onRevoke,
}: VenueBoardProps) {
  const state = !connected
    ? "Setup required"
    : quoting
      ? "Connected, quoting"
      : "Connected, ready";
  const [revokeConfirm, setRevokeConfirm] = useState(false);
  const perAccountMetrics = accounts.every(
    (account) =>
      account.exposureUsd !== undefined &&
      account.unrealizedPnlUsd !== undefined,
  );
  const accountsByBundle = Array.from(
    accounts.reduce((groups, account) => {
      const group = groups.get(account.bundle) ?? [];
      group.push(account);
      groups.set(account.bundle, group);
      return groups;
    }, new Map<string, VenueAccountRow[]>()),
  ).sort(([left], [right]) => {
    const rank = (bundle: string) =>
      bundle === "Core" ? 0 : bundle === "Not in a bundle" ? 2 : 1;
    return rank(left) - rank(right) || left.localeCompare(right);
  });

  return (
    <div className="venues-board">
      <PageHeader
        className="venues-title"
        title="Venues"
        description="Where Maker trades, what it's allowed to do there, and what your accounts hold."
      />

      <Card className="venue-card">
        <header className="venue-kit-heading">
          <div>
            <h2>{venue.name}</h2>
            <span
              className={connected ? "venue-state is-ready" : "venue-state"}
            >
              <i aria-hidden="true" />
              {state}
            </span>
          </div>
          <a
            className="ui-button ui-button-secondary ui-button-medium"
            href={venue.homeUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open {venue.name} <ExternalLink size={14} aria-hidden="true" />
          </a>
        </header>
        <dl className="venue-kit-facts">
          <div>
            <dt>Network</dt>
            <dd>{venue.network}</dd>
          </div>
          <div>
            <dt>Collateral</dt>
            <dd>{venue.collateral}</dd>
          </div>
          <div>
            <dt>Markets selected</dt>
            <dd>
              {selectedMarkets} of {eligibleMarkets} eligible
            </dd>
          </div>
          <div>
            <dt>Trading key</dt>
            <dd>
              {tradingKeyReady ? "Trades only" : "Not authorized"}
              <small>It can&apos;t withdraw or move funds.</small>
            </dd>
          </div>
          <div>
            <dt>Venue fee</dt>
            <dd>{feeText}</dd>
          </div>
          <div>
            <dt>Gas</dt>
            <dd>
              {gasText.split(",")[0]}
              <small>
                {gasText.match(/(\d+) transactions after reserve/)
                  ? `About ${gasText.match(/(\d+) transactions after reserve/)?.[1]} paid actions after the reserve`
                  : "Runway not reported"}
              </small>
            </dd>
          </div>
        </dl>
      </Card>

      <Card
        className="venue-accounts-card"
        title="Accounts"
        subtitle={`Equity ${formatMoney(totalEquityUsd)}, exposure ${formatMoney(grossExposureUsd)} of your ${formatMoney(grossExposureLimitUsd)} wallet limit.`}
        action={
          <div className="venue-kit-actions">
            <Button variant="secondary" size="small" onClick={onManage}>
              Manage accounts
            </Button>
            <Button variant="primary" size="small" onClick={onNewAccount}>
              New account
            </Button>
          </div>
        }
      >
        <div
          className="venue-accounts-scroll"
          role="region"
          aria-label="Aftermath accounts, scroll horizontally for more columns"
          tabIndex={0}
        >
          <KitTable className="venue-kit-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Role</th>
                <th>Equity</th>
                {perAccountMetrics && <th>Exposure</th>}
                {perAccountMetrics && <th>Unrealized</th>}
              </tr>
            </thead>
            <tbody>
              {accountsByBundle.map(([bundle, groupedAccounts]) => (
                <Fragment key={bundle}>
                  <tr className="venue-account-group">
                    <th colSpan={perAccountMetrics ? 5 : 3}>
                      {bundle} <span>{groupedAccounts.length}</span>
                    </th>
                  </tr>
                  {groupedAccounts.map((account) => (
                    <tr key={account.accountId}>
                      <td>
                        <strong>
                          {account.label ?? `Account ${account.accountId}`}
                        </strong>
                        <small>#{account.accountId}</small>
                      </td>
                      <td>{account.role}</td>
                      <td>{formatMoney(account.equityUsd)}</td>
                      {perAccountMetrics && (
                        <td>{formatMoney(account.exposureUsd ?? null)}</td>
                      )}
                      {perAccountMetrics && (
                        <td
                          className={
                            account.unrealizedPnlUsd &&
                            account.unrealizedPnlUsd < 0
                              ? "negative-number"
                              : ""
                          }
                        >
                          {formatMoney(account.unrealizedPnlUsd ?? null)}
                        </td>
                      )}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </KitTable>
        </div>
        <p className="venue-account-footnote">
          Wallet-wide unrealized result is {formatMoney(unrealizedPnlUsd)}.
          Per-account exposure and result are not reported by this account read.
        </p>
      </Card>

      <Card
        className="venue-execution-card"
        title="What Maker can and can't do here"
      >
        <ul>
          <li>Market data and account state come from {venue.name}.</li>
          <li>The delegated key can quote, cancel and reduce positions.</li>
          <li>Deposits, withdrawals and permissions stay owner-signed.</li>
        </ul>
        {onRevoke && (
          <Button variant="danger" onClick={() => setRevokeConfirm(true)}>
            Revoke trading key…
          </Button>
        )}
      </Card>

      <Sheet
        open={revokeConfirm}
        title="Revoke trading key?"
        description="This requires an owner-wallet confirmation and stops trading until you approve a new key."
        onClose={() => setRevokeConfirm(false)}
        footer={
          <>
            <Button variant="quiet" onClick={() => setRevokeConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setRevokeConfirm(false);
                onRevoke?.();
              }}
            >
              Revoke trading key
            </Button>
          </>
        }
      >
        <p>
          The owner wallet will review this action before any authorization
          changes.
        </p>
      </Sheet>
    </div>
  );
}
