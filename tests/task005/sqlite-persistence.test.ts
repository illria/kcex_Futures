import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StorageService } from "../../apps/server/src/storage/storage-service.js";
import { plannedTradeInput } from "./storage-test-helpers.js";

describe("SQLite file lifecycle", () => {
  const opened: StorageService[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    for (const storage of opened.splice(0)) storage.close();
    for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  it("persists validated records across close and reopen and sets private file modes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kcex-trading-storage-"));
    temporaryDirectories.push(directory);
    const fileName = join(directory, "trading.sqlite3");
    const storage = new StorageService({ databaseFile: fileName });
    opened.push(storage);
    await storage.initialize();

    const directoryMode = (await stat(directory)).mode & 0o777;
    const fileMode = (await stat(fileName)).mode & 0o777;
    expect(directoryMode).toBe(0o700);
    expect(fileMode).toBe(0o600);

    const trade = storage.trades.createTrade(plannedTradeInput({ quantity: 7, entryPrice: 0.02 }));
    const filesWhileOpen = await readdir(directory);
    for (const sidecar of ["trading.sqlite3-wal", "trading.sqlite3-shm"]) {
      if (filesWhileOpen.includes(sidecar)) {
        expect((await stat(join(directory, sidecar))).mode & 0o777).toBe(0o600);
      }
    }
    storage.close();
    storage.close();

    const reopened = new StorageService({ databaseFile: fileName });
    opened.push(reopened);
    await reopened.initialize();
    expect(reopened.getSchemaVersion()).toBe(1);
    expect(reopened.trades.getTrade(trade.id)).toEqual(trade);
    expect(reopened.getRecentTradeHistory()).toHaveLength(1);

    const files = await readdir(directory);
    expect(files).toContain("trading.sqlite3");
    reopened.close();
  });

  it("preserves permissions on an existing custom parent and protects the database file", async () => {
    const parent = await mkdtemp(join(tmpdir(), "kcex-custom-parent-"));
    temporaryDirectories.push(parent);
    await chmod(parent, 0o755);
    const fileName = join(parent, "trading.sqlite3");
    const storage = new StorageService({ databaseFile: fileName });
    opened.push(storage);
    await storage.initialize();

    expect((await stat(parent)).mode & 0o777).toBe(0o755);
    expect((await stat(fileName)).mode & 0o777).toBe(0o600);
  });

  it("creates missing custom nested directories with private permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "kcex-custom-nested-"));
    temporaryDirectories.push(root);
    const parent = join(root, "new-parent", "nested");
    const fileName = join(parent, "trading.sqlite3");
    const storage = new StorageService({ databaseFile: fileName });
    opened.push(storage);
    await storage.initialize();

    expect((await stat(join(root, "new-parent"))).mode & 0o777).toBe(0o700);
    expect((await stat(parent)).mode & 0o777).toBe(0o700);
    expect((await stat(fileName)).mode & 0o777).toBe(0o600);
  });
});
