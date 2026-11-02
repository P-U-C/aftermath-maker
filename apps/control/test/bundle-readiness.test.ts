import { describe, expect, it } from "vitest";
import { makerConfigSchema } from "@puc/core";
import {
  assertBundleReadyToStart,
  deriveBundleReadiness,
} from "../src/bundle-readiness.js";
import { classifyHttpError } from "../src/http-error.js";

const config = makerConfigSchema.parse({
  mode: "paper",
  rotationMode: "portfolio",
  markets: Array.from({ length: 5 }, (_, index) => ({
    marketId: `0x${(index + 1).toString(16)}`,
    symbol: `M${index + 1}`,
  })),
  quoteSizeUsd: 10,
  maxLeverage: 1,
  maxGasMist: 50_000_000,
});
const base = {
  bundle: { strategyId: "wide", makerAccountId: "42", takerAccountId: null },
  config,
  accounts: [{ accountId: "42", availableCollateralUsd: 100 }],
  authorizedAccountIds: new Set(["42"]),
  gasSui: 0.2,
  liveConfigs: [],
};

describe("five ordered bundle readiness stages", () => {
  it("returns the same $300 first fix as the card and the run status on Start", () => {
    const wide = makerConfigSchema.parse({
      ...config,
      maxQuoteAgeMs: 200_000,
      markets: Array.from({ length: 15 }, (_, index) => ({
        marketId: `0x${(index + 1).toString(16)}`,
        symbol: `M${index + 1}`,
      })),
    });
    const readiness = deriveBundleReadiness({
      ...base,
      config: wide,
      accounts: [{ accountId: "42", availableCollateralUsd: 0 }],
    });
    expect(readiness.stages[4]).toMatchObject({
      requiredUsd: 300,
      shortfallUsd: 300,
      accountId: "42",
    });
    try {
      assertBundleReadyToStart({ name: "Bundy" }, readiness);
      expect.fail("A short bundle must not start");
    } catch (error) {
      expect(classifyHttpError(error)).toMatchObject({
        status: 409,
        code: "bundle-not-ready-collateral",
        publicMessage: "Deposit $300.00 to account 42 before starting Bundy.",
        fix: { kind: "venues" },
      });
    }
  });

  it("marks a fully funded and authorized Paper bundle ready", () => {
    const result = deriveBundleReadiness(base);
    expect(result.ready).toBe(true);
    expect(result.stages.map((stage) => [stage.id, stage.status])).toEqual([
      ["strategy", "done"],
      ["accounts", "done"],
      ["tradingKeys", "done"],
      ["gas", "done"],
      ["collateral", "done"],
    ]);
    expect(result.stages[4]).toMatchObject({
      requiredUsd: 100,
      availableUsd: 100,
    });
  });
  it("reports a $300 collateral shortfall and its account", () => {
    const wide = makerConfigSchema.parse({
      ...config,
      maxQuoteAgeMs: 200_000,
      markets: Array.from({ length: 15 }, (_, index) => ({
        marketId: `0x${(index + 1).toString(16)}`,
        symbol: `M${index + 1}`,
      })),
    });
    const result = deriveBundleReadiness({
      ...base,
      config: wide,
      accounts: [{ accountId: "42", availableCollateralUsd: 0 }],
    });
    expect(result.ready).toBe(false);
    expect(result.stages[4]).toMatchObject({
      status: "todo",
      requiredUsd: 300,
      shortfallUsd: 300,
      accountId: "42",
    });
  });
  it("shows a missing strategy before dependent stages", () => {
    const result = deriveBundleReadiness({
      ...base,
      bundle: { ...base.bundle, strategyId: null },
      config: null,
    });
    expect(result.stages[0].status).toBe("todo");
    expect(result.stages[1].status).toBe("waiting");
  });
  it("distinguishes missing authorization from unassigned accounts", () => {
    const result = deriveBundleReadiness({
      ...base,
      authorizedAccountIds: new Set<string>(),
    });
    expect(result.stages[2]).toMatchObject({
      status: "todo",
      detail: "Authorize trading key",
    });
    expect(
      deriveBundleReadiness({
        ...base,
        bundle: { ...base.bundle, makerAccountId: null },
      }).stages[1].status,
    ).toBe("todo");
  });
  it("uses one Paper simulation budget and the unchanged Live gas reserve", () => {
    const paper = deriveBundleReadiness({ ...base, gasSui: 0.01 });
    expect(paper.stages[3]).toMatchObject({
      status: "todo",
      requiredGasSui: 0.05,
    });
    const live = makerConfigSchema.parse({ ...config, mode: "live" });
    const liveResult = deriveBundleReadiness({
      ...base,
      config: live,
      liveConfigs: [live],
      gasSui: 0.01,
    });
    expect(liveResult.stages[3].status).toBe("todo");
    expect(liveResult.stages[3].requiredGasSui).toBeGreaterThan(
      paper.stages[3].requiredGasSui!,
    );
  });
  it("uses the largest one-market override for single-slot and any positive hedge collateral", () => {
    const single = makerConfigSchema.parse({
      ...config,
      rotationMode: "single-slot",
      markets: [
        { marketId: "0x1", symbol: "A" },
        { marketId: "0x2", symbol: "B", overrides: { quoteSizeUsd: 20 } },
      ],
    });
    expect(
      deriveBundleReadiness({
        ...base,
        config: single,
        accounts: [{ accountId: "42", availableCollateralUsd: 40 }],
      }).stages[4],
    ).toMatchObject({ status: "done", requiredUsd: 40 });
    const hedge = makerConfigSchema.parse({
      ...single,
      makerAccountId: "42",
      hedge: { ...single.hedge, enabled: true, accountId: "43" },
    });
    const result = deriveBundleReadiness({
      ...base,
      config: hedge,
      bundle: { ...base.bundle, takerAccountId: "43" },
      accounts: [
        { accountId: "42", availableCollateralUsd: 40 },
        { accountId: "43", availableCollateralUsd: 0 },
      ],
      authorizedAccountIds: new Set(["42", "43"]),
    });
    expect(result.stages[4]).toMatchObject({
      status: "todo",
      accountId: "43",
      shortfallUsd: 0.01,
    });
  });
});
