import { Injectable } from '@nestjs/common';
import { NO_CONTACT_INFO, STALE, STALE_DAYS, UNTAGGED } from '../contacts/attention';
import { loadConfig } from '../config';
import { DatabaseService } from '../database/database.service';

export const RANGES = [7, 30, 90] as const;
export type Range = (typeof RANGES)[number];

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

interface Entry {
  at: number;
  value: unknown;
}

@Injectable()
export class MetricsService {
  private cache = new Map<string, Entry>();
  /** computations currently running, so concurrent requests share one instead of each starting their own */
  private inflight = new Map<string, Promise<unknown>>();
  private running = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly db: DatabaseService) {}

  /**
   * All dashboard numbers in one payload. Computing them is expensive (full scans of the contacts table), so:
   *  - fresh cache entries are served as they are;
   *  - concurrent requests for the same numbers share ONE computation (single flight), instead of every request
   *    starting its own the moment the cache expires, which can saturate the database (a "cache stampede");
   *  - an expired entry is still served immediately (up to METRICS_MAX_STALE_MS) while exactly one refresh runs;
   *  - only a few computations may run at once overall, whatever the mix of accounts and periods.
   * At very large scale this becomes incrementally maintained rollups (see README).
   */
  async get(accountId: string, range: Range) {
    const { metricsCacheTtlMs: ttl, metricsMaxStaleMs: maxStale } = loadConfig();
    const key = `${accountId}:${range}`;
    const hit = this.cache.get(key);
    const age = hit ? Date.now() - hit.at : Infinity;

    if (ttl > 0 && hit && age < ttl) return hit.value; // fresh

    const refresh = this.refresh(key, accountId, range, ttl);
    if (ttl > 0 && hit && age < maxStale) {
      refresh.catch(() => undefined); // keep serving the old numbers; a failed refresh will be retried by the next request
      return hit.value;
    }
    return refresh;
  }

  private refresh(key: string, accountId: string, range: Range, ttl: number): Promise<unknown> {
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.limited(() => this.compute(accountId, range))
      .then((value) => {
        if (ttl > 0) this.cache.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** A tiny semaphore. A finishing computation hands its slot straight to the next waiter, so the limit is never exceeded. */
  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running < loadConfig().metricsMaxConcurrent) this.running++;
    else await new Promise<void>((resolve) => this.waiters.push(resolve)); // resumes already holding a slot
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.running--;
    }
  }

  private async compute(accountId: string, range: Range) {
    // UTC calendar days: [today - (range-1) .. today]
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const start = new Date(today.getTime() - (range - 1) * 86_400_000);
    const q = (text: string, params: unknown[]) => this.db.query(text, params).then((r) => r.rows);

    const [[agg], createdByDay, editsByDay, activity, tags, [dup], [trash], [imports]] = await Promise.all([
      q(
        `SELECT count(*)::int AS active,
                count(*) FILTER (WHERE c.created_at >= $2::timestamptz)::int AS new_in_range,
                count(*) FILTER (WHERE c.created_at >= $3::timestamptz AND c.created_at < $2::timestamptz)::int AS new_prev,
                count(*) FILTER (WHERE c.email IS NOT NULL)::int AS with_email,
                count(*) FILTER (WHERE c.phone IS NOT NULL)::int AS with_phone,
                count(*) FILTER (WHERE c.company IS NOT NULL)::int AS with_company,
                count(*) FILTER (WHERE ${NO_CONTACT_INFO})::int AS no_contact,
                count(*) FILTER (WHERE ${UNTAGGED})::int AS untagged,
                count(*) FILTER (WHERE ${STALE})::int AS stale
         FROM contacts c WHERE c.account_id = $1 AND c.deleted_at IS NULL`,
        [accountId, start.toISOString(), new Date(start.getTime() - range * 86_400_000).toISOString()],
      ),
      q(
        `SELECT (created_at AT TIME ZONE 'UTC')::date::text AS d, count(*)::int AS n FROM contacts
         WHERE account_id = $1 AND deleted_at IS NULL AND created_at >= $2::timestamptz GROUP BY 1`,
        [accountId, start.toISOString()],
      ),
      q(
        `SELECT (created_at AT TIME ZONE 'UTC')::date::text AS d, count(*)::int AS n FROM contact_activity
         WHERE account_id = $1 AND type = 'CONTACT_UPDATED' AND created_at >= $2::timestamptz GROUP BY 1`,
        [accountId, start.toISOString()],
      ),
      q(
        `SELECT type, count(*)::int AS n FROM contact_activity WHERE account_id = $1 AND created_at >= $2::timestamptz GROUP BY type`,
        [accountId, start.toISOString()],
      ),
      q(
        `SELECT t.name, count(*)::int AS n FROM contact_tags ct
         JOIN tags t ON t.id = ct.tag_id
         JOIN contacts c ON c.id = ct.contact_id AND c.deleted_at IS NULL
         WHERE t.account_id = $1 GROUP BY t.id, t.name ORDER BY n DESC, lower(t.name) LIMIT 10`,
        [accountId],
      ),
      q(
        `SELECT count(*)::int AS groups, coalesce(sum(n), 0)::int AS contacts FROM (
           SELECT count(*) AS n FROM contacts WHERE account_id = $1 AND deleted_at IS NULL AND phone_digits <> ''
           GROUP BY phone_digits HAVING count(*) > 1) x`,
        [accountId],
      ),
      q(`SELECT count(*)::int AS n FROM contacts WHERE account_id = $1 AND deleted_at IS NOT NULL`, [accountId]),
      q(
        `SELECT count(*)::int AS jobs,
                count(*) FILTER (WHERE status = 'completed')::int AS completed,
                count(*) FILTER (WHERE status = 'failed')::int AS failed,
                coalesce(sum(created_count) FILTER (WHERE status = 'completed'), 0)::int AS created,
                coalesce(sum(updated_count) FILTER (WHERE status = 'completed'), 0)::int AS updated,
                coalesce(sum(unchanged_count) FILTER (WHERE status = 'completed'), 0)::int AS unchanged,
                coalesce(sum(error_rows) FILTER (WHERE status = 'completed'), 0)::int AS rejected,
                coalesce(sum(total_rows) FILTER (WHERE status = 'completed'), 0)::int AS submitted
         FROM import_jobs WHERE account_id = $1 AND created_at >= $2::timestamptz`,
        [accountId, start.toISOString()],
      ),
    ]);

    const created = new Map<string, number>(createdByDay.map((r) => [r.d, r.n]));
    const edits = new Map<string, number>(editsByDay.map((r) => [r.d, r.n]));
    const daily = Array.from({ length: range }, (_, i) => {
      const date = dayKey(new Date(start.getTime() + i * 86_400_000));
      return { date, created: created.get(date) ?? 0, edits: edits.get(date) ?? 0 };
    });
    const byType = new Map<string, number>(activity.map((r) => [r.type, r.n]));
    const accepted = imports.created + imports.updated + imports.unchanged;

    return {
      range,
      generatedAt: new Date().toISOString(),
      contacts: {
        active: agg.active,
        newInRange: agg.new_in_range,
        newPrevRange: agg.new_prev,
        changePct: agg.new_prev > 0 ? Math.round(((agg.new_in_range - agg.new_prev) / agg.new_prev) * 1000) / 10 : null,
        inTrash: trash.n,
      },
      quality: {
        withEmail: agg.with_email,
        withPhone: agg.with_phone,
        withCompany: agg.with_company,
        noContactInfo: agg.no_contact,
        reachable: agg.active - agg.no_contact,
        untagged: agg.untagged,
        stale: agg.stale,
        staleDays: STALE_DAYS,
        duplicatePhoneContacts: dup.contacts,
        duplicatePhoneGroups: dup.groups,
      },
      tags: tags.map((t) => ({ name: t.name, count: t.n })),
      daily,
      activity: [...byType].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
      trash: { current: trash.n, deletedInRange: byType.get('CONTACT_DELETED') ?? 0, restoredInRange: byType.get('CONTACT_RESTORED') ?? 0 },
      imports: {
        jobs: imports.jobs,
        completed: imports.completed,
        failed: imports.failed,
        rowsCreated: imports.created,
        rowsUpdated: imports.updated,
        rowsRejected: imports.rejected,
        rowsSubmitted: imports.submitted,
        acceptRate: imports.submitted > 0 ? Math.round((accepted / imports.submitted) * 1000) / 10 : null,
      },
    };
  }
}
