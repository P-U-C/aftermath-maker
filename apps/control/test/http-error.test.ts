import { describe, expect, it } from "vitest";
import { classifyHttpError } from "../src/http-error.js";

describe("HTTP error classification", () => {
  it("preserves Fastify 400 and rate-limit 429 statuses", () => {
    expect(
      classifyHttpError({ statusCode: 400, message: "Malformed JSON" }),
    ).toMatchObject({ status: 400, publicMessage: "Malformed JSON" });
    expect(
      classifyHttpError({ statusCode: 429, message: "Rate limit exceeded" }),
    ).toMatchObject({ status: 429, publicMessage: "Rate limit exceeded" });
  });

  it("does not expose internal 5xx details", () => {
    expect(classifyHttpError(new Error("database path and secret"))).toEqual({
      status: 500,
      publicMessage: "Internal server error",
      internalMessage: "database path and secret",
    });
    expect(
      classifyHttpError(new Error("MAKER_MASTER_KEY is not configured")),
    ).toMatchObject({ status: 503, publicMessage: "Service unavailable" });
  });
});
