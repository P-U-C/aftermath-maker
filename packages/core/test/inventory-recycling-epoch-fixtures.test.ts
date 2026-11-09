import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixtures = fileURLToPath(
  new URL("./fixtures/aftermath-epoch-fixtures/", import.meta.url),
);

type RewardObservations = {
  epochCsvRowUsd: Record<string, string>;
  uiPerpsUsdDisplayed: string;
  claimableAtomic?: string;
  claimableDecimals?: number;
};

const json = <T>(path: string) =>
  JSON.parse(readFileSync(`${fixtures}/${path}`, "utf8")) as T;

describe("Inventory recycling sanitized Epoch 4/5 accounting fixtures", () => {
  it("verifies the supplied source package and never uses aliases as live identifiers", () => {
    const output = execFileSync("python3", ["verify.py"], {
      cwd: fixtures,
      encoding: "utf8",
    });
    expect(output).toContain("Epoch 4: 463 fills");
    expect(output).toContain("Epoch 5: 1329 fills");
    expect(output).toContain("Sanitization check");
  });

  it("keeps CSV rewards, UI observations, and claimable balances distinct", () => {
    const epoch4 = json<RewardObservations>("epoch_4/reward_observations.json");
    const epoch5 = json<RewardObservations>("epoch_5/reward_observations.json");
    const csvPerps = (reward: RewardObservations) =>
      Object.entries(reward.epochCsvRowUsd)
        .filter(([name]) => name !== "referral" && name !== "integrator")
        .reduce((sum, [, usd]) => sum + Number(usd), 0);

    expect(csvPerps(epoch4)).toBeCloseTo(253.72198, 6);
    expect(epoch4.uiPerpsUsdDisplayed).toBe("893.63");
    expect(csvPerps(epoch5)).toBeCloseTo(4776.346896, 6);
    expect(epoch5.uiPerpsUsdDisplayed).toBe("3293.66");
    expect(epoch5.claimableAtomic).toBe("3683526368");
    expect(epoch5.claimableDecimals).toBe(6);
    // Claimable is an unlabelled aggregate balance, never an epoch payment.
    expect(
      Number(epoch5.claimableAtomic) / 10 ** epoch5.claimableDecimals!,
    ).not.toBeCloseTo(csvPerps(epoch5), 6);
  });

  it("uses the paired accounts as a negative control, never a calibration source", () => {
    const manifest = json<{ limitations: string[] }>("manifest.json");
    expect(manifest.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("historical order book/quotes"),
        expect.stringContaining("Wallet-paid gas"),
      ]),
    );
    // Candles support market-volume checks only; they cannot establish quote
    // priority, independent fills, or competitor parameter calibration.
    expect(
      json<{ markets: Record<string, unknown> }>(
        "epoch_5/hourly_market_candles.json",
      ).markets,
    ).not.toEqual({});
  });
});
