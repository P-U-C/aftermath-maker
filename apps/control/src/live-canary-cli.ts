import { readFile, rename, stat, writeFile } from "node:fs/promises";
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

async function main(): Promise<void> {
  const configPath = requiredArgument("--config");
  const statePath = requiredArgument("--state");
  const execute = process.argv.includes("--execute");
  if (execute && !process.argv.includes("--confirm-live-canary")) {
    throw new Error("--execute requires --confirm-live-canary");
  }
  const config = parseConfig(await jsonFile<FileCanaryConfig>(configPath));
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
  const result = await runLiveCanary({
    config,
    secrets: { agentAddress: config.agent.address, signer },
    execute,
    dependencies: { gateway, state: fileState(statePath) },
  });
  // Deliberately contains only public digests and the state-machine outcome.
  console.log(
    JSON.stringify({ ok: true, outcome: result.outcome, state: result.state }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  });
}
