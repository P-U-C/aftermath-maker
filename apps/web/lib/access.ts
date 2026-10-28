export function walletSessionMatches(
  ownerAddress: string | null,
  connectedAddress: string | null,
): boolean {
  if (!ownerAddress || !connectedAddress) return true;
  return ownerAddress.toLowerCase() === connectedAddress.toLowerCase();
}

/**
 * A refused wallet stays connected so the operator keeps a visible wallet
 * control; only a different connected address clears the refusal and retries.
 */
export function deniedWalletAction(
  deniedAddress: string | null,
  connectedAddress: string | null,
): "none" | "remember" | "try-new" {
  if (!connectedAddress) return "none";
  if (!deniedAddress) return "remember";
  return deniedAddress.toLowerCase() === connectedAddress.toLowerCase()
    ? "none"
    : "try-new";
}

export function shouldBeginWalletSignIn(inputs: {
  authChecked: boolean;
  authenticated: boolean;
  denied: boolean;
  busy: boolean;
  connectedAddress: string | null;
  attemptedAddress: string | null;
}): boolean {
  if (
    !inputs.authChecked ||
    inputs.authenticated ||
    inputs.denied ||
    inputs.busy ||
    !inputs.connectedAddress
  ) {
    return false;
  }
  return (
    inputs.attemptedAddress?.toLowerCase() !==
    inputs.connectedAddress.toLowerCase()
  );
}
