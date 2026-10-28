export const glossary = {
  spread: {
    term: "Spread",
    definition:
      "The gap between Maker's bid and ask; it is the price paid for immediacy.",
    animation: "#learn/spread",
  },
  bps: {
    term: "Basis points",
    definition: "A basis point is one hundredth of one percent.",
    animation: "#learn/spread",
  },
  inventory: {
    term: "Inventory",
    definition:
      "The position Maker holds after fills, measured here in dollars.",
    animation: "#learn/fills",
  },
  skew: {
    term: "Skew",
    definition:
      "A shift in both quotes that encourages fills reducing inventory.",
    animation: "#learn/skew",
  },
  taker: {
    term: "Taker",
    definition:
      "The paired account that uses a market order to reduce Maker inventory.",
    animation: "#learn/hedge",
  },
  unrealizedPnl: {
    term: "Unrealized P&L",
    definition:
      "The profit or loss a position would realize if it were closed at the current market price.",
  },
  runDrawdown: {
    term: "Run drawdown",
    definition:
      "How far combined equity has fallen from its highest point during this run.",
  },
  qScore: {
    term: "Q-score",
    definition:
      "The venue's measure of qualifying liquidity used to allocate rewards.",
  },
  rewardPotential: {
    term: "Reward potential",
    definition:
      "A relative estimate of how strongly a market can qualify for maker rewards.",
  },
  maker: {
    term: "Maker",
    definition:
      "The account that leaves buy and sell orders resting in the order book.",
    animation: "#learn/spread",
  },
  observe: {
    term: "Observe",
    definition:
      "Maker reads the market and calculates quotes without placing orders.",
  },
  paper: {
    term: "Paper",
    definition: "Maker simulates its decisions; it does not place real orders.",
  },
} as const;

export type GlossaryKey = keyof typeof glossary;
