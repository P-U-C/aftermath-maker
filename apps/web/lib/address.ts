export function shortAddress(value: string | null | undefined): string {
  return value ? `${value.slice(0, 6)}...${value.slice(-4)}` : "Not set";
}
