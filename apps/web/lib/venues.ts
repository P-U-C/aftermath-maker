export type VenueDescriptor = {
  id: string;
  name: string;
  glyph: string;
  network: string;
  collateral: string;
  feeModel: string;
  gasUnit: string;
  accountRoles: {
    maker: string;
    hedge: string;
  };
  explorerTxUrl: (digest: string) => string;
  explorerObjectUrl: (objectId: string) => string;
  homeUrl: string;
  rewardsUrl: string;
};

const suiNetwork =
  process.env.NEXT_PUBLIC_SUI_NETWORK === "testnet" ? "testnet" : "mainnet";

export const aftermathVenue: VenueDescriptor = {
  id: "aftermath",
  name: "Aftermath",
  glyph: "A",
  network: `Sui ${suiNetwork}`,
  collateral: "USDC",
  feeModel: "1 bps on filled orders",
  gasUnit: "SUI",
  accountRoles: {
    maker: "Quotes both sides",
    hedge: "Reduces net exposure",
  },
  explorerTxUrl: (digest) =>
    `https://suiscan.xyz/${suiNetwork}/tx/${encodeURIComponent(digest)}`,
  explorerObjectUrl: (objectId) =>
    `https://suiscan.xyz/${suiNetwork}/object/${encodeURIComponent(objectId)}`,
  homeUrl:
    suiNetwork === "testnet"
      ? "https://testnet.aftermath.finance/"
      : "https://aftermath.finance/",
  rewardsUrl:
    suiNetwork === "testnet"
      ? "https://testnet.aftermath.finance/rewards"
      : "https://aftermath.finance/rewards",
};

export const primaryVenue = aftermathVenue;
