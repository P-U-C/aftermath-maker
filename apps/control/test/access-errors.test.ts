import { describe, expect, it } from "vitest";
import { classifyHttpError, UserFacingError } from "../src/http-error.js";

// Each status/code/copy pair is the public contract for landing access errors.
describe("typed access-path errors", () => {
  it.each([
    [
      503,
      "access-list-unavailable",
      "Maker couldn't check the access list right now. Try again in a minute.",
    ],
    [
      503,
      "access-list-not-configured",
      "The access list isn't set up yet. The operator needs to finish setup.",
    ],
    [
      401,
      "signature-invalid",
      "Your wallet's signature didn't verify. Sign again.",
    ],
    [
      410,
      "access-check-expired",
      "That check expired. Sign again to request access.",
    ],
    [
      429,
      "access-request-limit",
      "You've sent 3 requests this hour. Try again later.",
    ],
  ] as const)(
    "returns %i %s without leaking internal error text",
    (status, code, message) => {
      expect(
        classifyHttpError(
          new UserFacingError(code, message, undefined, status),
        ),
      ).toMatchObject({ status, code, publicMessage: message });
    },
  );
  it("keeps unknown failures generic", () => {
    expect(classifyHttpError(new Error("secret"))).toMatchObject({
      status: 500,
      publicMessage: "Internal server error",
    });
  });
});
