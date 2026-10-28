export type MarketMotionBook = {
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  observedAt?: string;
} | null;

export type MarketMotionSample = {
  mid?: number | null;
  bid?: number | null;
  ask?: number | null;
  bestBid?: number | null;
  bestAsk?: number | null;
  inventoryUsd?: number | null;
  /** Depth for the desk. `null` draws only the venue's best bid and ask. */
  book?: MarketMotionBook;
};

export type MarketMotionEvent = "fill" | "queue" | "skew" | "hedge";

export type MarketMotionOptions = {
  /** `false` is the desk: driven only by update(), fill() and hedge(). Defaults to true. */
  sim?: boolean | undefined;
  compact?: boolean | undefined;
  /** A still frame with no loop. Also used under prefers-reduced-motion. */
  static?: boolean | undefined;
  mid?: number | undefined;
  sizeUsd?: number | undefined;
  hedgeTriggerUsd?: number | undefined;
  spreadBps?: number | undefined;
  seed?: number | undefined;
  initialInventory?: number | undefined;
  viewWidth?: number | undefined;
  height?: number | undefined;
  fontScale?: number | undefined;
  pxPerBps?: number | undefined;
  tickBps?: number | undefined;
  skewBpsPerFill?: number | undefined;
  /** The illustration writes its narration here (trusted markup it builds itself). */
  caption?: HTMLElement | null | undefined;
  /** The illustration writes its fill, hedge and spread counters here. */
  counters?: HTMLElement | null | undefined;
  intro?: string | undefined;
  onEvent?: (event: MarketMotionEvent) => void | undefined;
};

export type MarketMotionInstance = {
  stop(): void;
  retheme(): void;
  state(): {
    mid: number;
    bid: number;
    ask: number;
    inventoryUsd: number;
    fills: number;
    hedges: number;
    earned: number;
  };
  update(sample: MarketMotionSample): void;
  fill(side: "bid" | "ask"): void;
  hedge(): void;
};

export function mountMarketMotion(
  host: HTMLElement,
  options?: MarketMotionOptions,
): MarketMotionInstance;
