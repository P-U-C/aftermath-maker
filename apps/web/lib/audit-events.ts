import {
  accountReadStallText,
  formatPaperBlocker,
  type PaperBlocker,
} from "./paper-blocker";
import { formatPrice } from "./format";

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
  fixes?: Array<{
    label: string;
    view?: "venues" | "strategy" | "bundles";
    copyAddress?: string;
  }>;
};

export type AuditEventContext = {
  bundleName?: string | null;
  accountId?: string | null;
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

const shortMarketId = (value: string) =>
  value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value;

const market = (detail: Record<string, unknown>) =>
  typeof detail.symbol === "string" && detail.symbol.trim()
    ? detail.symbol.trim()
    : typeof detail.marketId === "string"
      ? shortMarketId(detail.marketId)
      : "this market";

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
  "bundles:mode.update:success": {
    severity: "info",
    sentence: (detail) =>
      `Bundle${bundle(detail)} switched to ${detail.to === "live" ? "Live" : "Paper"}.`,
  },
  "rewards:share.settings.update:success": {
    severity: "info",
    sentence: () => "Reward model settings saved.",
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
  "onboarding:agent.gas-transaction:prepared": {
    severity: "info",
    sentence: (detail) =>
      `Trading key gas top-up${account(detail)} is ready in your wallet.`,
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
    severity: "warning",
    sentence: (detail) =>
      `Maker is retrying a post-only quote${market(detail)}.`,
  },
  "runtime:cycle:cancelled": {
    severity: "info",
    sentence: () => "Maker cycle was cancelled.",
  },
  "runtime:cycle:error": {
    severity: "error",
    sentence: (detail) => {
      const reason =
        typeof detail.error === "string"
          ? detail.error
              .split("\n")[0]!
              .replace(/https?:\/\/\S+/g, "the venue endpoint")
              .trim()
              .slice(0, 220)
              .replace(/[.\s]+$/, "")
          : "";
      return reason ? `Maker cycle failed: ${reason}.` : "Maker cycle failed.";
    },
  },
  "runtime:cycle:retry": {
    severity: "warning",
    sentence: () => "Maker could not read venue data and will retry.",
  },
  "runtime:cycle:timeout": {
    severity: "warning",
    sentence: (detail) =>
      accountReadStallText(
        String(detail.accountReadAt ?? ""),
        String(detail.error ?? "venue read timed out"),
      ),
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
  "paper:estimated-fill:estimated": {
    severity: "info",
    sentence: (detail) => {
      const fills = Array.isArray(detail.estimatedFills)
        ? detail.estimatedFills
            .filter(
              (fill): fill is Record<string, unknown> =>
                Boolean(fill) && typeof fill === "object",
            )
            .slice(0, 2)
        : [];
      const format = (fill: Record<string, unknown>) => {
        const side = fill.side === "bid" ? "bought" : "sold";
        const size =
          typeof fill.sizeUsd === "number" && Number.isFinite(fill.sizeUsd)
            ? fill.sizeUsd.toFixed(2)
            : "an unknown amount";
        const symbol =
          typeof fill.symbol === "string" ? fill.symbol : market(detail);
        const price =
          typeof fill.price === "number" && Number.isFinite(fill.price)
            ? formatPrice(fill.price, null)
            : "an unknown price";
        return `${side} $${size} of ${symbol} at ${price}`;
      };
      const fillCount = Number(detail.fills ?? 0);
      const extra = Number.isFinite(fillCount)
        ? Math.max(0, fillCount - fills.length)
        : 0;
      return `Paper would have ${fills.length ? fills.map(format).join(", then ") : `filled ${market(detail)}`}${extra ? `, +${extra} more` : ""}. No order was sent.`;
    },
  },
  "paper:volume-close:estimated": {
    severity: "info",
    sentence: (detail) =>
      `Paper closed both simulated accounts in ${market(detail)} before rotating. No order was sent.`,
  },
  "paper:exposure-unwind:estimated": {
    severity: "warning",
    sentence: (detail) =>
      `Paper closed $${typeof detail.sizeUsd === "number" ? detail.sizeUsd.toFixed(2) : "0.00"} of ${market(detail)} to bring gross exposure under the limit.`,
  },
  "risk:exposure-unwind:confirmed": {
    severity: "warning",
    sentence: (detail) =>
      `Maker closed $${typeof detail.sizeUsd === "number" ? detail.sizeUsd.toFixed(2) : "0.00"} of ${market(detail)} to bring gross exposure under the limit.`,
  },
  "paper:volume-fee-budget:warning": {
    severity: "warning",
    sentence: (detail) =>
      `Volume reached its daily estimated fee budget${typeof detail.dailyFeeBudgetUsd === "number" ? ` ($${detail.dailyFeeBudgetUsd.toFixed(2)})` : ""}. Maker will finish the current close and resume at 00:00 UTC.`,
  },
  "paper:simulation:cleared": {
    severity: "info",
    sentence: () => "Paper is simulating again.",
  },
  "paper:market-skip:paused": {
    severity: "info",
    sentence: (detail) =>
      typeof detail.message === "string"
        ? detail.message
        : `${market(detail)} is paused.`,
  },
  "paper:market-skip:resumed": {
    severity: "info",
    sentence: (detail) => `${market(detail)} is quoting again.`,
  },
  "paper:market-skip:all-paused": {
    severity: "warning",
    sentence: (detail) =>
      typeof detail.message === "string"
        ? detail.message
        : "Paper has not quoted for 15 minutes.",
  },
  "paper:simulation:blocked": {
    severity: "warning",
    sentence: (detail) =>
      typeof detail.message === "string"
        ? detail.message
        : "Paper could not simulate this quote. Maker will keep reading the market.",
  },
  "paper:trial.start:success": {
    severity: "info",
    sentence: () => "Paper test run started.",
  },
  "paper:trial.complete:success": {
    severity: "info",
    sentence: () => "Paper test run completed.",
  },
  "paper:trial:error": {
    severity: "error",
    sentence: () => "Paper test run failed.",
  },
  "risk:stale-quote-watchdog:tripped": {
    severity: "warning",
    sentence: () =>
      "No market check finished in time, so Maker cancelled its quotes. It keeps checking and quotes again on the next completed check.",
  },
  "risk:stale-quote-watchdog:recovered": {
    severity: "info",
    sentence: () => "Market checks resumed; Maker is quoting again.",
  },
  "risk:stale-quote-cancel:cancelled": {
    severity: "info",
    sentence: (detail) => {
      const symbols = Array.isArray(detail.symbols)
        ? detail.symbols.filter((value) => typeof value === "string")
        : [];
      const seconds =
        typeof detail.maxQuoteAgeMs === "number"
          ? `${Math.round(detail.maxQuoteAgeMs / 1000)}s`
          : "its limit";
      return `Cancelled the ${symbols.length ? symbols.join(", ") : market(detail)} ${symbols.length > 1 ? "quotes" : "quote"}: not re-checked within ${seconds}. ${symbols.length > 1 ? "They're" : "It's"} replaced on the next visit.`;
    },
  },
  "risk:stale-quote-cancel:error": {
    severity: "warning",
    sentence: (detail) =>
      `Couldn't confirm cancelling the stale ${market(detail)} quote. Maker tries again on the next check.`,
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
    severity: "warning",
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

function withContext(
  sentence: string,
  event: AuditEventInput,
  context: AuditEventContext,
): string {
  const bundleName = context.bundleName?.trim();
  const accountId =
    context.accountId ??
    (bundleName && typeof event.detail.accountId === "string"
      ? event.detail.accountId
      : null);
  if (!bundleName && !accountId) return sentence;

  // Some sentences already name their bundle; never say it twice.
  const own =
    bundleName && sentence.startsWith(`${bundleName}: `)
      ? sentence.slice(bundleName.length + 2)
      : sentence;
  const withoutAccountSuffix = own.replace(/ for account \d+(?=\.)/, "");
  const subject = [bundleName, accountId ? `account ${accountId}` : null]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  // Lowercase a leading word ("Maker" -> "maker"), never a symbol ("SHFL").
  const lead = /^[A-Z][a-z]/.test(withoutAccountSuffix)
    ? withoutAccountSuffix[0]!.toLowerCase()
    : (withoutAccountSuffix[0] ?? "");
  return `${subject}: ${lead}${withoutAccountSuffix.slice(1)}`;
}

export function deskEvent(
  event: AuditEventInput,
  context: AuditEventContext = {},
): DeskEvent {
  const key = `${event.category}:${event.action}:${event.outcome}`;
  if (
    event.category === "request" &&
    (event.outcome === "rejected" || event.outcome === "error")
  ) {
    const message =
      typeof event.detail.message === "string"
        ? event.detail.message
        : "Maker could not complete the request.";
    const reference =
      typeof event.detail.reference === "string"
        ? event.detail.reference
        : "unavailable";
    return {
      id: event.id,
      occurredAt: event.occurredAt,
      severity: event.outcome === "error" ? "error" : "warning",
      sentence: withContext(
        `${message} Reference ${reference} is in your control log.`,
        event,
        context,
      ),
      fixes: [
        /strategy|market-rule|profile/i.test(String(event.detail.code ?? ""))
          ? { label: "Open Strategy", view: "strategy" }
          : /gas|account|collateral|authorization/i.test(
                String(event.detail.code ?? ""),
              )
            ? { label: "Open Venues", view: "venues" }
            : { label: "Open Bundles", view: "bundles" },
      ],
    };
  }
  if (key === "runtime:cycle:timeout") {
    const observedAt =
      typeof event.detail.accountReadAt === "string"
        ? event.detail.accountReadAt
        : "";
    const error =
      typeof event.detail.error === "string" ? event.detail.error : null;
    return {
      id: event.id,
      occurredAt: event.occurredAt,
      severity: "warning",
      sentence: `${context.bundleName ? `${context.bundleName}: ` : ""}${accountReadStallText(observedAt, error)}`,
      fixes: [{ label: "Open Venues", view: "venues" }],
    };
  }
  if (key === "paper:simulation:cleared") {
    return {
      id: event.id,
      occurredAt: event.occurredAt,
      severity: "info",
      sentence: `${context.bundleName ?? "Maker"}: Paper is simulating again.`,
    };
  }
  if (
    key === "paper:simulation:blocked" &&
    typeof event.detail.code === "string"
  ) {
    const blocker = formatPaperBlocker(event.detail as PaperBlocker);
    return {
      id: event.id,
      occurredAt: event.occurredAt,
      severity: "warning",
      sentence: context.bundleName
        ? `${context.bundleName}: ${blocker.sentence}`
        : blocker.sentence,
      fixes: [
        ...(blocker.destination === "venues"
          ? [{ label: "Open Venues", view: "venues" as const }]
          : []),
        ...(blocker.rotation
          ? [{ label: "Edit strategy", view: "strategy" as const }]
          : []),
        ...(blocker.copyAddress
          ? [
              {
                label: "Copy trading key address",
                copyAddress: blocker.copyAddress,
              },
            ]
          : []),
      ],
    };
  }
  const copy = copies[key];
  if (copy) {
    const needsFix = copy.severity !== "info";
    const destination =
      event.category === "risk" || event.category === "strategies"
        ? ("strategy" as const)
        : event.category === "hedge" || event.category === "onboarding"
          ? ("venues" as const)
          : ("bundles" as const);
    return {
      id: event.id,
      occurredAt: event.occurredAt,
      severity: copy.severity,
      sentence: withContext(copy.sentence(event.detail), event, context),
      ...(needsFix
        ? {
            fixes: [
              {
                label: `Open ${destination[0]!.toUpperCase()}${destination.slice(1)}`,
                view: destination,
              },
            ],
          }
        : {}),
    };
  }

  return {
    id: event.id,
    occurredAt: event.occurredAt,
    severity: "info",
    sentence: withContext(
      "Maker recorded an unclassified control event.",
      event,
      context,
    ),
  };
}
