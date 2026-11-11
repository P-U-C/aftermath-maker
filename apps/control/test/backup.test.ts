import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
