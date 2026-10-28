/**
 * Registers a Wallet Standard Sui wallet inside the browser so headless runs can
 * exercise the connected-but-not-signed-in states that a real extension produces.
 *
 * Install with page.addInitScript({ path }) and configure through
 * window.__makerMockWallet before the app connects.
 */
(() => {
  const FIRST_ADDRESS = `0x${"a1".repeat(32)}`;
  const SECOND_ADDRESS = `0x${"b2".repeat(32)}`;

  const config = (window.__makerMockWallet = {
    name: "Mock Sui Wallet",
    addresses: [FIRST_ADDRESS, SECOND_ADDRESS],
    // "pending" leaves signPersonalMessage unresolved, reproducing a wallet
    // prompt the operator has not answered yet.
    signPersonalMessage: "resolve",
    ...(window.__makerMockWallet ?? {}),
  });

  const ICON =
    "data:image/svg+xml;base64," +
    btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#1d4ed8"/></svg>',
    );

  const CHAINS = ["sui:mainnet"];
  const ACCOUNT_FEATURES = [
    "sui:signPersonalMessage",
    "sui:signTransaction",
    "sui:signAndExecuteTransaction",
  ];

  const publicKeyFor = (address) => {
    const bytes = new Uint8Array(32);
    for (let index = 0; index < 32; index += 1) {
      bytes[index] = parseInt(address.slice(2 + index * 2, 4 + index * 2), 16);
    }
    return bytes;
  };

  const accountFor = (address) => ({
    address,
    publicKey: publicKeyFor(address),
    chains: CHAINS,
    features: ACCOUNT_FEATURES,
  });

  const listeners = new Set();
  let accounts = [];

  const emitChange = () => {
    for (const listener of listeners) listener({ accounts });
  };

  const wallet = {
    version: "1.0.0",
    name: config.name,
    icon: ICON,
    chains: CHAINS,
    get accounts() {
      return accounts;
    },
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => {
          accounts = (
            window.__makerMockWallet?.addresses ?? config.addresses
          ).map(accountFor);
          emitChange();
          return { accounts };
        },
      },
      "standard:disconnect": {
        version: "1.0.0",
        disconnect: async () => {
          accounts = [];
          emitChange();
        },
      },
      "standard:events": {
        version: "1.0.0",
        on: (event, listener) => {
          if (event !== "change") return () => {};
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      "sui:signPersonalMessage": {
        version: "1.1.0",
        signPersonalMessage: async ({ message, account }) => {
          window.__makerMockWallet.lastSignRequest = {
            address: account?.address ?? null,
            message: new TextDecoder().decode(message),
          };
          const behaviour =
            window.__makerMockWallet?.signPersonalMessage ??
            config.signPersonalMessage;
          if (behaviour === "pending") {
            await new Promise(() => {});
          }
          if (behaviour === "reject") {
            throw new Error("User rejected the signature request");
          }
          return {
            bytes: btoa(String.fromCharCode(...message)),
            signature: `mock-signature:${account?.address ?? ""}`,
          };
        },
      },
      "sui:signTransaction": {
        version: "2.0.0",
        signTransaction: async () => {
          throw new Error("Mock wallet cannot sign transactions");
        },
      },
      "sui:signAndExecuteTransaction": {
        version: "2.0.0",
        signAndExecuteTransaction: async () => {
          throw new Error("Mock wallet cannot execute transactions");
        },
      },
    },
  };

  const register = (api) => {
    try {
      api.register(wallet);
    } catch {
      /* already registered */
    }
  };

  window.addEventListener("wallet-standard:app-ready", (event) =>
    register(event.detail),
  );
  window.dispatchEvent(
    new CustomEvent("wallet-standard:register-wallet", { detail: register }),
  );
})();
