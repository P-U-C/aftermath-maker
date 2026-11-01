import type { MakerMarketOverrides } from "@puc/core";

/** An exception equal to the strategy is inheritance, not a custom policy. */
export function effectiveMarketOverrides(
  overrides: MakerMarketOverrides | undefined,
  defaults: Partial<Record<keyof MakerMarketOverrides, number>> | undefined,
): MakerMarketOverrides {
  return Object.fromEntries(
    Object.entries(overrides ?? {}).filter(
      ([field, value]) =>
        value !== defaults?.[field as keyof MakerMarketOverrides],
    ),
  ) as MakerMarketOverrides;
}

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
