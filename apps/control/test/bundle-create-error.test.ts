import { describe, expect, it } from "vitest";
import { bundleCreateHttpError } from "../src/bundle-create-error.js";
import { classifyHttpError } from "../src/http-error.js";

describe("expected bundle creation failures", () => {
  it.each([
    [
      "Choose a strategy with one or more markets before creating this bundle",
      400,
    ],
    ["The selected account is not authorized", 400],
    ["Select an authorized Maker account before creating this bundle", 400],
    ["Strategy was not found for this wallet", 409],
    ["A bundle already uses that name", 409],
    ["Each account can hold one bundle role per wallet", 409],
    ["Confirm the wallet limits before creating a second bundle", 409],
    ["Configure Core wallet limits before creating this bundle", 409],
    ["Gross exposure limit exceeds this wallet's confirmed envelope", 409],
  ] as const)(
    "%s maps to HTTP %i without exposing unrelated errors",
    (message, status) => {
      expect(bundleCreateHttpError(new Error(message))).toEqual({
        message,
        status,
      });
      expect(classifyHttpError({ message, statusCode: status })).toMatchObject({
        status,
        publicMessage: message,
      });
    },
  );

  it("keeps unknown failures sanitized", () => {
    expect(
      bundleCreateHttpError(new Error("sqlite disk path /private/key")),
    ).toBeNull();
    expect(
      classifyHttpError(new Error("sqlite disk path /private/key")),
    ).toMatchObject({ status: 500, publicMessage: "Internal server error" });
  });
});
