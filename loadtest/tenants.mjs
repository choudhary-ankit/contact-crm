// Multi-tenant ("many enterprises at once") load test. Every enterprise is its own account with ~1M contacts,
// all in the same tables, served by the same API process and database.
//
//   node tenants.mjs --dur 20 --out results/multitenant.json
//
// Phases:
//   0 isolation   each key sees only its own data; cross-tenant reads and writes are refused
//   1 baseline    one enterprise alone, realistic mixed traffic
//   2 three       all three enterprises at the same time, same traffic each
//   3 three-x2    the same with twice the clients
//   4 noisy       enterprise 1 runs the heaviest queries flat out while 2 and 3 run normal traffic
//   5 exports     enterprise 1 runs 4 parallel 50,000-row exports + heavy queries while 2 and 3 run normal traffic
// Each generator runs as its own process, so the load generator is not the bottleneck.
import autocannon from 'autocannon';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, loadFixtures, pick, sampleResources, sleep, walker } from './lib.mjs';

export const TENANTS = [
  { name: 'enterprise-1', key: CONFIG.key, account: '11111111-1111-4111-8111-111111111111' },
  { name: 'enterprise-2', key: 'load-test-key-tenant-c-0123456789abcdef', account: '33333333-3333-4333-8333-333333333333' },
  { name: 'enterprise-3', key: 'load-test-key-tenant-d-0123456789abcdef', account: '44444444-4444-4444-8444-444444444444' },
];

const argv = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : a), []));

// ------------------------------------------------------------------ child: one generator for one tenant
async function child() {
  const t = TENANTS[Number(argv.tenant)];
  const conns = Number(argv.conns);
  const dur = Number(argv.dur);
  const profile = argv.profile;
  const F = loadFixtures({ writePool: 30_000, account: t.account });
  const nextUpdate = walker(F.writeIds);
  const run = Date.now().toString(36) + argv.tenant;
  let seq = 0;
  const g = (path) => ({ method: 'GET', path });
  const builders = {
    mixed: [
      [35, () => g('/contacts?limit=25')],
      [15, () => g(`/contacts?limit=25&cursor=${pick(F.cursorsCreated)}`)],
      [15, () => g(`/contacts?limit=25&q=${encodeURIComponent(pick(F.names))}`)],
      [15, () => g(`/contacts/${pick(F.readIds)}`)],
      [5, () => g('/contacts?limit=25&tags=VIP')],
      [5, () => ({ method: 'PATCH', path: `/contacts/${nextUpdate()}`, body: JSON.stringify({ company: `MT ${seq++}` }), headers: { 'if-match': '"1"' } })],
      [5, () => ({ method: 'POST', path: '/contacts', body: JSON.stringify({ firstName: 'Mt', lastName: 'Load', email: `mt-${run}-${seq++}@loadtest.example` }) })],
      [5, () => g('/metrics?range=30')],
    ],
    heavy: [
      [50, () => g('/contacts?limit=25&attention=duplicate_phone')],
      [50, () => g('/contacts?limit=25&q=an')],
    ],
    export: [[100, () => g('/contacts/export.csv')]],
  }[profile];
  const total = builders.reduce((n, [w]) => n + w, 0);
  const choose = () => {
    let r = Math.random() * total;
    for (const [w, b] of builders) if ((r -= w) < 0) return b();
    return builders[0][1]();
  };
  const result = await new Promise((resolve, reject) => {
    autocannon(
      {
        url: CONFIG.api,
        connections: conns,
        duration: dur,
        timeout: 20,
        headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' },
        requests: [
          {
            setupRequest: (req) => {
              const r = choose();
              req.method = r.method;
              req.path = r.path;
              if (r.body !== undefined) req.body = r.body;
              if (r.headers) req.headers = { ...req.headers, ...r.headers }; // merge, do not replace (keeps the API key)
              return req;
            },
          },
        ],
      },
      (e, r) => (e ? reject(e) : resolve(r)),
    );
  });
  const codes = result.statusCodeStats ?? {};
  const n = (pred) => Object.entries(codes).reduce((s, [c, v]) => (pred(Number(c)) ? s + v.count : s), 0);
  const failures = n((c) => c >= 500) + n((c) => c === 429 || c === 401 || c === 400 || c === 404) + result.errors + result.timeouts;
  process.stdout.write(
    JSON.stringify({
      tenant: t.name, profile, conns, rps: Math.round(result.requests.total / result.duration), total: result.requests.total,
      p50: result.latency.p50, p97: result.latency.p97_5, p99: result.latency.p99, max: result.latency.max,
      ok: n((c) => c >= 200 && c < 300), conflicts409: n((c) => c === 409), codes: Object.fromEntries(Object.entries(codes).map(([c, v]) => [c, v.count])), s5xx: n((c) => c >= 500), s503: n((c) => c === 503),
      other4xx: n((c) => c >= 400 && c < 500 && c !== 409), errors: result.errors, timeouts: result.timeouts, failures,
    }),
  );
}

// ------------------------------------------------------------------ orchestrator
const here = fileURLToPath(import.meta.url);
function spawnGen(tenant, profile, conns, dur) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [here, '--child', '--tenant', String(tenant), '--profile', profile, '--conns', String(conns), '--dur', String(dur)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`generator exited ${code}`))));
  });
}

async function api(tenant, path, init = {}) {
  const r = await fetch(CONFIG.api + path, { ...init, headers: { authorization: `Bearer ${TENANTS[tenant].key}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function isolation() {
  const checks = [];
  const mine = [];
  for (let i = 0; i < TENANTS.length; i++) {
    const list = await api(i, '/contacts?limit=3');
    const m = await api(i, '/metrics?range=30');
    mine.push(list.body.data.map((c) => c.id));
    checks.push({ check: `${TENANTS[i].name} lists its own contacts`, ok: list.status === 200 && list.body.data.length === 3, detail: `total ${list.body.total ?? '?'}, metrics total ${m.body?.totals?.contacts ?? m.body?.total ?? '?'}` });
  }
  for (let i = 0; i < TENANTS.length; i++) {
    const other = (i + 1) % TENANTS.length;
    const read = await api(i, `/contacts/${mine[other][0]}`);
    const write = await api(i, `/contacts/${mine[other][0]}`, { method: 'PATCH', body: JSON.stringify({ company: 'hijack' }), headers: { 'if-match': '"1"' } });
    const del = await api(i, `/contacts/${mine[other][0]}`, { method: 'DELETE', headers: { 'if-match': '"1"' } });
    checks.push({ check: `${TENANTS[i].name} cannot read / edit / delete a contact of ${TENANTS[other].name}`, ok: read.status === 404 && write.status === 404 && del.status === 404, detail: `${read.status} / ${write.status} / ${del.status}` });
  }
  // the same email can exist in every enterprise (uniqueness is per account)
  // use a contact from the original data set (first by name); the other enterprises were cloned from it
  const email = (await api(0, '/contacts?sort=name&order=asc&limit=1')).body?.data?.[0]?.email;
  if (email) {
    const r = await Promise.all([1, 2].map((i) => api(i, `/contacts?q=${encodeURIComponent(email)}&limit=1`)));
    checks.push({ check: 'the same email exists in every enterprise without conflict', ok: r.every((x) => x.status === 200 && x.body.data.length >= 1), detail: email });
  }
  return checks;
}

async function phase(name, plan, dur) {
  console.log(`\n== ${name}`);
  const pid = CONFIG.apiPid;
  const sampler = sleep(dur * 600).then(() => sampleResources(pid));
  const results = await Promise.all(plan.map(([tenant, profile, conns]) => spawnGen(tenant, profile, conns, dur)));
  const res = await sampler;
  for (const r of results) {
    console.log(`  ${r.tenant}  ${r.profile.padEnd(6)} c=${String(r.conns).padStart(3)}  ${String(r.rps).padStart(5)} req/s  p50 ${String(r.p50).padStart(5)} ms  p99 ${String(r.p99).padStart(5)} ms  ok ${r.ok}/${r.total}  409 ${r.conflicts409}  503 ${r.s503}  fail ${r.failures}`);
  }
  console.log(`  resources: API CPU ${res.apiCpu}%  DB CPU ${res.dbCpu}%  API RSS ${res.apiRssMb} MB`);
  return { name, results, resources: res };
}

async function main() {
  const dur = Number(argv.dur ?? 20);
  const out = { dur, phases: [] };
  console.log('== isolation checks');
  out.isolation = await isolation();
  for (const c of out.isolation) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.check}  (${c.detail})`);
  if (argv['isolation-only']) return;
  const mixed = (i, c) => [i, 'mixed', c];
  out.phases.push(await phase('1 baseline: enterprise-1 alone, 16 clients, mixed traffic', [mixed(0, 16)], dur));
  out.phases.push(await phase('2 three enterprises at once, 16 clients each (48 total)', [mixed(0, 16), mixed(1, 16), mixed(2, 16)], dur));
  out.phases.push(await phase('3 three enterprises at once, 32 clients each (96 total)', [mixed(0, 32), mixed(1, 32), mixed(2, 32)], dur));
  out.phases.push(await phase('4 noisy neighbour: enterprise-1 runs heavy queries (32 clients), 2 and 3 run normal traffic (16 each)', [[0, 'heavy', 32], mixed(1, 16), mixed(2, 16)], dur));
  out.phases.push(await phase('5 noisy neighbour: enterprise-1 runs 4 parallel exports + 16 heavy clients, 2 and 3 run normal traffic (16 each)', [[0, 'export', 4], [0, 'heavy', 16], mixed(1, 16), mixed(2, 16)], dur));
  mkdirSync(dirname(argv.out ?? 'results/multitenant.json'), { recursive: true });
  writeFileSync(argv.out ?? 'results/multitenant.json', JSON.stringify(out, null, 2));
  console.log('\nSaved', argv.out ?? 'results/multitenant.json');
}

if (argv.child) await child();
else await main();
