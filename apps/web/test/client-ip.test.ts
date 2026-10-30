import { describe, expect, it } from "vitest";

import { clientIpFromReverseProxy } from "../lib/client-ip";

describe("reverse-proxy client address", () => {
  it("uses the proxy's single-address header", () => {
    expect(
      clientIpFromReverseProxy(
        new Headers({
          "x-real-ip": "203.0.113.7",
          "x-forwarded-for": "198.51.100.1, 203.0.113.7",
        }),
      ),
    ).toBe("203.0.113.7");
  });

  it("does not accept a caller-provided forwarding chain", () => {
    expect(
      clientIpFromReverseProxy(
        new Headers({ "x-forwarded-for": "198.51.100.1" }),
      ),
    ).toBeNull();
  });

  it("rejects malformed or multiple proxy addresses", () => {
    expect(
      clientIpFromReverseProxy(
        new Headers({ "x-real-ip": "203.0.113.7, 198.51.100.1" }),
      ),
    ).toBeNull();
  });
});
