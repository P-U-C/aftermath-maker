import { createDAppKit } from "@mysten/dapp-kit-core";
import { SuiGrpcClient } from "@mysten/sui/grpc";

const SUI_NETWORK =
  process.env.NEXT_PUBLIC_SUI_NETWORK === "testnet" ? "testnet" : "mainnet";
const SUI_GRPC =
  process.env.NEXT_PUBLIC_SUI_GRPC_URL ??
  `https://fullnode.${SUI_NETWORK}.sui.io:443`;

export const dAppKit = createDAppKit({
  networks: [SUI_NETWORK],
  defaultNetwork: SUI_NETWORK,
  autoConnect: true,
  // Registers Slush's Wallet Standard bridge for browsers where the native
  // mobile app cannot inject a wallet provider (for example, a phone browser).
  // An injected Slush wallet still takes precedence when it is available.
  slushWalletConfig: { appName: "Maker" },
  createClient: () =>
    new SuiGrpcClient({
      network: SUI_NETWORK,
      baseUrl: SUI_GRPC,
    }),
});

declare module "@mysten/dapp-kit-react" {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}
