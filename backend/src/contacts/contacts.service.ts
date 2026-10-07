import { Injectable } from '@nestjs/common';
import { ApiError, notFound } from '../common/api-error';
import { DatabaseService } from '../database/database.service';
import { attentionSql } from './attention';
import { decodeCursor, encodeCursor } from './cursor';
import { CreateContactDto } from './dto/create-contact.dto';
import { ListContactsQuery } from './dto/list-contacts.query';
import { UpdateContactDto } from './dto/update-contact.dto';

type Queryable = { query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }> };

export interface TagRef {
  id: string;
  name: string;
}

export interface ContactView {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  tags: TagRef[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
  /** null for active contacts; set when the contact is in the trash */
  deletedAt: Date | null;
}

/** API field -> column. Only these are ever interpolated into SQL, so there is no injection surface. */
const EDITABLE_FIELDS = {
  firstName: 'first_name',
  lastName: 'last_name',
  email: 'email',
  phone: 'phone',
  company: 'company',
} as const;
type EditableField = keyof typeof EDITABLE_FIELDS;

const CONTACT_COLUMNS =
  'c.id, c.first_name, c.last_name, c.email, c.phone, c.company, c.version, c.created_at, c.updated_at, c.deleted_at';
const RETURNING_COLUMNS = 'id, first_name, last_name, email, phone, company, version, created_at, updated_at, deleted_at';

/** First-page totals are capped so COUNT never scans millions of rows. */
const TOTAL_CAP = 10_000;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

function toView(row: any, tags: TagRef[] = []): ContactView {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    company: row.company,
    tags,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
  };
}

const badRequest = (field: string, message: string) =>
  new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', { details: [{ field, message }] });

const inTrash = (current?: ContactView) =>
  new ApiError(409, 'CONTACT_DELETED', 'This contact is in the trash. Restore it to make changes.', { current });

const isEmailUniqueViolation = (e: any) => e?.code === '23505' && e?.constraint === 'contacts_account_email_uq';

@Injectable()
export class ContactsService {
  constructor(private readonly db: DatabaseService) {}

  // ---------------------------------------------------------------- list / get

  async list(accountId: string, q: ListContactsQuery) {
    const status = q.status ?? 'active';
    const sort = q.sort ?? (status === 'deleted' ? 'deletedAt' : 'createdAt');
    if (status === 'deleted' && sort !== 'deletedAt') throw badRequest('sort', 'The trash can only be sorted by deletedAt');
    if (status === 'active' && sort === 'deletedAt') throw badRequest('sort', 'deletedAt sorting is only available for the trash');

    if (q.attention && status === 'deleted') throw badRequest('attention', 'Attention filters only apply to active contacts');

    const params: unknown[] = [accountId];
    const bind = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where = ['c.account_id = $1', status === 'deleted' ? 'c.deleted_at IS NOT NULL' : 'c.deleted_at IS NULL'];

    if (q.q) {
      const term = q.q.toLowerCase();
      const like = bind(`%${escapeLike(term)}%`);
      const ors = [`c.search_name LIKE ${like}`, `c.email LIKE ${like}`];
      // phone-looking input also searches the digits-only phone column
      if (/^[\d\s()+.-]+$/.test(term)) {
        const digits = term.replace(/\D/g, '');
        if (digits.length >= 3) ors.push(`c.phone_digits LIKE ${bind(`%${digits}%`)}`);
      }
      where.push(`(${ors.join(' OR ')})`);
    }
    if (q.company) where.push(`c.company_lower LIKE ${bind(`%${escapeLike(q.company.toLowerCase())}%`)}`);
    if (q.tags?.length) {
      where.push(
        `EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
                 WHERE ct.contact_id = c.id AND lower(t.name) = ANY(${bind(q.tags.map((t) => t.toLowerCase()))}::text[]))`,
      );
    }
    if (q.attention) where.push(attentionSql(q.attention, '$1'));
    if (q.createdFrom) where.push(`c.created_at >= ${bind(q.createdFrom)}::timestamptz`);
    if (q.createdTo) where.push(`c.created_at <= ${bind(q.createdTo)}::timestamptz`);

    const countParams = params.slice();
    const countWhere = where.join(' AND ');

    // Keyset pagination: compare (sortKey, id) as a row so ties on the sort key stay stable.
    const ordering = `${sort}:${q.order}`;
    const col = { name: 'c.name_sort', createdAt: 'c.created_at', deletedAt: 'c.deleted_at' }[sort];
    const cast = sort === 'name' ? '::text' : '::timestamptz';
    const dir = q.order === 'asc' ? 'ASC' : 'DESC';
    if (q.cursor) {
      const cur = decodeCursor(q.cursor, ordering);
      where.push(`(${col}, c.id) ${q.order === 'asc' ? '>' : '<'} (${bind(cur.v)}${cast}, ${bind(cur.id)}::uuid)`);
    }

    const sql = `SELECT ${CONTACT_COLUMNS}, c.name_sort, c.created_at::text AS created_at_text, c.deleted_at::text AS deleted_at_text
                 FROM contacts c
                 WHERE ${where.join(' AND ')}
                 ORDER BY ${col} ${dir}, c.id ${dir}
                 LIMIT ${bind(q.limit + 1)}`;
    const { rows } = await this.db.query(sql, params);

    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const tagMap = await this.tagsFor(this.db, page.map((r) => r.id));
    const last = page[page.length - 1];

    // total only on the first page; the client keeps it while paging
    let total: number | null = null;
    let totalCapped = false;
    if (!q.cursor) {
      const counted = await this.db.query(
        `SELECT count(*)::int AS n FROM (SELECT 1 FROM contacts c WHERE ${countWhere} LIMIT ${TOTAL_CAP + 1}) x`,
        countParams,
      );
      totalCapped = counted.rows[0].n > TOTAL_CAP;
      total = Math.min(counted.rows[0].n, TOTAL_CAP);
    }

    const cursorValue = (r: any) => ({ name: r.name_sort, createdAt: r.created_at_text, deletedAt: r.deleted_at_text })[sort];
    return {
      data: page.map((r) => toView(r, tagMap.get(r.id))),
      nextCursor: hasMore && last ? encodeCursor({ s: ordering, v: cursorValue(last), id: last.id }) : null,
      total,
      totalCapped,
    };
  }

  /** Returns trashed contacts too, so the UI can show them read-only with a Restore action. */
  async get(accountId: string, id: string): Promise<ContactView> {
    const { rows } = await this.db.query(
      `SELECT ${CONTACT_COLUMNS} FROM contacts c WHERE c.id = $1 AND c.account_id = $2`,
      [id, accountId],
    );
    if (!rows[0]) throw notFound();
    const tags = await this.tagsFor(this.db, [id]);
    return toView(rows[0], tags.get(id));
  }

  // ---------------------------------------------------------------- create / update

  async create(accountId: string, dto: CreateContactDto): Promise<ContactView> {
    try {
      return await this.db.tx(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO contacts (account_id, first_name, last_name, email, phone, company)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING ${RETURNING_COLUMNS}`,
          [accountId, dto.firstName, dto.lastName, dto.email ?? null, dto.phone ?? null, dto.company ?? null],
        );
        const contact = rows[0];

        const added: TagRef[] = [];
        for (const name of dto.tags ?? []) {
          const tag = await this.ensureTag(c, accountId, name);
          const ins = await c.query(
            `INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING contact_id`,
            [contact.id, tag.id],
          );
          if (ins.rowCount) added.push(tag);
        }

        await c.query(
          `INSERT INTO contact_activity (account_id, contact_id, type, payload) VALUES ($1, $2, 'CONTACT_CREATED', $3::jsonb)`,
          [accountId, contact.id, JSON.stringify({ fields: { firstName: dto.firstName, lastName: dto.lastName } })],
        );
        for (const tag of added) await this.logTag(c, accountId, contact.id, 'TAG_ADDED', tag);

        return toView(contact, added.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())));
      });
    } catch (e) {
      throw isEmailUniqueViolation(e) ? await this.emailTaken(accountId, dto.email) : e;
    }
  }

  /**
   * Optimistic concurrency: the caller passes the version it last saw (If-Match).
   * The row is locked FOR UPDATE, the version compared, and only then written, so two
   * concurrent updates against the same version can never both succeed.
   */
  async update(accountId: string, id: string, expectedVersion: number, dto: UpdateContactDto) {
    try {
      return await this.db.tx(async (c) => {
        const cur = await this.lockContact(c, accountId, id);
        if (cur.deleted_at) throw inTrash(toView(cur, (await this.tagsFor(c, [id])).get(id)));
        await this.assertVersion(c, cur, expectedVersion);

        const changes: Record<string, { from: unknown; to: unknown }> = {};
        const sets: string[] = [];
        const values: unknown[] = [];
        for (const field of Object.keys(EDITABLE_FIELDS) as EditableField[]) {
          const next = dto[field];
          if (next === undefined) continue;
          const col = EDITABLE_FIELDS[field];
          if (next === cur[col]) continue;
          changes[field] = { from: cur[col], to: next };
          values.push(next);
          sets.push(`${col} = $${values.length}`);
        }

        const tags = await this.tagsFor(c, [id]);
        if (!sets.length) return { contact: toView(cur, tags.get(id)), changed: false }; // no-op: no version bump, no activity

        values.push(id);
        const updated = await c.query(
          `UPDATE contacts SET ${sets.join(', ')}, version = version + 1, updated_at = now()
           WHERE id = $${values.length}
           RETURNING ${RETURNING_COLUMNS}`,
          values,
        );
        await c.query(
          `INSERT INTO contact_activity (account_id, contact_id, type, payload) VALUES ($1, $2, 'CONTACT_UPDATED', $3::jsonb)`,
          [accountId, id, JSON.stringify({ changes, version: updated.rows[0].version })],
        );
        return { contact: toView(updated.rows[0], tags.get(id)), changed: true };
      });
    } catch (e) {
      throw isEmailUniqueViolation(e) ? await this.emailTaken(accountId, dto.email) : e;
    }
  }

  // ---------------------------------------------------------------- soft delete / restore

  /** Moves a contact to the trash. Idempotent: deleting something already in the trash is a no-op. */
  async softDelete(accountId: string, id: string, expectedVersion: number) {
    return this.db.tx(async (c) => {
      const cur = await this.lockContact(c, accountId, id);
      const tags = (await this.tagsFor(c, [id])).get(id);
      if (cur.deleted_at) return toView(cur, tags);
      await this.assertVersion(c, cur, expectedVersion);

      const { rows } = await c.query(
        `UPDATE contacts SET deleted_at = now(), version = version + 1, updated_at = now()
         WHERE id = $1 RETURNING ${RETURNING_COLUMNS}`,
        [id],
      );
      await c.query(
        `INSERT INTO contact_activity (account_id, contact_id, type, payload) VALUES ($1, $2, 'CONTACT_DELETED', $3::jsonb)`,
        [accountId, id, JSON.stringify({ version: rows[0].version })],
      );
      return toView(rows[0], tags);
    });
  }

  /**
   * Brings a contact back from the trash. If an active contact has since taken the same email,
   * the unique index rejects it and the caller gets EMAIL_TAKEN (with a pointer to that contact).
   */
  async restore(accountId: string, id: string, expectedVersion: number) {
    let email: string | null = null;
    try {
      return await this.db.tx(async (c) => {
        const cur = await this.lockContact(c, accountId, id);
        const tags = (await this.tagsFor(c, [id])).get(id);
        if (!cur.deleted_at) return toView(cur, tags); // already active: idempotent
        await this.assertVersion(c, cur, expectedVersion);
        email = cur.email;

        const { rows } = await c.query(
          `UPDATE contacts SET deleted_at = NULL, version = version + 1, updated_at = now()
           WHERE id = $1 RETURNING ${RETURNING_COLUMNS}`,
          [id],
        );
        await c.query(
          `INSERT INTO contact_activity (account_id, contact_id, type, payload) VALUES ($1, $2, 'CONTACT_RESTORED', $3::jsonb)`,
          [accountId, id, JSON.stringify({ version: rows[0].version })],
        );
        return toView(rows[0], tags);
      });
    } catch (e) {
      throw isEmailUniqueViolation(e) ? await this.emailTaken(accountId, email) : e;
    }
  }

  /**
   * Bulk move to trash. Like bulk tagging this is a set operation: it ignores per-contact versions
   * and is idempotent (contacts already in the trash are reported, not touched).
   */
  async bulkDelete(accountId: string, contactIds: string[]) {
    const ids = [...new Set(contactIds)];
    const { rows } = await this.db.query(
      `WITH existing AS (
         SELECT id, deleted_at FROM contacts WHERE account_id = $1 AND id = ANY($2::uuid[])
       ), del AS (
         UPDATE contacts c SET deleted_at = now(), version = c.version + 1, updated_at = now()
         FROM existing e WHERE c.id = e.id AND e.deleted_at IS NULL
         RETURNING c.id
       ), act AS (
         INSERT INTO contact_activity (account_id, contact_id, type, payload)
         SELECT $1, id, 'CONTACT_DELETED', '{"bulk": true}'::jsonb FROM del
         RETURNING 1
       )
       SELECT (SELECT coalesce(array_agg(id), '{}') FROM existing) AS existing_ids,
              (SELECT count(*) FROM del)::int AS deleted`,
      [accountId, ids],
    );
    const existing = new Set<string>(rows[0].existing_ids);
    return {
      requested: ids.length,
      deleted: rows[0].deleted as number,
      alreadyInTrash: existing.size - rows[0].deleted,
      notFound: ids.filter((id) => !existing.has(id)),
    };
  }

  // ---------------------------------------------------------------- tags

  /**
   * Tag changes are set operations (add/remove commute), so they deliberately do not take part in the
   * contact version check: adding a tag must not make a concurrent field edit fail.
   * Contacts in the trash are read-only, so tag edits on them are rejected.
   */
  async addTags(accountId: string, contactId: string, names: string[]) {
    // case-insensitive de-dupe, keeping the first spelling
    const seen = new Set<string>();
    const unique = names.filter((n) => !seen.has(n.toLowerCase()) && !!seen.add(n.toLowerCase()));
    return this.db.tx(async (c) => {
      await this.assertContact(c, accountId, contactId);
      let addedCount = 0;
      for (const name of unique) {
        const tag = await this.ensureTag(c, accountId, name);
        const ins = await c.query(
          `INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING contact_id`,
          [contactId, tag.id],
        );
        if ((ins.rowCount ?? 0) > 0) {
          addedCount++;
          await this.logTag(c, accountId, contactId, 'TAG_ADDED', tag);
        }
      }
      // the full, current tag list: clients can use it directly instead of re-fetching the contact
      return { added: addedCount > 0, addedCount, tags: (await this.tagsFor(c, [contactId])).get(contactId) ?? [] };
    });
  }

  async removeTag(accountId: string, contactId: string, tagId: string) {
    await this.db.tx(async (c) => {
      await this.assertContact(c, accountId, contactId);
      const del = await c.query(
        `DELETE FROM contact_tags ct USING tags t
         WHERE ct.contact_id = $1 AND ct.tag_id = $2 AND t.id = ct.tag_id AND t.account_id = $3
         RETURNING t.id, t.name`,
        [contactId, tagId, accountId],
      );
      if (del.rows[0]) await this.logTag(c, accountId, contactId, 'TAG_REMOVED', del.rows[0]);
    });
  }

  /** Idempotent: contacts that already have the tag are skipped and get no duplicate activity. Trashed contacts count as not found. */
  async bulkAddTag(accountId: string, contactIds: string[], tagName: string) {
    const ids = [...new Set(contactIds)];
    return this.db.tx(async (c) => {
      const tag = await this.ensureTag(c, accountId, tagName);
      const { rows } = await c.query(
        `WITH target AS (
           SELECT id FROM contacts WHERE account_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])
         ), ins AS (
           INSERT INTO contact_tags (contact_id, tag_id)
           SELECT id, $3 FROM target
           ON CONFLICT DO NOTHING
           RETURNING contact_id
         ), act AS (
           INSERT INTO contact_activity (account_id, contact_id, type, payload)
           SELECT $1, contact_id, 'TAG_ADDED', $4::jsonb FROM ins
           RETURNING 1
         )
         SELECT (SELECT coalesce(array_agg(id), '{}') FROM target) AS matched_ids,
                (SELECT count(*) FROM ins)::int AS added`,
        [accountId, ids, tag.id, JSON.stringify({ tag, bulk: true })],
      );
      const matched = new Set<string>(rows[0].matched_ids);
      return {
        tag,
        requested: ids.length,
        matched: matched.size,
        added: rows[0].added as number,
        alreadyTagged: matched.size - rows[0].added,
        notFound: ids.filter((id) => !matched.has(id)),
      };
    });
  }

  async listTags(accountId: string, prefix?: string) {
    const { rows } = await this.db.query(
      `SELECT id, name FROM tags WHERE account_id = $1 AND ($2::text IS NULL OR lower(name) LIKE $2)
       ORDER BY lower(name) LIMIT 200`,
      [accountId, prefix ? `${escapeLike(prefix.toLowerCase())}%` : null],
    );
    return rows as TagRef[];
  }

  // ---------------------------------------------------------------- activity

  /** History stays readable after a contact is trashed. */
  async activity(accountId: string, contactId: string, limit: number) {
    await this.assertContact(this.db, accountId, contactId, { allowDeleted: true });
    const { rows } = await this.db.query(
      `SELECT id, contact_id, type, payload, created_at FROM contact_activity
       WHERE contact_id = $1 AND account_id = $2
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [contactId, accountId, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      contactId: r.contact_id,
      type: r.type,
      payload: r.payload,
      createdAt: r.created_at,
    }));
  }

  // ---------------------------------------------------------------- helpers

  private async lockContact(c: Queryable, accountId: string, id: string) {
    const found = await c.query(`SELECT * FROM contacts WHERE id = $1 AND account_id = $2 FOR UPDATE`, [id, accountId]);
    if (!found.rows[0]) throw notFound();
    return found.rows[0];
  }

  private async assertVersion(c: Queryable, cur: any, expectedVersion: number) {
    if (cur.version === expectedVersion) return;
    const tags = await this.tagsFor(c, [cur.id]);
    throw new ApiError(409, 'VERSION_CONFLICT', 'This contact was modified by someone else since you loaded it', {
      current: toView(cur, tags.get(cur.id)),
    });
  }

  /** 404 if missing; 409 CONTACT_DELETED if in the trash (unless allowDeleted). */
  private async assertContact(q: Queryable, accountId: string, contactId: string, opts: { allowDeleted?: boolean } = {}) {
    const { rows } = await q.query(`SELECT deleted_at FROM contacts WHERE id = $1 AND account_id = $2`, [contactId, accountId]);
    if (!rows[0]) throw notFound();
    if (rows[0].deleted_at && !opts.allowDeleted) throw inTrash();
  }

  /** Builds EMAIL_TAKEN and, when possible, points at the active contact that owns the email. */
  private async emailTaken(accountId: string, email?: string | null): Promise<ApiError> {
    let existing: { id: string; name: string } | undefined;
    if (email) {
      const { rows } = await this.db.query(
        `SELECT id, first_name, last_name FROM contacts WHERE account_id = $1 AND email = $2 AND deleted_at IS NULL`,
        [accountId, email],
      );
      if (rows[0]) existing = { id: rows[0].id, name: `${rows[0].first_name} ${rows[0].last_name}` };
    }
    return new ApiError(409, 'EMAIL_TAKEN', 'Another contact already uses this email', {
      details: [{ field: 'email', message: existing ? `${existing.name} already uses this email` : 'Email is already used by another contact' }],
      existing,
    });
  }

  /** Find-or-create a tag, case-insensitively unique per account. */
  private async ensureTag(q: Queryable, accountId: string, name: string): Promise<TagRef> {
    const ins = await q.query(
      `INSERT INTO tags (account_id, name) VALUES ($1, $2)
       ON CONFLICT (account_id, lower(name)) DO NOTHING RETURNING id, name`,
      [accountId, name],
    );
    if (ins.rows[0]) return ins.rows[0];
    const existing = await q.query(`SELECT id, name FROM tags WHERE account_id = $1 AND lower(name) = lower($2)`, [
      accountId,
      name,
    ]);
    return existing.rows[0];
  }

  private logTag(q: Queryable, accountId: string, contactId: string, type: 'TAG_ADDED' | 'TAG_REMOVED', tag: TagRef) {
    return q.query(`INSERT INTO contact_activity (account_id, contact_id, type, payload) VALUES ($1, $2, $3, $4::jsonb)`, [
      accountId,
      contactId,
      type,
      JSON.stringify({ tag: { id: tag.id, name: tag.name } }),
    ]);
  }

  private async tagsFor(q: Queryable, contactIds: string[]): Promise<Map<string, TagRef[]>> {
    const map = new Map<string, TagRef[]>();
    if (!contactIds.length) return map;
    const { rows } = await q.query(
      `SELECT ct.contact_id, t.id, t.name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
       WHERE ct.contact_id = ANY($1::uuid[]) ORDER BY lower(t.name)`,
      [contactIds],
    );
    for (const r of rows) {
      const list = map.get(r.contact_id) ?? [];
      list.push({ id: r.id, name: r.name });
      map.set(r.contact_id, list);
    }
    return map;
  }
}
