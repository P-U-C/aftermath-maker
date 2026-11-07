import {
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  AftermathGateway,
  loadAgentKeypair,
  type EncryptedSecret,
} from "@puc/aftermath";
import { makerConfigSchema, setupSchema } from "@puc/core";
import {
  runLiveCanary,
  type LiveCanaryConfig,
  type LiveCanaryState,
  type LiveCanaryStateStore,
} from "./live-canary.js";

type FileCanaryConfig = LiveCanaryConfig & {
  agent: {
    address: string;
    encryptionContext: string;
    encryptedSecret: EncryptedSecret;
  };
  masterKeyPath: string;
};

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function optionalPositiveInteger(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 12) {
    throw new Error(`${name} must be an integer between 1 and 12`);
  }
  return value;
}

async function requirePrivateFile(path: string): Promise<void> {
  const metadata = await stat(path);
  if ((metadata.mode & 0o077) !== 0)
    throw new Error(`${path} must not be group- or world-readable`);
}

async function jsonFile<T>(path: string): Promise<T> {
  await requirePrivateFile(path);
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function parseConfig(value: FileCanaryConfig): FileCanaryConfig {
  if (value.network !== "mainnet") {
    throw new Error("Live canary config must name Mainnet explicitly");
  }
  return {
    ...value,
    network: "mainnet",
    makerSetup: setupSchema.parse(value.makerSetup),
    hedgeSetup: setupSchema.parse(value.hedgeSetup),
    config: makerConfigSchema.parse(value.config),
  };
}

function fileState(path: string): LiveCanaryStateStore {
  return {
    async read() {
      try {
        return JSON.parse(await readFile(path, "utf8")) as LiveCanaryState;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async write(state) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.next`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporary, path);
    },
  };
}

async function withExclusiveLock<T>(
  path: string,
  task: () => Promise<T>,
): Promise<T> {
  const acquire = async () => {
    try {
      return await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const prior = JSON.parse(await readFile(path, "utf8")) as {
        pid?: number;
      };
      if (
        prior.pid &&
        (() => {
          try {
            process.kill(prior.pid, 0);
            return true;
          } catch {
            return false;
          }
        })()
      ) {
        throw new Error("Another live canary invocation is already running");
      }
      await unlink(path);
      return open(path, "wx", 0o600);
    }
  };
  const lock = await acquire();
  await lock.writeFile(
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  try {
    return await task();
  } finally {
    await lock.close();
    await unlink(path).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const configPath = requiredArgument("--config");
  const statePath = requiredArgument("--state");
  const cycles = optionalPositiveInteger("--cycles", 1);
  const execute = process.argv.includes("--execute");
  if (execute && !process.argv.includes("--confirm-live-canary")) {
    throw new Error("--execute requires --confirm-live-canary");
  }
  const config = parseConfig(await jsonFile<FileCanaryConfig>(configPath));
  await withExclusiveLock(`${statePath}.lock`, async () => {
    await requirePrivateFile(config.masterKeyPath);
    const masterKey = (await readFile(config.masterKeyPath, "utf8")).trim();
    const signer = loadAgentKeypair({
      masterKey,
      context: config.agent.encryptionContext,
      encryptedSecret: config.agent.encryptedSecret,
    });
    if (
      signer.toSuiAddress().toLowerCase() !== config.agent.address.toLowerCase()
    ) {
      throw new Error(
        "Canary agent key does not match its configured public address",
      );
    }
    const gateway = await AftermathGateway.create({ network: "mainnet" });
    const startedAt = Date.now();
    const results = [];
    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      const cycleStatePath = cycles === 1 ? statePath : `${statePath}.${cycle}`;
      const result = await runLiveCanary({
        config,
        secrets: { agentAddress: config.agent.address, signer },
        execute,
        dependencies: { gateway, state: fileState(cycleStatePath) },
      });
      results.push({
        cycle,
        outcome: result.outcome,
        statePath: cycleStatePath,
        quoteDigest: result.state.quoteDigest,
        hedgeDigest: result.state.hedgeDigest,
        flattenDigests: result.state.flattenDigests,
      });
    }
    const [makerHistory, hedgeHistory] = await Promise.all([
      gateway.getAccountPerformanceHistory({
        setup: config.makerSetup,
        agentAddress: config.agent.address,
        sinceMs: startedAt,
        limit: 200,
      }),
      gateway.getAccountPerformanceHistory({
        setup: config.hedgeSetup,
        agentAddress: config.agent.address,
        sinceMs: startedAt,
        limit: 200,
      }),
    ]);
    const orders = [...makerHistory.orders, ...hedgeHistory.orders];
    const notionalUsd = orders.reduce(
      (sum, order) => sum + Math.abs(order.price * order.size),
      0,
    );
    const feesUsd = orders.reduce((sum, order) => sum + order.feesUsd, 0);
    const realizedPnlUsd = orders.reduce(
      (sum, order) => sum + order.realizedPnlUsd,
      0,
    );
    const estimatedBuilderFeesUsd =
      notionalUsd * config.builderCode.integratorFee;
    // Deliberately contains only public digests and the state-machine outcome.
    console.log(
      JSON.stringify({
        ok: true,
        cycles: results,
        performance: {
          since: new Date(startedAt).toISOString(),
          fills: orders.length,
          notionalUsd,
          realizedPnlUsd,
          feesUsd,
          estimatedBuilderFeesUsd,
          netAfterKnownTradingCostsUsd:
            realizedPnlUsd - feesUsd - estimatedBuilderFeesUsd,
          gasUsd: null,
          note: "Gas is intentionally not counted until every execution receipt is persisted in the canary checkpoint.",
          historyComplete:
            (makerHistory.historyComplete ?? true) &&
            (hedgeHistory.historyComplete ?? true),
        },
      }),
    );
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    // A timed-out SDK call can leave an undici handle alive. The canary
    // checkpoint has already been made recovery-required before this point;
    // force the one-shot process to end rather than silently lingering.
    process.exit(1);
  });
}
