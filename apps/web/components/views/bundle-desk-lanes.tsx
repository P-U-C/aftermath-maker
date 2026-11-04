"use client";

import { useEffect, useRef } from "react";

import { formatMoney } from "../../lib/format";
import {
  formatPaperBlocker,
  relativeAccountRead,
  type PaperBlocker,
} from "../../lib/paper-blocker";
import type { RunBundle } from "../../lib/run-state";
import { useMakerRunControls } from "../maker-shell";
import { MarketMotion, type MarketMotionHandle } from "../market-motion";
import { RunStatusChip } from "../run-control";

type LaneSnapshot = {
  mode: "observe" | "paper" | "live";
  lastError?: string | null;
  paperBlocker?: PaperBlocker | null;
  accountReadAt?: string | null;
  cycleIntervalMs?: number;
  market: {
    symbol: string;
    indexPrice: number | null;
    bestBid: number | null;
    bestAsk: number | null;
    book: {
      bids: Array<[number, number]>;
      asks: Array<[number, number]>;
      observedAt: string;
    } | null;
  };
  quote: { bidPrice: number; askPrice: number; sizeUsd: number } | null;
  balances: { inventoryUsd: number };
  inventory?: {
    netUsd: number;
    grossUsd: number;
    positions: Array<{ marketId: string; symbol: string; account: string; inventoryUsd: number }>;
  };
  maxInventoryUsd?: number;
  portfolio: { unrealizedPnlUsd: number };
};

export type RunningBundleLane = {
  bundle: RunBundle;
  snapshot: LaneSnapshot;
};

function BundleLane({ lane }: { lane: RunningBundleLane }) {
  const motion = useRef<MarketMotionHandle>(null);
  const { open: openRunStatus } = useMakerRunControls();
  const { snapshot, bundle } = lane;
  const notices = [
    snapshot.paperBlocker ? formatPaperBlocker(snapshot.paperBlocker).sentence : null,
    bundle.lastError ?? snapshot.lastError ?? null,
    snapshot.accountReadAt && Date.now() - Date.parse(snapshot.accountReadAt) > 3 * (snapshot.cycleIntervalMs ?? 5_000)
      ? `Account data is stale, last read ${relativeAccountRead(snapshot.accountReadAt)?.replace(/^Checked /, "")}`
      : null,
  ].filter((notice): notice is string => Boolean(notice));
  const positions = [...(snapshot.inventory?.positions ?? [])]
    .sort((left, right) => Math.abs(right.inventoryUsd) - Math.abs(left.inventoryUsd));
  const shownPositions = positions.slice(0, 3);
  const grossInventory = snapshot.inventory?.grossUsd ?? Math.abs(snapshot.balances.inventoryUsd);
  const inventoryLimit = snapshot.maxInventoryUsd ?? Math.max(1, grossInventory);

  useEffect(() => {
    motion.current?.update({
      mid: snapshot.market.indexPrice,
      bid: snapshot.quote?.bidPrice ?? null,
      ask: snapshot.quote?.askPrice ?? null,
      bestBid: snapshot.market.bestBid,
      bestAsk: snapshot.market.bestAsk,
      inventoryUsd: snapshot.balances.inventoryUsd,
      book: snapshot.market.book,
    });
  }, [snapshot]);

  return (
    <article className="bundle-desk-lane">
      <header>
        <div>
          <div className="bundle-lane-title">
            <h2>{bundle.name}</h2>
            <span className={`run-mode-tag is-${bundle.mode}`}>
              {bundle.mode === "live" ? "Live" : "Paper"}
            </span>
            <RunStatusChip
              bundle={bundle}
              onClick={() => openRunStatus(bundle.id)}
            />
          </div>
        </div>
        <dl>
          <div>
            <dt>Market</dt>
            <dd>{snapshot.market.symbol || "Waiting"}</dd>
          </div>
          <div>
            <dt>Known result</dt>
            <dd>{formatMoney(snapshot.portfolio.unrealizedPnlUsd)}</dd>
          </div>
        </dl>
      </header>
      <div className="bundle-lane-notice-slot">
        {notices.length > 0 && (
          <p className="bundle-lane-notice" role="status" title={notices.join(" ")}>
            {notices[0]}{notices.length > 1 ? `, and ${notices.length - 1} more` : ""}
            <details>
              <summary>Details</summary>
              {notices.join(" ")}
            </details>
          </p>
        )}
      </div>
      <section className="bundle-lane-inventory" aria-label={`${bundle.name} inventory`}>
        <header><span>Inventory</span><strong>{formatMoney(grossInventory)} gross</strong></header>
        <div className="bundle-lane-meter" aria-label={`${formatMoney(grossInventory)} of ${formatMoney(inventoryLimit)} inventory limit`}>
          <i style={{ width: `${Math.min(100, (grossInventory / inventoryLimit) * 100)}%` }} />
        </div>
        {shownPositions.length ? (
          <ul>
            {shownPositions.map((position) => (
              <li key={`${position.account}:${position.marketId}`}>
                <span>{position.symbol}</span>
                <i><b style={{ width: `${Math.min(100, (Math.abs(position.inventoryUsd) / inventoryLimit) * 100)}%` }} /></i>
                <strong>{formatMoney(position.inventoryUsd)}</strong>
              </li>
            ))}
          </ul>
        ) : <small>Flat across accounts</small>}
        {positions.length > 3 && <details className="bundle-lane-more"><summary>+{positions.length - 3} more</summary><ul>{positions.slice(3).map((position) => <li key={`${position.account}:${position.marketId}`}><span>{position.symbol}</span><strong>{formatMoney(position.inventoryUsd)}</strong></li>)}</ul></details>}
      </section>
      <MarketMotion
        ref={motion}
        compact
        sim={false}
        className="bundle-lane-motion"
        height={140}
        mid={snapshot.market.indexPrice}
        bid={snapshot.quote?.bidPrice ?? null}
        ask={snapshot.quote?.askPrice ?? null}
        bestBid={snapshot.market.bestBid}
        bestAsk={snapshot.market.bestAsk}
        inventoryUsd={snapshot.balances.inventoryUsd}
        book={snapshot.market.book}
      />
    </article>
  );
}

export function BundleDeskLanes({ lanes }: { lanes: RunningBundleLane[] }) {
  if (!lanes.length) return null;
  return (
    <section className="bundle-desk-lanes" aria-label="Running bundles">
      <header>
        <h2>Bundles on the desk</h2>
      </header>
      <div>
        {lanes.slice(0, 4).map((lane) => (
          <BundleLane key={lane.bundle.id} lane={lane} />
        ))}
      </div>
    </section>
  );
}
