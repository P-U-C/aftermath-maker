const usdWhole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const usdSmall = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumSignificantDigits: 1,
  maximumSignificantDigits: 4,
});

const clock = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});

function normalized(value: number): number {
  return Object.is(value, -0) || Math.abs(value) < Number.EPSILON ? 0 : value;
}

export function moneyTone(value: number | null): "gain" | "loss" | "neutral" {
  const safe = value === null ? 0 : normalized(value);
  if (safe > 0) return "gain";
  if (safe < 0) return "loss";
  return "neutral";
}

export function formatMoney(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const safe = normalized(value);
  const formatter = Math.abs(safe) >= 1 || safe === 0 ? usdWhole : usdSmall;
  return formatter.format(safe).replace("-$", "−$");
}

export function formatSignedMoney(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const safe = normalized(value);
  const amount = formatMoney(Math.abs(safe));
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
