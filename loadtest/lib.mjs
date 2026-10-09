// Shared helpers for the load tests. LOCAL USE ONLY: it reads fixtures straight from the Postgres container
// and samples CPU from Docker, so it is not meant to be pointed at a hosted environment.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..');

export const CONFIG = {
  api: process.env.API_URL ?? 'http://localhost:3400',
  apiNoCache: process.env.API_URL_NOCACHE ?? 'http://localhost:3401', // same API with METRICS_CACHE_TTL_MS=0
  key: process.env.API_KEY ?? 'load-test-key-0123456789abcdef',
  account: process.env.ACCOUNT_ID ?? '11111111-1111-4111-8111-111111111111',
  db: process.env.DB_NAME ?? 'crm_load',
  dbContainer: process.env.DB_CONTAINER ?? 'crm-contact-workspace-db-1',
  apiPid: process.env.API_PID ? Number(process.env.API_PID) : undefined,
  apiPidNoCache: process.env.API_PID_NOCACHE ? Number(process.env.API_PID_NOCACHE) : undefined,
};

/** Runs SQL inside the compose Postgres container and returns the rows as arrays of strings. */
export function sql(query, db = CONFIG.db) {
  const out = execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'db', 'psql', '-U', 'crm', '-d', db, '-tAF', '|', '-c', query],
    { cwd: ROOT, maxBuffer: 1 << 29 },
  ).toString();
  return out.split('\n').filter(Boolean).map((l) => l.split('|'));
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const cursor = (s, v, id) => b64({ s, v, id });

/** Picks a random element. */
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];

/** Walks through an array once (wrapping around), so mutating tests touch each contact only once where possible. */
export function walker(arr) {
  let i = 0;
  return () => arr[i++ % arr.length];
}

export function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Everything the scenarios need, harvested once from the database. */
export function loadFixtures({ writePool = 400_000 } = {}) {
  const A = CONFIG.account;
  const t = Date.now();
  const readIds = sql(`SELECT id FROM contacts TABLESAMPLE SYSTEM (1) WHERE account_id='${A}' AND deleted_at IS NULL LIMIT 8000`).map((r) => r[0]);
  const createdRows = sql(`SELECT id, created_at::text FROM contacts TABLESAMPLE SYSTEM (0.1) WHERE account_id='${A}' AND deleted_at IS NULL LIMIT 600`);
  const nameRows = sql(`SELECT id, name_sort FROM contacts TABLESAMPLE SYSTEM (0.1) WHERE account_id='${A}' AND deleted_at IS NULL LIMIT 600`);
  const sampleRows = sql(`SELECT first_name||' '||last_name, coalesce(email,''), coalesce(phone_digits,'') FROM contacts TABLESAMPLE SYSTEM (0.2) WHERE account_id='${A}' AND deleted_at IS NULL LIMIT 1000`);
  const writeIds = shuffle(
    sql(`SELECT id FROM contacts TABLESAMPLE SYSTEM (60) WHERE account_id='${A}' AND deleted_at IS NULL AND version=1 LIMIT ${writePool}`).map((r) => r[0]),
  );
  return {
    readIds,
    cursorsCreated: createdRows.map(([id, v]) => cursor('createdAt:desc', v, id)),
    cursorsName: nameRows.map(([id, v]) => cursor('name:asc', v, id)),
    names: sampleRows.map((r) => r[0]),
    emails: sampleRows.map((r) => r[1]).filter(Boolean).map((e) => e.split('@')[0]),
    phones: sampleRows.map((r) => r[2]).filter((p) => p.length >= 7).map((p) => p.slice(0, 7)),
    writeIds,
    seconds: ((Date.now() - t) / 1000).toFixed(1),
  };
}

/** CPU of the API process (one thread = up to ~100%) and of the database container, sampled once. */
export function sampleResources(pid = CONFIG.apiPid) {
  const out = {};
  try {
    if (pid) {
      out.apiCpu = Number(execFileSync('ps', ['-o', '%cpu=', '-p', String(pid)]).toString().trim());
      out.apiRssMb = Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024);
    }
    const s = execFileSync('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}', CONFIG.dbContainer]).toString().trim();
    const [cpu, mem] = s.split('|');
    out.dbCpu = Number(cpu.replace('%', ''));
    out.dbMem = mem.split('/')[0].trim();
  } catch {
    /* sampling is best-effort */
  }
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
