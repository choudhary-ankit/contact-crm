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
