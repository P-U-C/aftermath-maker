export function walletSessionMatches(
  ownerAddress: string | null,
  connectedAddress: string | null,
): boolean {
  if (!ownerAddress || !connectedAddress) return true;
  return ownerAddress.toLowerCase() === connectedAddress.toLowerCase();
}
