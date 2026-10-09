// Turns results/*.json into the tables used in the report.
//   node summarize.mjs results/1m.json [results/3m.json]
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) throw new Error('usage: node summarize.mjs results/1m.json [results/3m.json]');
const runs = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
const fmt = (n) => (n === undefined || n === null ? '-' : Number(n).toLocaleString('en-US'));

function bottleneck(step) {
  if (!step) return '-';
  if (step.apiCpu >= 85) return 'API CPU (one Node thread is full)';
  if (step.dbCpu >= 60) return 'Database CPU';
  return 'waiting on the database pool or disk';
}

function row(r) {
  const s = r.summary;
  if (s.error || !r.steps.length) return `| \`${r.name}\` | could not run: ${s.error ?? 'no data'} |||||`;
  const peak = r.steps.find((x) => x.rps === s.maxRps);
  const comfy = s.comfortableAt ? `${s.comfortableAt} clients (${fmt(s.comfortableRps)} req/s)` : 'none';
  const brk = s.breakAt ? `**${s.breakAt.level} clients**: ${s.breakAt.reason}` : 'did not break (tested up to ' + r.steps.at(-1).c + ')';
  return `| \`${r.name}\` | ${fmt(s.maxRps)} (at ${peak.c}) | ${peak.p50} / ${peak.p99} ms | ${comfy} | ${brk} | ${bottleneck(peak)} |`;
}

const GROUPS = { light: 'Light reads', list: 'Listing, sorting and paging', search: 'Search', filter: 'Filters', aggregate: 'Metrics and export', write: 'Writes' };
for (const run of runs) {
  console.log(`\n### ${run.label}  (${run.stepSeconds}s per step)\n`);
  for (const [g, title] of Object.entries(GROUPS)) {
    const rs = run.results.filter((r) => r.group === g);
    if (!rs.length) continue;
    console.log(`\n**${title}**\n`);
    console.log('| Endpoint | Peak req/s (at clients) | p50 / p99 at peak | Comfortable up to (p99 under 500 ms) | Break point | What was the limit at peak |');
    console.log('|---|---|---|---|---|---|');
    rs.forEach((r) => console.log(row(r)));
  }
}

if (runs.length > 1) {
  console.log('\n### Effect of table size\n');
  console.log('| Endpoint | ' + runs.map((r) => `${r.label} peak req/s | ${r.label} p50 @ 8 clients`).join(' | ') + ' |');
  console.log('|---|' + runs.map(() => '---|---|').join('') );
  const names = runs[0].results.map((r) => r.name).filter((n) => runs.every((x) => x.results.find((r) => r.name === n)?.steps.length));
  for (const n of names) {
    console.log(`| \`${n}\` | ` + runs.map((x) => { const r = x.results.find((q) => q.name === n); const s8 = r.steps.find((s) => s.c === 8) ?? r.steps[0]; return `${fmt(r.summary.maxRps)} | ${s8.p50} ms`; }).join(' | ') + ' |');
  }
}
