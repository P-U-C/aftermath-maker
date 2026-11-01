import { describe, expect, it } from "vitest";
import { buildIdentity } from "../src/build-identity.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The two public handlers both spread this shared immutable build-time identity.
describe("public build identity", () => {
  it("exposes non-empty commit and build time in health and authenticated status", () => {
    const server = readFileSync(
      fileURLToPath(new URL("../src/server.ts", import.meta.url)),
      "utf8",
    );
    const health = server.match(
      /app\.get\("\/health"[\s\S]*?app\.get\("\/ready"/,
    );
    const status = server.match(
      /app\.get\("\/api\/status"[\s\S]*?app\.get\("\/api\/config"/,
    );
    expect(health?.[0]).toContain("...buildIdentity");
    expect(status?.[0]).toContain("...buildIdentity");
    expect(buildIdentity).toMatchObject({
      commit: expect.any(String),
      builtAt: expect.any(String),
    });
    expect(Object.keys(buildIdentity)).toEqual(["commit", "builtAt"]);
  });
});
