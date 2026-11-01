"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { glossary, type GlossaryKey } from "../../lib/glossary";
import { MarketMotion, type MarketMotionHandle } from "../market-motion";
import { ViewFrame } from "./view-frame";

const chapters = [
  {
    id: "spread",
    title: "The spread",
    text: "Your bid and ask rest either side of the price. The gap between the two capsules is the spread you earn.",
  },
  {
    id: "fills",
    title: "Fills",
    text: "One seller can trade with your bid. That filled order becomes inventory, then your bid grows back.",
  },
  {
    id: "skew",
    title: "Inventory and skew",
    text: "Three fills leave you holding the asset. Maker leans both quotes down to invite the trade that reduces it.",
  },
  {
    id: "hedge",
    title: "Hedging",
    text: "Past your trigger, the Taker account trades the other way and returns the meter to flat.",
  },
  {
    id: "rewards",
    title: "Rewards",
    text: "Resting, competitive quotes can qualify for venue rewards while they wait near the market price.",
  },
] as const;

type ChapterId = (typeof chapters)[number]["id"];

const chapterByTerm: Record<GlossaryKey, ChapterId> = {
  spread: "spread",
  bps: "spread",
  inventory: "fills",
  skew: "skew",
  taker: "hedge",
  unrealizedPnl: "fills",
  runDrawdown: "hedge",
  qScore: "rewards",
  rewardPotential: "rewards",
  maker: "spread",
  observe: "spread",
  paper: "fills",
};

function chapterFromHash() {
  const [, chapter] = window.location.hash.replace(/^#/, "").split("/");
  return chapters.some((item) => item.id === chapter)
    ? (chapter as ChapterId)
    : null;
}

export function LearnView({ active }: { active: boolean }) {
  const motion = useRef<MarketMotionHandle>(null);
  const chapterNodes = useRef<Record<ChapterId, HTMLElement | null>>(
    Object.fromEntries(chapters.map((item) => [item.id, null])) as Record<
      ChapterId,
      HTMLElement | null
    >,
  );
  const [chapter, setChapter] = useState<ChapterId>("spread");
  const chapterRef = useRef<ChapterId>("spread");
  const [beat, setBeat] = useState("");
  const directHashLocked = useRef(false);

  const showChapter = useCallback(
    (
      next: ChapterId,
      options: { scroll?: boolean; replace?: boolean } = {},
    ) => {
      chapterRef.current = next;
      setChapter(next);
      motion.current?.play(next);
      if (options.replace !== false) {
        window.history.replaceState(null, "", "#learn/" + next);
      }
      if (options.scroll) {
        chapterNodes.current[next]?.scrollIntoView({
          block: "center",
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "auto"
            : "smooth",
        });
      }
    },
    [],
  );

  useEffect(() => {
    if (!active) return;
    const fromHash = chapterFromHash();
    if (fromHash) directHashLocked.current = true;
    const next = fromHash ?? chapterRef.current;
    const frame = window.requestAnimationFrame(() => {
      showChapter(next, { scroll: Boolean(fromHash), replace: false });
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [active, showChapter]);

  useLayoutEffect(() => {
    if (!active) return;
    const syncHash = () => {
      const next = chapterFromHash();
      if (!next || next === chapterRef.current) return;
      directHashLocked.current = true;
      showChapter(next, { scroll: true, replace: false });
    };
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, [active, showChapter]);

  useEffect(() => {
    if (!active || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entered = entries.find(
          (entry) => entry.isIntersecting && entry.intersectionRatio >= 0.6,
        );
        if (!entered) return;
        const next = entered.target.getAttribute("data-chapter") as ChapterId;
        // Keep an explicit chapter selection while its programmatic scroll
        // settles. Wheel, touch, keyboard, or pointer input unlocks reading
        // progress below.
        if (directHashLocked.current) return;
        if (next && next !== chapterRef.current) showChapter(next);
      },
      { threshold: [0.6] },
    );
    const nodes = chapterNodes.current;
    chapters.forEach((item) => {
      const node = nodes[item.id];
      if (node) observer.observe(node);
    });
    return () => observer.disconnect();
  }, [active, showChapter]);

  useEffect(() => {
    if (!active) return;
    const unlockObserver = () => {
      directHashLocked.current = false;
    };
    const unlockOnNavigationKey = (event: KeyboardEvent) => {
      if (
        [
          "ArrowDown",
          "ArrowUp",
          "PageDown",
          "PageUp",
          "Home",
          "End",
          " ",
        ].includes(event.key)
      ) {
        unlockObserver();
      }
    };
    window.addEventListener("pointerdown", unlockObserver, { passive: true });
    window.addEventListener("wheel", unlockObserver, { passive: true });
    window.addEventListener("touchstart", unlockObserver, { passive: true });
    window.addEventListener("keydown", unlockOnNavigationKey);
    return () => {
      window.removeEventListener("pointerdown", unlockObserver);
      window.removeEventListener("wheel", unlockObserver);
      window.removeEventListener("touchstart", unlockObserver);
      window.removeEventListener("keydown", unlockOnNavigationKey);
    };
  }, [active]);

  const setChapterNode = useCallback(
    (id: ChapterId) => (node: HTMLElement | null) => {
      chapterNodes.current[id] = node;
    },
    [],
  );

  const selectChapter = useCallback(
    (next: ChapterId) => {
      directHashLocked.current = true;
      showChapter(next, { scroll: true });
    },
    [showChapter],
  );

  const onEvent = useCallback((event: string) => setBeat(event), []);

  return (
    <ViewFrame active={active} name="learn">
      <main className="learn-view">
        <header className="learn-heading">
          <h1>Watch a market being made.</h1>
          <p>
            Each chapter directs one moment in the same order-book animation.
            The desk uses real quotes, fills, and depth instead.
          </p>
        </header>

        <div className="learn-layout">
          <section
            className="learn-stage"
            aria-label="Market-making illustration"
          >
            <MarketMotion
              ref={motion}
              sim
              director={false}
              onEvent={onEvent}
              mid={0.021441}
              bid={0.021407}
              ask={0.021475}
              bestBid={0.021398}
              bestAsk={0.021484}
              inventoryUsd={0}
              book={null}
              caption="Illustration. The desk uses real quotes, fills, and depth instead."
            />
            <div className="learn-legend" aria-label="Order book legend">
              <span className="is-ask">Your ask</span>
              <span className="is-market">Market price</span>
              <span className="is-bid">Your bid</span>
              <span className="is-book">Everyone else&apos;s orders</span>
            </div>
            <p className="learn-beat" aria-live="polite">
              {beat ? "Scene: " + beat.replaceAll("-", " ") : "Scene ready"}
            </p>
          </section>

          <ol className="learn-chapters">
            {chapters.map((item, index) => (
              <li
                key={item.id}
                id={item.id}
                data-chapter={item.id}
                ref={setChapterNode(item.id)}
              >
                <button
                  type="button"
                  className={chapter === item.id ? "is-active" : undefined}
                  onClick={() => selectChapter(item.id)}
                >
                  <span>{index + 1}</span>
                  <strong>{item.title}</strong>
                  <p>{item.text}</p>
                  <small>Play scene</small>
                </button>
              </li>
            ))}
          </ol>
        </div>

        <section className="learn-glossary" aria-labelledby="learn-glossary">
          <header>
            <h2 id="learn-glossary">The words on your desk.</h2>
          </header>
          <dl>
            {Object.entries(glossary).map(([key, entry]) => {
              const target = chapterByTerm[key as GlossaryKey];
              return (
                <div key={key}>
                  <dt>{entry.term}</dt>
                  <dd>
                    <span>{entry.definition}</span>
                    <a
                      href={"#learn/" + target}
                      onClick={(event) => {
                        event.preventDefault();
                        selectChapter(target);
                      }}
                    >
                      See it
                    </a>
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      </main>
    </ViewFrame>
  );
}
