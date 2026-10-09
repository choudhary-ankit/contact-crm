import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { loadConfig } from '../config';
import { runMigrations } from './migrate';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool: Pool;

  constructor() {
    const cfg = loadConfig();
    this.pool = new Pool({
      connectionString: cfg.databaseUrl,
      max: cfg.dbPoolMax,
      // A request that cannot get a connection fails fast (503) instead of waiting forever behind a backlog.
      connectionTimeoutMillis: cfg.dbConnectTimeoutMs,
      // Postgres cancels any single statement that runs this long, so a runaway query cannot hold a connection forever.
      statement_timeout: cfg.dbStatementTimeoutMs > 0 ? cfg.dbStatementTimeoutMs : undefined,
    });
  }

  async onModuleInit() {
    if (loadConfig().autoMigrate) {
      const applied = await runMigrations(this.pool);
      if (applied.length) this.logger.log(`Applied migrations: ${applied.join(', ')}`);
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  query<T extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params as any[]);
  }

  /** Runs fn inside a transaction; rolls back and rethrows on any error. */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
