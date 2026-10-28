"use client";

import { useEffect, useRef } from "react";

import { formatMoney } from "../../lib/format";
import { MarketMotion, type MarketMotionHandle } from "../market-motion";

type LaneSnapshot = {
  mode: "observe" | "paper" | "live";
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
  id: string;
  name: string;
  snapshot: LaneSnapshot;
};

function BundleLane({ lane }: { lane: RunningBundleLane }) {
  const motion = useRef<MarketMotionHandle>(null);
  const { snapshot } = lane;

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
          <span>{snapshot.mode === "paper" ? "Paper" : "Observe"}</span>
          <h2>{lane.name}</h2>
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
          <BundleLane key={lane.id} lane={lane} />
        ))}
      </div>
    </section>
  );
}
