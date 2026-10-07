import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DatabaseService } from '../src/database/database.service';
import { ACCOUNT_B, api, createApp, insertContact, KEY_B, resetDb } from './helpers';

describe('Contacts API (real Postgres)', () => {
  let app: INestApplication;
  let db: DatabaseService;
  let http: ReturnType<typeof api>;

  beforeAll(async () => {
    ({ app, db } = await createApp());
    http = api(app);
  });
  afterAll(() => app.close());
  beforeEach(() => resetDb(db));

  // ------------------------------------------------------------------ auth
  describe('authentication', () => {
    it('rejects missing and wrong API keys with 401', async () => {
      await request(app.getHttpServer()).get('/contacts').expect(401);
      const res = await request(app.getHttpServer()).get('/contacts').set('Authorization', 'Bearer nope').expect(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });
    it('keeps /health public', async () => {
      await request(app.getHttpServer()).get('/health').expect(200);
    });
  });

  // ------------------------------------------------------------------ validation
  describe('validation', () => {
    it('returns field-level details for bad input', async () => {
      const res = await http.post('/contacts').send({ firstName: 'A', lastName: '', email: 'not-an-email', phone: '12' }).expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.details.map((d: any) => d.field).sort()).toEqual(['email', 'lastName', 'phone']);
    });
    it('rejects unknown fields (no mass assignment of version/accountId)', async () => {
      await http.post('/contacts').send({ firstName: 'A', lastName: 'B', accountId: ACCOUNT_B }).expect(400);
    });
    it('PATCH cannot clear a required name but can clear optional fields', async () => {
      const id = await insertContact(db, { first: 'Ada', last: 'Lovelace', phone: '555-010-1234' });
      await http.patch(`/contacts/${id}`).set('If-Match', '1').send({ firstName: null }).expect(400);
      const res = await http.patch(`/contacts/${id}`).set('If-Match', '1').send({ phone: '' }).expect(200);
      expect(res.body.phone).toBeNull();
    });
    it('returns 400 (not 500) for a malformed id', async () => {
      await http.get('/contacts/not-a-uuid').expect(400);
    });
  });

  // ------------------------------------------------------------------ pagination
  describe('keyset pagination', () => {
    const combos: Array<['name' | 'createdAt', 'asc' | 'desc']> = [
      ['name', 'asc'], ['name', 'desc'], ['createdAt', 'asc'], ['createdAt', 'desc'],
    ];

    beforeEach(async () => {
      // 55 contacts; only 5 distinct last names and 3 distinct created_at values => lots of sort-key ties
      for (let i = 0; i < 55; i++) {
        await insertContact(db, {
          first: `First${String(i).padStart(2, '0')}`,
          last: `Last${i % 5}`,
          createdAt: `2025-01-0${(i % 3) + 1}T10:00:00.123456Z`,
        });
      }
    });

    it.each(combos)('pages through every row exactly once, sorted by %s %s', async (sort, order) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: request.Response = await http.get('/contacts').query({ sort, order, limit: 10, ...(cursor ? { cursor } : {}) }).expect(200);
        if (pages === 0) {
          expect(res.body.total).toBe(55);
        } else {
          expect(res.body.total).toBeNull(); // count only computed on the first page
        }
        res.body.data.forEach((c: any) => seen.push(c.id));
        cursor = res.body.nextCursor;
        pages++;
      } while (cursor);

      expect(pages).toBe(6);
      expect(new Set(seen).size).toBe(55);

      const all = (await http.get('/contacts').query({ sort, order, limit: 100 }).expect(200)).body.data;
      expect(seen).toEqual(all.map((c: any) => c.id)); // paging order == single-page order
    });

    it('sorts by name (last, first) ascending', async () => {
      const res = await http.get('/contacts').query({ sort: 'name', order: 'asc', limit: 100 }).expect(200);
      const names = res.body.data.map((c: any) => `${c.lastName} ${c.firstName}`.toLowerCase());
      expect(names).toEqual([...names].sort());
    });

    it('rejects a cursor used with a different sort, and garbage cursors', async () => {
      const first = await http.get('/contacts').query({ sort: 'name', order: 'asc', limit: 5 }).expect(200);
      const res = await http.get('/contacts').query({ sort: 'createdAt', order: 'asc', cursor: first.body.nextCursor }).expect(400);
      expect(res.body.code).toBe('INVALID_CURSOR');
      await http.get('/contacts').query({ cursor: 'garbage' }).expect(400);
    });

    it('rejects out-of-range limits', async () => {
      await http.get('/contacts').query({ limit: 0 }).expect(400);
      await http.get('/contacts').query({ limit: 101 }).expect(400);
    });
  });

  // ------------------------------------------------------------------ search + filters
  describe('search and filters', () => {
    beforeEach(async () => {
      await insertContact(db, { first: 'Ada', last: 'Lovelace', email: 'ada@analytical.io', phone: '+1 (555) 010-1234', company: 'Analytical Engines', createdAt: '2025-03-01T00:00:00Z' });
      await insertContact(db, { first: 'Grace', last: 'Hopper', email: 'grace@navy.mil', phone: '555.020.9999', company: 'US Navy', createdAt: '2025-06-01T00:00:00Z' });
      await insertContact(db, { first: 'Alan', last: 'Turing', email: 'alan@bletchley.uk', company: 'Bletchley Park', createdAt: '2025-09-01T00:00:00Z' });
    });
    const names = (res: request.Response) => res.body.data.map((c: any) => c.firstName).sort();

    it('searches name (partial, case-insensitive, across first+last)', async () => {
      expect(names(await http.get('/contacts').query({ q: 'LACE' }))).toEqual(['Ada']);
      expect(names(await http.get('/contacts').query({ q: 'ada love' }))).toEqual(['Ada']);
    });
    it('searches email', async () => {
      expect(names(await http.get('/contacts').query({ q: 'navy.mil' }))).toEqual(['Grace']);
    });
    it('searches phone ignoring formatting', async () => {
      expect(names(await http.get('/contacts').query({ q: '010-1234' }))).toEqual(['Ada']);
      expect(names(await http.get('/contacts').query({ q: '(555) 020' }))).toEqual(['Grace']);
    });
    it('treats LIKE wildcards in the query literally', async () => {
      const res = await http.get('/contacts').query({ q: '%%' }).expect(200);
      expect(res.body.data).toHaveLength(0);
    });
    it('requires at least 2 characters', async () => {
      await http.get('/contacts').query({ q: 'a' }).expect(400);
    });

    it('filters by company, created range and tag (and combinations)', async () => {
      expect(names(await http.get('/contacts').query({ company: 'navy' }))).toEqual(['Grace']);
      expect(names(await http.get('/contacts').query({ createdFrom: '2025-05-01T00:00:00Z', createdTo: '2025-07-01T00:00:00Z' }))).toEqual(['Grace']);

      const ada = (await http.get('/contacts').query({ q: 'ada' })).body.data[0];
      await http.post(`/contacts/${ada.id}/tags`).send({ name: 'VIP' }).expect(201);
      expect(names(await http.get('/contacts').query({ tags: 'vip' }))).toEqual(['Ada']); // case-insensitive
      expect(names(await http.get('/contacts').query({ tags: 'vip,lead' }))).toEqual(['Ada']); // ANY of
      expect(await http.get('/contacts').query({ tags: 'vip', company: 'navy' }).then((r) => r.body.data)).toHaveLength(0);
      const res = await http.get('/contacts').query({ tags: 'vip' });
      expect(res.body.data[0].tags.map((t: any) => t.name)).toEqual(['VIP']);
    });
  });

  // ------------------------------------------------------------------ updates + concurrency
  describe('updates and optimistic concurrency', () => {
    let id: string;
    beforeEach(async () => {
      id = await insertContact(db, { first: 'Ada', last: 'Lovelace', email: 'ada@x.io', company: 'Old Co' });
    });

    it('returns an ETag and bumps the version on update', async () => {
      const got = await http.get(`/contacts/${id}`).expect(200);
      expect(got.headers.etag).toBe('"1"');
      const res = await http.patch(`/contacts/${id}`).set('If-Match', got.headers.etag).send({ company: 'New Co' }).expect(200);
      expect(res.body).toMatchObject({ company: 'New Co', version: 2 });
      expect(res.headers.etag).toBe('"2"');
    });

    it('requires If-Match (428) and rejects a malformed one (400)', async () => {
      const res = await http.patch(`/contacts/${id}`).send({ company: 'X' }).expect(428);
      expect(res.body.code).toBe('PRECONDITION_REQUIRED');
      await http.patch(`/contacts/${id}`).set('If-Match', 'abc').send({ company: 'X' }).expect(400);
    });

    it('user B wins, user A submits stale data -> 409 with the current server copy, nothing overwritten', async () => {
      // A and B both loaded version 1
      await http.patch(`/contacts/${id}`).set('If-Match', '"1"').send({ company: 'B Corp' }).expect(200); // B saves
      const stale = await http.patch(`/contacts/${id}`).set('If-Match', '"1"').send({ company: 'A Corp', phone: '555-010-9999' }).expect(409); // A is stale
      expect(stale.body.code).toBe('VERSION_CONFLICT');
      expect(stale.body.current).toMatchObject({ company: 'B Corp', version: 2 });
      const after = (await http.get(`/contacts/${id}`)).body;
      expect(after).toMatchObject({ company: 'B Corp', phone: null, version: 2 });
    });

    it('two simultaneous updates with the same version: exactly one wins', async () => {
      const results = await Promise.all(
        ['One', 'Two', 'Three', 'Four'].map((co) => http.patch(`/contacts/${id}`).set('If-Match', '1').send({ company: co })),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409, 409, 409]);
      expect((await http.get(`/contacts/${id}`)).body.version).toBe(2);
    });

    it('a no-op update changes nothing: no version bump, no activity', async () => {
      const res = await http.patch(`/contacts/${id}`).set('If-Match', '1').send({ company: 'Old Co', firstName: 'Ada' }).expect(200);
      expect(res.body.version).toBe(1);
      expect((await http.get(`/contacts/${id}/activity`)).body.data).toHaveLength(0);
    });

    it('normalises email (trim + lower-case)', async () => {
      const res = await http.patch(`/contacts/${id}`).set('If-Match', '1').send({ email: '  Ada.L@Example.COM ' }).expect(200);
      expect(res.body.email).toBe('ada.l@example.com');
    });

    it('returns 404 for unknown contacts and for another account\'s contact', async () => {
      await http.patch('/contacts/00000000-0000-4000-8000-000000000000').set('If-Match', '1').send({ company: 'X' }).expect(404);
      await api(app, KEY_B).get(`/contacts/${id}`).expect(404);
      await api(app, KEY_B).patch(`/contacts/${id}`).set('If-Match', '1').send({ company: 'hijack' }).expect(404);
      expect((await http.get(`/contacts/${id}`)).body.company).toBe('Old Co');
    });
  });

  // ------------------------------------------------------------------ email uniqueness
  describe('email uniqueness', () => {
    it('rejects updating to an email owned by another contact (case-insensitive) with a field error', async () => {
      await insertContact(db, { first: 'Grace', last: 'Hopper', email: 'grace@navy.mil' });
      const id = await insertContact(db, { first: 'Ada', last: 'Lovelace', email: 'ada@x.io' });
      const res = await http.patch(`/contacts/${id}`).set('If-Match', '1').send({ email: 'GRACE@navy.mil' }).expect(409);
      expect(res.body.code).toBe('EMAIL_TAKEN');
      expect(res.body.details[0].field).toBe('email');
      expect((await http.get(`/contacts/${id}`)).body.email).toBe('ada@x.io'); // unchanged, version not bumped
    });
    it('rejects duplicate on create', async () => {
      await http.post('/contacts').send({ firstName: 'A', lastName: 'B', email: 'dup@x.io' }).expect(201);
      const res = await http.post('/contacts').send({ firstName: 'C', lastName: 'D', email: 'DUP@x.io' }).expect(409);
      expect(res.body.code).toBe('EMAIL_TAKEN');
    });
    it('allows many contacts without an email, and the same email in a different account', async () => {
      await http.post('/contacts').send({ firstName: 'A', lastName: 'One' }).expect(201);
      await http.post('/contacts').send({ firstName: 'A', lastName: 'Two', email: '' }).expect(201);
      await http.post('/contacts').send({ firstName: 'A', lastName: 'Three', email: null }).expect(201);
      await http.post('/contacts').send({ firstName: 'A', lastName: 'Shared', email: 'shared@x.io' }).expect(201);
      await api(app, KEY_B).post('/contacts').send({ firstName: 'B', lastName: 'Shared', email: 'shared@x.io' }).expect(201);
    });
    it('only one of two racing creates with the same email succeeds', async () => {
      const results = await Promise.all(
        [1, 2, 3].map((i) => http.post('/contacts').send({ firstName: 'R', lastName: `Race${i}`, email: 'race@x.io' })),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    });
  });

  // ------------------------------------------------------------------ tags + activity
  describe('tags and activity', () => {
    let id: string;
    beforeEach(async () => {
      id = await insertContact(db, { first: 'Ada', last: 'Lovelace' });
    });

    it('adds a tag idempotently, removes it, and logs activity only for real changes', async () => {
      const first = await http.post(`/contacts/${id}/tags`).send({ name: 'VIP' }).expect(201);
      const tagId = first.body.tags[0].id;
      await http.post(`/contacts/${id}/tags`).send({ name: 'vip' }).expect(200); // same tag, case-insensitive, already present
      await http.delete(`/contacts/${id}/tags/${tagId}`).expect(204);
      await http.delete(`/contacts/${id}/tags/${tagId}`).expect(204); // idempotent

      expect((await http.get(`/contacts/${id}`)).body.tags).toEqual([]);
      const types = (await http.get(`/contacts/${id}/activity`)).body.data.map((a: any) => a.type);
      expect(types).toEqual(['TAG_REMOVED', 'TAG_ADDED']); // newest first, no duplicates
    });

    it('does not bump the contact version (tag ops commute with field edits)', async () => {
      await http.post(`/contacts/${id}/tags`).send({ name: 'Lead' }).expect(201);
      expect((await http.get(`/contacts/${id}`)).body.version).toBe(1);
      await http.patch(`/contacts/${id}`).set('If-Match', '1').send({ company: 'X' }).expect(200);
    });

    it('records CONTACT_UPDATED with a field diff, contactId and timestamp', async () => {
      await http.patch(`/contacts/${id}`).set('If-Match', '1').send({ company: 'Analytical Engines' }).expect(200);
      const [act] = (await http.get(`/contacts/${id}/activity`)).body.data;
      expect(act).toMatchObject({ type: 'CONTACT_UPDATED', contactId: id });
      expect(act.payload.changes.company).toEqual({ from: null, to: 'Analytical Engines' });
      expect(new Date(act.createdAt).getTime()).not.toBeNaN();
    });

    it('validates tag names and cannot remove a tag via another account', async () => {
      await http.post(`/contacts/${id}/tags`).send({ name: '  ' }).expect(400);
      await http.post(`/contacts/${id}/tags`).send({ name: 'a,b' }).expect(400);
      const added = await http.post(`/contacts/${id}/tags`).send({ name: 'Lead' }).expect(201);
      await api(app, KEY_B).delete(`/contacts/${id}/tags/${added.body.tags[0].id}`).expect(404);
      expect((await http.get(`/contacts/${id}`)).body.tags).toHaveLength(1);
    });

    it('lists tags for the account only', async () => {
      await http.post(`/contacts/${id}/tags`).send({ name: 'Customer' }).expect(201);
      const otherId = await insertContact(db, { first: 'X', last: 'Y', account: ACCOUNT_B });
      await api(app, KEY_B).post(`/contacts/${otherId}/tags`).send({ name: 'Secret' }).expect(201);
      expect((await http.get('/tags')).body.data.map((t: any) => t.name)).toEqual(['Customer']);
    });
  });

  // ------------------------------------------------------------------ bulk
  describe('bulk tag assignment', () => {
    it('assigns to many, skips duplicates, reports unknown ids, scopes to the account', async () => {
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push(await insertContact(db, { first: 'C', last: `N${i}` }));
      const foreign = await insertContact(db, { first: 'F', last: 'Other', account: ACCOUNT_B });
      const missing = '00000000-0000-4000-8000-000000000000';

      await http.post(`/contacts/${ids[0]}/tags`).send({ name: 'Prospect' }).expect(201); // one already tagged

      const res = await http.post('/contacts/bulk/tags').send({ contactIds: [...ids, foreign, missing, ids[1]], tag: 'prospect' }).expect(200);
      expect(res.body).toMatchObject({ requested: 7, matched: 5, added: 4, alreadyTagged: 1 });
      expect(res.body.notFound.sort()).toEqual([foreign, missing].sort());
      expect(res.body.tag.name).toBe('Prospect'); // reuses the existing tag, keeps canonical casing

      // idempotent re-run
      const again = await http.post('/contacts/bulk/tags').send({ contactIds: ids, tag: 'Prospect' }).expect(200);
      expect(again.body).toMatchObject({ matched: 5, added: 0, alreadyTagged: 5 });

      // foreign contact untouched; one TAG_ADDED per contact, no duplicates
      expect((await db.query('SELECT count(*)::int n FROM contact_tags WHERE contact_id = $1', [foreign])).rows[0].n).toBe(0);
      expect((await db.query(`SELECT count(*)::int n FROM contact_activity WHERE type = 'TAG_ADDED'`)).rows[0].n).toBe(5);
      expect((await http.get('/contacts').query({ tags: 'prospect' })).body.total).toBe(5);
    });

    it('validates the payload', async () => {
      await http.post('/contacts/bulk/tags').send({ contactIds: [], tag: 'x' }).expect(400);
      await http.post('/contacts/bulk/tags').send({ contactIds: ['nope'], tag: 'x' }).expect(400);
      const tooMany = Array.from({ length: 1001 }, () => '00000000-0000-4000-8000-000000000000');
      await http.post('/contacts/bulk/tags').send({ contactIds: tooMany, tag: 'x' }).expect(400);
    });
  });
});
