import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DatabaseService } from '../src/database/database.service';
import { FORMATS } from '../src/imports/formats';
import { ImportsWorker } from '../src/imports/imports.worker';
import { ACCOUNT_B, api, createApp, insertContact, KEY_A, KEY_B, resetDb } from './helpers';

describe('Async CSV import (real Postgres)', () => {
  let app: INestApplication;
  let db: DatabaseService;
  let worker: ImportsWorker;
  let http: ReturnType<typeof api>;

  beforeAll(async () => {
    ({ app, db } = await createApp());
    worker = app.get(ImportsWorker);
    http = api(app);
  });
  afterAll(() => app.close());
  beforeEach(() => resetDb(db));

  const upload = (csv: string | Buffer, mode: 'create' | 'update', opts: { key?: string; filename?: string; contentType?: string } = {}) =>
    request(app.getHttpServer())
      .post('/imports')
      .set('Authorization', `Bearer ${opts.key ?? KEY_A}`)
      .field('mode', mode)
      .attach('file', Buffer.isBuffer(csv) ? csv : Buffer.from(csv), { filename: opts.filename ?? 'contacts.csv', contentType: opts.contentType ?? 'text/csv' });

  /** upload -> worker validates -> returns the job in its 'ready' (or failed) state */
  const validated = async (csv: string, mode: 'create' | 'update' = 'create') => {
    const res = await upload(csv, mode).expect(202);
    await worker.drain();
    return (await http.get(`/imports/${res.body.id}`).expect(200)).body;
  };
  /** full run: validate, confirm, import */
  const imported = async (csv: string, mode: 'create' | 'update' = 'create') => {
    const job = await validated(csv, mode);
    await http.post(`/imports/${job.id}/confirm`).expect(202);
    await worker.drain();
    return (await http.get(`/imports/${job.id}`).expect(200)).body;
  };
  const count = async (sql = 'SELECT count(*)::int n FROM contacts') => (await db.query(sql)).rows[0].n as number;

  // ------------------------------------------------------------------ create: lifecycle
  describe('add new contacts', () => {
    const MIXED = [
      'first_name,last_name,email,phone,company,tags',
      'Ada,Lovelace,ada@x.io,+1 415 555 0172,Analytical Engines,VIP;Lead',
      'Grace,Hopper,GRACE@x.io,,US Navy,vip',
      'Alan,Turing,,,Bletchley Park,',
      'Bad,Email,not-an-email,,,',
      ',NoFirstName,nf@x.io,,,',
      'Dup,Email,ada@x.io,,,',
      'Bad,Phone,bp@x.io,12,,',
    ].join('\n');

    it('accepts the upload immediately (202, validating) and writes nothing until you confirm', async () => {
      const res = await upload(MIXED, 'create').expect(202);
      expect(res.body).toMatchObject({ status: 'validating', mode: 'create', filename: 'contacts.csv' });
      expect(await count()).toBe(0);

      await worker.drain();
      const job = (await http.get(`/imports/${res.body.id}`)).body;
      expect(job).toMatchObject({ status: 'ready', totalRows: 7, validRows: 3, errorRows: 4 });
      expect(await count()).toBe(0); // reviewing is read-only
    });

    it('reports each problem with its row number, field and a friendly message', async () => {
      const job = await validated(MIXED);
      const { body } = await http.get(`/imports/${job.id}/errors`).expect(200);
      expect(body.total).toBe(4);
      expect(body.data).toEqual([
        { row: 4, phase: 'validate', field: 'email', message: 'Not a valid email address' },
        { row: 5, phase: 'validate', field: 'first_name', message: 'First name is required' },
        { row: 6, phase: 'validate', field: 'email', message: 'Duplicate of row 1 in this file' },
        { row: 7, phase: 'validate', field: 'phone', message: 'Phone must be 7 to 15 digits' },
      ]);
    });

    it('imports the valid rows: normalised fields, de-duplicated tags, history, and a completed summary', async () => {
      const job = await imported(MIXED);
      expect(job).toMatchObject({ status: 'completed', createdCount: 3, errorRows: 4, processedRows: 7 });
      expect(job.finishedAt).not.toBeNull();

      const list = (await http.get('/contacts').query({ sort: 'name', order: 'asc' })).body.data;
      expect(list.map((c: any) => `${c.firstName} ${c.lastName}`)).toEqual(['Grace Hopper', 'Ada Lovelace', 'Alan Turing']);
      const grace = list[0];
      expect(grace).toMatchObject({ email: 'grace@x.io', version: 1 }); // lower-cased
      expect(list[1].tags.map((t: any) => t.name).sort()).toEqual(['Lead', 'VIP']);
      expect(grace.tags.map((t: any) => t.name)).toEqual(['VIP']); // "vip" reuses the existing tag
      expect((await http.get('/tags')).body.data).toHaveLength(2);

      const acts = (await http.get(`/contacts/${list[1].id}/activity`)).body.data;
      expect(acts.map((a: any) => a.type).sort()).toEqual(['CONTACT_CREATED', 'TAG_ADDED', 'TAG_ADDED']);
      expect(acts.every((a: any) => a.payload.import === job.id)).toBe(true);
      expect(await count('SELECT count(*)::int n FROM import_jobs WHERE file IS NOT NULL')).toBe(0); // file is dropped when finished
    });

    it('the shipped sample file imports cleanly', async () => {
      const job = await imported(FORMATS.create.sample);
      expect(job).toMatchObject({ status: 'completed', createdCount: 3, errorRows: 0 });
    });

    it('accepts header aliases, a BOM, CRLF, quoted commas/newlines, and ignores unknown columns (with a note)', async () => {
      const csv = '﻿First Name,LASTNAME,E-mail,Favourite colour,Company\r\nAda,Lovelace,ada@x.io,blue,"Acme, Inc."\r\nGrace,"Hop\nper",g@x.io,red,\r\n';
      const job = await imported(csv);
      expect(job).toMatchObject({ status: 'completed', createdCount: 2, notes: ['Ignored columns: Favourite colour'] });
      const { rows } = await db.query(`SELECT first_name, last_name, company FROM contacts ORDER BY first_name`);
      expect(rows).toEqual([
        { first_name: 'Ada', last_name: 'Lovelace', company: 'Acme, Inc.' },
        { first_name: 'Grace', last_name: 'Hop\nper', company: null },
      ]);
    });

    it('skips rows whose email already belongs to a contact, and never overwrites it', async () => {
      await insertContact(db, { first: 'Existing', last: 'Owner', email: 'taken@x.io', company: 'Original' });
      const job = await validated('first_name,last_name,email\nNew,Person,taken@x.io\nOther,Person,free@x.io');
      expect(job).toMatchObject({ validRows: 1, errorRows: 1 });
      expect((await http.get(`/imports/${job.id}/errors`)).body.data[0]).toMatchObject({ row: 1, message: 'Already used by Existing Owner' });
      await http.post(`/imports/${job.id}/confirm`).expect(202);
      await worker.drain();
      expect((await db.query(`SELECT company FROM contacts WHERE email = 'taken@x.io'`)).rows[0].company).toBe('Original');
    });

    it('can reuse the email of a trashed contact', async () => {
      await insertContact(db, { first: 'Old', last: 'Owner', email: 'reuse@x.io', deletedAt: new Date().toISOString() });
      expect(await imported('first_name,last_name,email\nNew,Owner,reuse@x.io')).toMatchObject({ status: 'completed', createdCount: 1 });
    });

    it('handles an email that was taken between review and import: that row is reported, the rest still import', async () => {
      const job = await validated('first_name,last_name,email\nA,One,race@x.io\nB,Two,fine@x.io');
      expect(job.validRows).toBe(2);
      await insertContact(db, { first: 'Sneaky', last: 'Writer', email: 'race@x.io' }); // someone else creates it meanwhile

      await http.post(`/imports/${job.id}/confirm`).expect(202);
      await worker.drain();
      const done = (await http.get(`/imports/${job.id}`)).body;
      expect(done).toMatchObject({ status: 'completed', createdCount: 1, errorRows: 1 });
      const errors = (await http.get(`/imports/${job.id}/errors`)).body.data;
      expect(errors).toEqual([{ row: 1, phase: 'import', field: 'email', message: 'Already used by another contact' }]);
      expect(await count(`SELECT count(*)::int n FROM contacts WHERE email IN ('race@x.io', 'fine@x.io')`)).toBe(2);
    });

    it('rows without an email can be imported (and repeated uploads create more of them)', async () => {
      const csv = 'first_name,last_name\nNo,Email';
      await imported(csv);
      await imported(csv);
      expect(await count()).toBe(2);
    });
  });

  // ------------------------------------------------------------------ files that cannot be used
  describe('unusable files', () => {
    it.each([
      ['a missing required column', 'first_name,email\nA,a@x.io', /Missing required column: last_name/],
      ['no data rows', 'first_name,last_name\n', /no data rows/],
      ['an unterminated quote', 'first_name,last_name\n"Ada,Lovelace\n', /not valid CSV/],
      ['a duplicated column', 'first_name,last_name,firstname\nA,B,C', /appears twice/],
    ])('fails the job with a clear reason for %s', async (_label, csv, reason) => {
      const job = await validated(csv);
      expect(job.status).toBe('failed');
      expect(job.failureReason).toMatch(reason);
      expect(await count()).toBe(0);
      expect(await count('SELECT count(*)::int n FROM import_jobs WHERE file IS NOT NULL')).toBe(0);
      await http.post(`/imports/${job.id}/confirm`).expect(409);
    });

    it('fails a file with more rows than the limit', async () => {
      const saved = process.env.IMPORT_MAX_ROWS;
      process.env.IMPORT_MAX_ROWS = '3';
      try {
        const job = await validated('first_name,last_name\nA,1\nB,2\nC,3\nD,4');
        expect(job).toMatchObject({ status: 'failed' });
        expect(job.failureReason).toMatch(/limit is 3/);
      } finally {
        process.env.IMPORT_MAX_ROWS = saved;
        if (saved === undefined) delete process.env.IMPORT_MAX_ROWS;
      }
    });

    it('rejects bad uploads synchronously with field errors', async () => {
      const bad = (res: request.Response, field: string) => {
        expect(res.status).toBe(400);
        expect(res.body.details[0].field).toBe(field);
      };
      bad(await upload('a,b\n1,2', 'create', { filename: 'data.xlsx', contentType: 'application/vnd.ms-excel' }), 'file');
      bad(await upload('a,b\n1,2', 'create', { filename: 'evil.csv', contentType: 'image/png' }), 'file');
      bad(await upload(Buffer.alloc(0), 'create'), 'file');
      bad(await upload(Buffer.from([0x50, 0x4b, 0x03, 0x00, 0x04]), 'create'), 'file'); // binary content
      bad(await upload('a,b\n1,2', 'delete' as any), 'mode');
      bad(await request(app.getHttpServer()).post('/imports').set('Authorization', `Bearer ${KEY_A}`).field('mode', 'create'), 'file');
    });

    it('rejects a file over the size limit with 413', async () => {
      const big = Buffer.alloc(5 * 1024 * 1024 + 10, 'a');
      const res = await upload(big, 'create');
      expect(res.status).toBe(413);
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  // ------------------------------------------------------------------ job state machine
  describe('confirm / cancel', () => {
    const csv = 'first_name,last_name\nA,One\nB,Two';

    it('only a ready job can be confirmed, and only once', async () => {
      const res = await upload(csv, 'create').expect(202);
      await http.post(`/imports/${res.body.id}/confirm`).expect(409); // still validating
      await worker.drain();
      await http.post(`/imports/${res.body.id}/confirm`).expect(202);
      const again = await http.post(`/imports/${res.body.id}/confirm`).expect(409);
      expect(again.body.code).toBe('IMPORT_NOT_READY');
      await worker.drain();
      expect(await count()).toBe(2); // not doubled
    });

    it('refuses to start an import with no valid rows', async () => {
      const job = await validated('first_name,last_name,email\nA,B,nope');
      expect(job).toMatchObject({ status: 'ready', validRows: 0 });
      const res = await http.post(`/imports/${job.id}/confirm`).expect(409);
      expect(res.body.code).toBe('NOTHING_TO_IMPORT');
    });

    it('cancelling a reviewed job discards it; completed jobs cannot be cancelled', async () => {
      const job = await validated(csv);
      const cancelled = await http.post(`/imports/${job.id}/cancel`).expect(200);
      expect(cancelled.body.status).toBe('cancelled');
      await http.post(`/imports/${job.id}/confirm`).expect(409);
      expect(await count()).toBe(0);
      expect(await count('SELECT count(*)::int n FROM import_jobs WHERE file IS NOT NULL')).toBe(0);

      const done = await imported(csv);
      expect((await http.post(`/imports/${done.id}/cancel`).expect(409)).body.code).toBe('IMPORT_NOT_CANCELLABLE');
    });

    it('a cancel that arrives while the file is being validated wins', async () => {
      const res = await upload(csv, 'create').expect(202);
      await http.post(`/imports/${res.body.id}/cancel`).expect(200);
      await worker.drain();
      expect((await http.get(`/imports/${res.body.id}`)).body.status).toBe('cancelled');
    });
  });

  // ------------------------------------------------------------------ resumability
  describe('chunking, resume and crash recovery', () => {
    const rows = (n: number) => 'first_name,last_name\n' + Array.from({ length: n }, (_, i) => `P${i},Person`).join('\n'); // no emails: duplicates would not be caught by the unique index

    it('imports in chunks, can stop midway and resume exactly where it left off', async () => {
      process.env.IMPORT_CHUNK_SIZE = '2';
      try {
        const job = await validated(rows(7));
        await http.post(`/imports/${job.id}/confirm`).expect(202);

        await worker.tick({ maxChunks: 1 });
        let mid = (await http.get(`/imports/${job.id}`)).body;
        expect(mid).toMatchObject({ status: 'importing', processedRows: 2, createdCount: 2 });
        expect(await count()).toBe(2);

        await worker.tick({ maxChunks: 2 });
        mid = (await http.get(`/imports/${job.id}`)).body;
        expect(mid).toMatchObject({ processedRows: 6, createdCount: 6 });

        await worker.drain();
        const done = (await http.get(`/imports/${job.id}`)).body;
        expect(done).toMatchObject({ status: 'completed', processedRows: 7, createdCount: 7 });
        expect(await count()).toBe(7); // each row exactly once
      } finally {
        process.env.IMPORT_CHUNK_SIZE = '500';
      }
    });

    it('a job whose worker crashed is picked up again once its lease expires', async () => {
      process.env.IMPORT_CHUNK_SIZE = '2';
      try {
        const job = await validated(rows(5));
        await http.post(`/imports/${job.id}/confirm`).expect(202);
        await worker.tick({ maxChunks: 1 });

        // simulate a worker that died while holding the job: lease still in the future
        await db.query(`UPDATE import_jobs SET lease_until = now() + interval '1 hour' WHERE id = $1`, [job.id]);
        expect(await worker.tick()).toBe(false); // nobody else may take it yet
        expect(await count()).toBe(2);

        await db.query(`UPDATE import_jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [job.id]);
        await worker.drain();
        expect((await http.get(`/imports/${job.id}`)).body).toMatchObject({ status: 'completed', createdCount: 5 });
        expect(await count()).toBe(5);
      } finally {
        process.env.IMPORT_CHUNK_SIZE = '500';
      }
    });
  });

  // ------------------------------------------------------------------ update mode
  describe('update existing contacts', () => {
    let ada: string;
    beforeEach(async () => {
      ada = await insertContact(db, { first: 'Ada', last: 'Lovelace', email: 'ada@x.io', phone: '555-010-1234', company: 'Old Co' });
      await insertContact(db, { first: 'Grace', last: 'Hopper', email: 'grace@x.io', phone: '555-020-9999', company: 'US Navy' });
      await insertContact(db, { first: 'Gone', last: 'Away', email: 'gone@x.io', deletedAt: new Date().toISOString() });
    });
    const get = async (email: string) => (await db.query(`SELECT * FROM contacts WHERE email = $1 AND deleted_at IS NULL`, [email])).rows[0];

    it('changes only the filled-in columns; blank is unchanged; [clear] empties; unchanged rows are counted', async () => {
      const job = await imported(
        ['email,first_name,phone,company,tags', 'ADA@x.io,,[clear],New Co,VIP;Customer', 'grace@x.io,,,US Navy,'].join('\n'),
        'update',
      );
      expect(job).toMatchObject({ status: 'completed', updatedCount: 1, unchangedCount: 1, errorRows: 0, createdCount: 0 });

      const a = await get('ada@x.io');
      expect(a).toMatchObject({ first_name: 'Ada', company: 'New Co', phone: null, version: 2 }); // name untouched, phone cleared
      const g = await get('grace@x.io');
      expect(g).toMatchObject({ version: 1, company: 'US Navy', phone: '555-020-9999' }); // no change => no version bump

      const acts = (await http.get(`/contacts/${ada}/activity`)).body.data;
      const upd = acts.find((x: any) => x.type === 'CONTACT_UPDATED');
      expect(upd.payload.changes).toEqual({ phone: { from: '555-010-1234', to: null }, company: { from: 'Old Co', to: 'New Co' } });
      expect(upd.payload.import).toBe(job.id);
      expect(acts.filter((x: any) => x.type === 'TAG_ADDED')).toHaveLength(2);
      expect((await http.get(`/contacts/${ada}`)).body.tags.map((t: any) => t.name).sort()).toEqual(['Customer', 'VIP']);
    });

    it('only ever adds tags, never removes them', async () => {
      await http.post(`/contacts/${ada}/tags`).send({ name: 'Keep' }).expect(201);
      await imported('email,tags\nada@x.io,Extra', 'update');
      expect((await http.get(`/contacts/${ada}`)).body.tags.map((t: any) => t.name).sort()).toEqual(['Extra', 'Keep']);
    });

    it('reports rows with no matching contact, trashed contacts, uncleared names and bad values', async () => {
      const job = await validated(
        ['email,first_name,phone', 'nobody@x.io,X,', 'gone@x.io,X,', 'ada@x.io,[clear],', 'grace@x.io,,12', ',X,', 'ada@x.io,Dup,'].join('\n'),
        'update',
      );
      expect(job).toMatchObject({ validRows: 0, errorRows: 6 });
      const messages = (await http.get(`/imports/${job.id}/errors`)).body.data.map((e: any) => `${e.row}:${e.message}`);
      expect(messages).toEqual([
        '1:No contact has this email',
        '2:This contact is in the trash',
        "3:First name can't be cleared",
        '4:Phone must be 7 to 15 digits',
        '5:Email is required to find the contact',
        '6:Duplicate of row 3 in this file',
      ]);
    });

    it('rejects update files that lack the key or have nothing to change', async () => {
      expect((await validated('first_name,phone\nA,555-010-9999', 'update')).failureReason).toMatch(/Missing required column: email/);
      expect((await validated('email\nada@x.io', 'update')).failureReason).toMatch(/at least one column to change/);
    });

    it('the shipped update sample works against contacts created from the add sample', async () => {
      await imported(FORMATS.create.sample, 'create');
      const job = await imported(FORMATS.update.sample, 'update');
      expect(job).toMatchObject({ status: 'completed', errorRows: 0, updatedCount: 2 });
    });

    it('does not touch contacts that were modified in the app after the review (it applies the file on top, atomically per row)', async () => {
      const job = await validated('email,company\nada@x.io,From File', 'update');
      await http.patch(`/contacts/${ada}`).set('If-Match', '1').send({ phone: '555-777-0000' }).expect(200); // edited in the UI meanwhile
      await http.post(`/imports/${job.id}/confirm`).expect(202);
      await worker.drain();
      expect(await get('ada@x.io')).toMatchObject({ company: 'From File', phone: '555-777-0000', version: 3 });
    });
  });

  // ------------------------------------------------------------------ rejected rows download
  describe('rejected rows CSV', () => {
    it('contains the original rows plus an error column, ready to fix and upload again', async () => {
      const job = await validated('first_name,last_name,email,company\nAda,Lovelace,ada@x.io,Acme\nBad,Row,nope,"Acme, Inc."\n=cmd,Evil,evil@x.io,');
      const res = await http.get(`/imports/${job.id}/errors.csv`).expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('contacts-errors.csv');
      const lines = res.text.trim().split('\r\n');
      expect(lines[0]).toBe('first_name,last_name,email,company,error');
      expect(lines).toHaveLength(2); // header + the one bad row (row 3 is valid text, just a weird name)
      expect(lines[1]).toBe('Bad,Row,nope,"Acme, Inc.",email: Not a valid email address');
    });

    it('neutralises formula injection in rejected rows', async () => {
      const job = await validated('first_name,last_name,email\n"=HYPERLINK(""http://evil"")",X,nope');
      const res = await http.get(`/imports/${job.id}/errors.csv`).expect(200);
      expect(res.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    });
  });

  // ------------------------------------------------------------------ listing, formats, isolation
  describe('history, formats and tenant isolation', () => {
    it('lists your imports newest first with live progress counters', async () => {
      await imported('first_name,last_name\nA,One');
      const second = await validated('first_name,last_name\nB,Two');
      const list = (await http.get('/imports')).body.data;
      expect(list.map((j: any) => j.id)[0]).toBe(second.id);
      expect(list).toHaveLength(2);
      expect(list.find((j: any) => j.status === 'completed')).toMatchObject({ createdCount: 1, totalRows: 1, validRows: 1 });
    });

    it('serves the format guide and downloadable samples', async () => {
      const formats = (await http.get('/imports/formats').expect(200)).body;
      expect(formats.map((f: any) => f.mode)).toEqual(['create', 'update']);
      expect(formats[0].columns.find((c: any) => c.column === 'first_name')).toMatchObject({ required: true });
      expect(formats[1].columns.find((c: any) => c.column === 'email')).toMatchObject({ required: true });
      expect(formats[0].sample).toBeUndefined();

      const sample = await http.get('/imports/templates/create').expect(200);
      expect(sample.headers['content-disposition']).toContain('contacts-add-sample.csv');
      expect(sample.text.split('\n')[0]).toBe('first_name,last_name,email,phone,company,tags');
      await http.get('/imports/templates/other').expect(404);
    });

    it('keeps imports private to the account', async () => {
      const job = await validated('first_name,last_name,email\nA,B,nope');
      const other = api(app, KEY_B);
      await other.get(`/imports/${job.id}`).expect(404);
      await other.get(`/imports/${job.id}/errors`).expect(404);
      await other.get(`/imports/${job.id}/errors.csv`).expect(404);
      await other.post(`/imports/${job.id}/confirm`).expect(404);
      await other.post(`/imports/${job.id}/cancel`).expect(404);
      expect((await other.get('/imports')).body.data).toEqual([]);
      await request(app.getHttpServer()).get('/imports').expect(401);
    });

    it('imports into the uploader\'s account only', async () => {
      await upload('first_name,last_name\nA,B', 'create', { key: KEY_B }).expect(202);
      await worker.drain();
      const { rows } = await db.query(`SELECT account_id FROM import_jobs`);
      expect(rows[0].account_id).toBe(ACCOUNT_B);
    });
  });
});
