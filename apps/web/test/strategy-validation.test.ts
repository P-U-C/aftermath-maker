import { describe, expect, it } from "vitest";
import { strategyIssueFromServer } from "../lib/strategy-validation";

describe("server strategy validation mapping", () => {
  it("focuses a market override without discarding its draft", () => {
    const issue = JSON.stringify([
      {
        path: ["markets", 1, "overrides", "inventoryTargetUsd"],
        message: "Target exceeds market inventory",
      },
    ]);
    expect(
      strategyIssueFromServer(issue, [
        { marketId: "0xa" },
        { marketId: "0xb" },
      ]),
    ).toEqual({
      message:
        "markets.1.overrides.inventoryTargetUsd: Target exceeds market inventory",
      step: 2,
      fieldId: "market-0xb-inventoryTargetUsd",
    });
  });
  it("maps numeric and hedge errors and treats unknown messages safely", () => {
    expect(
      strategyIssueFromServer(
        JSON.stringify([
          { path: ["config", "maxGrossExposureUsd"], message: "Too low" },
        ]),
        [],
      ),
    ).toMatchObject({ fieldId: "strategy-gross", step: 2 });
    expect(
      strategyIssueFromServer(
        JSON.stringify([
          { path: ["hedge", "maxOrderUsd"], message: "Too low" },
        ]),
        [],
      ),
    ).toMatchObject({ fieldId: "strategy-hedge-max", step: 3 });
    expect(strategyIssueFromServer("Service unavailable", [])).toBeNull();
  });
});
