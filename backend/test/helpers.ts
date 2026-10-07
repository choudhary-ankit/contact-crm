// Must be set before AppModule/config is evaluated by the app.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://crm:crm@localhost:5432/crm_test';
process.env.AUTO_MIGRATE = 'true';
process.env.RATE_LIMIT_PER_MIN ??= '100000';
process.env.WRITE_RATE_LIMIT_PER_MIN ??= '100000';
// tests drive the import worker directly (worker.drain()) instead of waiting on its timer
process.env.IMPORT_WORKER_ENABLED = 'false';
process.env.METRICS_CACHE_TTL_MS = '0';
process.env.IMPORT_CHUNK_SIZE ??= '500';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { setupApp } from '../src/setup-app';

export const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
export const ACCOUNT_B = '22222222-2222-4222-8222-222222222222';
export const KEY_A = 'demo-key';
export const KEY_B = 'demo-key-2';

export async function createApp(): Promise<{ app: INestApplication; db: DatabaseService }> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  setupApp(app);
  await app.init();
  return { app, db: app.get(DatabaseService) };
}

export const resetDb = (db: DatabaseService) =>
  db.query('TRUNCATE import_job_errors, import_jobs, contact_activity, contact_tags, tags, contacts CASCADE');

export interface SeedContact {
  first: string;
  last: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  createdAt?: string;
  deletedAt?: string;
  updatedAt?: string;
  account?: string;
}

export async function insertContact(db: DatabaseService, c: SeedContact): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO contacts (account_id, first_name, last_name, email, phone, company, created_at, updated_at, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()), coalesce($8::timestamptz, $7::timestamptz, now()), $9::timestamptz) RETURNING id`,
    [c.account ?? ACCOUNT_A, c.first, c.last, c.email ?? null, c.phone ?? null, c.company ?? null, c.createdAt ?? null, c.updatedAt ?? null, c.deletedAt ?? null],
  );
  return rows[0].id;
}

/** supertest agent pre-authenticated as the given key. */
export const api = (app: INestApplication, key = KEY_A) => ({
  get: (url: string) => request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${key}`),
  post: (url: string) => request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${key}`),
  patch: (url: string) => request(app.getHttpServer()).patch(url).set('Authorization', `Bearer ${key}`),
  delete: (url: string) => request(app.getHttpServer()).delete(url).set('Authorization', `Bearer ${key}`),
});
