import type { MakerMarketOverrides } from "@puc/core";

/** Change exactly one market; an empty override object means inheritance. */
export function withMarketPolicyOverride<
  T extends {
    marketId: string;
    overrides?: MakerMarketOverrides | undefined;
  },
>(
  markets: readonly T[],
  marketId: string,
  overrides: MakerMarketOverrides,
): T[] {
  if (!markets.some((market) => market.marketId === marketId)) {
    throw new Error("Market is not part of this strategy");
  }
  return markets.map((market) => {
    if (market.marketId !== marketId) return market;
    const { overrides: _old, ...base } = market;
    return Object.keys(overrides).length
      ? ({ ...base, overrides } as T)
      : (base as T);
  });
}
