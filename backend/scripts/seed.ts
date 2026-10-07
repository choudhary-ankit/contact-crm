/**
 * Seed script. Usage:  npm run seed            (25,000 contacts)
 *                      SEED_COUNT=1000000 npm run seed   (scale demo)
 * Deterministic (seeded PRNG) so every run produces the same dataset. Re-running replaces the demo accounts' data.
 */
import { Pool } from 'pg';
import { loadConfig } from '../src/config';
import { runMigrations } from '../src/database/migrate';

const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222';
const COUNT = Number(process.argv[2] ?? process.env.SEED_COUNT ?? 25_000);
const BATCH = 5_000;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)];

const FIRST = ['Ada','Alan','Grace','Linus','Margaret','Dennis','Barbara','Ken','Radia','Tim','Hedy','Donald','Frances','Guido','Sophie','James','Maria','Liam','Olivia','Noah','Emma','Oliver','Ava','Elijah','Mia','Lucas','Amelia','Mason','Harper','Ethan','Evelyn','Logan','Abigail','Aiden','Ella','Jackson','Scarlett','Sebastian','Aria','Mateo','Chloe','Henry','Layla','Owen','Riley','Wyatt','Zoe','Carter','Nora','Julian','Priya','Rohan','Ananya','Arjun','Wei','Mei','Hiro','Yuki','Fatima','Omar','Sofia','Diego','Lucia','Mateus','Ingrid','Lars'] as const;
const LAST = ['Lovelace','Turing','Hopper','Torvalds','Hamilton','Ritchie','Liskov','Thompson','Perlman','Berners-Lee','Lamarr','Knuth','Allen','van Rossum','Wilson','Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin','Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson','Walker','Young','Allen','King','Wright','Scott','Torres','Nguyen','Hill','Flores','Green','Adams','Nelson','Baker','Hall','Rivera','Campbell','Mitchell','Carter','Roberts','Patel','Sharma','Gupta','Kumar','Singh','Chen','Wang','Tanaka','Kim'] as const;
const COMPANY_A = ['Acme','Globex','Initech','Umbrella','Hooli','Stark','Wayne','Wonka','Soylent','Cyberdyne','Tyrell','Aperture','Pied Piper','Dunder','Vandelay','Oscorp','Massive','Sterling','Bluth','Gringotts'] as const;
const COMPANY_B = ['Industries','Labs','Group','Logistics','Systems','Holdings','Partners','Motors','Dealerships','Auto','Capital','Solutions'] as const;
const DOMAINS = ['gmail.com','outlook.com','yahoo.com','example.com','acme.io','mail.test'] as const;
const TAGS: Array<[string, number]> = [['Lead', 0.25], ['Customer', 0.3], ['VIP', 0.03], ['Prospect', 0.2], ['Partner', 0.05], ['Churned', 0.08]];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
const phone = () => `(${200 + Math.floor(rand() * 799)}) ${200 + Math.floor(rand() * 799)}-${String(Math.floor(rand() * 10000)).padStart(4, '0')}`;

interface Row { first: string; last: string; email: string | null; phone: string | null; company: string | null; createdAt: string }

function makeRow(i: number, now: number): Row {
  const first = pick(FIRST);
  const last = pick(LAST);
  return {
    first,
    last,
    email: rand() < 0.07 ? null : `${slug(first)}.${slug(last)}.${i}@${pick(DOMAINS)}`, // index suffix keeps emails unique
    phone: rand() < 0.15 ? null : phone(),
    company: rand() < 0.1 ? null : `${pick(COMPANY_A)} ${pick(COMPANY_B)}`,
    createdAt: new Date(now - Math.floor(rand() * 730 * 86_400_000)).toISOString(),
  };
}

async function insertBatch(pool: Pool, accountId: string, rows: Row[]) {
  await pool.query(
    `INSERT INTO contacts (account_id, first_name, last_name, email, phone, company, created_at, updated_at)
     SELECT $1, f, l, e, p, c, ts, ts FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::timestamptz[]) AS t(f, l, e, p, c, ts)`,
    [accountId, rows.map((r) => r.first), rows.map((r) => r.last), rows.map((r) => r.email), rows.map((r) => r.phone), rows.map((r) => r.company), rows.map((r) => r.createdAt)],
  );
}

async function seedAccount(pool: Pool, accountId: string, count: number, demo: Row[]) {
  await pool.query('DELETE FROM import_jobs WHERE account_id = $1', [accountId]); // cascades their row errors
  await pool.query('DELETE FROM contacts WHERE account_id = $1', [accountId]); // cascades tags links + activity
  await pool.query('DELETE FROM tags WHERE account_id = $1', [accountId]);

  const now = Date.now();
  await insertBatch(pool, accountId, demo);
  for (let done = 0; done < count; done += BATCH) {
    const n = Math.min(BATCH, count - done);
    await insertBatch(pool, accountId, Array.from({ length: n }, (_, k) => makeRow(done + k, now)));
    process.stdout.write(`\r  account ${accountId.slice(0, 4)}: ${Math.min(done + n, count).toLocaleString()} / ${count.toLocaleString()}`);
  }
  process.stdout.write('\n');

  for (const [name, p] of TAGS) {
    await pool.query(
      `WITH t AS (INSERT INTO tags (account_id, name) VALUES ($1, $2) RETURNING id)
       INSERT INTO contact_tags (contact_id, tag_id)
       SELECT c.id, t.id FROM contacts c, t WHERE c.account_id = $1 AND random() < $3`,
      [accountId, name, p],
    );
  }
  // every demo contact has at least one tag so the tag UI is visible on the first page
  await pool.query(
    `INSERT INTO contact_tags (contact_id, tag_id)
     SELECT c.id, (SELECT id FROM tags WHERE account_id = $1 AND name = 'VIP') FROM contacts c
     WHERE c.account_id = $1 AND c.email = ANY($2::text[]) ON CONFLICT DO NOTHING`,
    [accountId, demo.map((d) => d.email)],
  );
}

/** Puts the two demo contacts plus ~10 random ones in the trash, with matching history. */
async function seedTrash(pool: Pool, accountId: string) {
  await pool.query(
    `WITH picked AS (
       SELECT id FROM contacts WHERE account_id = $1 AND email IN ('jon.snow@example.com', 'tony.stark@stark.example')
       UNION ALL
       (SELECT id FROM contacts WHERE account_id = $1 AND email IS NOT NULL AND email NOT LIKE '%@example.com' ORDER BY random() LIMIT 10)
     ), del AS (
       UPDATE contacts c SET deleted_at = now() - (random() * interval '10 days'), version = 2, updated_at = now()
       FROM picked p WHERE c.id = p.id RETURNING c.id, c.deleted_at
     )
     INSERT INTO contact_activity (account_id, contact_id, type, payload, created_at)
     SELECT $1, id, 'CONTACT_DELETED', '{"version": 2}'::jsonb, deleted_at FROM del`,
    [accountId],
  );
}

async function seedActivity(pool: Pool, accountId: string) {
  // history for the 2,000 newest contacts: their tag assignments + a few field edits
  await pool.query(
    `WITH recent AS (SELECT id, created_at FROM contacts WHERE account_id = $1 ORDER BY created_at DESC LIMIT 2000)
     INSERT INTO contact_activity (account_id, contact_id, type, payload, created_at)
     SELECT $1, ct.contact_id, 'TAG_ADDED', jsonb_build_object('tag', jsonb_build_object('id', t.id, 'name', t.name)),
            r.created_at + interval '1 hour'
     FROM contact_tags ct JOIN recent r ON r.id = ct.contact_id JOIN tags t ON t.id = ct.tag_id`,
    [accountId],
  );
  await pool.query(
    `INSERT INTO contact_activity (account_id, contact_id, type, payload, created_at)
     SELECT $1, id, 'CONTACT_UPDATED', jsonb_build_object('changes', jsonb_build_object('company', jsonb_build_object('from', NULL, 'to', company)), 'version', 2),
            created_at + interval '2 hours'
     FROM (SELECT id, company, created_at FROM contacts WHERE account_id = $1 AND company IS NOT NULL ORDER BY created_at DESC LIMIT 500) x`,
    [accountId],
  );
}

(async () => {
  const pool = new Pool({ connectionString: loadConfig().databaseUrl });
  await runMigrations(pool);
  const t0 = Date.now();
  const now = Date.now();

  // fixed, memorable records for the README walkthrough (incl. identical names to exercise sort ties)
  const demo: Row[] = [
    { first: 'Ada', last: 'Lovelace', email: 'ada.lovelace@analytical.io', phone: '+1 (555) 010-1234', company: 'Analytical Engines', createdAt: new Date(now - 5 * 86_400_000).toISOString() },
    { first: 'Grace', last: 'Hopper', email: 'grace.hopper@navy.example', phone: '555-020-9999', company: 'US Navy', createdAt: new Date(now - 4 * 86_400_000).toISOString() },
    { first: 'Alan', last: 'Turing', email: 'alan.turing@bletchley.example', phone: null, company: 'Bletchley Park', createdAt: new Date(now - 3 * 86_400_000).toISOString() },
    { first: 'Sam', last: 'Smith', email: 'sam.smith.a@example.com', phone: '(415) 555-0101', company: 'Acme Auto', createdAt: new Date(now - 2 * 86_400_000).toISOString() },
    { first: 'Sam', last: 'Smith', email: null, phone: '(415) 555-0102', company: 'Acme Auto', createdAt: new Date(now - 2 * 86_400_000).toISOString() },
    // these two start in the trash (see seedTrash)
    { first: 'Jon', last: 'Snow', email: 'jon.snow@example.com', phone: '(555) 010-0001', company: "Night's Watch", createdAt: new Date(now - 30 * 86_400_000).toISOString() },
    { first: 'Tony', last: 'Stark', email: 'tony.stark@stark.example', phone: '(555) 010-0002', company: 'Stark Industries', createdAt: new Date(now - 40 * 86_400_000).toISOString() },
  ];

  console.log(`Seeding ${COUNT.toLocaleString()} contacts for account A (demo-key) ...`);
  await seedAccount(pool, ACCOUNT_A, COUNT, demo);
  await seedActivity(pool, ACCOUNT_A);
  await seedTrash(pool, ACCOUNT_A);
  console.log('Seeding 25 contacts for account B (demo-key-2, tenant isolation demo) ...');
  await seedAccount(pool, ACCOUNT_B, 25, []);

  await pool.query('ANALYZE contacts');
  await pool.query('ANALYZE contact_tags');
  const { rows } = await pool.query(
    `SELECT (SELECT count(*) FROM contacts)::int AS contacts, (SELECT count(*) FROM contact_tags)::int AS links, (SELECT count(*) FROM contact_activity)::int AS activity`,
  );
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, rows[0]);
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
