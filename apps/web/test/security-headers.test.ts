import { describe, expect, it } from "vitest";

import nextConfig, { securityHeaders } from "../next.config";

const header = (key: string) =>
  securityHeaders.find((candidate) => candidate.key === key)?.value;

describe("browser response policy", () => {
  it("keeps the transport, embedding, and content restrictions enabled", async () => {
    expect(header("Strict-Transport-Security")).toBe("max-age=31536000");
    expect(header("X-Frame-Options")).toBe("DENY");
    expect(header("X-Content-Type-Options")).toBe("nosniff");

    expect(header("Content-Security-Policy")).toContain("default-src 'self'");
    expect(header("Content-Security-Policy")).toContain("form-action 'self'");
    expect(header("Content-Security-Policy")).toContain("connect-src 'self'");

    const rules = await nextConfig.headers?.();
    expect(rules).toEqual([
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ]);
  });
});
