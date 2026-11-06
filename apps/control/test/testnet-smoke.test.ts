import { describe, expect, it } from "vitest";
import {
  selectTestnetUsdcCoin,
  testnetSmokeConfig,
} from "../src/testnet-smoke.js";

describe("Testnet smoke preflight", () => {
  it("refuses every network other than Testnet", () => {
    expect(() => testnetSmokeConfig({ SUI_NETWORK: "mainnet" })).toThrow(
      "SUI_NETWORK=testnet",
    );
  });

  it("uses Testnet-only defaults and identifies the faucet USDC type", () => {
    expect(testnetSmokeConfig({ SUI_NETWORK: "testnet" })).toEqual({
      network: "testnet",
      controlUrl: "http://control:8787",
      rpcUrl: "https://fullnode.testnet.sui.io",
    });
    expect(selectTestnetUsdcCoin(["0x2::sui::SUI", "0x123::usdc::USDC"])).toBe(
      "0x123::usdc::USDC",
    );
  });

  it("fails closed when Testnet has no faucet USDC", () => {
    expect(() => selectTestnetUsdcCoin(["0x2::sui::SUI"])).toThrow(
      "did not advertise a USDC coin",
    );
  });
});
