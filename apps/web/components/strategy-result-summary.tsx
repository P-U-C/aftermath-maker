"use client";

import { formatMoney, formatSignedMoney, moneyTone } from "../lib/format";

export type StrategyResultSide = {
  fills: number;
  volumeUsd: number;
  realizedPricePnlUsd: number;
  unrealizedPricePnlUsd: number;
  /** Signed cost: negative is a rebate. */
  executionFeesUsd: number;
  builderFeesUsd: number;
  /** Signed income, or null when it isn't measured. */
  fundingUsd: number | null;
  gasUsd: number | null;
  tradingNetUsd: number;
  returnPct: number | null;
  since: string | null;
  gaps: string[];
};

export type StrategyResults = {
  requiredCollateralUsd: number;
  paper: StrategyResultSide;
  /** Fixed Paper evidence, shown separately from trading P&L. */
  paperEvidence?: Array<{
    marketId: string;
    symbol: string;
    fills: number;
    makerFills: number;
    volumeUsd: number;
    knownFeesUsd: number;
    feeTermsMissing: number;
    markout5mUsd: number | null;
    markout5mMeasuredFills: number;
    markout5mUnavailableFills: number;
  }>;
  live: StrategyResultSide;
  liveReadError?: string | null;
};

const sinceDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : null;

/** Gas and fees are often fractions of a cent; show enough digits to see them. */
const part = (value: number) =>
  formatSignedMoney(
    value,
    Math.abs(value) > 0 && Math.abs(value) < 1
      ? { maximumFractionDigits: 4 }
      : {},
  );

function Breakdown({ side }: { side: StrategyResultSide }) {
  const rows: Array<[string, number | null, string?]> = [
    [
      "Price moves",
      side.realizedPricePnlUsd + side.unrealizedPricePnlUsd,
      `${formatSignedMoney(side.realizedPricePnlUsd)} closed, ${formatSignedMoney(side.unrealizedPricePnlUsd)} on open positions`,
    ],
    ["Venue fees", -side.executionFeesUsd],
    ["Builder fees", -side.builderFeesUsd],
    ["Funding", side.fundingUsd],
    ["Gas", side.gasUsd === null ? null : -side.gasUsd],
  ];
  const missing = side.gaps.length;
  return (
    <details className="strategy-result-breakdown">
      <summary>
        How it adds up
        {missing
          ? ` (${missing} ${missing === 1 ? "part" : "parts"} not counted)`
          : ""}
      </summary>
      <dl>
        {rows.map(([label, value, title]) => (
          <div key={label} title={title}>
            <dt>{label}</dt>
            <dd className={value === null ? "is-missing" : undefined}>
              {value === null ? "Not counted" : part(value)}
            </dd>
          </div>
        ))}
        <div className="is-total">
          <dt>Trading result</dt>
          <dd>{formatSignedMoney(side.tradingNetUsd)}</dd>
        </div>
      </dl>
      {missing > 0 && (
        <ul>
          {side.gaps.map((gap) => (
            <li key={gap}>{gap}</li>
          ))}
        </ul>
      )}
    </details>
  );
}

function ResultStat({
  label,
  side,
  requiredCollateralUsd,
  empty,
}: {
  label: string;
  side: StrategyResultSide;
  requiredCollateralUsd: number;
  empty: string;
}) {
  if (!side.fills) {
    return (
      <div className="strategy-result-stat">
        <dt>{label}</dt>
        <dd>
          <strong>—</strong>
          <small>{empty}</small>
        </dd>
      </div>
    );
  }
  const percent =
    side.returnPct === null
      ? null
      : `${side.returnPct > 0 ? "+" : side.returnPct < 0 ? "−" : ""}${Math.abs(side.returnPct).toFixed(2)}%`;
  return (
    <div className="strategy-result-stat">
      <dt>{label}</dt>
      <dd>
        <strong className={`is-${moneyTone(side.tradingNetUsd)}`}>
          {formatSignedMoney(side.tradingNetUsd)}
        </strong>
        <small>
          {percent
            ? `${percent} on ${formatMoney(requiredCollateralUsd)} required collateral. `
            : ""}
          {formatMoney(side.volumeUsd)} volume in {side.fills}{" "}
          {side.fills === 1 ? "fill" : "fills"}
          {side.since ? ` since ${sinceDate(side.since)}` : ""}.
        </small>
        <Breakdown side={side} />
      </dd>
    </div>
  );
}

function PaperEvidence({
  rows,
}: {
  rows: NonNullable<StrategyResults["paperEvidence"]>;
}) {
  if (!rows.length) return null;
  return (
    <section
      className="strategy-paper-evidence"
      aria-label="Paper evidence by market"
    >
      <header>
        <div>
          <h4>Paper evidence by market</h4>
          <p>
            Frozen fee terms and 5-minute index markouts. Markouts measure
            post-fill selection; they are not trading P&amp;L.
          </p>
        </div>
      </header>
      <div className="strategy-paper-evidence-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col">Flow</th>
              <th scope="col">Known fees</th>
              <th scope="col">5m markout</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const markoutCoverage = `${row.markout5mMeasuredFills}/${row.makerFills} measured`;
              const waiting = Math.max(
                0,
                row.makerFills -
                  row.markout5mMeasuredFills -
                  row.markout5mUnavailableFills,
              );
              return (
                <tr key={row.marketId}>
                  <th scope="row">{row.symbol}</th>
                  <td>
                    {formatMoney(row.volumeUsd)} · {row.fills}{" "}
                    {row.fills === 1 ? "fill" : "fills"}
                  </td>
                  <td>
                    <strong>{part(-row.knownFeesUsd)}</strong>
                    {row.feeTermsMissing ? (
                      <small>{row.feeTermsMissing} legacy missing</small>
                    ) : (
                      <small>all terms captured</small>
                    )}
                  </td>
                  <td>
                    <strong
                      className={
                        row.markout5mUsd === null
                          ? undefined
                          : `is-${moneyTone(row.markout5mUsd)}`
                      }
                    >
                      {row.markout5mUsd === null
                        ? "—"
                        : formatSignedMoney(row.markout5mUsd)}
                    </strong>
                    <small>
                      {markoutCoverage}
                      {row.markout5mUnavailableFills
                        ? ` · ${row.markout5mUnavailableFills} unavailable`
                        : ""}
                      {waiting ? ` · ${waiting} waiting` : ""}
                    </small>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** A strategy's overall trading result across every bundle that has run it.
 * Paper and Live sit side by side and are never added together, and rewards
 * are never added to either. */
export function StrategyResultSummary({
  results,
}: {
  results: StrategyResults | null;
}) {
  if (!results) return null;
  return (
    <div className="strategy-result">
      <dl aria-label="Overall result">
        <ResultStat
          label="Paper result, estimated"
          side={results.paper}
          requiredCollateralUsd={results.requiredCollateralUsd}
          empty="No Paper fills yet."
        />
        <ResultStat
          label="Live result"
          side={results.live}
          requiredCollateralUsd={results.requiredCollateralUsd}
          empty={
            results.liveReadError
              ? "Live fills couldn't be read just now."
              : "No Live trades yet."
          }
        />
      </dl>
      <PaperEvidence rows={results.paperEvidence ?? []} />
      <p className="strategy-result-rewards">
        Rewards aren&apos;t included. Paper doesn&apos;t earn them, and Live
        rewards are paid per wallet with no validated estimate for this epoch.
      </p>
    </div>
  );
}
