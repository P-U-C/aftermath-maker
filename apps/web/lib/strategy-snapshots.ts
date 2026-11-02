/** The server list is authoritative, except for creations not yet visible to it. */
export function mergeStrategyReads<T extends { id: string; version: number }>(
  current: readonly T[],
  incoming: readonly T[],
  pendingCreateIds: ReadonlySet<string> = new Set(),
): T[] {
  const known = new Map(current.map((strategy) => [strategy.id, strategy]));
  const serverIds = new Set(incoming.map((strategy) => strategy.id));
  return [
    ...incoming.map((strategy) => {
      const previous = known.get(strategy.id);
      return previous && previous.version > strategy.version
        ? previous
        : strategy;
    }),
    ...current.filter(
      (strategy) =>
        pendingCreateIds.has(strategy.id) && !serverIds.has(strategy.id),
    ),
  ];
}
