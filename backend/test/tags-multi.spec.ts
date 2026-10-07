import { INestApplication } from '@nestjs/common';
import { DatabaseService } from '../src/database/database.service';
import { api, createApp, insertContact, KEY_B, resetDb } from './helpers';

describe('Adding several tags at once (real Postgres)', () => {
  let app: INestApplication;
  let db: DatabaseService;
  let http: ReturnType<typeof api>;
  let id: string;

  beforeAll(async () => {
    ({ app, db } = await createApp());
    http = api(app);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb(db);
    id = await insertContact(db, { first: 'Ada', last: 'Lovelace' });
  });

  const tagNames = async () => (await http.get(`/contacts/${id}`)).body.tags.map((t: any) => t.name);
  const activity = async () => (await http.get(`/contacts/${id}/activity`)).body.data;

  it('adds every tag in one request and returns the complete current tag list', async () => {
    const res = await http.post(`/contacts/${id}/tags`).send({ names: ['VIP', 'Lead', 'Customer'] }).expect(201);
    expect(res.body).toMatchObject({ added: true, addedCount: 3 });
    expect(res.body.tags.map((t: any) => t.name)).toEqual(['Customer', 'Lead', 'VIP']);
    expect(await tagNames()).toEqual(['Customer', 'Lead', 'VIP']);
  });

  it('records one TAG_ADDED per tag actually added, newest first', async () => {
    await http.post(`/contacts/${id}/tags`).send({ names: ['VIP', 'Lead'] }).expect(201);
    await http.post(`/contacts/${id}/tags`).send({ names: ['Customer'] }).expect(201);
    const acts = await activity();
    expect(acts.map((a: any) => a.payload.tag.name)).toEqual(['Customer', 'Lead', 'VIP']); // descending: latest action first
    expect(new Set(acts.map((a: any) => a.type))).toEqual(new Set(['TAG_ADDED']));
  });

  it('de-duplicates case-insensitively and skips tags the contact already has', async () => {
    await http.post(`/contacts/${id}/tags`).send({ name: 'VIP' }).expect(201);
    const res = await http.post(`/contacts/${id}/tags`).send({ names: ['vip', 'Lead', 'LEAD', 'Customer'] }).expect(201);
    expect(res.body.addedCount).toBe(2); // Lead + Customer
    expect(await tagNames()).toEqual(['Customer', 'Lead', 'VIP']);
    expect((await activity()).filter((a: any) => a.type === 'TAG_ADDED')).toHaveLength(3); // no duplicate event for VIP
  });

  it('is idempotent: if every tag is already there nothing is added or logged (200)', async () => {
    await http.post(`/contacts/${id}/tags`).send({ names: ['A', 'B'] }).expect(201);
    const res = await http.post(`/contacts/${id}/tags`).send({ names: ['a', 'B'] }).expect(200);
    expect(res.body).toMatchObject({ added: false, addedCount: 0 });
    expect(await activity()).toHaveLength(2);
  });

  it('is atomic: one invalid tag adds none of them', async () => {
    await http.post(`/contacts/${id}/tags`).send({ names: ['Good', 'bad,comma'] }).expect(400);
    expect(await tagNames()).toEqual([]);
    expect((await http.get('/tags')).body.data).toEqual([]);
  });

  it('validates the list', async () => {
    await http.post(`/contacts/${id}/tags`).send({ names: [] }).expect(400);
    await http.post(`/contacts/${id}/tags`).send({ names: ['ok', ''] }).expect(400);
    await http.post(`/contacts/${id}/tags`).send({ names: ['x'.repeat(51)] }).expect(400);
    await http.post(`/contacts/${id}/tags`).send({ names: Array.from({ length: 21 }, (_, i) => `t${i}`) }).expect(400);
    const neither = await http.post(`/contacts/${id}/tags`).send({}).expect(400);
    expect(neither.body.code).toBe('VALIDATION_ERROR');
  });

  it('still accepts the original single "name" form', async () => {
    const res = await http.post(`/contacts/${id}/tags`).send({ name: 'Solo' }).expect(201);
    expect(res.body.tags.map((t: any) => t.name)).toEqual(['Solo']);
  });

  it('cannot add tags to a trashed or another account\'s contact', async () => {
    await http.delete(`/contacts/${id}`).set('If-Match', '1').expect(200);
    expect((await http.post(`/contacts/${id}/tags`).send({ names: ['A', 'B'] }).expect(409)).body.code).toBe('CONTACT_DELETED');
    const other = await insertContact(db, { first: 'O', last: 'Ther' });
    await api(app, KEY_B).post(`/contacts/${other}/tags`).send({ names: ['A'] }).expect(404);
  });

  it('adding tags concurrently never loses any (every response is a consistent snapshot)', async () => {
    const results = await Promise.all(['A', 'B', 'C', 'D', 'E'].map((n) => http.post(`/contacts/${id}/tags`).send({ names: [n] })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await tagNames()).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(await activity()).toHaveLength(5);
  });
});
