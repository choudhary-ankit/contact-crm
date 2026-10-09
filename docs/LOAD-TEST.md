# Load test at 1 million contacts

Everything here was measured on one laptop: the API (one Node process), Postgres 16 in Docker (default settings, untuned)
and the load generator (autocannon) all shared the same machine. Absolute numbers are therefore conservative for the
generator side and optimistic for network latency. Each step lasted 8 seconds and was run once. Treat the numbers as an
order of magnitude, and the breaking points as the useful part.

**Data:** 999,995 active contacts in one account. **"Breaks"** means more than 0.5 % failed requests, or p99 above 2 seconds.
Tooling is in `loadtest/` (`ramp.mjs`, `stampede.mjs`, `summarize.mjs`); raw results are in `loadtest/results/`.

## Headline

| Group | Result at 1M rows |
|---|---|
| Light reads (get, tags, activity, trash, list first/deep page, date filter) | 700 to 2,300 req/s, p99 under 50 ms up to 8 to 16 clients. One Node thread is the limit, not the database. |
| Name / email / phone search | 130 to 415 req/s. Breaks between 64 and 128 clients (p99 above 2 s). Limit: database. |
| Tag filters, "needs attention" filters | 1 to 100 req/s. The slowest paths: p99 above 2 s at 1 to 16 clients. Limit: database. |
| Writes (create, update, tag, delete, restore) | 600 to 1,300 req/s, p99 under 50 ms up to 16 clients; about 1.2 s p99 at 128 clients after the fix. |
| `/metrics` (cached) | 1,000 to 2,300 req/s. |
| `/metrics` (cache off, every call recomputes) | about 2.7 s per call; not usable without the cache. |
| `GET /contacts/export.csv` (50,000 rows) | about 0.6 s alone; p99 above 2 s at 4 simultaneous exports. |

## A real bug the test found

When the 30 s metrics cache expired, every concurrent request started its own full recomputation (about 8 heavy queries
each). With 64 clients for 6 seconds Postgres ran 14 queries at once and needed **86 seconds** to drain; none of the metrics
requests finished, and 8 of 24 unrelated `GET /contacts` probes failed or timed out.

Fixed (single flight, serve-stale-while-refreshing, at most 2 computations at once, 10 s database wait limit, 30 s statement
timeout, overload answered with 503 + Retry-After, export stops when the client disconnects). Same test after the fix:
19,124 metrics requests ok, database idle immediately, 24 of 24 probes ok (p99 343 ms).

## Honest limits

- Single run per step, same-machine generator, untuned Postgres.
- The tag filters and attention filters (especially duplicate phone) are the first things to rework at this size
  (pre-computed flags or rollups, covering indexes), and metrics should become incrementally maintained rollups.
- One API process saturates one CPU core; scaling out needs more API instances (the import worker and the in-memory
  metrics cache are per instance).

## Several enterprises at the same time

Three enterprises (accounts), about 1.05M contacts each (about 3.2M rows in one table), served by one API process and one
Postgres. The data is in the same tables, separated by `account_id`. Each enterprise got its own API key and its own
load-generator process. Tooling: `loadtest/tenants.mjs`, `loadtest/clone-tenants.sql`; raw results in
`loadtest/results/multitenant.json`. 20 seconds per phase, single run, Postgres in Docker with 8 CPUs and default memory settings.
"Mixed traffic" per client: 35% list first page, 15% deep page, 15% search by name, 15% open a contact, 5% tag filter,
5% edit, 5% create, 5% metrics.

**Data isolation (passed):** each key sees only its own contacts; reading, editing or deleting a contact of another
enterprise returns 404 in all six directions; the same email can exist in every enterprise at once (uniqueness is per account).

| Phase | Enterprise 1 | Enterprise 2 | Enterprise 3 |
|---|---|---|---|
| 1. Enterprise 1 alone, 16 clients | 10 req/s, p50 20 ms, p99 0.8 s | none | none |
| 2. All three, 16 clients each | 15 req/s, p50 69 ms, p99 1.8 s | 26 req/s, p50 111 ms, p99 1.2 s | 16 req/s, p50 106 ms, p99 1.6 s |
| 3. All three, 32 clients each | 28 req/s, p50 298 ms, p99 1.4 s | 31 req/s, p50 239 ms, p99 1.4 s | 26 req/s, p50 270 ms, p99 1.4 s |
| 4. Enterprise 1 runs heavy queries (32 clients); 2 and 3 normal | 7 req/s, p50 4.4 s, p99 8.6 s | 5 req/s, p50 3.1 s, p99 6.1 s | 4 req/s, p50 3.1 s, p99 7.6 s |
| 5. Enterprise 1 runs 4 exports + heavy queries; 2 and 3 normal | exports timed out (8 failed), heavy p99 6.0 s | 7 req/s, p50 1.2 s, p99 3.7 s | 9 req/s, p50 1.1 s, p99 4.2 s |

Nothing returned a server error in phases 1 to 4. All failures were the export timeouts in phase 5.

**What this shows**
- **Data is isolated, performance is not.** Phase 4: when one enterprise runs the heaviest queries (duplicate-phone filter and
  broad search), the other two slow from tens of milliseconds to about 3 seconds at the median. Database CPU went to
  about 780% of 800%. All enterprises share one database, and nothing stops one from using all of it.
- **Adding enterprises adds load roughly in proportion.** Phases 1 to 3: p99 stays near 1 to 2 seconds, and each enterprise
  keeps getting served. The throughput is low because the mix includes the tag filter and name search, which are the
  expensive queries at this size (single-client: tag filter about 375 ms, name search about 83 ms, everything else under 5 ms).
- **Exports are the first thing to fail** when the database is busy: 50,000-row streams did not finish inside the 20 s client timeout.

**What I would do next (not built):** a per-enterprise cap on concurrent expensive queries (search, attention filters, export),
returning 429 to the enterprise that exceeds it, so one tenant cannot take the whole database; pre-computed flags
for the attention filters and a cheaper tag filter; a read replica for list, search and export; larger `shared_buffers`.
