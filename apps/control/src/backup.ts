import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

export type SqliteBackupOptions = {
  sourcePath: string;
  destinationPath: string;
  onProgress?: (info: { totalPages: number; remainingPages: number }) => number;
};

type SqliteBackupVerifier = (snapshotPath: string) => void;

export function verifySqliteBackup(snapshotPath: string): void {
  let snapshot: Database.Database | undefined;
  try {
    snapshot = new Database(snapshotPath, {
      readonly: true,
      fileMustExist: true,
    });
    const integrity = snapshot.pragma("quick_check", { simple: true });
    if (integrity !== "ok") {
      throw new Error(
        `SQLite backup integrity check failed: ${String(integrity)}`,
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("SQLite backup integrity check failed:")
    ) {
      throw error;
    }
    throw new Error(
      `SQLite backup integrity check failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  } finally {
    snapshot?.close();
  }
}

export async function createVerifiedSqliteBackup(
  { sourcePath, destinationPath, onProgress }: SqliteBackupOptions,
  verifySnapshot: SqliteBackupVerifier = verifySqliteBackup,
): Promise<string> {
  const resolved = resolve(destinationPath);
  mkdirSync(dirname(resolved), { recursive: true });
  const database = new Database(sourcePath, {
    readonly: true,
    fileMustExist: true,
  });

  try {
    await database.backup(
      resolved,
      onProgress === undefined ? undefined : { progress: onProgress },
    );
  } finally {
    database.close();
  }

  verifySnapshot(resolved);
  return resolved;
}

async function main(): Promise<void> {
  const destination = process.argv[2];
  if (!destination) {
    throw new Error("Usage: node dist/backup.js <destination.db>");
  }

  const source = process.env.DATABASE_PATH ?? "data/maker.db";
  const resolved = await createVerifiedSqliteBackup({
    sourcePath: source,
    destinationPath: destination,
  });
  process.stdout.write(`${resolved}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
