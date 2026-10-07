import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { loadConfig } from '../config';
import { DatabaseService } from '../database/database.service';
import { ColumnMap, CsvFormatError, mapColumns, parseCsv } from './csv';
import { FieldError, ImportValues, readRow } from './row-validation';

const LEASE = `interval '2 minutes'`;
const POLL_MS = 1000;
const DB_CHECK_BATCH = 1000;

interface Job {
  id: string;
  account_id: string;
  mode: 'create' | 'update';
  status: 'validating' | 'importing';
  file: Buffer | null;
  processed_rows: number;
}

interface ValidRow {
  n: number; // 1-based data row
  values: ImportValues;
}

interface ChunkResult {
  created: number;
  updated: number;
  unchanged: number;
  errors: Array<{ n: number; field: string; message: string; cells: string[] }>;
}

/**
 * Background worker for CSV imports, backed by the import_jobs table (no extra infrastructure).
 *  - claims one job at a time with FOR UPDATE SKIP LOCKED + a lease, so several API instances can run workers safely
 *    and a crashed worker's job is picked up again when its lease expires;
 *  - validate phase: checks every row and records problems, writes nothing to contacts;
 *  - import phase: writes in chunks, advancing processed_rows in the same transaction as each chunk, so it is
 *    resumable and a chunk is never applied twice.
 */
@Injectable()
export class ImportsWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImportsWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(private readonly db: DatabaseService) {}

  onModuleInit() {
    if (!loadConfig().importWorkerEnabled) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.logger.error(e?.stack ?? e)), POLL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Processes jobs until the queue is empty. Used by tests so they don't depend on timers. */
  async drain(maxJobs = 20): Promise<number> {
    let done = 0;
    while (done < maxJobs && (await this.tick())) done++;
    return done;
  }

  /** Claims and runs one job. Returns false when there was nothing to do. `maxChunks` lets tests stop mid-import. */
  async tick(opts: { maxChunks?: number } = {}): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const { rows } = await this.db.query<Job>(
        `UPDATE import_jobs SET lease_until = now() + ${LEASE}, started_at = coalesce(started_at, now()), updated_at = now()
         WHERE id = (
           SELECT id FROM import_jobs
           WHERE status IN ('validating', 'importing') AND (lease_until IS NULL OR lease_until < now())
           ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         RETURNING id, account_id, mode, status, file, processed_rows`,
      );
      const job = rows[0];
      if (!job) return false;
      try {
        if (!job.file) throw new CsvFormatError('The uploaded file is no longer available');
        if (job.status === 'validating') await this.validate(job);
        else await this.runImport(job, opts.maxChunks);
      } catch (e: any) {
        const known = e instanceof CsvFormatError;
        if (!known) this.logger.error(`Import ${job.id} failed: ${e?.stack ?? e}`);
        await this.fail(job.id, known ? e.message : 'Something went wrong while processing the file. Try again.');
      }
      return true;
    } finally {
      this.busy = false;
    }
  }

  private fail(id: string, reason: string) {
    return this.db.query(
      `UPDATE import_jobs SET status = 'failed', failure_reason = $2, file = NULL, lease_until = NULL, finished_at = now(), updated_at = now()
       WHERE id = $1 AND status IN ('validating', 'importing')`,
      [id, reason],
    );
  }

  // ------------------------------------------------------------------ validate

  private async validate(job: Job) {
    const { header, rows } = parseCsv(job.file!, loadConfig().importMaxRows);
    if (!rows.length) throw new CsvFormatError('The file has a header but no data rows');
    const map = mapColumns(header, job.mode);

    const problems = new Map<number, FieldError[]>();
    const add = (n: number, field: string, message: string) => problems.set(n, [...(problems.get(n) ?? []), { field, message }]);

    const parsed = rows.map((cells, i) => ({ n: i + 1, ...readRow(job.mode, cells, map) }));
    const firstSeen = new Map<string, number>();
    for (const p of parsed) {
      p.errors.forEach((e) => add(p.n, e.field, e.message));
      const email = p.values.email;
      if (email) {
        const prior = firstSeen.get(email);
        if (prior) add(p.n, 'email', `Duplicate of row ${prior} in this file`);
        else firstSeen.set(email, p.n);
      }
    }

    // check against existing contacts (only rows that passed the static checks)
    const candidates = parsed.filter((p) => !problems.has(p.n) && p.values.email);
    const known = await this.lookupEmails(job.account_id, [...new Set(candidates.map((p) => p.values.email!))]);
    for (const p of candidates) {
      const hit = known.get(p.values.email!);
      if (job.mode === 'create' && hit?.activeName) add(p.n, 'email', `Already used by ${hit.activeName}`);
      if (job.mode === 'update' && !hit?.activeName) add(p.n, 'email', hit?.trashed ? 'This contact is in the trash' : 'No contact has this email');
    }

    const notes = map.ignored.length ? [`Ignored columns: ${map.ignored.join(', ')}`] : [];
    await this.db.tx(async (c) => {
      const flat = [...problems.entries()].flatMap(([n, list]) => list.map((e) => ({ n, ...e })));
      for (let i = 0; i < flat.length; i += 1000) {
        const part = flat.slice(i, i + 1000);
        await c.query(
          `INSERT INTO import_job_errors (job_id, row_number, phase, field, message, row_data)
           SELECT $1, n, 'validate', f, m, d::jsonb FROM unnest($2::int[], $3::text[], $4::text[], $5::text[]) AS t(n, f, m, d)`,
          [job.id, part.map((e) => e.n), part.map((e) => e.field), part.map((e) => e.message), part.map((e) => JSON.stringify(rows[e.n - 1]))],
        );
      }
      // conditional on status: a cancel that arrived while we were validating wins
      await c.query(
        `UPDATE import_jobs SET status = 'ready', header = $2, total_rows = $3, valid_rows = $4, error_rows = $5, notes = $6,
                lease_until = NULL, updated_at = now()
         WHERE id = $1 AND status = 'validating'`,
        [job.id, header, rows.length, rows.length - problems.size, problems.size, notes],
      );
    });
  }

  private async lookupEmails(accountId: string, emails: string[]) {
    const out = new Map<string, { activeName?: string; trashed?: boolean }>();
    for (let i = 0; i < emails.length; i += DB_CHECK_BATCH) {
      const { rows } = await this.db.query(
        `SELECT email, first_name, last_name, deleted_at FROM contacts WHERE account_id = $1 AND email = ANY($2::text[])`,
        [accountId, emails.slice(i, i + DB_CHECK_BATCH)],
      );
      for (const r of rows) {
        const e = out.get(r.email) ?? {};
        if (r.deleted_at) e.trashed = true;
        else e.activeName = `${r.first_name} ${r.last_name}`;
        out.set(r.email, e);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ import

  private async runImport(job: Job, maxChunks?: number) {
    const cfg = loadConfig();
    const { header, rows } = parseCsv(job.file!, cfg.importMaxRows);
    const map = mapColumns(header, job.mode);
    const rejected = new Set<number>(
      (await this.db.query(`SELECT DISTINCT row_number FROM import_job_errors WHERE job_id = $1 AND phase = 'validate'`, [job.id])).rows.map((r) => r.row_number),
    );

    let offset = job.processed_rows; // resume where the previous run stopped
    let chunks = 0;
    while (offset < rows.length) {
      if (maxChunks !== undefined && chunks >= maxChunks) {
        await this.db.query(`UPDATE import_jobs SET lease_until = NULL WHERE id = $1`, [job.id]); // hand back for the next tick
        return;
      }
      const slice = rows.slice(offset, offset + cfg.importChunkSize);
      const valid: ValidRow[] = [];
      slice.forEach((cells, i) => {
        const n = offset + i + 1;
        if (rejected.has(n)) return; // already reported during review
        const r = readRow(job.mode, cells, map);
        if (!r.errors.length) valid.push({ n, values: r.values });
      });

      await this.db.tx(async (c) => {
        const res = job.mode === 'create' ? await this.createChunk(c, job, valid, map) : await this.updateChunk(c, job, valid);
        if (res.errors.length) {
          await c.query(
            `INSERT INTO import_job_errors (job_id, row_number, phase, field, message, row_data)
             SELECT $1, n, 'import', f, m, d::jsonb FROM unnest($2::int[], $3::text[], $4::text[], $5::text[]) AS t(n, f, m, d)`,
            [job.id, res.errors.map((e) => e.n), res.errors.map((e) => e.field), res.errors.map((e) => e.message), res.errors.map((e) => JSON.stringify(rows[e.n - 1]))],
          );
        }
        await c.query(
          `UPDATE import_jobs SET processed_rows = $2, created_count = created_count + $3, updated_count = updated_count + $4,
                  unchanged_count = unchanged_count + $5, error_rows = error_rows + $6, lease_until = now() + ${LEASE}, updated_at = now()
           WHERE id = $1`,
          [job.id, offset + slice.length, res.created, res.updated, res.unchanged, new Set(res.errors.map((e) => e.n)).size],
        );
      });
      offset += slice.length;
      chunks++;
    }

    await this.db.query(
      `UPDATE import_jobs SET status = 'completed', file = NULL, lease_until = NULL, finished_at = now(), updated_at = now() WHERE id = $1`,
      [job.id],
    );
  }

  private async createChunk(c: PoolClient, job: Job, valid: ValidRow[], _map: ColumnMap): Promise<ChunkResult> {
    const res: ChunkResult = { created: 0, updated: 0, unchanged: 0, errors: [] };
    if (!valid.length) return res;
    const ids = valid.map(() => randomUUID());

    // The partial unique index is the arbiter: rows that lost a race with another writer simply don't insert.
    const ins = await c.query(
      `WITH src AS (
         SELECT * FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) AS t(id, first_name, last_name, email, phone, company)
       )
       INSERT INTO contacts (id, account_id, first_name, last_name, email, phone, company)
       SELECT id, $1, first_name, last_name, email, phone, company FROM src
       ON CONFLICT (account_id, email) WHERE email IS NOT NULL AND deleted_at IS NULL DO NOTHING
       RETURNING id`,
      [job.account_id, ids, ...(['firstName', 'lastName', 'email', 'phone', 'company'] as const).map((k) => valid.map((v) => v.values[k] ?? null))],
    );
    const inserted = new Set<string>(ins.rows.map((r) => r.id));
    const kept = valid.map((v, i) => ({ ...v, id: ids[i] })).filter((v) => inserted.has(v.id));
    valid.forEach((v, i) => {
      if (!inserted.has(ids[i])) res.errors.push({ n: v.n, field: 'email', message: 'Already used by another contact', cells: [] });
    });
    res.created = kept.length;
    if (!kept.length) return res;

    await c.query(
      `INSERT INTO contact_activity (account_id, contact_id, type, payload)
       SELECT $1, id, 'CONTACT_CREATED', $3::jsonb FROM unnest($2::uuid[]) AS id`,
      [job.account_id, kept.map((k) => k.id), JSON.stringify({ import: job.id })],
    );

    // tags: resolve each distinct name once, then link in bulk
    const wanted = new Map<string, string>(); // lower -> display name (first spelling wins)
    kept.forEach((k) => k.values.tags.forEach((t) => !wanted.has(t.toLowerCase()) && wanted.set(t.toLowerCase(), t)));
    if (wanted.size) {
      const tagIds = await this.ensureTags(c, job.account_id, [...wanted.values()]);
      const pairs = kept.flatMap((k) => k.values.tags.map((t) => ({ contact: k.id, tag: tagIds.get(t.toLowerCase())! })));
      await c.query(
        `INSERT INTO contact_tags (contact_id, tag_id) SELECT * FROM unnest($1::uuid[], $2::uuid[]) ON CONFLICT DO NOTHING`,
        [pairs.map((p) => p.contact), pairs.map((p) => p.tag.id)],
      );
      await c.query(
        `INSERT INTO contact_activity (account_id, contact_id, type, payload)
         SELECT $1, contact_id, 'TAG_ADDED', jsonb_build_object('tag', jsonb_build_object('id', tag_id, 'name', tag_name), 'import', $5::text)
         FROM unnest($2::uuid[], $3::uuid[], $4::text[]) AS t(contact_id, tag_id, tag_name)`,
        [job.account_id, pairs.map((p) => p.contact), pairs.map((p) => p.tag.id), pairs.map((p) => p.tag.name), job.id],
      );
    }
    return res;
  }

  private async updateChunk(c: PoolClient, job: Job, valid: ValidRow[]): Promise<ChunkResult> {
    const res: ChunkResult = { created: 0, updated: 0, unchanged: 0, errors: [] };
    if (!valid.length) return res;

    const found = await c.query(
      `SELECT * FROM contacts WHERE account_id = $1 AND deleted_at IS NULL AND email = ANY($2::text[]) FOR UPDATE`,
      [job.account_id, valid.map((v) => v.values.email)],
    );
    const byEmail = new Map<string, any>(found.rows.map((r) => [r.email, r]));
    const tagCache = new Map<string, { id: string; name: string }>();

    for (const v of valid) {
      const cur = byEmail.get(v.values.email!);
      if (!cur) {
        res.errors.push({ n: v.n, field: 'email', message: 'No contact has this email', cells: [] });
        continue;
      }
      const cols = { firstName: 'first_name', lastName: 'last_name', phone: 'phone', company: 'company' } as const;
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const key of Object.keys(cols) as Array<keyof typeof cols>) {
        const next = v.values[key];
        if (next === undefined || next === cur[cols[key]]) continue;
        changes[key] = { from: cur[cols[key]], to: next };
        params.push(next);
        sets.push(`${cols[key]} = $${params.length}`);
      }
      let touched = false;
      if (sets.length) {
        params.push(cur.id);
        const up = await c.query(
          `UPDATE contacts SET ${sets.join(', ')}, version = version + 1, updated_at = now() WHERE id = $${params.length} RETURNING version`,
          params,
        );
        await c.query(
          `INSERT INTO contact_activity (account_id, contact_id, type, payload) VALUES ($1, $2, 'CONTACT_UPDATED', $3::jsonb)`,
          [job.account_id, cur.id, JSON.stringify({ changes, version: up.rows[0].version, import: job.id })],
        );
        touched = true;
      }
      for (const name of v.values.tags) {
        let tag = tagCache.get(name.toLowerCase());
        if (!tag) {
          tag = { id: (await this.ensureTags(c, job.account_id, [name])).get(name.toLowerCase())!.id, name };
          const real = await c.query(`SELECT name FROM tags WHERE id = $1`, [tag.id]);
          tag.name = real.rows[0].name;
          tagCache.set(name.toLowerCase(), tag);
        }
        const link = await c.query(`INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING contact_id`, [cur.id, tag.id]);
        if (link.rowCount) {
          await c.query(
            `INSERT INTO contact_activity (account_id, contact_id, type, payload) VALUES ($1, $2, 'TAG_ADDED', $3::jsonb)`,
            [job.account_id, cur.id, JSON.stringify({ tag, import: job.id })],
          );
          touched = true;
        }
      }
      touched ? res.updated++ : res.unchanged++;
    }
    return res;
  }

  /** Find-or-create tags (case-insensitive per account); returns lower-name -> {id, name}. */
  private async ensureTags(c: PoolClient, accountId: string, names: string[]) {
    await c.query(
      `INSERT INTO tags (account_id, name) SELECT $1, n FROM unnest($2::text[]) AS n ON CONFLICT (account_id, lower(name)) DO NOTHING`,
      [accountId, names],
    );
    const { rows } = await c.query(`SELECT id, name FROM tags WHERE account_id = $1 AND lower(name) = ANY($2::text[])`, [
      accountId,
      names.map((n) => n.toLowerCase()),
    ]);
    return new Map<string, { id: string; name: string }>(rows.map((r) => [r.name.toLowerCase(), r]));
  }
}
