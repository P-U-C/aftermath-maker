export type BundleAssignment = {
  id: string;
  name: string;
  makerAccountId: string | null;
  takerAccountId: string | null;
  marketIds: string[];
  archivedAt: string | null;
};

type BundleAccount = { accountId: string };
type BundleMarket = { id: string };

export function activeBundles<T extends BundleAssignment>(bundles: T[]): T[] {
  return bundles.filter((bundle) => !bundle.archivedAt);
}

export function availableBundleAccounts<T extends BundleAccount>(
  accounts: T[],
  bundles: BundleAssignment[],
  exceptAccountId: string | null = null,
): T[] {
  const assigned = new Set(
    activeBundles(bundles).flatMap((bundle) => [
      bundle.makerAccountId,
      bundle.takerAccountId,
    ]),
  );
  if (exceptAccountId) assigned.add(exceptAccountId);
  return accounts.filter((account) => !assigned.has(account.accountId));
}

export function availableBundleMarkets<T extends BundleMarket>(
  markets: T[],
  bundles: BundleAssignment[],
): T[] {
  const assigned = new Set(
    activeBundles(bundles).flatMap((bundle) => bundle.marketIds),
  );
  return markets.filter((market) => !assigned.has(market.id));
}

export function selectedActiveBundleId(
  bundles: BundleAssignment[],
  currentId: string | null,
): string | null {
  const active = activeBundles(bundles);
  if (currentId && active.some((bundle) => bundle.id === currentId)) {
    return currentId;
  }
  return (
    active.find((bundle) => bundle.name === "Core")?.id ?? active[0]?.id ?? null
  );
}
