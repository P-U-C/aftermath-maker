/** The control snapshot is the authority; the UI formats its safe structured fields. */
export type PaperBlocker = {
  code: string;
  message: string;
  accountId?: string;
  availableUsd?: number;
  requiredUsd?: number;
  maxOrderUsd?: number;
  concurrentMarkets?: number;
  quoteSizeUsd?: number;
  leverage?: number;
  observedAt?: string;
  agentAddress?: string;
  requiredGasSui?: number;
};

export function relativeAccountRead(
  observedAt: string | undefined,
  now = Date.now(),
): string | null {
  const timestamp = Date.parse(observedAt ?? "");
  if (!Number.isFinite(timestamp)) return null;
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  return `Checked ${minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 1_440 ? `${Math.floor(minutes / 60)} hr ago` : `${Math.floor(minutes / 1_440)} days ago`}`;
}

export function accountReadStallText(
  observedAt: string,
  lastError: string | null,
): string {
  const timestamp = Date.parse(observedAt);
  const time = Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(timestamp)
    : "an unknown time";
  return `Account reads stalled at ${time}. Last error: ${lastError ?? "venue read timed out"}`;
}

const money = (amount: number) => `$${amount.toFixed(2)}`;

export function formatPaperBlocker(blocker: PaperBlocker, now = Date.now()) {
  const account = blocker.accountId ?? "this account";
  let sentence = blocker.message;
  let rotation = false;
  if (
    blocker.code === "collateral" &&
    blocker.availableUsd !== undefined &&
    blocker.requiredUsd !== undefined &&
    blocker.concurrentMarkets &&
    blocker.quoteSizeUsd !== undefined &&
    blocker.leverage
  ) {
    const count = blocker.concurrentMarkets;
    const missing = Math.max(0, blocker.requiredUsd - blocker.availableUsd);
    rotation = count > 1;
    sentence = `Paper is waiting on account ${account}. It has ${money(blocker.availableUsd)} free collateral, and quoting ${count} ${count === 1 ? "market" : "markets"} at ${money(blocker.quoteSizeUsd)} a side needs ${money(blocker.requiredUsd)}. Deposit at least ${money(missing)}${rotation ? `, or quote one market at a time (needs ${money((blocker.quoteSizeUsd * 2) / Math.max(1, blocker.leverage))})` : ""}.`;
  } else if (
    blocker.code === "hedge-collateral" &&
    blocker.availableUsd !== undefined &&
    blocker.requiredUsd !== undefined &&
    blocker.maxOrderUsd !== undefined &&
    blocker.leverage !== undefined
  ) {
    sentence = `Hedge account ${account} needs ${money(blocker.requiredUsd)} free collateral to place one hedge of up to ${money(blocker.maxOrderUsd)} at ${blocker.leverage}x. It has ${money(blocker.availableUsd)}.`;
  } else if (blocker.code === "gas" && blocker.requiredGasSui !== undefined) {
    sentence = `Paper is waiting on gas. The trading key for account ${account} needs ${blocker.requiredGasSui.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")} SUI to simulate.`;
  }
  return {
    sentence,
    checked: relativeAccountRead(blocker.observedAt, now),
    rotation,
    destination:
      blocker.code === "gas"
        ? null
        : blocker.code === "collateral" || blocker.code === "hedge-collateral"
          ? ("venues" as const)
          : null,
    copyAddress: blocker.code === "gas" ? blocker.agentAddress : undefined,
  };
}
