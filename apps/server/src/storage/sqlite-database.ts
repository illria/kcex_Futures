import { chmod, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MigrationRunner, type StorageMigration } from "./migrations.js";

export interface SQLiteDatabaseOptions {
  fileName?: string;
  migrations?: readonly StorageMigration[];
}

export class SQLiteDatabase {
  private connection: DatabaseSync | null = null;
  private schemaVersion = 0;

  constructor(private readonly options: SQLiteDatabaseOptions = {}) {}

  get isOpen(): boolean {
    return this.connection !== null;
  }

  async initialize(): Promise<number> {
    if (this.connection) return this.schemaVersion;
    const fileName = this.resolveFileName();
    if (fileName !== ":memory:") {
      await preparePrivateDatabaseFile(fileName, !this.hasCustomFileName());
    }

    const database = new DatabaseSync(fileName);
    try {
      database.exec("PRAGMA foreign_keys = ON;");
      database.exec("PRAGMA journal_mode = WAL;");
      database.exec("PRAGMA synchronous = NORMAL;");
      database.exec("PRAGMA busy_timeout = 5000;");
      const runner = new MigrationRunner(database, this.options.migrations);
      this.schemaVersion = runner.run();
      if (fileName !== ":memory:") await chmodExistingSqliteSidecars(fileName);
      this.connection = database;
      return this.schemaVersion;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  getConnection(): DatabaseSync {
    if (!this.connection) throw new Error("TRADING_STORAGE_NOT_INITIALIZED");
    return this.connection;
  }

  getSchemaVersion(): number {
    return this.schemaVersion;
  }

  close(): void {
    const database = this.connection;
    this.connection = null;
    if (database) database.close();
  }

  private resolveFileName(): string {
    if (this.options.fileName === ":memory:") return ":memory:";
    const configured = this.configuredFileName();
    return configured ? resolve(configured) : resolve(process.cwd(), "data/trading.sqlite3");
  }

  private hasCustomFileName(): boolean {
    return Boolean(this.configuredFileName());
  }

  private configuredFileName(): string | undefined {
    return this.options.fileName ?? process.env.TRADING_DB_FILE?.trim();
  }
}

async function preparePrivateDatabaseFile(fileName: string, appManagedDirectory: boolean): Promise<void> {
  const directory = dirname(fileName);
  const createdDirectory = await mkdir(directory, { recursive: true, mode: 0o700 });
  if (appManagedDirectory || createdDirectory) {
    await chmod(directory, 0o700).catch(() => undefined);
  }

  const handle = await open(fileName, "a", 0o600);
  await handle.close();
  await chmod(fileName, 0o600).catch(() => undefined);
}

async function chmodExistingSqliteSidecars(fileName: string): Promise<void> {
  await Promise.all([
    chmod(`${fileName}-wal`, 0o600).catch(() => undefined),
    chmod(`${fileName}-shm`, 0o600).catch(() => undefined),
  ]);
}
