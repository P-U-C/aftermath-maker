const usdWhole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const clock = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});

const eventClock = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export type MoneyFormatOptions = {
  /** Retained for old call sites; money (including table values) always defaults to cents. */
  table?: boolean;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
};

function normalized(value: number): number {
  return Object.is(value, -0) || Math.abs(value) < Number.EPSILON ? 0 : value;
}

function moneyPrecision(options: MoneyFormatOptions, _value: number) {
  return {
    minimumFractionDigits: options.minimumFractionDigits ?? 2,
    maximumFractionDigits: options.maximumFractionDigits ?? 2,
  };
}

function moneyFormatter(options: MoneyFormatOptions, value: number) {
  const { minimumFractionDigits, maximumFractionDigits } = moneyPrecision(
    options,
    value,
  );
  if (minimumFractionDigits === 2 && maximumFractionDigits === 2) {
    return usdWhole;
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits,
    maximumFractionDigits,
  });
}

function displayedMoneyValue(value: number, options: MoneyFormatOptions) {
  const safe = normalized(value);
  const { maximumFractionDigits } = moneyPrecision(options, safe);
  const roundingFloor = 0.5 * 10 ** -maximumFractionDigits;
  return Math.abs(safe) < roundingFloor ? 0 : safe;
}

export function moneyTone(value: number | null): "gain" | "loss" | "neutral" {
  const safe = value === null ? 0 : displayedMoneyValue(value, {});
  if (safe > 0) return "gain";
  if (safe < 0) return "loss";
  return "neutral";
}

export function formatMoney(
  value: number | null,
  options: MoneyFormatOptions = {},
): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const safe = displayedMoneyValue(value, options);
  return moneyFormatter(options, safe).format(safe).replace("-$", "−$");
}

/** A stable, inspectable value for native UI tooltips. */
export function formatExactMoney(value: number | null): string {
  return formatMoney(value, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  });
}

export function formatCompactMoney(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  })
    .format(displayedMoneyValue(value, {}))
    .replace("-$", "−$");
}

export function formatSignedMoney(
  value: number | null,
  options?: MoneyFormatOptions,
): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const safe = displayedMoneyValue(value, options ?? {});
  const amount = formatMoney(Math.abs(safe), options);
  if (safe > 0) return `+${amount}`;
  if (safe < 0) return `−${amount}`;
  return amount;
}

function decimalPlaces(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 2;
  const text = value.toString().toLowerCase();
  if (text.includes("e-")) {
    const [coefficient, exponentText] = text.split("e-");
    const coefficientDecimals = coefficient?.split(".")[1]?.length ?? 0;
    return Number(exponentText) + coefficientDecimals;
  }
  return text.split(".")[1]?.length ?? 0;
}

export function formatPrice(
  value: number | null,
  tickSize: number | null,
): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const digits = Math.min(12, decimalPlaces(tickSize ?? 0.01));
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(normalized(value));
}

export function formatTimestamp(
  timestamp: string | null,
  now = Date.now(),
): string {
  if (!timestamp) return "Waiting";
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return "Waiting";
  const elapsedSeconds = Math.max(0, Math.floor((now - parsed) / 1_000));
  if (elapsedSeconds < 60) return `${elapsedSeconds} s ago`;
  return clock.format(parsed);
}

export function formatEventTimestamp(timestamp: string | null): string {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return "Waiting";
  return eventClock.format(new Date(timestamp));
}
