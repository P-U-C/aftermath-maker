import { Aftermath } from "aftermath-ts-sdk";
import { SuiGrpcClient } from "@mysten/sui/grpc";

const TESTNET_RPC = "https://fullnode.testnet.sui.io:443";

export type TestnetSmokeConfig = {
  controlUrl: string;
  rpcUrl: string;
  network: "testnet";
};

export type TestnetSmokeReport = {
  network: "testnet";
  chainIdentifier: string;
  controlReady: boolean;
  aftermathRegistry: string;
  usdcCoinType: string;
  marketCount: number;
};

function requiredUrl(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
}

/**
 * Testnet smoke runs must never quietly fall back to a Mainnet endpoint. The
 * full execution smoke adds its disposable signer separately, after these
 * public venue preflight checks pass.
 */
export function testnetSmokeConfig(
  environment: NodeJS.ProcessEnv,
): TestnetSmokeConfig {
  if (environment.SUI_NETWORK !== "testnet") {
    throw new Error("Testnet smoke refuses to run unless SUI_NETWORK=testnet");
  }
  return {
    network: "testnet",
    controlUrl: requiredUrl(
      environment.CONTROL_SMOKE_URL ?? "http://control:8787",
      "CONTROL_SMOKE_URL",
    ),
    rpcUrl: requiredUrl(
      environment.SUI_TESTNET_RPC ?? TESTNET_RPC,
      "SUI_TESTNET_RPC",
    ),
  };
}

export function selectTestnetUsdcCoin(supportedCoins: string[]): string {
  const usdc = supportedCoins.find((coin) => /::usdc::usdc$/i.test(coin));
  if (!usdc) {
    throw new Error("Aftermath Testnet faucet did not advertise a USDC coin");
  }
  return usdc;
}

async function expectOk(response: Response, label: string): Promise<void> {
  if (response.ok) return;
  throw new Error(`${label} returned HTTP ${response.status}`);
}

/**
 * Read-only prerequisite gate for the disposable Testnet execution smoke.
 * It is intentionally independent of production credentials and never signs,
 * broadcasts, creates accounts, or requests faucet funds.
 */
export async function runTestnetSmokePreflight(
  environment: NodeJS.ProcessEnv,
): Promise<TestnetSmokeReport> {
  const config = testnetSmokeConfig(environment);
  const controlHealth = await fetch(`${config.controlUrl}/health`);
  await expectOk(controlHealth, "Control health");
  const controlReady = await fetch(`${config.controlUrl}/ready`);
  await expectOk(controlReady, "Control readiness");

  const client = new SuiGrpcClient({
    network: config.network,
    baseUrl: config.rpcUrl,
  });
  const chain = await client.getChainIdentifier();
  const sdk = await Aftermath.create({ network: "TESTNET" });
  const [addresses, supportedCoins] = await Promise.all([
    sdk.getAddresses(),
    sdk.Faucet().getSupportedCoins(),
  ]);
  const usdcCoinType = selectTestnetUsdcCoin(supportedCoins);
  const registry = addresses.perpetuals?.objects.registry;
  if (!registry) {
    throw new Error("Aftermath Testnet did not publish a perpetuals registry");
  }
  const { markets } = await sdk.Perpetuals().getAllMarkets({
    collateralCoinType: usdcCoinType,
  });
  if (!markets.length) {
    throw new Error("Aftermath Testnet returned no USDC perpetual markets");
  }

  return {
    network: config.network,
    chainIdentifier: chain.chainIdentifier,
    controlReady: true,
    aftermathRegistry: registry,
    usdcCoinType,
    marketCount: markets.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTestnetSmokePreflight(process.env)
    .then((report) => {
      console.log(JSON.stringify({ ok: true, ...report }));
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({ ok: false, network: "testnet", error: message }),
      );
      process.exitCode = 1;
    });
}
