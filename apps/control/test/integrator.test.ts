import { describe, expect, it } from "vitest";
import { activeBuilderCode } from "../src/integrator.js";

describe("activeBuilderCode", () => {
  it("prefers the confirmed registration over bootstrap configuration", () => {
    expect(
      activeBuilderCode({
        confirmedIntegratorId: 12,
        configuredIntegratorId: 7,
        feeBps: 1,
      }),
    ).toEqual({ integratorId: 12, integratorFee: 0.0001 });
  });

  it("uses bootstrap configuration before a registration is confirmed", () => {
    expect(
      activeBuilderCode({
        confirmedIntegratorId: null,
        configuredIntegratorId: 7,
        feeBps: 1,
      }),
    ).toEqual({ integratorId: 7, integratorFee: 0.0001 });
  });

  it("returns no code when neither source is configured", () => {
    expect(
      activeBuilderCode({
        confirmedIntegratorId: null,
        configuredIntegratorId: undefined,
        feeBps: 1,
      }),
    ).toBeNull();
  });
});
