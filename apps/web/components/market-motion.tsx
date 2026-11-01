"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import {
  mountMarketMotion,
  type MarketMotionInstance,
} from "../lib/market-motion-engine";

export type MarketBook = {
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  observedAt: string;
} | null;

export type MarketMotionUpdate = {
  mid: number | null;
  bid: number | null;
  ask: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  inventoryUsd: number;
  book: MarketBook;
};

export type MarketMotionHandle = {
  update: (value: MarketMotionUpdate) => void;
  fill: (side: "bid" | "ask") => void;
  hedge: () => void;
  play: (name: string) => void;
  pose: (name: string) => void;
};

type MarketMotionProps = MarketMotionUpdate & {
  /** `false` is the desk: it draws only what update(), fill() and hedge() report. */
  sim?: boolean;
  compact?: boolean;
  className?: string;
  caption?: string;
  /** Illustration only: show the running narration and the fill and hedge counters. */
  narrate?: boolean;
  sizeUsd?: number;
  hedgeTriggerUsd?: number;
  spreadBps?: number;
  seed?: number;
  /** A fixed desktop lane height. The phone layout keeps the engine's compact default. */
  height?: number;
  /** Learn turns off the engine's ambient simulated takers and directs named scenes. */
  director?: boolean;
  onEvent?: (event: string) => void;
};

// Under this width the engine draws its phone layout.
const PHONE_WIDTH = 620;

const sampleOf = (props: MarketMotionUpdate): MarketMotionUpdate => ({
  mid: props.mid,
  bid: props.bid,
  ask: props.ask,
  bestBid: props.bestBid,
  bestAsk: props.bestAsk,
  inventoryUsd: props.inventoryUsd,
  book: props.book,
});

/**
 * The mirrored order book from mockups/motion.js, mounted as-is. The engine owns its SVG;
 * React only picks the layout, feeds samples and tears it down.
 */
export const MarketMotion = forwardRef<MarketMotionHandle, MarketMotionProps>(
  function MarketMotion(props, ref) {
    const {
      sim = true,
      compact = false,
      className,
      caption,
      narrate = false,
      sizeUsd,
      hedgeTriggerUsd,
      spreadBps,
      seed,
      height,
      director,
      onEvent,
    } = props;
    const stage = useRef<HTMLDivElement>(null);
    const narration = useRef<HTMLParagraphElement>(null);
    const counters = useRef<HTMLDivElement>(null);
    const engine = useRef<MarketMotionInstance | null>(null);
    const sample = useRef<MarketMotionUpdate>(sampleOf(props));
    const [layout, setLayout] = useState<"wide" | "phone" | null>(null);
    const [reduced, setReduced] = useState(false);

    // Keep the latest sample for a remount. Declared first, so it runs before the mount.
    useEffect(() => {
      sample.current = sampleOf(props);
    });

    useEffect(() => {
      const node = stage.current;
      if (!node) return;
      const measure = () =>
        setLayout(
          node.getBoundingClientRect().width < PHONE_WIDTH ? "phone" : "wide",
        );
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      return () => observer.disconnect();
    }, []);

    useEffect(() => {
      const media = window.matchMedia("(prefers-reduced-motion: reduce)");
      const sync = () => setReduced(media.matches);
      sync();
      media.addEventListener("change", sync);
      return () => media.removeEventListener("change", sync);
    }, []);

    useEffect(() => {
      const node = stage.current;
      if (!node || !layout) return;
      const first = sample.current;
      const instance = mountMarketMotion(node, {
        sim,
        compact,
        static: reduced,
        height: layout === "phone" && !compact ? undefined : height,
        mid: first.mid && first.mid > 0 ? first.mid : undefined,
        sizeUsd,
        hedgeTriggerUsd,
        spreadBps,
        seed,
        director,
        onEvent,
        caption: narrate ? narration.current : null,
        counters: narrate ? counters.current : null,
      });
      if (!sim) instance.update(first);
      engine.current = instance;
      return () => {
        instance.stop();
        if (engine.current === instance) engine.current = null;
      };
    }, [
      layout,
      reduced,
      sim,
      compact,
      narrate,
      height,
      sizeUsd,
      hedgeTriggerUsd,
      spreadBps,
      seed,
      director,
      onEvent,
    ]);

    // The book's tint depends on the surface, so follow theme changes.
    useEffect(() => {
      const retheme = () => engine.current?.retheme();
      const observer = new MutationObserver(retheme);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "class"],
      });
      const scheme = window.matchMedia("(prefers-color-scheme: dark)");
      scheme.addEventListener("change", retheme);
      return () => {
        observer.disconnect();
        scheme.removeEventListener("change", retheme);
      };
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        update(value) {
          sample.current = value;
          engine.current?.update(value);
        },
        fill(side) {
          engine.current?.fill(side);
        },
        hedge() {
          engine.current?.hedge();
        },
        play(name) {
          engine.current?.play(name);
        },
        pose(name) {
          engine.current?.pose(name);
        },
      }),
      [],
    );

    return (
      <figure
        className={[
          "market-motion",
          compact ? "is-compact" : null,
          sim ? "is-illustration" : "is-live",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div ref={stage} className="market-motion-stage" />
        {narrate && <p ref={narration} className="market-motion-narration" />}
        {(narrate || caption) && (
          <figcaption className="market-motion-foot">
            {narrate && (
              <div ref={counters} className="market-motion-counters" />
            )}
            {caption && <span>{caption}</span>}
          </figcaption>
        )}
      </figure>
    );
  },
);
