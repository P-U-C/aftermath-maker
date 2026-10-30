/** A lagging list read must not replace an already acknowledged newer version. */
export function mergeStrategyReads<T extends { id: string; version: number }>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const known = new Map(current.map((strategy) => [strategy.id, strategy]));
  const incomingIds = new Set(incoming.map((strategy) => strategy.id));
  return [
    ...incoming.map((strategy) => {
      const previous = known.get(strategy.id);
      return previous && previous.version > strategy.version
        ? previous
        : strategy;
    }),
    ...current.filter((strategy) => !incomingIds.has(strategy.id)),
  ];
}
