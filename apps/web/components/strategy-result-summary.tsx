"use client";

import { formatMoney, formatSignedMoney, moneyTone } from "../lib/format";

export type StrategyResultSide = {
  fills: number;
  volumeUsd: number;
  netUsd: number;
  returnPct: number | null;
  since: string | null;
};

export type StrategyResults = {
  requiredCollateralUsd: number;
  paper: StrategyResultSide;
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
        <strong className={`is-${moneyTone(side.netUsd)}`}>
          {formatSignedMoney(side.netUsd)}
        </strong>
        <small>
          {percent
            ? `${percent} on ${formatMoney(requiredCollateralUsd)} required collateral. `
            : ""}
          {formatMoney(side.volumeUsd)} volume in {side.fills}{" "}
          {side.fills === 1 ? "fill" : "fills"}
          {side.since ? ` since ${sinceDate(side.since)}` : ""}.
        </small>
      </dd>
    </div>
  );
}

/** A strategy's overall result across every bundle that has run it. Paper and
 * Live sit side by side and are never added together. */
export function StrategyResultSummary({
  results,
}: {
  results: StrategyResults | null;
}) {
  if (!results) return null;
  return (
    <dl className="strategy-result" aria-label="Overall result">
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
  );
}
