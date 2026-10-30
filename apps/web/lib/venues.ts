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

export const aftermathVenue: VenueDescriptor = {
  id: "aftermath",
  name: "Aftermath",
  glyph: "A",
  network: "Sui mainnet",
  collateral: "USDC",
  feeModel: "1 bps on filled orders",
  gasUnit: "SUI",
  accountRoles: {
    maker: "Quotes both sides",
    hedge: "Reduces net exposure",
  },
  explorerTxUrl: (digest) =>
    `https://suiscan.xyz/mainnet/tx/${encodeURIComponent(digest)}`,
  explorerObjectUrl: (objectId) =>
    `https://suiscan.xyz/mainnet/object/${encodeURIComponent(objectId)}`,
  homeUrl: "https://aftermath.finance/",
  rewardsUrl: "https://aftermath.finance/rewards",
};

export const primaryVenue = aftermathVenue;
