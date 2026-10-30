/** Only expected, explicitly recognized bundle-create failures may be shown to users.
 * Unknown store/database failures remain sanitized 500s in the HTTP handler. */
export function bundleCreateHttpError(
  error: unknown,
): { status: 400 | 409; message: string } | null {
  if (!(error instanceof Error)) return null;
  const { message } = error;
  if (
    message === "Bundle name must be between 1 and 80 characters" ||
    message === "The selected account is not authorized" ||
    message ===
      "Select an authorized Maker account before creating this bundle" ||
    message ===
      "Choose a strategy with one or more markets before creating this bundle"
  )
    return { status: 400, message };
  if (
    message === "Strategy was not found for this wallet" ||
    message === "A bundle already uses that name" ||
    message === "Each account can hold one bundle role per wallet" ||
    message === "Maker and Taker accounts must be different" ||
    message === "Additional bundles can only use Paper mode" ||
    message === "A wallet can have at most four active bundles" ||
    message === "Configure Core wallet limits before creating this bundle" ||
    message === "Confirm the wallet limits before creating a second bundle"
  )
    return { status: 409, message };
  if (
    /^(Run drawdown|Inventory|Gross exposure|Unrealized loss) limit exceeds this wallet's confirmed envelope$/.test(
      message,
    )
  )
    return { status: 409, message };
  return null;
}
