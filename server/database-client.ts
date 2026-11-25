import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

export interface StatementResult {
  changes: number;
}

export interface Statement {
  get(...params: unknown[]): Promise<Record<string, unknown> | undefined>;
  all(...params: unknown[]): Promise<Record<string, unknown>[]>;
  run(...params: unknown[]): Promise<StatementResult>;
}

export interface DatabaseClient {
  readonly kind: 'sqlite' | 'postgres';
  readonly dbPath: string;
  connect(): void | Promise<void>;
  prepare(sql: string): Statement;
  exec(sql: string): Promise<void>;
  close(): void | Promise<void>;
}

class SQLiteStatement implements Statement {
  constructor(private readonly statement: ReturnType<DatabaseSync['prepare']>) {}

  async get(...params: unknown[]): Promise<Record<string, unknown> | undefined> {
    return this.statement.get(...(params as never[])) as Record<string, unknown> | undefined;
  }

  async all(...params: unknown[]): Promise<Record<string, unknown>[]> {
    return this.statement.all(...(params as never[])) as Record<string, unknown>[];
  }

  async run(...params: unknown[]): Promise<StatementResult> {
    const result = this.statement.run(...(params as never[]));
    return { changes: Number(result.changes) };
  }
}

class SQLiteClient implements DatabaseClient {
  readonly kind = 'sqlite' as const;

  constructor(private readonly db: DatabaseSync, readonly dbPath: string) {}

  connect(): void {}

  prepare(sql: string): Statement {
    return new SQLiteStatement(this.db.prepare(sql));
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

function toPostgresSql(sql: string): { sql: string; conflictIgnore: boolean } {
  let conflictIgnore = false;
  let converted = sql;
  if (/\bINSERT\s+OR\s+IGNORE\b/i.test(converted)) {
    conflictIgnore = true;
    converted = converted.replace(/\bINSERT\s+OR\s+IGNORE\b/i, 'INSERT');
  }
  converted = converted.replace(/\bBEGIN\s+IMMEDIATE\b/i, 'BEGIN');
  let index = 0;
  converted = converted.replace(/\?/g, () => `$${++index}`);
  if (conflictIgnore) {
    converted = `${converted.trim().replace(/;\s*$/, '')} ON CONFLICT DO NOTHING`;
  }
  return { sql: converted, conflictIgnore };
}

class PostgresStatement implements Statement {
  constructor(
    private readonly client: pg.Client,
    private readonly sql: string,
  ) {}

  private async execute(params: unknown[]): Promise<pg.QueryResult> {
    const converted = toPostgresSql(this.sql);
    return this.client.query(converted.sql, params);
  }

  async get(...params: unknown[]): Promise<Record<string, unknown> | undefined> {
    const result = await this.execute(params);
    return result.rows[0] as Record<string, unknown> | undefined;
  }

  async all(...params: unknown[]): Promise<Record<string, unknown>[]> {
    const result = await this.execute(params);
    return result.rows as Record<string, unknown>[];
  }

  async run(...params: unknown[]): Promise<StatementResult> {
    const result = await this.execute(params);
    return { changes: result.rowCount ?? 0 };
  }
}

class PostgresClient implements DatabaseClient {
  readonly kind = 'postgres' as const;

  constructor(
    private readonly client: pg.Client,
    readonly dbPath: string,
  ) {}

  async connect(): Promise<void> {
    await this.client.connect();
  }

  prepare(sql: string): Statement {
    return new PostgresStatement(this.client, sql);
  }

  async exec(sql: string): Promise<void> {
    if (/^\s*PRAGMA\b/i.test(sql)) return;
    await this.client.query(toPostgresSql(sql).sql);
  }

  close(): Promise<void> {
    return this.client.end();
  }
}

export function createDatabaseClient(options?: {
  dbPath?: string | null;
}): DatabaseClient {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl && databaseUrl.trim()) {
    return new PostgresClient(new pg.Client({ connectionString: databaseUrl }), databaseUrl);
  }

  const resolvedDbPath =
    options && 'dbPath' in options
      ? options.dbPath || ':memory:'
      : path.resolve(process.cwd(), process.env.FLOWMAIL_DB_PATH || path.join('.data', 'mailbox.db'));

  if (resolvedDbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });
  }

  const db = new DatabaseSync(resolvedDbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (resolvedDbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
  }
  return new SQLiteClient(db, resolvedDbPath);
}
