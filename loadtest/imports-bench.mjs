// CSV import benchmark: how long do upload, validation and import take for 1k / 10k / 50k rows, and how much does a
// running import slow down normal requests (the worker runs inside the API process)?
//   node imports-bench.mjs [--sizes 1000,10000,50000] [--out results/imports.json]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONFIG, sleep } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const SIZES = (args.sizes ?? '1000,10000,50000').split(',').map(Number);
const OUT = args.out ?? 'results/imports.json';
const H = { authorization: `Bearer ${CONFIG.key}` };
const RUN = Date.now().toString(36);

const csvCreate = (n, tag) => {
  const rows = ['first_name,last_name,email,phone,company,tags'];
  for (let i = 0; i < n; i++) rows.push(`Imp${i},Load,imp.${RUN}.${tag}.${i}@loadtest.example,+1 415 555 ${String(1000 + (i % 9000))},Import Co ${i % 50},ImportTag${i % 5}`);
  return rows.join('\n');
};
const csvUpdate = (n, tag) => {
  const rows = ['email,company'];
  for (let i = 0; i < n; i++) rows.push(`imp.${RUN}.${tag}.${i}@loadtest.example,Updated Co ${i % 70}`);
  return rows.join('\n');
};

async function api(path, init = {}) {
  const res = await fetch(`${CONFIG.api}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const upload = async (mode, csv, name) => {
  const form = new FormData();
  form.append('mode', mode);
  form.append('file', new Blob([csv], { type: 'text/csv' }), name);
  return api('/imports', { method: 'POST', body: form });
};
async function until(id, wanted) {
  for (;;) {
    const { body } = await api(`/imports/${id}`);
    if (wanted.includes(body.status)) return body;
    await sleep(50);
  }
}

/** Latency of a trivial request, sampled continuously while `work` runs: shows event-loop stalls. */
async function withProbe(work) {
  const lat = [];
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      const t = performance.now();
      await fetch(`${CONFIG.api}/health`).then((r) => r.arrayBuffer()).catch(() => undefined);
      lat.push(performance.now() - t);
      await sleep(25);
    }
  })();
  const result = await work();
  stop = true;
  await loop;
  lat.sort((a, b) => a - b);
  const q = (p) => +(lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] ?? 0).toFixed(1);
  return { result, probe: { samples: lat.length, p50: q(0.5), p99: q(0.99), max: +(lat.at(-1) ?? 0).toFixed(1) } };
}

const out = { when: new Date().toISOString(), runs: [] };
const idle = await withProbe(() => sleep(3000));
console.log(`idle /health latency: p50 ${idle.probe.p50} ms, p99 ${idle.probe.p99} ms, max ${idle.probe.max} ms`);
out.idleProbe = idle.probe;

for (const n of SIZES) {
  for (const mode of ['create', 'update']) {
    const tag = `n${n}`;
    const csv = mode === 'create' ? csvCreate(n, tag) : csvUpdate(n, tag);
    const mb = +(Buffer.byteLength(csv) / 1e6).toFixed(2);
    const { result, probe } = await withProbe(async () => {
      const t0 = performance.now();
      const up = await upload(mode, csv, `${mode}-${n}.csv`);
      if (up.status !== 202) return { error: `upload returned ${up.status}: ${JSON.stringify(up.body)}` };
      const tUpload = performance.now() - t0;
      const ready = await until(up.body.id, ['ready', 'failed']);
      const tValidated = performance.now() - t0;
      if (ready.status !== 'ready') return { error: `validation ended as ${ready.status}: ${ready.failureReason}` };
      await api(`/imports/${up.body.id}/confirm`, { method: 'POST' });
      const done = await until(up.body.id, ['completed', 'failed']);
      const tDone = performance.now() - t0;
      return { id: up.body.id, tUpload, tValidated, tDone, valid: ready.validRows, created: done.createdCount, updated: done.updatedCount, errorRows: done.errorRows, status: done.status };
    });
    if (result.error) {
      console.log(`${mode} ${n}: ${result.error}`);
      out.runs.push({ mode, rows: n, mb, error: result.error });
      continue;
    }
    const row = {
      mode, rows: n, fileMb: mb,
      uploadMs: Math.round(result.tUpload), validateSec: +((result.tValidated - result.tUpload) / 1000).toFixed(2), importSec: +((result.tDone - result.tValidated) / 1000).toFixed(2),
      validateRowsPerSec: Math.round(n / ((result.tValidated - result.tUpload) / 1000)), importRowsPerSec: Math.round(n / ((result.tDone - result.tValidated) / 1000)),
      status: result.status, created: result.created, updated: result.updated, errorRows: result.errorRows, healthDuringImport: probe,
    };
    out.runs.push(row);
    console.log(`${mode.padEnd(6)} ${String(n).padStart(6)} rows (${mb} MB): upload ${row.uploadMs} ms | validate ${row.validateSec}s (${row.validateRowsPerSec} rows/s) | import ${row.importSec}s (${row.importRowsPerSec} rows/s) | ${row.status} | /health meanwhile p99 ${probe.p99} ms, max ${probe.max} ms`);
  }
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`Saved ${OUT}`);
