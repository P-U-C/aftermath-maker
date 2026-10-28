"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

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
};

type MarketMotionProps = MarketMotionUpdate & {
  sim?: boolean;
  compact?: boolean;
  className?: string;
  caption?: string;
};

const finite = (value: number | null): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const seededBook = (mid: number): NonNullable<MarketBook> => ({
  bids: Array.from({ length: 14 }, (_, index) => [
    mid * (1 - (index + 1) * 0.00035),
    120 + ((index * 73) % 280),
  ]),
  asks: Array.from({ length: 14 }, (_, index) => [
    mid * (1 + (index + 1) * 0.00035),
    120 + ((index * 61) % 280),
  ]),
  observedAt: "illustration",
});

export const MarketMotion = forwardRef<MarketMotionHandle, MarketMotionProps>(
  function MarketMotion(
    {
      mid,
      bid,
      ask,
      bestBid,
      bestAsk,
      inventoryUsd,
      book,
      sim = true,
      compact = false,
      className,
      caption,
    },
    ref,
  ) {
    const host = useRef<SVGSVGElement>(null);
    const current = useRef<MarketMotionUpdate>({
      mid,
      bid,
      ask,
      bestBid,
      bestAsk,
      inventoryUsd,
      book,
    });
    const [motionEvent, setMotionEvent] = useState<{
      type: "fill" | "hedge";
      side?: "bid" | "ask";
      startedAt: number;
    } | null>(null);
    const [frame, setFrame] = useState(0);
    const [reduced, setReduced] = useState(false);
    const reducedRef = useRef(false);

    useEffect(() => {
      current.current = {
        mid,
        bid,
        ask,
        bestBid,
        bestAsk,
        inventoryUsd,
        book,
      };
    }, [ask, bestAsk, bestBid, bid, book, inventoryUsd, mid]);

    useEffect(() => {
      const media = window.matchMedia("(prefers-reduced-motion: reduce)");
      const sync = () => {
        reducedRef.current = media.matches;
        setReduced(media.matches);
      };
      sync();
      media.addEventListener("change", sync);
      return () => media.removeEventListener("change", sync);
    }, []);

    useEffect(() => {
      if (reduced) return;
      let active = true;
      let visible = true;
      let animation = 0;
      let last = 0;
      const node = host.current;
      const observer = node
        ? new IntersectionObserver(
            ([entry]) => {
              visible = Boolean(entry?.isIntersecting) && !document.hidden;
              if (visible && !animation)
                animation = requestAnimationFrame(loop);
            },
            { threshold: 0.15 },
          )
        : null;
      const visibility = () => {
        visible = !document.hidden;
        if (visible && !animation) animation = requestAnimationFrame(loop);
      };
      const loop = (now: number) => {
        if (!active || !visible) {
          animation = 0;
          return;
        }
        if (now - last > 33) {
          last = now;
          setFrame((value) => value + 1);
        }
        animation = requestAnimationFrame(loop);
      };
      if (node) observer?.observe(node);
      else animation = requestAnimationFrame(loop);
      document.addEventListener("visibilitychange", visibility);
      return () => {
        active = false;
        observer?.disconnect();
        document.removeEventListener("visibilitychange", visibility);
        cancelAnimationFrame(animation);
      };
    }, [reduced]);

    useImperativeHandle(
      ref,
      () => ({
        update(value) {
          current.current = value;
          setFrame((item) => item + 1);
        },
        fill(side) {
          if (!reducedRef.current) {
            setMotionEvent({ type: "fill", side, startedAt: Date.now() });
          }
          setFrame((item) => item + 1);
        },
        hedge() {
          if (!reducedRef.current) {
            setMotionEvent({ type: "hedge", startedAt: Date.now() });
          }
          setFrame((item) => item + 1);
        },
      }),
      [],
    );

    const scene = useMemo(() => {
      const value = current.current;
      const center = finite(value.mid)
        ? value.mid
        : finite(value.bestBid) && finite(value.bestAsk)
          ? (value.bestBid + value.bestAsk) / 2
          : 1;
      const realBook = value.book;
      const activeBook = realBook ?? (sim ? seededBook(center) : null);
      const asks =
        activeBook?.asks ?? (finite(value.bestAsk) ? [[value.bestAsk, 1]] : []);
      const bids =
        activeBook?.bids ?? (finite(value.bestBid) ? [[value.bestBid, 1]] : []);
      const levels = [...asks, ...bids].filter(
        ([price, size]) => price > 0 && size > 0,
      );
      const scale = Math.max(
        1,
        [...levels.map(([, size]) => size)].sort((a, b) => a - b)[
          Math.max(0, Math.floor(levels.length * 0.9) - 1)
        ] ?? 1,
      );
      return { center, asks, bids, scale, value };
    }, [frame, sim]);

    const width = compact ? 440 : 940;
    const height = compact ? 236 : 330;
    const axis = Math.round(height / 2);
    const x = (price: number) =>
      width / 2 +
      ((price - scene.center) / scene.center) * 10_000 * (compact ? 2.7 : 4.2);
    const bar = (size: number) =>
      Math.max(5, Math.min(axis - 62, (size / scene.scale) * (axis - 62)));
    const open = reduced ? 1 : Math.min(1, frame / 36);
    const activeEvent =
      motionEvent && Date.now() - motionEvent.startedAt < 900
        ? motionEvent
        : null;
    const eventProgress = activeEvent
      ? Math.min(1, (Date.now() - activeEvent.startedAt) / 900)
      : 0;
    const quote = {
      bid: finite(scene.value.bid) ? scene.value.bid : scene.value.bestBid,
      ask: finite(scene.value.ask) ? scene.value.ask : scene.value.bestAsk,
    };
    const priceText = (value: number | null) =>
      finite(value) ? value.toFixed(6) : "—";

    return (
      <figure
        className={["market-motion", className].filter(Boolean).join(" ")}
      >
        <svg
          ref={host}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Mirrored order book. Asks rise above the market price and bids hang below it."
        >
          <line
            className="market-motion-axis"
            x1={(width * (1 - open)) / 2}
            x2={(width * (1 + open)) / 2}
            y1={axis}
            y2={axis}
          />
          {scene.asks.map(([price, size], index) => {
            const heightValue = bar(size) * open;
            return (
              <rect
                key={`ask-${index}-${price}`}
                className="market-motion-book market-motion-ask"
                x={x(price) - 2}
                y={axis - 31 - heightValue}
                width="4"
                height={heightValue}
                rx="2"
              />
            );
          })}
          {scene.bids.map(([price, size], index) => {
            const heightValue = bar(size) * open;
            return (
              <rect
                key={`bid-${index}-${price}`}
                className="market-motion-book market-motion-bid"
                x={x(price) - 2}
                y={axis + 31}
                width="4"
                height={heightValue}
                rx="2"
              />
            );
          })}
          <line
            className="market-motion-mid"
            x1={width / 2}
            x2={width / 2}
            y1={axis - 27}
            y2={axis + 27}
          />
          {quote.ask && (
            <rect
              className="market-motion-quote market-motion-ask"
              x={x(quote.ask) - 26}
              y={axis - 26}
              width={52 * open}
              height="14"
              rx="7"
            />
          )}
          {quote.bid && (
            <rect
              className="market-motion-quote market-motion-bid"
              x={x(quote.bid) - 26}
              y={axis + 12}
              width={52 * open}
              height="14"
              rx="7"
            />
          )}
          <g className="market-motion-readout">
            <text x="18" y="28">
              Your ask
            </text>
            <text x="170" y="28" className="market-motion-value">
              {priceText(quote.ask)}
            </text>
            <text x="18" y="49">
              Market
            </text>
            <text x="170" y="49" className="market-motion-value">
              {priceText(scene.value.mid)}
            </text>
            <text x="18" y="70">
              Your bid
            </text>
            <text x="170" y="70" className="market-motion-value">
              {priceText(quote.bid)}
            </text>
            <text x="18" y="91">
              Spread
            </text>
            <text x="170" y="91" className="market-motion-value">
              {finite(quote.ask) && finite(quote.bid)
                ? `${Math.round(((quote.ask - quote.bid) / scene.center) * 10_000)} bps`
                : "—"}
            </text>
          </g>
          <g className="market-motion-inventory">
            <text x={width - 210} y={height - 38}>
              Inventory · Taker account
            </text>
            <rect
              x={width - 210}
              y={height - 27}
              width="180"
              height="6"
              rx="3"
            />
            <rect
              className={
                scene.value.inventoryUsd >= 0
                  ? "market-motion-bid"
                  : "market-motion-ask"
              }
              x={width - 120}
              y={height - 27}
              width={Math.min(90, Math.abs(scene.value.inventoryUsd) * 20)}
              height="6"
              rx="3"
            />
            <text
              x={width - 30}
              y={height - 38}
              textAnchor="end"
              className="market-motion-value"
            >
              {scene.value.inventoryUsd === 0
                ? "Flat"
                : `$${Math.abs(scene.value.inventoryUsd).toFixed(2)}`}
            </text>
          </g>
          {activeEvent?.type === "fill" &&
            activeEvent.side &&
            finite(activeEvent.side === "bid" ? quote.bid : quote.ask) && (
              <circle
                className={
                  activeEvent.side === "bid"
                    ? "market-motion-bid"
                    : "market-motion-ask"
                }
                cx={x(activeEvent.side === "bid" ? quote.bid! : quote.ask!)}
                cy={
                  axis +
                  (activeEvent.side === "bid" ? 19 : -19) +
                  (height / 2 - axis) * eventProgress
                }
                r={Math.max(2, 6 * (1 - eventProgress * 0.45))}
              />
            )}
          {activeEvent?.type === "hedge" && (
            <circle
              className="market-motion-hedge"
              cx={width - 210 - eventProgress * (width * 0.24)}
              cy={height - 24 - eventProgress * (height * 0.2)}
              r="7"
            />
          )}
        </svg>
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
    );
  },
);
