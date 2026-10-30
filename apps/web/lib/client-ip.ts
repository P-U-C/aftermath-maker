const IP_ADDRESS = /^[0-9a-fA-F:.]+$/;

/**
 * The public reverse proxy overwrites X-Real-IP with its peer address.
 * Do not fall back to client-provided forwarding chains here.
 */
export function clientIpFromReverseProxy(headers: Headers): string | null {
  const value = headers.get("x-real-ip")?.trim();
  if (!value || value.length > 64 || !IP_ADDRESS.test(value)) return null;
  return value;
}
