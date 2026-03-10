import { afterEach, expect, test, describe } from "bun:test";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createSnapshot, restoreSnapshot, discardSnapshot, type DBSnapshot } from "../src/db-snapshot.ts";
import { cleanupDir, makeTempDir } from "./test-utils.ts";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length) {
    cleanupDir(tempPaths.pop()!);
  }
});

function createTestDir(): string {
  const dir = makeTempDir("db-snap-");
  tempPaths.push(dir);
  return dir;
}

function createTestDB(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");
  db.exec("INSERT INTO test (value) VALUES ('original')");
  db.close();
}

describe("DB Snapshot", () => {
  test("snapshot captures all .db files in repo", async () => {
    const dir = createTestDir();
    const dbPath = join(dir, "test.db");
    createTestDB(dbPath);

    const snapshot = await createSnapshot({ repoPath: dir });

    expect(snapshot.files.length).toBe(1);
    expect(snapshot.files[0].originalPath).toBe(dbPath);
    expect(existsSync(snapshot.files[0].snapshotPath)).toBe(true);
    expect(snapshot.files[0].sizeBytes).toBeGreaterThan(0);

    await discardSnapshot(snapshot);
  });

  test("restore rollbacks DB changes", async () => {
    const dir = createTestDir();
    const dbPath = join(dir, "test.db");
    createTestDB(dbPath);

    // Snapshot the original state
    const snapshot = await createSnapshot({ repoPath: dir });

    // Modify the database
    const db = new Database(dbPath);
    db.exec("INSERT INTO test (value) VALUES ('modified')");
    db.exec("UPDATE test SET value = 'changed' WHERE id = 1");
    db.close();

    // Verify modification happened
    const dbBefore = new Database(dbPath, { readonly: true });
    const rows = dbBefore.prepare("SELECT value FROM test WHERE id = 1").get() as { value: string };
    expect(rows.value).toBe("changed");
    dbBefore.close();

    // Restore snapshot
    await restoreSnapshot(snapshot);

    // Verify original state restored
    const dbAfter = new Database(dbPath, { readonly: true });
    const restored = dbAfter.prepare("SELECT value FROM test WHERE id = 1").get() as { value: string };
    expect(restored.value).toBe("original");

    const count = dbAfter.prepare("SELECT COUNT(*) AS c FROM test").get() as { c: number };
    expect(count.c).toBe(1); // the "modified" row is gone
    dbAfter.close();

    await discardSnapshot(snapshot);
  });

  test("WAL checkpointed before copy", async () => {
    const dir = createTestDir();
    const dbPath = join(dir, "test.db");

    // Create DB in WAL mode (bun:sqlite default)
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)");
    db.exec("INSERT INTO test (value) VALUES ('wal-data')");
    db.close();

    const snapshot = await createSnapshot({ repoPath: dir });
    expect(snapshot.files.length).toBe(1);

    // Verify snapshot captured the data
    const snapDb = new Database(snapshot.files[0].snapshotPath, { readonly: true });
    const row = snapDb.prepare("SELECT value FROM test WHERE id = 1").get() as { value: string };
    expect(row.value).toBe("wal-data");
    snapDb.close();

    await discardSnapshot(snapshot);
  });

  test("snapshot of empty repo = no-op", async () => {
    const dir = createTestDir();

    const snapshot = await createSnapshot({ repoPath: dir });

    expect(snapshot.files.length).toBe(0);
    expect(snapshot.snapshotDir).toBe("");

    // Discard is a no-op
    await discardSnapshot(snapshot);
  });

  test("discard cleans up snapshot files", async () => {
    const dir = createTestDir();
    const dbPath = join(dir, "test.db");
    createTestDB(dbPath);

    const snapshot = await createSnapshot({ repoPath: dir });
    expect(existsSync(snapshot.snapshotDir)).toBe(true);

    await discardSnapshot(snapshot);
    expect(existsSync(snapshot.snapshotDir)).toBe(false);
  });

  test("snapshot handles multiple DB files", async () => {
    const dir = createTestDir();
    createTestDB(join(dir, "alpha.db"));
    createTestDB(join(dir, "beta.sqlite"));

    const snapshot = await createSnapshot({ repoPath: dir });
    expect(snapshot.files.length).toBe(2);

    const names = snapshot.files.map(f => f.originalPath);
    expect(names.some(n => n.includes("alpha.db"))).toBe(true);
    expect(names.some(n => n.includes("beta.sqlite"))).toBe(true);

    await discardSnapshot(snapshot);
  });

  test("snapshot with specific dbPaths", async () => {
    const dir = createTestDir();
    const specificDb = join(dir, "specific.db");
    createTestDB(specificDb);
    createTestDB(join(dir, "ignored.db"));

    const snapshot = await createSnapshot({
      repoPath: dir,
      dbPaths: [specificDb],
    });

    expect(snapshot.files.length).toBe(1);
    expect(snapshot.files[0].originalPath).toBe(specificDb);

    await discardSnapshot(snapshot);
  });

  test("snapshot handles locked DB gracefully", async () => {
    const dir = createTestDir();
    const dbPath = join(dir, "test.db");
    createTestDB(dbPath);

    // Open a connection (simulates lock)
    const db = new Database(dbPath);

    // Snapshot should still work (best-effort WAL checkpoint)
    const snapshot = await createSnapshot({ repoPath: dir });
    expect(snapshot.files.length).toBe(1);

    db.close();
    await discardSnapshot(snapshot);
  });

  test("restore to different target path", async () => {
    const dir = createTestDir();
    const dbPath = join(dir, "data.db");
    createTestDB(dbPath);

    const snapshot = await createSnapshot({ repoPath: dir });

    // Create a target directory
    const targetDir = makeTempDir("db-snap-target-");
    tempPaths.push(targetDir);

    await restoreSnapshot(snapshot, targetDir);

    // Verify the DB was restored to the target
    const targetDb = join(targetDir, "data.db");
    expect(existsSync(targetDb)).toBe(true);

    const db = new Database(targetDb, { readonly: true });
    const row = db.prepare("SELECT value FROM test WHERE id = 1").get() as { value: string };
    expect(row.value).toBe("original");
    db.close();

    await discardSnapshot(snapshot);
  });
});
