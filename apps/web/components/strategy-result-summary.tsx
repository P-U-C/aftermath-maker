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
    markouts: Array<{
      horizonMs: number;
      totalUsd: number | null;
      measuredFills: number;
      measuredNotionalUsd: number;
      unavailableFills: number;
      averageBps: number | null;
    }>;
    adverseSelection: {
      state: "collecting" | "within_limit" | "blocked";
      measuredFills: number;
      unavailableFills: number;
      makerNotionalUsd: number;
      totalMarkoutUsd: number | null;
      averageMarkoutBps: number | null;
      windowStartedAtMs: number;
      policy: {
        horizonMs: number;
        windowMs: number;
        minimumMeasuredFills: number;
        maximumAverageMarkoutBps: number;
      };
    };
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

const markoutHorizonLabel = (horizonMs: number) =>
  horizonMs % 3_600_000 === 0
    ? `${horizonMs / 3_600_000}h`
    : `${horizonMs / 60_000}m`;

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
            Frozen fee terms and fixed-horizon index markouts. Markouts measure
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
              <th scope="col">Markouts</th>
              <th scope="col">Paper guard</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const guard = row.adverseSelection;
              const guardLabel =
                guard.state === "blocked"
                  ? "New exposure paused"
                  : guard.state === "within_limit"
                    ? "Within limit"
                    : "Collecting evidence";
              return (
                <tr key={row.marketId}>
                  <th scope="row" data-label="Market">
                    {row.symbol}
                  </th>
                  <td data-label="Flow">
                    {formatMoney(row.volumeUsd)} · {row.fills}{" "}
                    {row.fills === 1 ? "fill" : "fills"}
                  </td>
                  <td data-label="Known fees">
                    <strong>{part(-row.knownFeesUsd)}</strong>
                    {row.feeTermsMissing ? (
                      <small>{row.feeTermsMissing} legacy missing</small>
                    ) : (
                      <small>all terms captured</small>
                    )}
                  </td>
                  <td data-label="Markouts">
                    <div className="strategy-paper-markouts">
                      {row.markouts.map((markout) => {
                        const waiting = Math.max(
                          0,
                          row.makerFills -
                            markout.measuredFills -
                            markout.unavailableFills,
                        );
                        return (
                          <div key={markout.horizonMs}>
                            <strong>
                              {markoutHorizonLabel(markout.horizonMs)}{" "}
                              <span
                                className={
                                  markout.totalUsd === null
                                    ? undefined
                                    : `is-${moneyTone(markout.totalUsd)}`
                                }
                              >
                                {markout.totalUsd === null
                                  ? "—"
                                  : part(markout.totalUsd)}
                              </span>
                            </strong>
                            <small>
                              {markout.measuredFills}/{row.makerFills} measured
                              {markout.averageBps === null
                                ? ""
                                : ` · ${markout.averageBps.toFixed(1)} bps`}
                              {markout.unavailableFills
                                ? ` · ${markout.unavailableFills} unavailable`
                                : ""}
                              {waiting ? ` · ${waiting} waiting` : ""}
                            </small>
                          </div>
                        );
                      })}
                    </div>
                  </td>
                  <td data-label="Paper guard">
                    <strong
                      className={
                        guard.state === "blocked" ? "is-loss" : undefined
                      }
                    >
                      {guardLabel}
                    </strong>
                    <small>
                      {guard.averageMarkoutBps === null
                        ? `${guard.measuredFills}/${guard.policy.minimumMeasuredFills} measured`
                        : `${guard.averageMarkoutBps.toFixed(0)} bps across ${guard.measuredFills} fills`}
                      {guard.state === "blocked"
                        ? ` · limit ${guard.policy.maximumAverageMarkoutBps} bps`
                        : ""}
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
