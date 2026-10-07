import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { loadConfig } from '../config';
import { runMigrations } from './migrate';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool: Pool;

  constructor() {
    this.pool = new Pool({ connectionString: loadConfig().databaseUrl, max: 10 });
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
