export type AuditEventInput = {
  id: number;
  occurredAt: string;
  category: string;
  action: string;
  outcome: string;
  detail: Record<string, unknown>;
};

export type DeskEvent = {
  id: number;
  occurredAt: string;
  severity: "info" | "warning" | "error";
  sentence: string;
};

type AuditCopy = {
  severity: DeskEvent["severity"];
  sentence: (detail: Record<string, unknown>) => string;
};

const account = (detail: Record<string, unknown>) =>
  typeof detail.accountId === "string"
    ? ` for account ${detail.accountId}`
    : "";

const bundle = (detail: Record<string, unknown>) =>
  typeof detail.name === "string" && detail.name.trim()
    ? ` ${detail.name.trim()}`
    : "";

const market = (detail: Record<string, unknown>) =>
  typeof detail.marketId === "string" ? ` for market ${detail.marketId}` : "";

const copies: Record<string, AuditCopy> = {
  "access:membership-revoked-stop:completed": {
    severity: "warning",
    sentence: () => "Access was removed and Maker stopped.",
  },
  "bundles:wallet-limits.update:success": {
    severity: "info",
    sentence: () => "Wallet limits saved.",
  },
  "bundles:create:success": {
    severity: "info",
    sentence: (detail) => `Bundle${bundle(detail)} created.`,
  },
  "bundles:configure:success": {
    severity: "info",
    sentence: (detail) => `Bundle${bundle(detail)} strategy saved.`,
  },
  "bundles:allocation.update:success": {
    severity: "info",
    sentence: (detail) => `Bundle${bundle(detail)} allocation saved.`,
  },
  "strategies:create:success": {
    severity: "info",
    sentence: (detail) => `Strategy${bundle(detail)} created.`,
  },
  "strategies:update:success": {
    severity: "info",
    sentence: (detail) => `Strategy${bundle(detail)} saved.`,
  },
  "strategies:duplicate:success": {
    severity: "info",
    sentence: (detail) => `Strategy${bundle(detail)} duplicated.`,
  },
  "strategies:archive:success": {
    severity: "info",
    sentence: (detail) => `Strategy${bundle(detail)} archived.`,
  },
  "accounts:metadata.update:success": {
    severity: "info",
    sentence: () => "Account name and tags saved.",
  },
  "onboarding:account.create-transaction:prepared": {
    severity: "info",
    sentence: () => "Account creation is ready in your wallet.",
  },
  "onboarding:agent.provision:success": {
    severity: "info",
    sentence: (detail) => `Trading key created${account(detail)}.`,
  },
  "onboarding:agent.grant:confirmed": {
    severity: "info",
    sentence: (detail) => `Trading key approved${account(detail)}.`,
  },
  "onboarding:agent.revoke:confirmed": {
    severity: "info",
    sentence: (detail) => `Trading key revoked${account(detail)}.`,
  },
  "collateral:deposit.transaction:prepared": {
    severity: "info",
    sentence: (detail) => `Deposit${account(detail)} is ready in your wallet.`,
  },
  "collateral:withdraw.transaction:prepared": {
    severity: "info",
    sentence: (detail) =>
      `Withdrawal${account(detail)} is ready in your wallet.`,
  },
  "configuration:maker.update:success": {
    severity: "info",
    sentence: () => "Core strategy saved.",
  },
  "inspection:builder-fee:success": {
    severity: "info",
    sentence: () => "Venue fee inspection completed.",
  },
  "operator:runtime.stop-tenant:completed": {
    severity: "info",
    sentence: () => "Bundle stopped.",
  },
  "operator:runtime.stop-tenant:not-found": {
    severity: "info",
    sentence: () => "Bundle was already stopped.",
  },
  "operator:runtime.stop-all:completed": {
    severity: "info",
    sentence: () => "All bundles stopped.",
  },
  "operator:runtime.stop-all:partial": {
    severity: "warning",
    sentence: () => "Some bundles are still stopping.",
  },
  "system:runtime.initialize:success": {
    severity: "info",
    sentence: () => "Maker runtime is ready.",
  },
  "system:gateway.replace:success": {
    severity: "info",
    sentence: () => "Maker reconnected to its venue.",
  },
  "runtime:start:success": {
    severity: "info",
    sentence: () => "Maker started.",
  },
  "runtime:watchdog-stop:success": {
    severity: "warning",
    sentence: () => "Watchdog stopped Maker.",
  },
  "runtime:stop:success": {
    severity: "info",
    sentence: () => "Maker stopped.",
  },
  "runtime:cancel-maker-orders:confirmed": {
    severity: "info",
    sentence: () => "Open Maker orders cancelled.",
  },
  "runtime:cancel-maker-orders:clear": {
    severity: "info",
    sentence: () => "No Maker orders remained open.",
  },
  "runtime:cancel-maker-orders-attempt:error": {
    severity: "error",
    sentence: () => "Maker order cancellation failed.",
  },
  "runtime:post-only-retry:retry": {
    severity: "info",
    sentence: (detail) =>
      `Maker is retrying a post-only quote${market(detail)}.`,
  },
  "runtime:cycle:cancelled": {
    severity: "info",
    sentence: () => "Maker cycle was cancelled.",
  },
  "runtime:cycle:error": {
    severity: "error",
    sentence: () => "Maker cycle failed.",
  },
  "runtime:strategy-trial-start:success": {
    severity: "info",
    sentence: () => "Test run started.",
  },
  "runtime:strategy-trial-complete:success": {
    severity: "info",
    sentence: () => "Test run completed.",
  },
  "runtime:strategy-trial:error": {
    severity: "error",
    sentence: () => "Test run failed.",
  },
  "risk:stale-quote-watchdog:tripped": {
    severity: "warning",
    sentence: (detail) =>
      `Stale quote protection paused Maker${market(detail)}.`,
  },
  "risk:flatten-cycle-wait:timeout": {
    severity: "warning",
    sentence: () => "Maker timed out waiting for positions to settle.",
  },
  "risk:reduce-only-flatten:partial": {
    severity: "warning",
    sentence: () => "Some positions remain after flattening.",
  },
  "risk:reduce-only-flatten:confirmed": {
    severity: "info",
    sentence: () => "Positions flattened.",
  },
  "risk:reduce-only-flatten:clear": {
    severity: "info",
    sentence: () => "No positions needed flattening.",
  },
  "risk:automatic-paired-rebalance:retry": {
    severity: "info",
    sentence: () => "Maker is retrying the paired-account rebalance.",
  },
  "risk:automatic-paired-rebalance:confirmed": {
    severity: "info",
    sentence: () => "Paired-account rebalance completed.",
  },
  "risk:wallet-limit:rejected": {
    severity: "warning",
    sentence: (detail) => `Wallet limit paused a quote${market(detail)}.`,
  },
  "hedge:fill-attribution-reconciliation:waiting": {
    severity: "info",
    sentence: (detail) => `Waiting to match fills${market(detail)}.`,
  },
  "hedge:fill-attribution-reconciliation:confirmed": {
    severity: "info",
    sentence: (detail) => `Fills matched${market(detail)}.`,
  },
  "hedge:position-attribution-reconciliation:waiting": {
    severity: "info",
    sentence: (detail) => `Waiting to match positions${market(detail)}.`,
  },
  "hedge:position-attribution-reconciliation:confirmed": {
    severity: "info",
    sentence: (detail) => `Positions matched${market(detail)}.`,
  },
  "hedge:cancel-maker-quotes:confirmed": {
    severity: "info",
    sentence: (detail) => `Maker quotes cancelled${market(detail)}.`,
  },
  "hedge:cancel-maker-quotes:clear": {
    severity: "info",
    sentence: (detail) => `No Maker quotes remained${market(detail)}.`,
  },
  "hedge:post-cancel-reconciliation:waiting": {
    severity: "info",
    sentence: () => "Waiting for cancelled orders to settle.",
  },
  "hedge:post-cancel-reconciliation:confirmed": {
    severity: "info",
    sentence: () => "Cancelled orders settled.",
  },
  "hedge:post-hedge-reconciliation:waiting": {
    severity: "info",
    sentence: () => "Waiting for hedge positions to settle.",
  },
  "hedge:post-hedge-reconciliation:confirmed": {
    severity: "info",
    sentence: () => "Hedge positions settled.",
  },
  "hedge:fill-driven-market-order:confirmed": {
    severity: "info",
    sentence: (detail) => `Hedge order confirmed${market(detail)}.`,
  },
  "hedge:fill-driven-market-order:partial": {
    severity: "warning",
    sentence: (detail) => `Hedge order needs review${market(detail)}.`,
  },
};

export const auditEventCopyKeys = Object.keys(copies);

export function deskEvent(event: AuditEventInput): DeskEvent {
  const key = `${event.category}:${event.action}:${event.outcome}`;
  const copy = copies[key];
  if (copy) {
    return {
      id: event.id,
      occurredAt: event.occurredAt,
      severity: copy.severity,
      sentence: copy.sentence(event.detail),
    };
  }

  return {
    id: event.id,
    occurredAt: event.occurredAt,
    severity: "info",
    sentence: "Maker recorded an unclassified control event.",
  };
}
