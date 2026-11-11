import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  createVerifiedSqliteBackup,
  verifySqliteBackup,
} from "../src/backup.js";

function temporaryDirectory(): string {
  const directory = join(
    tmpdir(),
    `aftermath-maker-backup-${randomBytes(8).toString("hex")}`,
  );
  mkdirSync(directory, { recursive: true });
  return directory;
}

const backupSourcePath = fileURLToPath(
  new URL("../src/backup.ts", import.meta.url),
);

describe("SQLite backups", () => {
  it("creates a verified SQLite online backup without stopping the source database", async () => {
    const directory = temporaryDirectory();
    const sourcePath = join(directory, "source.db");
    const destinationPath = join(directory, "snapshot.db");
    const source = new Database(sourcePath);
    source.pragma("journal_mode = WAL");
    source.exec("CREATE TABLE entries (value TEXT NOT NULL)");
    source.prepare("INSERT INTO entries (value) VALUES (?)").run("before");

    let wroteWhileBackingUp = false;
    const backupPath = await createVerifiedSqliteBackup({
      sourcePath,
      destinationPath,
      onProgress: () => {
        if (!wroteWhileBackingUp) {
          source
            .prepare("INSERT INTO entries (value) VALUES (?)")
            .run("during");
          wroteWhileBackingUp = true;
        }
        return 100;
      },
    });

    expect(wroteWhileBackingUp).toBe(true);
    expect(
      source.prepare("SELECT value FROM entries ORDER BY rowid").all(),
    ).toEqual([{ value: "before" }, { value: "during" }]);
    source.prepare("INSERT INTO entries (value) VALUES (?)").run("after");
    expect(
      source.prepare("SELECT COUNT(*) AS count FROM entries").get(),
    ).toEqual({
      count: 3,
    });

    const snapshot = new Database(backupPath, { readonly: true });
    expect(snapshot.pragma("quick_check", { simple: true })).toBe("ok");
    expect(
      snapshot.prepare("SELECT value FROM entries ORDER BY rowid").all(),
    ).toEqual(expect.arrayContaining([{ value: "before" }]));
    snapshot.close();
    source.close();

    const invalidSnapshotPath = join(directory, "invalid.db");
    writeFileSync(invalidSnapshotPath, "not a SQLite database");
    expect(() => verifySqliteBackup(invalidSnapshotPath)).toThrow(
      "SQLite backup integrity check failed",
    );
  });

  it("fails closed when quick_check reports corruption for a valid copied snapshot", async () => {
    const directory = temporaryDirectory();
    const sourcePath = join(directory, "source.db");
    const destinationPath = join(directory, "snapshot.db");
    const source = new Database(sourcePath);
    source.exec("CREATE TABLE entries (value TEXT NOT NULL)");
    source.prepare("INSERT INTO entries (value) VALUES (?)").run("before");
    source.close();

    let verifiedPath: string | undefined;
    await expect(
      createVerifiedSqliteBackup(
        { sourcePath, destinationPath },
        (snapshotPath) => {
          verifiedPath = snapshotPath;
          verifySqliteBackup(snapshotPath, (snapshot) => {
            expect(snapshot.pragma("quick_check", { simple: true })).toBe("ok");
            return "*** in database main ***";
          });
        },
      ),
    ).rejects.toThrow("SQLite backup integrity check failed");

    expect(verifiedPath).toBe(resolve(destinationPath));
    const snapshot = new Database(destinationPath, { readonly: true });
    expect(snapshot.pragma("quick_check", { simple: true })).toBe("ok");
    snapshot.close();
  });

  it("uses DATABASE_PATH and prints the destination when run as a CLI", () => {
    const directory = temporaryDirectory();
    const sourcePath = join(directory, "source.db");
    const destinationPath = join(directory, "snapshot.db");
    const source = new Database(sourcePath);
    source.exec("CREATE TABLE entries (value TEXT NOT NULL)");
    source.prepare("INSERT INTO entries (value) VALUES (?)").run("from-cli");
    source.close();

    const completed = spawnSync(
      process.execPath,
      ["--import", "tsx", backupSourcePath, destinationPath],
      {
        encoding: "utf8",
        env: { ...process.env, DATABASE_PATH: sourcePath },
      },
    );

    expect(completed.status).toBe(0);
    expect(completed.stderr).toBe("");
    expect(completed.stdout).toBe(`${resolve(destinationPath)}\n`);

    const missingDestination = spawnSync(
      process.execPath,
      ["--import", "tsx", backupSourcePath],
      { encoding: "utf8", env: { ...process.env, DATABASE_PATH: sourcePath } },
    );
    expect(missingDestination.status).not.toBe(0);
    expect(missingDestination.stderr).toContain(
      "Usage: node dist/backup.js <destination.db>",
    );
  });
});
