import { Fragment, useState, type ReactNode } from "react";
import { Check, MoreHorizontal } from "lucide-react";

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
  bundleMode: "observe" | "paper" | "live" | null;
  bundleRunning: boolean;
  freeUsd: number;
  withdrawableUsd: number;
  requiredUsd: number;
  shortfallUsd: number;
  authorized: boolean;
  gasSui: number | null;
  readiness: import("../../lib/bundle-readiness").BundleReadiness | null;
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
  walletAddress?: string;
  walletUsdcUsd?: number | null;
  walletSui?: number | null;
  onFund: (
    account: VenueAccountRow,
    mode: "deposit" | "withdraw" | "gas",
  ) => void;
  onFundBundle: (bundleName: string, accounts: VenueAccountRow[]) => void;
  onAuthorize: (accountId: string) => void;
  onOpenStrategy: () => void;
  blockedBundle?: {
    name: string;
    accountId: string;
    freeUsd: number;
    requiredUsd: number;
    shortfallUsd: number;
    markets: number;
    quoteSizeUsd: number;
  } | null;
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
  walletAddress,
  walletUsdcUsd,
  walletSui,
  onFund,
  onFundBundle,
  onAuthorize,
  onOpenStrategy,
  blockedBundle,
  onRevoke,
}: VenueBoardProps) {
  const [accountMenu, setAccountMenu] = useState<string | null>(null);
  const [revokeConfirm, setRevokeConfirm] = useState(false);
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
        actions={
          walletAddress && (
            <div className="venue-wallet-balance">
              <span>
                Your wallet {walletAddress.slice(0, 6)}…
                {walletAddress.slice(-4)}
              </span>
              <strong>
                {walletUsdcUsd === null ||
                walletUsdcUsd === undefined ||
                walletSui === null ||
                walletSui === undefined
                  ? "Connect your wallet to see balances"
                  : `${formatMoney(walletUsdcUsd)} USDC and ${walletSui.toFixed(2)} SUI`}
              </strong>
            </div>
          )
        }
      />

      {blockedBundle && (
        <Card className="venue-blocked-banner">
          <span className="venue-blocked-dot" aria-hidden="true" />
          <div>
            <h2>{blockedBundle.name} can’t quote yet</h2>
            <p>
              Account {blockedBundle.accountId} has{" "}
              {formatMoney(blockedBundle.freeUsd)} free. Quoting{" "}
              {blockedBundle.markets} markets at{" "}
              {formatMoney(blockedBundle.quoteSizeUsd)} a side needs{" "}
              {formatMoney(blockedBundle.requiredUsd)}.
            </p>
          </div>
          <Button variant="secondary" onClick={onOpenStrategy}>
            Quote one market at a time
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              const account = accounts.find(
                (row) => row.accountId === blockedBundle.accountId,
              );
              if (account) onFund(account, "deposit");
            }}
          >
            Deposit {formatMoney(blockedBundle.shortfallUsd)}
          </Button>
        </Card>
      )}

      <Card
        className="venue-accounts-card"
        title={
          <span className="venue-accounts-title">
            Aftermath accounts{" "}
            <span className="venue-state is-ready">
              <i aria-hidden="true" />
              Connected
            </span>
          </span>
        }
        subtitle="Each account needs a trading key, gas for that key, and enough free collateral for its bundle’s strategy."
        action={
          <div className="venue-kit-actions">
            <Button variant="secondary" size="small" onClick={onNewAccount}>
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
                <th>Free collateral</th>
                <th>Trading key</th>
                <th>Key gas</th>
                <th>Stage</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {accountsByBundle.map(([bundle, groupedAccounts]) => {
                const shortfall = Math.max(
                  ...groupedAccounts.map((account) => account.shortfallUsd),
                  0,
                );
                const shortAccounts = groupedAccounts.filter(
                  (account) => account.shortfallUsd > 0,
                );
                const mode = groupedAccounts[0]?.bundleMode;
                return (
                  <Fragment key={bundle}>
                    <tr className="venue-account-group">
                      <th colSpan={7}>
                        <span className="venue-bundle-group">
                          <strong>{bundle}</strong>
                          {mode && (
                            <span className={`bundle-mode mode-${mode}`}>
                              {mode === "live" ? "Live" : "Paper"}
                            </span>
                          )}
                          <span
                            className={shortfall > 0 ? "is-short" : "is-ready"}
                          >
                            {shortfall > 0
                              ? `Needs ${formatMoney(shortfall)} collateral`
                              : groupedAccounts.every(
                                    (account) => account.readiness?.ready,
                                  )
                                ? "Ready"
                                : "Checking readiness"}
                          </span>
                          {shortAccounts.length > 0 && (
                            <Button
                              size="small"
                              variant="secondary"
                              onClick={() =>
                                onFundBundle(bundle, groupedAccounts)
                              }
                            >
                              Fund {bundle}
                            </Button>
                          )}
                        </span>
                      </th>
                    </tr>
                    {groupedAccounts.map((account) => {
                      const stage = !account.authorized
                        ? "Needs trading key"
                        : account.shortfallUsd > 0
                          ? `Needs ${formatMoney(account.shortfallUsd)}`
                          : account.gasSui !== null &&
                              account.readiness?.stages[3].status === "todo"
                            ? "Needs gas"
                            : account.readiness
                              ? "Ready"
                              : "Checking";
                      return (
                        <tr key={account.accountId}>
                          <td>
                            <strong>
                              {account.label ?? `Account ${account.accountId}`}
                            </strong>
                            <small>#{account.accountId}</small>
                          </td>
                          <td>{account.role}</td>
                          <td
                            className={
                              account.shortfallUsd > 0
                                ? "venue-amount-short"
                                : "venue-amount"
                            }
                          >
                            {formatMoney(account.freeUsd)}
                          </td>
                          <td>
                            {account.authorized ? (
                              <>
                                <Check size={14} aria-hidden="true" />{" "}
                                Authorized
                              </>
                            ) : (
                              <Button
                                variant="quiet"
                                size="small"
                                onClick={() => onAuthorize(account.accountId)}
                              >
                                Authorize
                              </Button>
                            )}
                          </td>
                          <td className="venue-amount">
                            {account.gasSui === null
                              ? "—"
                              : `${account.gasSui.toFixed(2)} SUI`}
                          </td>
                          <td>
                            <span
                              className={`venue-stage ${stage === "Ready" ? "is-ready" : "is-short"}`}
                            >
                              {stage}
                            </span>
                          </td>
                          <td className="venue-account-actions">
                            <Button
                              variant={
                                account.shortfallUsd > 0
                                  ? "primary"
                                  : "secondary"
                              }
                              size="small"
                              onClick={() => onFund(account, "deposit")}
                            >
                              {account.shortfallUsd > 0
                                ? `Deposit ${formatMoney(account.shortfallUsd)}`
                                : "Deposit"}
                            </Button>
                            <div className="venue-account-menu">
                              <Button
                                variant="secondary"
                                size="small"
                                aria-label={`More actions for account ${account.accountId}`}
                                aria-expanded={
                                  accountMenu === account.accountId
                                }
                                onClick={() =>
                                  setAccountMenu((current) =>
                                    current === account.accountId
                                      ? null
                                      : account.accountId,
                                  )
                                }
                              >
                                <MoreHorizontal size={18} />
                              </Button>
                              {accountMenu === account.accountId && (
                                <div
                                  role="group"
                                  aria-label={`Account ${account.accountId} actions`}
                                >
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setAccountMenu(null);
                                      onFund(account, "withdraw");
                                    }}
                                  >
                                    Withdraw
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setAccountMenu(null);
                                      onFund(account, "gas");
                                    }}
                                  >
                                    Add gas
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setAccountMenu(null);
                                      onManage();
                                    }}
                                  >
                                    Rename
                                  </button>
                                  {onRevoke && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setAccountMenu(null);
                                        setRevokeConfirm(true);
                                      }}
                                    >
                                      Revoke trading key
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </KitTable>
        </div>
      </Card>

      <Card className="venue-card venue-facts-strip">
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
            <dt>Trading keys</dt>
            <dd>{tradingKeyReady ? "Trades only" : "Not authorized"}</dd>
          </div>
          <div>
            <dt>Venue fee</dt>
            <dd>{feeText}</dd>
          </div>
        </dl>
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
