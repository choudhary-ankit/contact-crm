// Ramp-up load test: for every endpoint, raise the number of simultaneous clients step by step and record
// throughput, latency and CPU, stopping at the first step where the API "breaks".
//
//   node ramp.mjs                      # all scenarios
//   node ramp.mjs --only list-first-page,search-broad --dur 6 --label 1M --out results/1m.json
//
// BREAK = the first step where (a) more than 0.5% of requests fail (5xx, timeouts, connection errors, or an
// unexpected 4xx), or (b) the 99th percentile latency exceeds 2 seconds.
import autocannon from 'autocannon';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONFIG, cursor, loadFixtures, pick, sampleResources, shuffle, sleep, walker } from './lib.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : acc), []),
);
const DUR = Number(args.dur ?? 8); // seconds per step
const ONLY = args.only ? args.only.split(',') : null;
const LABEL = args.label ?? 'run';
const OUT = args.out ?? `results/${LABEL}.json`;

const LEVELS_LIGHT = [1, 8, 32, 64, 128, 256];
const LEVELS_MEDIUM = [1, 4, 8, 16, 32, 64, 128];
const LEVELS_HEAVY = [1, 2, 4, 8, 16, 32, 64];

const P99_LIMIT_MS = 2000;
const FAIL_LIMIT = 0.005;

console.log(`Loading fixtures from ${CONFIG.db} ...`);
const F = loadFixtures();
console.log(`  ${F.readIds.length} read ids, ${F.cursorsCreated.length} cursors, ${F.writeIds.length} write ids (${F.seconds}s)`);

const W = F.writeIds;
const slice = (from, to) => W.slice(from, to);
const nextUpdate = walker(slice(0, 250_000));
const nextDelete = walker(slice(250_000, 310_000));
const deleted = []; // ids soft-deleted by the delete scenario, restored by the restore scenario
const nextTagSingle = walker(slice(310_000, 360_000));
const nextTagMulti = walker(slice(360_000, 400_000));
const hotId = W[W.length - 1];
const subsets = (pool, size, n) => Array.from({ length: n }, () => JSON.stringify(shuffle([...pool]).slice(0, size)));
const bulkTag100 = subsets(F.readIds, 100, 200);
const bulkTag1000 = subsets(F.readIds, 1000, 40);
const bulkDelPool = slice(400_000 - 20_000, 400_000);
const bulkDelete100 = Array.from({ length: 200 }, (_, i) => JSON.stringify(bulkDelPool.slice((i * 100) % (bulkDelPool.length - 100), ((i * 100) % (bulkDelPool.length - 100)) + 100)));

const RUN = Date.now().toString(36);
let seq = 0;
const FIRST = ['Ava', 'Noah', 'Mia', 'Liam', 'Zoe', 'Omar', 'Priya', 'Hiro', 'Sofia', 'Lars'];
const LAST = ['Stone', 'Rivera', 'Khan', 'Nguyen', 'Brooks', 'Silva', 'Patel', 'Tanaka', 'Moreau', 'Berg'];

/** query: GET with a path built per request. */
const get = (name, title, path, o = {}) => ({ name, title, method: 'GET', make: typeof path === 'function' ? path : () => ({ path }), levels: LEVELS_MEDIUM, ...o });

const SCENARIOS = [
  // ---- infrastructure + tiny reads
  get('health', 'GET /health (one database ping)', '/health', { levels: LEVELS_LIGHT, noAuth: true, group: 'light' }),
  get('tags-list', 'GET /tags', '/tags', { levels: LEVELS_LIGHT, group: 'light' }),
  get('imports-formats', 'GET /imports/formats (static)', '/imports/formats', { levels: LEVELS_LIGHT, group: 'light' }),
  get('imports-list', 'GET /imports (history)', '/imports', { levels: LEVELS_LIGHT, group: 'light' }),
  get('get-contact', 'GET /contacts/:id', () => ({ path: `/contacts/${pick(F.readIds)}` }), { levels: LEVELS_LIGHT, group: 'light' }),
  get('get-activity', 'GET /contacts/:id/activity', () => ({ path: `/contacts/${pick(F.readIds)}/activity` }), { levels: LEVELS_LIGHT, group: 'light' }),

  // ---- list, sort, pagination
  get('list-first-page', 'GET /contacts (first page, newest first, with total)', '/contacts?limit=25', { group: 'list' }),
  get('list-first-page-name', 'GET /contacts (first page, sorted by name)', '/contacts?sort=name&order=asc&limit=25', { group: 'list' }),
  get('list-limit-100', 'GET /contacts?limit=100', '/contacts?limit=100', { group: 'list' }),
  get('list-deep-page', 'GET /contacts (random deep page via cursor, newest first)', () => ({ path: `/contacts?limit=25&cursor=${pick(F.cursorsCreated)}` }), { group: 'list' }),
  get('list-deep-page-name', 'GET /contacts (random deep page via cursor, by name)', () => ({ path: `/contacts?sort=name&order=asc&limit=25&cursor=${pick(F.cursorsName)}` }), { group: 'list' }),

  // ---- search
  get('search-name', 'GET /contacts?q=<full name> (selective)', () => ({ path: `/contacts?limit=25&q=${encodeURIComponent(pick(F.names))}` }), { group: 'search' }),
  get('search-email', 'GET /contacts?q=<email prefix> (very selective)', () => ({ path: `/contacts?limit=25&q=${encodeURIComponent(pick(F.emails))}` }), { group: 'search' }),
  get('search-phone', 'GET /contacts?q=<7 phone digits>', () => ({ path: `/contacts?limit=25&q=${pick(F.phones)}` }), { group: 'search' }),
  get('search-medium', 'GET /contacts?q=garc (about 1.5% of rows match)', '/contacts?limit=25&q=garc', { group: 'search', levels: LEVELS_HEAVY }),
  get('search-broad', 'GET /contacts?q=an (worst case: about a quarter of all rows match)', '/contacts?limit=25&q=an', { group: 'search', levels: LEVELS_HEAVY }),

  // ---- filters
  get('filter-tag-rare', 'GET /contacts?tags=VIP (3% of rows)', '/contacts?limit=25&tags=VIP', { group: 'filter' }),
  get('filter-tag-common', 'GET /contacts?tags=Customer (30% of rows)', '/contacts?limit=25&tags=Customer', { group: 'filter' }),
  get('filter-company', 'GET /contacts?company=acme', '/contacts?limit=25&company=acme', { group: 'filter', levels: LEVELS_HEAVY }),
  get('filter-combined', 'GET /contacts?q=garc&tags=Lead&company=group', '/contacts?limit=25&q=garc&tags=Lead&company=group', { group: 'filter', levels: LEVELS_HEAVY }),
  get('filter-date-range', 'GET /contacts?createdFrom&createdTo (one month)', '/contacts?limit=25&createdFrom=2026-01-01T00:00:00&createdTo=2026-01-31T23:59:59', { group: 'filter' }),
  get('attention-untagged', 'GET /contacts?attention=untagged (36% of rows)', '/contacts?limit=25&attention=untagged', { group: 'filter' }),
  get('attention-stale', 'GET /contacts?attention=stale', '/contacts?limit=25&attention=stale', { group: 'filter' }),
  get('attention-no-contact', 'GET /contacts?attention=no_contact_info (1% of rows)', '/contacts?limit=25&attention=no_contact_info', { group: 'filter', levels: LEVELS_HEAVY }),
  get('attention-duplicate-phone', 'GET /contacts?attention=duplicate_phone (groups every phone number)', '/contacts?limit=25&attention=duplicate_phone', { group: 'filter', levels: LEVELS_HEAVY }),
  get('trash-list', 'GET /contacts?status=deleted', '/contacts?limit=25&status=deleted&sort=deletedAt', { group: 'filter', levels: LEVELS_LIGHT }),

  // ---- aggregates + export
  get('metrics-cached', 'GET /metrics (30 s cache, the normal case)', '/metrics?range=30', { group: 'aggregate', levels: LEVELS_LIGHT }),
  get('metrics-uncached', 'GET /metrics (cache off: every request recomputes everything)', '/metrics?range=30', { group: 'aggregate', target: 'nocache', levels: LEVELS_HEAVY }),
  get('export-csv', 'GET /contacts/export.csv (streams 50,000 rows)', '/contacts/export.csv', { group: 'aggregate', levels: [1, 2, 4, 8, 16, 32] }),

  // ---- writes
  {
    name: 'create-contact', title: 'POST /contacts (create one)', method: 'POST', group: 'write', levels: LEVELS_MEDIUM,
    make: () => {
      const n = seq++;
      return { path: '/contacts', body: JSON.stringify({ firstName: pick(FIRST), lastName: pick(LAST), email: `load.${RUN}.${n}@loadtest.example`, company: 'Load Test Co' }) };
    },
  },
  {
    name: 'update-contact', title: 'PATCH /contacts/:id (different contacts)', method: 'PATCH', group: 'write', levels: LEVELS_MEDIUM, expect: [409],
    make: () => ({ path: `/contacts/${nextUpdate()}`, body: JSON.stringify({ company: `Load ${seq++}` }), headers: { 'if-match': '"1"' } }),
  },
  {
    name: 'update-same-contact', title: 'PATCH /contacts/:id (everyone edits the SAME contact: conflicts)', method: 'PATCH', group: 'write', levels: LEVELS_MEDIUM, expect: [409],
    make: () => ({ path: `/contacts/${hotId}`, body: JSON.stringify({ company: `Hot ${seq++}` }), headers: { 'if-match': '"1"' } }),
  },
  {
    name: 'tag-add-single', title: 'POST /contacts/:id/tags (1 tag)', method: 'POST', group: 'write', levels: LEVELS_MEDIUM,
    make: () => ({ path: `/contacts/${nextTagSingle()}/tags`, body: JSON.stringify({ names: ['LoadTag'] }) }),
  },
  {
    name: 'tag-add-multi', title: 'POST /contacts/:id/tags (5 tags at once)', method: 'POST', group: 'write', levels: LEVELS_MEDIUM,
    make: () => ({ path: `/contacts/${nextTagMulti()}/tags`, body: JSON.stringify({ names: ['LoadA', 'LoadB', 'LoadC', 'LoadD', 'LoadE'] }) }),
  },
  {
    name: 'bulk-tag-100', title: 'POST /contacts/bulk/tags (100 contacts)', method: 'POST', group: 'write', levels: LEVELS_HEAVY,
    make: () => ({ path: '/contacts/bulk/tags', body: `{"contactIds":${pick(bulkTag100)},"tag":"BulkLoad"}` }),
  },
  {
    name: 'bulk-tag-1000', title: 'POST /contacts/bulk/tags (1,000 contacts, the maximum)', method: 'POST', group: 'write', levels: LEVELS_HEAVY,
    make: () => ({ path: '/contacts/bulk/tags', body: `{"contactIds":${pick(bulkTag1000)},"tag":"BulkLoadBig"}` }),
  },
  {
    name: 'delete-contact', title: 'DELETE /contacts/:id (soft delete)', method: 'DELETE', group: 'write', levels: LEVELS_MEDIUM, expect: [409],
    make: () => {
      const id = nextDelete();
      deleted.push(id);
      return { path: `/contacts/${id}`, headers: { 'if-match': '"1"' } };
    },
  },
  {
    name: 'restore-contact', title: 'POST /contacts/:id/restore', method: 'POST', group: 'write', levels: LEVELS_MEDIUM, expect: [409],
    make: () => {
      const i = seq++ % Math.max(1, deleted.length);
      return { path: `/contacts/${deleted[i]}/restore`, headers: { 'if-match': '"2"' } };
    },
  },
  {
    name: 'bulk-delete-100', title: 'POST /contacts/bulk/delete (100 contacts)', method: 'POST', group: 'write', levels: LEVELS_HEAVY,
    make: () => ({ path: '/contacts/bulk/delete', body: `{"contactIds":${pick(bulkDelete100)}}` }),
  },
].filter((s) => !ONLY || ONLY.includes(s.name));

// ------------------------------------------------------------------------------------------------ engine

function runStep(scn, connections, duration) {
  const base = scn.target === 'nocache' ? CONFIG.apiNoCache : CONFIG.api;
  const headers = scn.noAuth ? {} : { authorization: `Bearer ${CONFIG.key}` };
  if (scn.method !== 'GET') headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const inst = autocannon(
      {
        url: base,
        connections,
        duration,
        timeout: 15,
        headers,
        requests: [
          {
            method: scn.method,
            setupRequest: (req) => {
              const r = scn.make();
              req.path = r.path;
              if (r.body !== undefined) req.body = r.body;
              if (r.headers) req.headers = { ...req.headers, ...r.headers };
              return req;
            },
          },
        ],
      },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
    autocannon.track(inst, { renderProgressBar: false, renderResultsTable: false, renderLatencyTable: false });
  });
}

function digest(r, c, resources) {
  const codes = r.statusCodeStats ?? {};
  const count = (pred) => Object.entries(codes).reduce((n, [code, v]) => (pred(Number(code)) ? n + v.count : n), 0);
  return {
    c,
    rps: Math.round(r.requests.total / r.duration),
    p50: r.latency.p50,
    p97: r.latency.p97_5,
    p99: r.latency.p99,
    max: r.latency.max,
    total: r.requests.total,
    ok: count((s) => s >= 200 && s < 300),
    s4xx: count((s) => s >= 400 && s < 500),
    s5xx: count((s) => s >= 500),
    errors: r.errors,
    timeouts: r.timeouts,
    mbps: +(r.throughput.average / 1e6).toFixed(1),
    ...resources,
  };
}

function verdict(scn, step) {
  const expected = new Set(scn.expect ?? []);
  const codes = step.codes ?? {};
  const unexpected4xx = Object.entries(codes).reduce((n, [code, v]) => (Number(code) >= 400 && Number(code) < 500 && !expected.has(Number(code)) ? n + v.count : n), 0);
  const failures = step.s5xx + step.errors + step.timeouts + unexpected4xx;
  const failRate = failures / Math.max(1, step.total + step.errors + step.timeouts);
  if (failRate > FAIL_LIMIT) return `${(failRate * 100).toFixed(1)}% of requests failed (${step.s5xx} server errors, ${step.errors + step.timeouts} timeouts or connection errors, ${unexpected4xx} unexpected 4xx)`;
  if (step.p99 > P99_LIMIT_MS) return `p99 latency ${step.p99} ms exceeds ${P99_LIMIT_MS} ms`;
  return null;
}

async function ramp(scn) {
  const levels = scn.levels;
  // warm-up (discarded): fill caches and JIT without counting
  await runStep(scn, Math.min(8, levels[1] ?? 4), 3).catch(() => undefined);
  const steps = [];
  let breakAt = null;
  for (const c of levels) {
    let resources = {};
    const pid = scn.target === 'nocache' ? CONFIG.apiPidNoCache : CONFIG.apiPid;
    const sampler = sleep(DUR * 600).then(() => (resources = sampleResources(pid)));
    const raw = await runStep(scn, c, DUR);
    await sampler;
    const step = digest(raw, c, resources);
    step.codes = raw.statusCodeStats;
    const why = verdict(scn, step);
    steps.push({ ...step, break: why });
    console.log(
      `  c=${String(c).padStart(3)}  ${String(step.rps).padStart(6)} req/s  p50 ${String(step.p50).padStart(5)} ms  p99 ${String(step.p99).padStart(5)} ms  ok ${step.ok}/${step.total}` +
        `  api ${resources.apiCpu ?? '?'}%  db ${resources.dbCpu ?? '?'}%${why ? `   <-- BREAK: ${why}` : ''}`,
    );
    if (why) {
      breakAt = { level: c, reason: why };
      break;
    }
    await sleep(500);
  }
  const maxRps = Math.max(...steps.map((s) => s.rps));
  const knee = steps.find((s) => s.rps >= maxRps * 0.95);
  const comfortable = [...steps].reverse().find((s) => !s.break && s.p99 <= 500);
  return { name: scn.name, title: scn.title, group: scn.group ?? 'other', target: scn.target ?? 'api', steps, summary: { maxRps, kneeAt: knee?.c, comfortableAt: comfortable?.c ?? null, comfortableRps: comfortable?.rps ?? null, breakAt } };
}

const results = [];
for (const scn of SCENARIOS) {
  console.log(`\n== ${scn.name}: ${scn.title}`);
  try {
    results.push(await ramp(scn));
  } catch (e) {
    console.log(`  scenario failed to run: ${e.message}`);
    results.push({ name: scn.name, title: scn.title, group: scn.group ?? 'other', steps: [], summary: { error: String(e.message) } });
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ label: LABEL, when: new Date().toISOString(), stepSeconds: DUR, limits: { p99Ms: P99_LIMIT_MS, failRate: FAIL_LIMIT }, results }, null, 2));
}
console.log(`\nSaved ${OUT}`);
