/** Local, wallet-scoped draft only. The server's versioned strategy remains the authority. */
export function strategyDraftKey(
  ownerAddress: string,
  strategyId: string,
): string {
  return `maker:strategy-draft:v1:${ownerAddress.toLowerCase()}:${strategyId}`;
}

export function readStrategyDraft<T>(
  storage: Pick<Storage, "getItem">,
  ownerAddress: string,
  strategyId: string,
): T | null {
  try {
    const value = storage.getItem(strategyDraftKey(ownerAddress, strategyId));
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
}

export function writeStrategyDraft(
  storage: Pick<Storage, "setItem">,
  ownerAddress: string,
  strategyId: string,
  draft: unknown,
): void {
  storage.setItem(
    strategyDraftKey(ownerAddress, strategyId),
    JSON.stringify(draft),
  );
}
