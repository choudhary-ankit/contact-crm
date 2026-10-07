import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DatabaseService } from '../src/database/database.service';
import { ImportsWorker } from '../src/imports/imports.worker';
import { ACCOUNT_A, api, createApp, insertContact, KEY_A, KEY_B, resetDb } from './helpers';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const utcDate = (iso: string) => iso.slice(0, 10);

describe('Metrics, attention filters and export (real Postgres)', () => {
  let app: INestApplication;
  let db: DatabaseService;
  let http: ReturnType<typeof api>;

  beforeAll(async () => {
    ({ app, db } = await createApp());
    http = api(app);
  });
  afterAll(() => app.close());
  beforeEach(() => resetDb(db));

  // ------------------------------------------------------------------ dataset
  /**
   * Active: A1..A7.  Trash: T1.
   *  A1 email+phone+company, tagged VIP         created 2d ago
   *  A2 email only, tagged Lead, edited today   created 5d ago
   *  A3 phone only, STALE (updated 120d ago)    created 40d ago  (previous 30-day window)
   *  A4 company only (no email, no phone)       created 10d ago
   *  A5 email + phone 555-010-1234, tagged VIP  created 3d ago   } same phone
   *  A6 phone (555) 010-1234                    created 3d ago   }
   *  A7 email only; was trashed then restored   created 1d ago
   *  T1 in the trash                            created 1d ago
   */
  async function seed() {
    const ids: Record<string, string> = {};
    ids.A1 = await insertContact(db, { first: 'A1', last: 'Full', email: 'a1@x.io', phone: '+1 415 555 0001', company: 'Acme', createdAt: daysAgo(2) });
    ids.A2 = await insertContact(db, { first: 'A2', last: 'Email', email: 'a2@x.io', createdAt: daysAgo(5) });
    ids.A3 = await insertContact(db, { first: 'A3', last: 'Stale', phone: '+1 415 555 0003', createdAt: daysAgo(40), updatedAt: daysAgo(120) });
    ids.A4 = await insertContact(db, { first: 'A4', last: 'Nothing', company: 'Ghost Co', createdAt: daysAgo(10) });
    ids.A5 = await insertContact(db, { first: 'A5', last: 'DupOne', email: 'a5@x.io', phone: '555-010-1234', createdAt: daysAgo(3) });
    ids.A6 = await insertContact(db, { first: 'A6', last: 'DupTwo', phone: '(555) 010-1234', createdAt: daysAgo(3) });
    ids.A7 = await insertContact(db, { first: 'A7', last: 'Restored', email: 'a7@x.io', createdAt: daysAgo(1) });
    ids.T1 = await insertContact(db, { first: 'T1', last: 'Trashed', email: 't1@x.io', createdAt: daysAgo(1) });

    // activity through the real API so the numbers come from real events
    await http.post(`/contacts/${ids.A1}/tags`).send({ name: 'VIP' }).expect(201);
    await http.post(`/contacts/${ids.A5}/tags`).send({ name: 'VIP' }).expect(201);
    await http.post(`/contacts/${ids.A2}/tags`).send({ name: 'Lead' }).expect(201);
    await http.patch(`/contacts/${ids.A2}`).set('If-Match', '1').send({ company: 'Edited Co' }).expect(200);
    await http.delete(`/contacts/${ids.T1}`).set('If-Match', '1').expect(200);
    await http.delete(`/contacts/${ids.A7}`).set('If-Match', '1').expect(200);
    await http.post(`/contacts/${ids.A7}/restore`).set('If-Match', '2').expect(200);

    await db.query(
      `INSERT INTO import_jobs (account_id, mode, filename, status, total_rows, valid_rows, error_rows, created_count, updated_count, unchanged_count, processed_rows)
       VALUES ($1, 'create', 'ok.csv', 'completed', 100, 95, 5, 80, 10, 5, 100), ($1, 'create', 'bad.csv', 'failed', NULL, NULL, 0, 0, 0, 0, 0)`,
      [ACCOUNT_A],
    );
    return ids;
  }

  // ------------------------------------------------------------------ metrics
  describe('GET /metrics', () => {
    it('computes every number from the data', async () => {
      await seed();
      const m = (await http.get('/metrics').query({ range: 30 }).expect(200)).body;

      expect(m.range).toBe(30);
      expect(m.contacts).toEqual({ active: 7, newInRange: 6, newPrevRange: 1, changePct: 500, inTrash: 1 });
      expect(m.quality).toMatchObject({
        withEmail: 4, withPhone: 4, withCompany: 3, // A2 now has a company
        noContactInfo: 1, reachable: 6,
        untagged: 4, // A3, A4, A6, A7
        stale: 1, staleDays: 90,
        duplicatePhoneContacts: 2, duplicatePhoneGroups: 1,
      });
      expect(m.tags).toEqual([{ name: 'VIP', count: 2 }, { name: 'Lead', count: 1 }]);
      expect(m.trash).toEqual({ current: 1, deletedInRange: 2, restoredInRange: 1 });
      expect(m.imports).toEqual({
        jobs: 2, completed: 1, failed: 1, rowsCreated: 80, rowsUpdated: 10, rowsRejected: 5, rowsSubmitted: 100, acceptRate: 95,
      });
      const types = Object.fromEntries(m.activity.map((a: any) => [a.type, a.count]));
      expect(types).toMatchObject({ TAG_ADDED: 3, CONTACT_UPDATED: 1, CONTACT_DELETED: 2, CONTACT_RESTORED: 1 });
    });

    it('returns one point per UTC day, with zeros for quiet days, on the right dates', async () => {
      await seed();
      const m = (await http.get('/metrics').query({ range: 7 })).body;
      expect(m.daily).toHaveLength(7);
      expect(m.daily[6].date).toBe(utcDate(new Date().toISOString())); // ends today
      const byDate = Object.fromEntries(m.daily.map((d: any) => [d.date, d]));
      expect(byDate[utcDate(daysAgo(2))].created).toBe(1); // A1
      expect(byDate[utcDate(daysAgo(3))].created).toBe(2); // A5 + A6
      expect(byDate[utcDate(daysAgo(1))].created).toBe(1); // A7 (T1 is trashed so it is not counted)
      expect(byDate[utcDate(daysAgo(4))].created).toBe(0);
      expect(byDate[utcDate(new Date().toISOString())].edits).toBe(1);
      // range changes the window, not the totals
      expect(m.contacts.active).toBe(7);
      expect(m.contacts.newInRange).toBe(5); // A4 (10 days ago) and A3 fall outside 7 days... A2 5d, A1 2d, A5, A6, A7 inside
    });

    it('supports 7, 30 and 90 days and rejects anything else', async () => {
      for (const r of [7, 30, 90]) expect((await http.get('/metrics').query({ range: r }).expect(200)).body.daily).toHaveLength(r);
      expect((await http.get('/metrics').expect(200)).body.range).toBe(30); // default
      for (const bad of ['15', 'abc', '0']) {
        const res = await http.get('/metrics').query({ range: bad }).expect(400);
        expect(res.body.details[0].field).toBe('range');
      }
    });

    it('an empty account is all zeros (no division by zero) and sees nothing of other accounts', async () => {
      await seed();
      const m = (await api(app, KEY_B).get('/metrics').expect(200)).body;
      expect(m.contacts).toEqual({ active: 0, newInRange: 0, newPrevRange: 0, changePct: null, inTrash: 0 });
      expect(m.quality).toMatchObject({ withEmail: 0, noContactInfo: 0, reachable: 0, untagged: 0, stale: 0, duplicatePhoneContacts: 0 });
      expect(m.tags).toEqual([]);
      expect(m.imports).toMatchObject({ jobs: 0, acceptRate: null });
      expect(m.daily.every((d: any) => d.created === 0 && d.edits === 0)).toBe(true);
      await request(app.getHttpServer()).get('/metrics').expect(401);
    });

    it('counts imported contacts (the metrics reflect real import activity)', async () => {
      const worker = app.get(ImportsWorker);
      const up = await request(app.getHttpServer()).post('/imports').set('Authorization', `Bearer ${KEY_A}`).field('mode', 'create')
        .attach('file', Buffer.from('first_name,last_name,email\nA,B,imp@x.io\nC,D,nope'), { filename: 'i.csv', contentType: 'text/csv' }).expect(202);
      await worker.drain();
      await http.post(`/imports/${up.body.id}/confirm`).expect(202);
      await worker.drain();
      const m = (await http.get('/metrics')).body;
      expect(m.contacts.active).toBe(1);
      expect(m.imports).toMatchObject({ jobs: 1, completed: 1, rowsCreated: 1, rowsRejected: 1, rowsSubmitted: 2, acceptRate: 50 });
      expect(m.activity.find((a: any) => a.type === 'CONTACT_CREATED').count).toBe(1);
    });
  });

  // ------------------------------------------------------------------ attention filters
  describe('"needs attention" filters match the metrics exactly', () => {
    it.each([
      ['no_contact_info', 'noContactInfo', ['A4']],
      ['untagged', 'untagged', ['A3', 'A4', 'A6', 'A7']],
      ['stale', 'stale', ['A3']],
      ['duplicate_phone', 'duplicatePhoneContacts', ['A5', 'A6']],
    ])('?attention=%s lists the same contacts that metrics.quality.%s counts', async (attention, metric, expectedNames) => {
      await seed();
      const m = (await http.get('/metrics')).body;
      const list = (await http.get('/contacts').query({ attention, limit: 100 }).expect(200)).body;
      expect(list.total).toBe(m.quality[metric]);
      expect(list.data.map((c: any) => c.firstName).sort()).toEqual(expectedNames);
    });

    it('combines with search and other filters, and rejects misuse', async () => {
      await seed();
      expect((await http.get('/contacts').query({ attention: 'untagged', q: 'a4' })).body.data.map((c: any) => c.firstName)).toEqual(['A4']);
      expect((await http.get('/contacts').query({ attention: 'untagged', company: 'ghost' })).body.total).toBe(1);
      await http.get('/contacts').query({ attention: 'nonsense' }).expect(400);
      await http.get('/contacts').query({ attention: 'untagged', status: 'deleted' }).expect(400);
    });

    it('trashed contacts never count as attention items or duplicates', async () => {
      const a = await insertContact(db, { first: 'Live', last: 'One', phone: '555-010-9999' });
      const t = await insertContact(db, { first: 'Gone', last: 'Two', phone: '555-010-9999' });
      await http.delete(`/contacts/${t}`).set('If-Match', '1').expect(200);
      expect((await http.get('/metrics')).body.quality.duplicatePhoneContacts).toBe(0);
      expect((await http.get('/contacts').query({ attention: 'duplicate_phone' })).body.data).toEqual([]);
      void a;
    });
  });

  // ------------------------------------------------------------------ export
  describe('GET /contacts/export.csv', () => {
    const lines = (text: string) => text.replace(/^﻿/, '').trim().split('\r\n');

    beforeEach(async () => {
      const ada = await insertContact(db, { first: 'Ada', last: 'Lovelace', email: 'ada@x.io', phone: '+1 415 555 0172', company: 'Acme, Inc.' });
      await insertContact(db, { first: 'Grace', last: 'Hopper', email: 'grace@x.io' });
      const gone = await insertContact(db, { first: 'Gone', last: 'Away', email: 'gone@x.io' });
      await http.post(`/contacts/${ada}/tags`).send({ name: 'VIP' }).expect(201);
      await http.post(`/contacts/${ada}/tags`).send({ name: 'Lead' }).expect(201);
      await http.delete(`/contacts/${gone}`).set('If-Match', '1').expect(200);
    });

    it('streams a CSV in the update-import column order, with tags joined by ; and trashed contacts excluded', async () => {
      const res = await http.get('/contacts/export.csv').query({ sort: 'name', order: 'asc' }).expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('contacts.csv');
      expect(res.text.startsWith('﻿')).toBe(true); // BOM so Excel reads UTF-8
      expect(lines(res.text)).toEqual([
        'first_name,last_name,email,phone,company,tags',
        'Grace,Hopper,grace@x.io,,,',
        'Ada,Lovelace,ada@x.io,+1 415 555 0172,"Acme, Inc.",Lead;VIP',
      ]);
    });

    it('respects the same filters as the list', async () => {
      expect(lines((await http.get('/contacts/export.csv').query({ tags: 'vip' })).text)).toHaveLength(2); // header + Ada
      expect(lines((await http.get('/contacts/export.csv').query({ q: 'grace' })).text)[1]).toMatch(/^Grace,Hopper/);
      expect(lines((await http.get('/contacts/export.csv').query({ q: 'zzzz' })).text)).toHaveLength(1); // header only
    });

    it('returns a normal JSON error (not a broken CSV) for a bad request', async () => {
      const res = await http.get('/contacts/export.csv').query({ sort: 'deletedAt' }).expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      await request(app.getHttpServer()).get('/contacts/export.csv').expect(401);
    });

    it('pages through large result sets (more than one internal page)', async () => {
      await db.query(
        `INSERT INTO contacts (account_id, first_name, last_name, email)
         SELECT $1, 'Bulk', 'N' || g, 'bulk' || g || '@x.io' FROM generate_series(1, 2300) g`,
        [ACCOUNT_A],
      );
      const out = lines((await http.get('/contacts/export.csv').query({ q: 'bulk' })).text);
      expect(out).toHaveLength(2301);
      expect(new Set(out.slice(1).map((l) => l.split(',')[2])).size).toBe(2300); // no duplicates across pages
    });

    it('neutralises spreadsheet formulas but keeps phone numbers intact', async () => {
      await insertContact(db, { first: 'Evil', last: 'Cell', email: 'evil@x.io', phone: '+1 (415) 555-0172', company: '=cmd|\' /C calc\'!A0' });
      const row = lines((await http.get('/contacts/export.csv').query({ q: 'evil' })).text)[1];
      expect(row).toContain(`'=cmd`);
      expect(row).toContain('+1 (415) 555-0172'); // not prefixed
    });

    it('round-trips: export -> edit -> import as an update changes exactly what was edited', async () => {
      const worker = app.get(ImportsWorker);
      const exported = (await http.get('/contacts/export.csv').query({ q: 'grace' })).text.replace(/^﻿/, '');
      const edited = exported.replace('grace@x.io,,,', 'grace@x.io,555-020-9999,Navy,');
      const up = await request(app.getHttpServer()).post('/imports').set('Authorization', `Bearer ${KEY_A}`).field('mode', 'update')
        .attach('file', Buffer.from(edited), { filename: 'edited.csv', contentType: 'text/csv' }).expect(202);
      await worker.drain();
      const job = (await http.get(`/imports/${up.body.id}`)).body;
      expect(job).toMatchObject({ status: 'ready', validRows: 1, errorRows: 0 });
      await http.post(`/imports/${job.id}/confirm`).expect(202);
      await worker.drain();
      const grace = (await http.get('/contacts').query({ q: 'grace' })).body.data[0];
      expect(grace).toMatchObject({ phone: '555-020-9999', company: 'Navy', firstName: 'Grace' });
    });
  });
});
