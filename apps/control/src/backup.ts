import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

const source = process.env.DATABASE_PATH ?? "data/maker.db";
const destination = process.argv[2];

if (!destination) {
  throw new Error("Usage: node dist/backup.js <destination.db>");
}

const resolved = resolve(destination);
mkdirSync(dirname(resolved), { recursive: true });
const database = new Database(source, { readonly: true, fileMustExist: true });

try {
  await database.backup(resolved);
} finally {
  database.close();
}

const snapshot = new Database(resolved, {
  readonly: true,
  fileMustExist: true,
});
try {
  const integrity = snapshot.pragma("quick_check", { simple: true });
  if (integrity !== "ok") {
    throw new Error(
      `SQLite backup integrity check failed: ${String(integrity)}`,
    );
  }
} finally {
  snapshot.close();
}

process.stdout.write(`${resolved}\n`);
