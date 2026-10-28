import { Store } from "./store.js";

type Options = {
  all: boolean;
  dryRun: boolean;
  ownerAddress: string | null;
};

function usage(): never {
  throw new Error(
    "Usage: npm run -w @puc/control bundles:rollback -- (--owner <address> | --all) [--dry-run]",
  );
}

function parseOptions(argv: string[]): Options {
  let all = false;
  let dryRun = false;
  let ownerAddress: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--all") {
      all = true;
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--owner") {
      const value = argv[index + 1];
      if (!value) usage();
      ownerAddress = value.toLowerCase();
      index += 1;
    } else {
      usage();
    }
  }

  if (all === (ownerAddress !== null)) usage();
  if (ownerAddress && !/^0x[0-9a-f]{64}$/.test(ownerAddress)) {
    throw new Error("--owner must be a 32-byte hexadecimal wallet address");
  }
  return { all, dryRun, ownerAddress };
}

const options = parseOptions(process.argv.slice(2));
const store = new Store(process.env.DATABASE_PATH ?? "data/maker.db");

try {
  const owners = options.all
    ? store.listBundleRollbackCandidates()
    : [options.ownerAddress!];
  const results = owners.map((ownerAddress) => {
    const eligible = store.canRollbackBundleMigration(ownerAddress);
    return {
      ownerAddress,
      eligible,
      rolledBack:
        !options.dryRun && eligible
          ? store.forTenant(ownerAddress).rollbackBundleMigration()
          : false,
    };
  });
  process.stdout.write(
    `${JSON.stringify({ dryRun: options.dryRun, results }, null, 2)}\n`,
  );
} finally {
  store.close();
}
