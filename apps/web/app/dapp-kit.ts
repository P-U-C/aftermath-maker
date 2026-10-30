import { createDAppKit } from "@mysten/dapp-kit-core";
import { SuiGrpcClient } from "@mysten/sui/grpc";

const MAINNET_GRPC =
  process.env.NEXT_PUBLIC_SUI_GRPC_URL ?? "https://fullnode.mainnet.sui.io:443";

export const dAppKit = createDAppKit({
  networks: ["mainnet"],
  defaultNetwork: "mainnet",
  autoConnect: true,
  // Registers Slush's Wallet Standard bridge for browsers where the native
  // mobile app cannot inject a wallet provider (for example, a phone browser).
  // An injected Slush wallet still takes precedence when it is available.
  slushWalletConfig: { appName: "Maker" },
  createClient: () =>
    new SuiGrpcClient({
      network: "mainnet",
      baseUrl: MAINNET_GRPC,
    }),
});

declare module "@mysten/dapp-kit-react" {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}
