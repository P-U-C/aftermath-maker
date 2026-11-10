export type MakerStrategyPresetId =
  | "inventory-recycling"
  | "fill-driven-aftermath-hedge"
  | "selective-rotation"
  | "hedged-hold"
  | "cross-venue-funding-arbitrage"
  | "cross-venue-hedged-market-making"
  | "adaptive-quoting";

export type MakerStrategyPreset = {
  id: MakerStrategyPresetId;
  name: string;
  shortName: string;
  summary: string;
  mode: "Paper" | "Observe";
  state: "ready" | "research";
  nextStep: string;
};

/**
 * The strategy bench is deliberately separate from saved strategies. A card is
 * an honest description of a strategy family; only `ready` cards have a
 * runtime behind them and can create a draft. This prevents a named research
 * idea from silently running the passive-maker engine.
 */
export const makerStrategyCatalog: readonly MakerStrategyPreset[] = [
  {
    id: "inventory-recycling",
    name: "Inventory recycling",
    shortName: "Passive maker",
    summary:
      "Posts two-sided Aftermath quotes, skews as inventory builds, and measures spread capture from independently attributed fills.",
    mode: "Paper",
    state: "ready",
    nextStep: "Create an unattached Paper draft",
  },
  {
    id: "fill-driven-aftermath-hedge",
    name: "Fill-driven Aftermath hedge",
    shortName: "Paired-account hedge",
    summary:
      "After a genuine Maker fill, cancels resting quotes and uses a distinct Aftermath hedge account to reduce the confirmed delta.",
    mode: "Paper",
    state: "ready",
    nextStep: "Create a Paper draft, then assign two distinct accounts",
  },
  {
    id: "selective-rotation",
    name: "Selective rotation",
    shortName: "Allocation engine",
    summary:
      "Moves a bounded budget only when a measured maker or hold opportunity improves enough to cover switching costs.",
    mode: "Observe",
    state: "research",
    nextStep:
      "Needs the allocation decision engine and switching-cost evidence",
  },
  {
    id: "hedged-hold",
    name: "Hedged hold",
    shortName: "Measured hold",
    summary:
      "Hedges an externally filled position on a second Aftermath account, then holds it for a measured interval with low turnover.",
    mode: "Observe",
    state: "research",
    nextStep: "Needs a dedicated hold lifecycle and exit evidence",
  },
  {
    id: "cross-venue-funding-arbitrage",
    name: "Cross-venue funding arbitrage",
    shortName: "AF short / HL long",
    summary:
      "Would post an Aftermath short and hedge only its confirmed base fill with a Hyperliquid long when net funding exceeds all costs.",
    mode: "Observe",
    state: "research",
    nextStep:
      "Read-only scanner and deterministic Paper replay only; no Live execution",
  },
  {
    id: "cross-venue-hedged-market-making",
    name: "Cross-venue hedged market making",
    shortName: "External fair value",
    summary:
      "Would quote passively on Aftermath around an independent fair price and hedge confirmed fills externally inside a bounded cap.",
    mode: "Observe",
    state: "research",
    nextStep: "Needs external fair-value and hedge-execution contracts",
  },
  {
    id: "adaptive-quoting",
    name: "Adaptive quoting",
    shortName: "Policy upgrade",
    summary:
      "Would adjust spread, size, skew, or pauses using volatility, reference divergence, time of day, and measured post-fill markouts.",
    mode: "Observe",
    state: "research",
    nextStep: "Needs a fixed-policy baseline and validated adaptive controls",
  },
] as const;

export function makerStrategyPreset(
  id: MakerStrategyPresetId,
): MakerStrategyPreset {
  const preset = makerStrategyCatalog.find((candidate) => candidate.id === id);
  if (!preset) throw new Error(`Unknown Maker strategy preset: ${id}`);
  return preset;
}
