export function decimalToBaseUnits(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("Decimals must be an integer between 0 and 18");
  }

  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!match) {
    throw new Error("Amount must be a plain, non-negative decimal");
  }

  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new Error("Amount supports at most " + decimals + " decimal places");
  }

  const wholeUnits = BigInt(match[1]!) * 10n ** BigInt(decimals);
  const fractionalUnits = fraction
    ? BigInt(fraction.padEnd(decimals, "0"))
    : 0n;
  return wholeUnits + fractionalUnits;
}
