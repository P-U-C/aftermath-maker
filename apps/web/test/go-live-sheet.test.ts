import { describe, expect, it } from "vitest";
import { GO_LIVE_REQUIREMENT_HEADINGS } from "../components/views/strategy.js";

describe("Go live sheet requirements", () => {
  it("uses neutral requirement headings rather than asserting conditions", () => {
    expect(GO_LIVE_REQUIREMENT_HEADINGS).toEqual([
      "Live enabled on this server",
      "Signing key on control",
      "Runs on Core",
      "Core stopped",
      "Live trading key",
      "Live gas reserve",
      "Collateral",
    ]);
    expect(GO_LIVE_REQUIREMENT_HEADINGS.join(" ")).not.toMatch(/is on|is available|this bundle is/i);
  });
});
