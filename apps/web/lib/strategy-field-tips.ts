export const advancedFieldTips = {
  "per-pair-inventory":
    "Caps the absolute USD position in one market, long or short. Raising it allows more inventory before Maker pauses that market; lowering it reduces per-market exposure.",
  "inventory-target":
    "Sets the preferred signed USD inventory for each market. Raising it favours a longer position; lowering it favours a shorter position.",
  "gross-exposure":
    "Caps total absolute USD position across all selected markets. Raising it lets the portfolio carry more combined exposure; lowering it makes Maker stop adding risk sooner.",
  "unrealized-loss":
    "Sets the USD loss allowed on one market's open position. Raising it tolerates a deeper open loss; lowering it pauses quoting that market sooner.",
  "run-drawdown":
    "Sets the USD equity drop allowed from this run's highest equity. Raising it lets the run absorb a larger drawdown; lowering it stops the run sooner.",
  "book-index-divergence":
    "Sets the maximum gap between the venue book and index price in bps. Raising it accepts less aligned prices; lowering it skips more uncertain books.",
  "inventory-skew":
    "Shifts quotes in bps to encourage fills back toward the inventory target. Raising it corrects inventory more aggressively; lowering it keeps quotes more symmetric.",
  "max-leverage":
    "Caps leverage used for quote collateral. Raising it uses less collateral per quote but increases leverage risk; lowering it keeps more collateral behind each quote.",
  "poll-interval":
    "Controls how often Maker checks price and risk, in seconds. Shorter refresh follows price more closely but can cost more gas; longer refresh trades responsiveness for fewer checks.",
  "market-dwell":
    "Controls how long one market stays live in single-pair rotation, in seconds. Raising it holds a market longer; lowering it rotates sooner.",
  "requote-movement":
    "Sets the price move, in bps, that can trigger a requote. Raising it leaves quotes resting through larger moves; lowering it follows price more closely and can cost more gas.",
  "forced-refresh":
    "Sets the longest a quote may rest before Maker refreshes it, in seconds. Raising it reduces refreshes; lowering it refreshes more often and can cost more gas.",
  "stale-observation-cutoff":
    "Sets how old market observations may be, in seconds, before the watchdog cancels quotes. Raising it tolerates older data; lowering it pauses sooner when data is stale.",
} as const;

export type AdvancedFieldTipId = keyof typeof advancedFieldTips;
