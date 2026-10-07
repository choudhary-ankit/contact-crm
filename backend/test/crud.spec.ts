import { INestApplication } from '@nestjs/common';
import { DatabaseService } from '../src/database/database.service';
import { ACCOUNT_B, api, createApp, insertContact, KEY_B, resetDb } from './helpers';

describe('Create, soft delete and restore (real Postgres)', () => {
  let app: INestApplication;
  let db: DatabaseService;
  let http: ReturnType<typeof api>;

  beforeAll(async () => {
    ({ app, db } = await createApp());
    http = api(app);
  });
  afterAll(() => app.close());
  beforeEach(() => resetDb(db));

  const activityTypes = async (id: string) => (await http.get(`/contacts/${id}/activity`)).body.data.map((a: any) => a.type);

  // ------------------------------------------------------------------ create
  describe('create', () => {
    it('creates a contact with tags, returns 201 + ETag, and records activity', async () => {
      const res = await http.post('/contacts').send({ firstName: 'Ada', lastName: 'Byron', email: 'Ada.B@X.io', tags: ['VIP', ' lead ', 'vip'] }).expect(201);
      expect(res.headers.etag).toBe('"1"');
      expect(res.body).toMatchObject({ firstName: 'Ada', email: 'ada.b@x.io', version: 1, deletedAt: null });
      expect(res.body.tags.map((t: any) => t.name)).toEqual(['lead', 'VIP']); // trimmed, case-insensitive de-dupe, sorted
      expect((await activityTypes(res.body.id)).sort()).toEqual(['CONTACT_CREATED', 'TAG_ADDED', 'TAG_ADDED']);
      expect((await http.get('/contacts').query({ tags: 'vip' })).body.total).toBe(1);
    });

    it('is atomic: a duplicate email creates nothing, not even tags or activity', async () => {
      await insertContact(db, { first: 'Ada', last: 'Lovelace', email: 'ada@x.io' });
      const res = await http.post('/contacts').send({ firstName: 'Ada', lastName: 'Byron', email: 'ADA@x.io', tags: ['Ghost'] }).expect(409);
      expect(res.body.code).toBe('EMAIL_TAKEN');
      expect(res.body.existing).toMatchObject({ name: 'Ada Lovelace' });
      expect(res.body.details[0]).toEqual({ field: 'email', message: 'Ada Lovelace already uses this email' });
      expect((await http.get('/tags')).body.data).toEqual([]); // the 'Ghost' tag was rolled back
      expect((await http.get('/contacts')).body.total).toBe(1);
    });

    it('validates tags on create', async () => {
      await http.post('/contacts').send({ firstName: 'A', lastName: 'B', tags: ['a,b'] }).expect(400);
      await http.post('/contacts').send({ firstName: 'A', lastName: 'B', tags: ['x'.repeat(51)] }).expect(400);
      await http.post('/contacts').send({ firstName: 'A', lastName: 'B', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }).expect(400);
    });
  });

  // ------------------------------------------------------------------ soft delete
  describe('soft delete', () => {
    let id: string;
    beforeEach(async () => {
      id = await insertContact(db, { first: 'Jon', last: 'Snow', email: 'jon@x.io', company: 'Watch' });
      await http.post(`/contacts/${id}/tags`).send({ name: 'VIP' }).expect(201);
    });

    it('requires If-Match, moves the contact to the trash and bumps the version', async () => {
      await http.delete(`/contacts/${id}`).expect(428);
      const res = await http.delete(`/contacts/${id}`).set('If-Match', '"1"').expect(200);
      expect(res.body).toMatchObject({ id, version: 2 });
      expect(res.body.deletedAt).not.toBeNull();
      expect(res.headers.etag).toBe('"2"');
    });

    it('hides the contact from the active list, search, tag filters and tag suggestions counts', async () => {
      await http.delete(`/contacts/${id}`).set('If-Match', '1').expect(200);
      expect((await http.get('/contacts')).body.data).toHaveLength(0);
      expect((await http.get('/contacts').query({ q: 'snow' })).body.data).toHaveLength(0);
      expect((await http.get('/contacts').query({ tags: 'vip' })).body.data).toHaveLength(0);
      expect((await http.get('/contacts').query({ company: 'watch' })).body.total).toBe(0);
    });

    it('shows it in the trash, with its tags, newest deletion first', async () => {
      const other = await insertContact(db, { first: 'Tony', last: 'Stark' });
      await http.delete(`/contacts/${id}`).set('If-Match', '1').expect(200);
      await http.delete(`/contacts/${other}`).set('If-Match', '1').expect(200);

      const res = await http.get('/contacts').query({ status: 'deleted' }).expect(200);
      expect(res.body.total).toBe(2);
      expect(res.body.data.map((c: any) => c.lastName)).toEqual(['Stark', 'Snow']);
      expect(res.body.data[1].tags.map((t: any) => t.name)).toEqual(['VIP']);
      expect(res.body.data[0].deletedAt).not.toBeNull();
    });

    it('can still be opened directly (read-only view) and keeps its history', async () => {
      await http.delete(`/contacts/${id}`).set('If-Match', '1').expect(200);
      expect((await http.get(`/contacts/${id}`).expect(200)).body.deletedAt).not.toBeNull();
      expect((await activityTypes(id))[0]).toBe('CONTACT_DELETED');
    });

    it('is read-only while in the trash: edits and tag changes get 409 CONTACT_DELETED', async () => {
      const del = await http.delete(`/contacts/${id}`).set('If-Match', '1').expect(200);
      const edit = await http.patch(`/contacts/${id}`).set('If-Match', '2').send({ company: 'X' }).expect(409);
      expect(edit.body.code).toBe('CONTACT_DELETED');
      expect(edit.body.current.deletedAt).not.toBeNull();
      expect((await http.post(`/contacts/${id}/tags`).send({ name: 'Lead' })).body.code).toBe('CONTACT_DELETED');
      await http.delete(`/contacts/${id}/tags/${del.body.tags[0].id}`).expect(409);
    });

    it('detects a stale delete: user B edited, user A deletes with the old version -> 409 and nothing is deleted', async () => {
      await http.patch(`/contacts/${id}`).set('If-Match', '1').send({ company: 'Changed by B' }).expect(200);
      const res = await http.delete(`/contacts/${id}`).set('If-Match', '1').expect(409);
      expect(res.body.code).toBe('VERSION_CONFLICT');
      expect(res.body.current).toMatchObject({ company: 'Changed by B', version: 2, deletedAt: null });
      expect((await http.get(`/contacts/${id}`)).body.deletedAt).toBeNull();
    });

    it('is idempotent: deleting something already in the trash changes nothing and logs nothing', async () => {
      await http.delete(`/contacts/${id}`).set('If-Match', '1').expect(200);
      const again = await http.delete(`/contacts/${id}`).set('If-Match', '1').expect(200);
      expect(again.body.version).toBe(2);
      expect((await activityTypes(id)).filter((t: string) => t === 'CONTACT_DELETED')).toHaveLength(1);
    });

    it('cannot touch another account\'s contact', async () => {
      await api(app, KEY_B).delete(`/contacts/${id}`).set('If-Match', '1').expect(404);
      expect((await http.get(`/contacts/${id}`)).body.deletedAt).toBeNull();
    });

    it('does not allow tagging trashed contacts in bulk (reported as notFound)', async () => {
      await http.delete(`/contacts/${id}`).set('If-Match', '1').expect(200);
      const res = await http.post('/contacts/bulk/tags').send({ contactIds: [id], tag: 'Lead' }).expect(200);
      expect(res.body).toMatchObject({ matched: 0, added: 0, notFound: [id] });
    });

    it('validates list sorting rules for the trash', async () => {
      await http.get('/contacts').query({ status: 'deleted', sort: 'name' }).expect(400);
      await http.get('/contacts').query({ status: 'active', sort: 'deletedAt' }).expect(400);
      await http.get('/contacts').query({ status: 'bogus' }).expect(400);
    });
  });

  // ------------------------------------------------------------------ restore + email reuse
  describe('restore and email reuse', () => {
    it('restores a trashed contact with its tags and records CONTACT_RESTORED', async () => {
      const id = await insertContact(db, { first: 'Jon', last: 'Snow', email: 'jon@x.io' });
      await http.post(`/contacts/${id}/tags`).send({ name: 'VIP' }).expect(201);
      await http.delete(`/contacts/${id}`).set('If-Match', '1').expect(200);

      const res = await http.post(`/contacts/${id}/restore`).set('If-Match', '2').expect(200);
      expect(res.body).toMatchObject({ version: 3, deletedAt: null });
      expect(res.body.tags.map((t: any) => t.name)).toEqual(['VIP']);
      expect((await http.get('/contacts')).body.data.map((c: any) => c.id)).toEqual([id]);
      expect((await http.get('/contacts').query({ status: 'deleted' })).body.total).toBe(0);
      expect((await activityTypes(id)).slice(0, 2)).toEqual(['CONTACT_RESTORED', 'CONTACT_DELETED']);
    });

    it('requires a current version to restore, and is idempotent for active contacts', async () => {
      const id = await insertContact(db, { first: 'Jon', last: 'Snow' });
      await http.delete(`/contacts/${id}`).set('If-Match', '1').expect(200);
      await http.post(`/contacts/${id}/restore`).expect(428);
      await http.post(`/contacts/${id}/restore`).set('If-Match', '1').expect(409); // stale
      await http.post(`/contacts/${id}/restore`).set('If-Match', '2').expect(200);
      const again = await http.post(`/contacts/${id}/restore`).set('If-Match', '2').expect(200);
      expect(again.body.version).toBe(3);
    });

    it('lets a new contact reuse a trashed contact\'s email', async () => {
      const old = await insertContact(db, { first: 'Old', last: 'Owner', email: 'shared@x.io' });
      await http.delete(`/contacts/${old}`).set('If-Match', '1').expect(200);
      await http.post('/contacts').send({ firstName: 'New', lastName: 'Owner', email: 'shared@x.io' }).expect(201);
    });

    it('refuses to restore into an email now owned by an active contact, and points at that contact', async () => {
      const old = await insertContact(db, { first: 'Old', last: 'Owner', email: 'shared@x.io' });
      await http.delete(`/contacts/${old}`).set('If-Match', '1').expect(200);
      const owner = (await http.post('/contacts').send({ firstName: 'New', lastName: 'Owner', email: 'shared@x.io' })).body;

      const res = await http.post(`/contacts/${old}/restore`).set('If-Match', '2').expect(409);
      expect(res.body.code).toBe('EMAIL_TAKEN');
      expect(res.body.existing).toEqual({ id: owner.id, name: 'New Owner' });
      expect((await http.get(`/contacts/${old}`)).body.deletedAt).not.toBeNull(); // still in the trash

      // resolution path: the active owner moves on, then restore works
      await http.patch(`/contacts/${owner.id}`).set('If-Match', '1').send({ email: 'moved@x.io' }).expect(200);
      await http.post(`/contacts/${old}/restore`).set('If-Match', '2').expect(200);
    });

    it('exactly one of two racing restores of the same email wins', async () => {
      const a = await insertContact(db, { first: 'A', last: 'One', email: 'race@x.io', deletedAt: new Date().toISOString() });
      const b = await insertContact(db, { first: 'B', last: 'Two', email: 'race@x.io', deletedAt: new Date().toISOString() });
      const results = await Promise.all([a, b].map((id) => http.post(`/contacts/${id}/restore`).set('If-Match', '1')));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });
  });

  // ------------------------------------------------------------------ bulk delete
  describe('bulk delete', () => {
    it('trashes many, reports already-trashed and unknown ids, and logs one activity per contact', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) ids.push(await insertContact(db, { first: 'C', last: `N${i}` }));
      const foreign = await insertContact(db, { first: 'F', last: 'Other', account: ACCOUNT_B });
      const missing = '00000000-0000-4000-8000-000000000000';
      await http.delete(`/contacts/${ids[0]}`).set('If-Match', '1').expect(200);

      const res = await http.post('/contacts/bulk/delete').send({ contactIds: [...ids, foreign, missing, ids[1]] }).expect(200);
      expect(res.body).toMatchObject({ requested: 6, deleted: 3, alreadyInTrash: 1 });
      expect(res.body.notFound.sort()).toEqual([foreign, missing].sort());

      expect((await http.get('/contacts')).body.total).toBe(0);
      expect((await http.get('/contacts').query({ status: 'deleted' })).body.total).toBe(4);
      expect((await db.query(`SELECT deleted_at IS NULL AS active FROM contacts WHERE id = $1`, [foreign])).rows[0].active).toBe(true);
      expect((await db.query(`SELECT count(*)::int n FROM contact_activity WHERE type = 'CONTACT_DELETED'`)).rows[0].n).toBe(4);

      const again = await http.post('/contacts/bulk/delete').send({ contactIds: ids }).expect(200);
      expect(again.body).toMatchObject({ deleted: 0, alreadyInTrash: 4 });
    });

    it('validates the payload', async () => {
      await http.post('/contacts/bulk/delete').send({ contactIds: [] }).expect(400);
      await http.post('/contacts/bulk/delete').send({ contactIds: ['nope'] }).expect(400);
      await http.post('/contacts/bulk/delete').send({ contactIds: Array.from({ length: 1001 }, () => '00000000-0000-4000-8000-000000000000') }).expect(400);
    });
  });

  // ------------------------------------------------------------------ trash pagination
  describe('trash pagination', () => {
    it('pages through the trash with a stable cursor even when many rows share a deletion time', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 23; i++) ids.push(await insertContact(db, { first: 'T', last: `N${i}` }));
      await http.post('/contacts/bulk/delete').send({ contactIds: ids }).expect(200); // one statement => identical deleted_at

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res: any = await http.get('/contacts').query({ status: 'deleted', limit: 5, ...(cursor ? { cursor } : {}) }).expect(200);
        res.body.data.forEach((c: any) => seen.push(c.id));
        cursor = res.body.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(23);
      expect(new Set(seen).size).toBe(23);
    });
  });
});
