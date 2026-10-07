import { Injectable } from '@nestjs/common';
import { ApiError, notFound } from '../common/api-error';
import { DatabaseService } from '../database/database.service';
import { toCsvLine } from './csv';

const JOB_COLUMNS = `id, mode, filename, status, total_rows, valid_rows, error_rows, processed_rows, created_count, updated_count,
  unchanged_count, notes, failure_reason, created_at, started_at, finished_at`;

export interface ImportJobView {
  id: string;
  mode: 'create' | 'update';
  filename: string;
  status: 'validating' | 'ready' | 'importing' | 'completed' | 'failed' | 'cancelled';
  totalRows: number | null;
  validRows: number | null;
  errorRows: number;
  processedRows: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  notes: string[];
  failureReason: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

const toView = (r: any): ImportJobView => ({
  id: r.id,
  mode: r.mode,
  filename: r.filename,
  status: r.status,
  totalRows: r.total_rows,
  validRows: r.valid_rows,
  errorRows: r.error_rows,
  processedRows: r.processed_rows,
  createdCount: r.created_count,
  updatedCount: r.updated_count,
  unchangedCount: r.unchanged_count,
  notes: r.notes ?? [],
  failureReason: r.failure_reason,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

@Injectable()
export class ImportsService {
  constructor(private readonly db: DatabaseService) {}

  async createJob(accountId: string, mode: 'create' | 'update', filename: string, file: Buffer): Promise<ImportJobView> {
    const { rows } = await this.db.query(
      `INSERT INTO import_jobs (account_id, mode, filename, status, file) VALUES ($1, $2, $3, 'validating', $4) RETURNING ${JOB_COLUMNS}`,
      [accountId, mode, filename.slice(0, 200), file],
    );
    return toView(rows[0]);
  }

  async list(accountId: string, limit: number): Promise<ImportJobView[]> {
    const { rows } = await this.db.query(
      `SELECT ${JOB_COLUMNS} FROM import_jobs WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [accountId, limit],
    );
    return rows.map(toView);
  }

  async get(accountId: string, id: string): Promise<ImportJobView> {
    const { rows } = await this.db.query(`SELECT ${JOB_COLUMNS} FROM import_jobs WHERE id = $1 AND account_id = $2`, [id, accountId]);
    if (!rows[0]) throw notFound('Import');
    return toView(rows[0]);
  }

  async errors(accountId: string, id: string, limit: number, offset: number) {
    await this.get(accountId, id);
    const [{ rows }, count] = await Promise.all([
      this.db.query(
        `SELECT row_number, phase, field, message FROM import_job_errors WHERE job_id = $1 ORDER BY row_number, id LIMIT $2 OFFSET $3`,
        [id, limit, offset],
      ),
      this.db.query(`SELECT count(*)::int AS n FROM import_job_errors WHERE job_id = $1`, [id]),
    ]);
    return {
      data: rows.map((r) => ({ row: r.row_number, phase: r.phase, field: r.field, message: r.message })),
      total: count.rows[0].n as number,
    };
  }

  /** The rejected rows exactly as uploaded + an `error` column, ready to fix and upload again. */
  async errorsCsv(accountId: string, id: string): Promise<{ filename: string; body: string }> {
    const { rows: jobs } = await this.db.query(`SELECT filename, header FROM import_jobs WHERE id = $1 AND account_id = $2`, [id, accountId]);
    if (!jobs[0]) throw notFound('Import');
    const header: string[] = jobs[0].header ?? [];
    const { rows } = await this.db.query(
      `SELECT row_number, (array_agg(row_data))[1] AS row_data, string_agg(coalesce(field || ': ', '') || message, '; ' ORDER BY id) AS reasons
       FROM import_job_errors WHERE job_id = $1 GROUP BY row_number ORDER BY row_number`,
      [id],
    );
    const width = Math.max(header.length, ...rows.map((r) => (r.row_data as string[]).length), 0);
    let body = toCsvLine([...Array.from({ length: width }, (_, i) => header[i] ?? ''), 'error']);
    for (const r of rows) {
      const cells = r.row_data as string[];
      body += toCsvLine([...Array.from({ length: width }, (_, i) => cells[i] ?? ''), r.reasons]);
    }
    return { filename: `${jobs[0].filename.replace(/\.csv$/i, '')}-errors.csv`, body };
  }

  /** ready -> importing. The worker picks it up on its next poll. */
  async confirm(accountId: string, id: string): Promise<ImportJobView> {
    const { rows } = await this.db.query(
      `UPDATE import_jobs SET status = 'importing', lease_until = NULL, updated_at = now()
       WHERE id = $1 AND account_id = $2 AND status = 'ready' AND valid_rows > 0 RETURNING ${JOB_COLUMNS}`,
      [id, accountId],
    );
    if (rows[0]) return toView(rows[0]);
    const job = await this.get(accountId, id); // 404 if it isn't yours
    if (job.status === 'ready') throw new ApiError(409, 'NOTHING_TO_IMPORT', 'There are no valid rows to import');
    throw new ApiError(409, 'IMPORT_NOT_READY', `This import is ${job.status}, so it can't be started`);
  }

  /** Allowed until the import starts writing. */
  async cancel(accountId: string, id: string): Promise<ImportJobView> {
    const { rows } = await this.db.query(
      `UPDATE import_jobs SET status = 'cancelled', file = NULL, lease_until = NULL, finished_at = now(), updated_at = now()
       WHERE id = $1 AND account_id = $2 AND status IN ('validating', 'ready') RETURNING ${JOB_COLUMNS}`,
      [id, accountId],
    );
    if (rows[0]) return toView(rows[0]);
    const job = await this.get(accountId, id);
    throw new ApiError(409, 'IMPORT_NOT_CANCELLABLE', `This import is ${job.status}, so it can't be cancelled`);
  }
}
