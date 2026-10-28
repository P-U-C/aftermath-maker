"use client";

import { useRef, useState } from "react";

import { MarketMotion, type MarketMotionHandle } from "../market-motion";
import { ViewFrame } from "./view-frame";

const chapters = [
  {
    title: "The spread",
    text: "Your bid and ask rest either side of the price. The gap between the two capsules is the spread you earn.",
  },
  {
    title: "Fills",
    text: "Sellers can trade with your bid and buyers can trade with your ask. A filled order becomes inventory.",
  },
  {
    title: "Inventory and skew",
    text: "Fills leave you holding some of the asset. Maker leans its quotes to encourage a return toward flat.",
  },
  {
    title: "Hedging",
    text: "Past your trigger, the taker account can trade the other way so a move cannot run away with you.",
  },
  {
    title: "Rewards",
    text: "Venues can reward resting, competitive quotes near the market price.",
  },
] as const;

export function LearnView({ active }: { active: boolean }) {
  const motion = useRef<MarketMotionHandle>(null);
  const [chapter, setChapter] = useState(0);

  function selectChapter(index: number) {
    setChapter(index);
    if (index === 1) motion.current?.fill("bid");
    if (index === 3) motion.current?.hedge();
  }

  return (
    <ViewFrame active={active} name="learn">
      <main className="learn-view">
        <header className="learn-heading">
          <p className="eyebrow">Illustration</p>
          <h1>Watch a market being made.</h1>
          <p>
            Your ask rests above the price and your bid below it. Takers can
            trade with them, and the taker account can hedge inventory when it
            grows too far from flat. On your desk the same picture uses your
            real quotes, fills, and the live book.
          </p>
        </header>
        <section
          className="learn-stage"
          aria-label="Market-making illustration"
        >
          <MarketMotion
            ref={motion}
            sim
            mid={0.021441}
            bid={0.021407}
            ask={0.021475}
            bestBid={0.021398}
            bestAsk={0.021484}
            inventoryUsd={chapter === 2 ? 1.04 : 0}
            book={null}
            caption="Illustration. The desk uses real quotes, fills, and depth instead."
          />
          <div className="learn-legend" aria-label="Order book legend">
            <span className="is-ask">Your ask</span>
            <span className="is-market">Market price</span>
            <span className="is-bid">Your bid</span>
            <span className="is-book">Everyone else's orders</span>
          </div>
        </section>
        <ol className="learn-chapters">
          {chapters.map((item, index) => (
            <li key={item.title}>
              <button
                type="button"
                className={chapter === index ? "is-active" : undefined}
                onClick={() => selectChapter(index)}
              >
                <span>{index + 1}</span>
                <strong>{item.title}</strong>
                <p>{item.text}</p>
              </button>
            </li>
          ))}
        </ol>
      </main>
    </ViewFrame>
  );
}
