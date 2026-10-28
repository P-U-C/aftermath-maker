export function walletSessionMatches(
  ownerAddress: string | null,
  connectedAddress: string | null,
): boolean {
  if (!ownerAddress || !connectedAddress) return true;
  return ownerAddress.toLowerCase() === connectedAddress.toLowerCase();
}

export function deniedWalletAction(
  deniedAddress: string | null,
  connectedAddress: string | null,
): "none" | "disconnect" | "try-new" {
  if (!connectedAddress) return "none";
  if (!deniedAddress) return "disconnect";
  return deniedAddress.toLowerCase() === connectedAddress.toLowerCase()
    ? "disconnect"
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
