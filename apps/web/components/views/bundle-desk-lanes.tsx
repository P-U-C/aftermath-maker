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
  running?: boolean;
  markets?: Array<{ id: string; symbol: string; inventoryUsd?: number }>;
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
    positions: Array<{
      marketId: string;
      symbol: string;
      account: string;
      inventoryUsd: number;
    }>;
  };
  maxInventoryUsd?: number;
  portfolio: { unrealizedPnlUsd: number };
};

export type RunningBundleLane = {
  bundle: RunBundle;
  snapshot: LaneSnapshot;
};

function laneNotices(lane: RunningBundleLane): string[] {
  const { snapshot, bundle } = lane;
  return [
    snapshot.paperBlocker
      ? formatPaperBlocker(snapshot.paperBlocker).sentence
      : null,
    bundle.lastError ?? snapshot.lastError ?? null,
    // A paused or stopped bundle stops reading on purpose; only a running one
    // can be stale.
    snapshot.running !== false &&
    snapshot.accountReadAt &&
    Date.now() - Date.parse(snapshot.accountReadAt) >
      3 * (snapshot.cycleIntervalMs ?? 5_000)
      ? `Account data is stale, last read ${relativeAccountRead(snapshot.accountReadAt)?.replace(/^Checked /, "")}`
      : null,
  ].filter((notice): notice is string => Boolean(notice));
}

function lanePositions(snapshot: LaneSnapshot) {
  // Bundle-wide positions, never the market being quoted this second.
  const positions = snapshot.inventory?.positions?.length
    ? snapshot.inventory.positions
    : (snapshot.markets ?? [])
        .filter((market) => Math.abs(market.inventoryUsd ?? 0) >= 0.005)
        .map((market) => ({
          marketId: market.id,
          symbol: market.symbol,
          account: "maker",
          inventoryUsd: market.inventoryUsd ?? 0,
        }));
  return [...positions].sort(
    (left, right) => Math.abs(right.inventoryUsd) - Math.abs(left.inventoryUsd),
  );
}

function BundleLane({
  lane,
  reserveNotice,
}: {
  lane: RunningBundleLane;
  reserveNotice: boolean;
}) {
  const motion = useRef<MarketMotionHandle>(null);
  const { open: openRunStatus } = useMakerRunControls();
  const { snapshot, bundle } = lane;
  const notices = laneNotices(lane);
  const positions = lanePositions(snapshot);
  const netInventoryUsd = positions.reduce(
    (total, position) => total + position.inventoryUsd,
    0,
  );
  const grossInventoryUsd = positions.reduce(
    (total, position) => total + Math.abs(position.inventoryUsd),
    0,
  );
  const positionSummary = positions
    .map(
      (position) => `${position.symbol} ${formatMoney(position.inventoryUsd)}`,
    )
    .join(", ");

  useEffect(() => {
    motion.current?.update({
      mid: snapshot.market.indexPrice,
      bid: snapshot.quote?.bidPrice ?? null,
      ask: snapshot.quote?.askPrice ?? null,
      bestBid: snapshot.market.bestBid,
      bestAsk: snapshot.market.bestAsk,
      inventoryUsd: netInventoryUsd,
      book: snapshot.market.book,
    });
  }, [snapshot, netInventoryUsd]);

  return (
    <article className="bundle-desk-lane">
      <header>
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
        <dl>
          <div>
            <dt>Quoting</dt>
            <dd>{snapshot.market.symbol || "Waiting"}</dd>
          </div>
          <div title={positionSummary || "No open positions"}>
            <dt>Gross</dt>
            <dd>
              {formatMoney(grossInventoryUsd)}
              {positions.length > 1 && <small> in {positions.length}</small>}
            </dd>
          </div>
          <div>
            <dt>Known result</dt>
            <dd>{formatMoney(snapshot.portfolio.unrealizedPnlUsd)}</dd>
          </div>
        </dl>
      </header>
      {(notices.length > 0 || reserveNotice) && (
        <div className="bundle-lane-notice-slot">
          {notices.length > 0 && (
            <button
              type="button"
              className="bundle-lane-notice"
              title={notices.join(" ")}
              onClick={() => openRunStatus(bundle.id)}
            >
              <span>{notices[0]}</span>
              {notices.length > 1 && <b>+{notices.length - 1}</b>}
            </button>
          )}
        </div>
      )}
      <MarketMotion
        ref={motion}
        compact
        sim={false}
        className="bundle-lane-motion"
        mid={snapshot.market.indexPrice}
        bid={snapshot.quote?.bidPrice ?? null}
        ask={snapshot.quote?.askPrice ?? null}
        bestBid={snapshot.market.bestBid}
        bestAsk={snapshot.market.bestAsk}
        inventoryUsd={netInventoryUsd}
        book={snapshot.market.book}
      />
    </article>
  );
}

export function BundleDeskLanes({ lanes }: { lanes: RunningBundleLane[] }) {
  if (!lanes.length) return null;
  // Every card keeps the same shape: when one has a notice, the others keep
  // the same slot empty so a row never goes ragged.
  const reserveNotice = lanes
    .slice(0, 4)
    .some((lane) => laneNotices(lane).length > 0);
  return (
    <section className="bundle-desk-lanes" aria-label="Running bundles">
      <header>
        <h2>Bundles on the desk</h2>
      </header>
      <div>
        {lanes.slice(0, 4).map((lane) => (
          <BundleLane
            key={lane.bundle.id}
            lane={lane}
            reserveNotice={reserveNotice}
          />
        ))}
      </div>
    </section>
  );
}
