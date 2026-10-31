"use client";

import { useEffect, useRef } from "react";

import { formatMoney } from "../../lib/format";
import type { RunBundle } from "../../lib/run-state";
import { useMakerRunControls } from "../maker-shell";
import { MarketMotion, type MarketMotionHandle } from "../market-motion";
import { RunStatusChip } from "../run-control";

type LaneSnapshot = {
  mode: "observe" | "paper" | "live";
  lastError?: string | null;
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
      {(bundle.lastError ?? snapshot.lastError) && (
        <p className="bundle-lane-notice" role="status">
          {bundle.lastError ?? snapshot.lastError}
        </p>
      )}
      <MarketMotion
        ref={motion}
        compact
        sim={false}
        className="bundle-lane-motion"
        height={220}
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
        <span className="eyebrow">Running bundles</span>
        <h2>Bundles</h2>
      </header>
      <div>
        {lanes.slice(0, 4).map((lane) => (
          <BundleLane key={lane.bundle.id} lane={lane} />
        ))}
      </div>
    </section>
  );
}
