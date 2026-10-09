// Reproduces a "cache stampede": N users hit /metrics at the same moment while its cache is cold, then we measure
//  (1) how other, unrelated endpoints behave meanwhile, and (2) how long the database takes to recover afterwards.
//   node stampede.mjs [--url http://localhost:3400] [--clients 64] [--seconds 6] [--out results/stampede-before.json]
import autocannon from 'autocannon';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONFIG, sleep, sql } from './lib.mjs';

const a = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, all) => (x.startsWith('--') ? [...acc, [x.slice(2), all[i + 1]]] : acc), []));
const URL_ = a.url ?? CONFIG.api;
const CLIENTS = Number(a.clients ?? 64);
const SECONDS = Number(a.seconds ?? 6);
const OUT = a.out ?? 'results/stampede.json';
const H = { authorization: `Bearer ${CONFIG.key}` };

const activeQueries = () => Number(sql(`select count(*) from pg_stat_activity where state='active' and pid<>pg_backend_pid() and datname='${CONFIG.db}'`)[0][0]);

// "Collateral" probe: a normal, cheap request (one contact list page) once every 200 ms, with a 10 s patience limit.
const probe = { ok: 0, slow: 0, failed: 0, lat: [] };
let probing = true;
const prober = (async () => {
  while (probing) {
    const t = performance.now();
    try {
      const r = await fetch(`${URL_}/contacts?limit=5`, { headers: H, signal: AbortSignal.timeout(10_000) });
      await r.arrayBuffer();
      const ms = performance.now() - t;
      probe.lat.push(ms);
      r.ok ? probe.ok++ : probe.failed++;
      if (ms > 1000) probe.slow++;
    } catch {
      probe.failed++;
      probe.lat.push(10_000);
    }
    await sleep(200);
  }
})();

console.log(`baseline: ${activeQueries()} queries active in Postgres`);
const t0 = performance.now();
const result = await autocannon({ url: `${URL_}/metrics?range=30`, connections: CLIENTS, duration: SECONDS, timeout: 20, headers: H });
const loadEnded = performance.now();
console.log(`load: ${CLIENTS} clients for ${SECONDS}s -> ${result.requests.total} completed, ${result.timeouts} timed out, ${result['2xx']} ok, p50 ${result.latency.p50} ms, max ${result.latency.max} ms`);

// How long until Postgres has finished the work the clients already abandoned?
let peak = activeQueries();
const timeline = [];
while (performance.now() - loadEnded < 600_000) {
  const n = activeQueries();
  peak = Math.max(peak, n);
  timeline.push({ sinceLoadEndSec: Math.round((performance.now() - loadEnded) / 1000), active: n });
  if (n === 0) break;
  await sleep(3000);
}
const drainSec = Math.round((performance.now() - loadEnded) / 1000);
probing = false;
await prober;
probe.lat.sort((x, y) => x - y);
const q = (p) => Math.round(probe.lat[Math.min(probe.lat.length - 1, Math.floor(probe.lat.length * p))] ?? 0);

const summary = {
  url: URL_, clients: CLIENTS, seconds: SECONDS,
  metricsRequestsCompleted: result.requests.total, metricsTimeouts: result.timeouts, metricsLatencyMs: { p50: result.latency.p50, p99: result.latency.p99, max: result.latency.max },
  peakQueriesInPostgres: peak, secondsUntilPostgresIdle: drainSec,
  collateral: { probeRequests: probe.lat.length, ok: probe.ok, failedOrTimedOut: probe.failed, over1s: probe.slow, p50Ms: q(0.5), p99Ms: q(0.99), maxMs: Math.round(probe.lat.at(-1) ?? 0) },
  timeline,
};
console.log(JSON.stringify(summary, null, 2));
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(summary, null, 2));
