# CRM Contact Workspace

A full-stack contact workspace with complete CRUD: browse, search, filter, sort and page through contacts, **add** them,
edit them safely under concurrent use, **soft-delete** them to a Trash and **restore** them, manage tags (including bulk assignment
and bulk delete) and see per-contact activity history. It also has an **async CSV import** (add or update many contacts, with a review step and
a downloadable rejected-rows file), a **CSV export**, and a **Metrics** tab that points at data-quality problems and links straight to the affected contacts. The UI uses an enterprise layout (navy sidebar, cobalt accent) modelled on
the public palette of gohighlevel.com. It uses no HighLevel logo or branding.

- **Frontend:** Vue 3 + TypeScript + Vite
- **Backend:** NestJS 11 + TypeScript
- **Database:** PostgreSQL 16

## Live demo

| | |
|---|---|
| **App** | https://contact-crm-frontend.netlify.app |
| **API** | https://contact-crm-api.onrender.com (health: `/health`, interactive docs: `/docs`) |
| **Source** | https://github.com/choudhary-ankit/contact-crm |

- The demo runs on free hosting tiers, so if nobody has used it for a while the **first request can take up to a minute** while the backend wakes up. After that it is fast.
- It contains **synthetic seed data only** (about 10,000 contacts, tags, a few trashed contacts and some history). Feel free to edit, delete, import and export.
- The deployed frontend carries a **public demo API key**, so anyone with the link can use the demo. This is demo-grade authentication; see *Known issues* for what production would use.
- Good places to start: search for `sam smith`, open **Metrics** and click a "Needs attention" **View** link, or import `docs/samples/try-add-contacts.csv` from **Imports**.

## Run it

Prerequisites: Node 20+ and Docker.

```bash
# 1. database (also creates a separate crm_test database for the tests)
docker compose up -d db

# 2. backend  ->  http://localhost:3000   (Swagger UI at /docs)
cd backend
cp .env.example .env
npm install
npm run seed          # 25,000 contacts (SEED_COUNT=1000000 npm run seed for the scale demo)
npm run start:dev     # migrations run automatically on boot

# 3. frontend  ->  http://localhost:5173
cd ../frontend
npm install
npm run dev
```

The frontend proxies `/api/*` to the backend, so no CORS setup is needed. It authenticates with the demo key `demo-key`
(see [Authentication](#authentication-and-rate-limiting)).

### Tests

```bash
cd backend  && npm test     # 170 tests; unit + API integration against a real Postgres (crm_test)
cd frontend && npm test     # 113 tests; API client, dialogs, create form, list/trash/detail, import wizard/job/history, metrics
```

> The backend tests need the database from step 1. If you ever `docker compose down -v`, the `crm_test` database is
> recreated on the next `up` by `docker/init-test-db.sql`.

### Things to try

| Scenario | How |
|---|---|
| **Import a CSV** | sidebar → Imports → Import contacts. Use `docs/samples/try-add-contacts.csv` (4 valid rows, 4 deliberately bad ones), review the problems, then import. Then try `try-update-contacts.csv` in "Update existing" mode |
| **Download a sample file** | on the upload step, "Download sample CSV" for the selected type, next to the column-by-column format guide |
| **Export → edit → re-import** | Contacts → Export CSV (respects your search and filters), edit it, then import it as "Update existing" |
| **Metrics** | sidebar → Metrics: period selector, charts, and "Needs attention" rows whose **View** link opens the Contacts list pre-filtered |
| **Add a contact** | "Add contact" → fill the form with tags. Reuse `ada.lovelace@analytical.io` to see the duplicate-email error with an "Open contact" link |
| **Move to trash / Undo** | row menu (⋯) → Move to trash, or the button on a contact's page; use "Undo" in the toast |
| **Trash and restore** | sidebar → Trash → Restore. Jon Snow and Tony Stark are seeded there |
| **Restore blocked by email** | create an active contact with `jon.snow@example.com`, then try to restore Jon Snow |
| Search | `ada` (name), `analytical` (email), `010-1234` (phone, formatting ignored) |
| Identical names / sort stability | search `sam smith`, sort Name A → Z |
| Filters | Tag = VIP, Company contains `acme`, created-date range, combinable with search |
| **Conflict** | open **Ada Lovelace**, edit Company, and before saving change her through the API (see below), then Save |
| Email uniqueness | edit a contact's email to one that exists → field error |
| Bulk tags | tick rows (selection persists across pages) → "Assign tag" |
| Backend down | stop the API and reload → error state with Retry |

Simulate the second user:

```bash
ID=<contact id from the URL>
curl -X PATCH localhost:3000/contacts/$ID -H 'Authorization: Bearer demo-key' \
  -H 'Content-Type: application/json' -H 'If-Match: "1"' -d '{"company":"Changed by user B"}'
```

## Deployment

Three separately hosted pieces, all described in code:

| Piece | Host | Defined in |
|---|---|---|
| PostgreSQL 16 | Neon | managed; the backend applies `migrations/` itself on boot (guarded by an advisory lock) |
| Backend (NestJS, includes the import worker) | Render, as a Docker web service | `backend/Dockerfile`, `render.yaml` |
| Frontend (static build) | Netlify | `frontend/netlify.toml` |

The backend must be a long-running server (not serverless) because the CSV import worker runs inside it. The frontend calls the backend directly with CORS, so the backend sees each visitor's real IP for rate limiting (`TRUST_PROXY=1`).

**Backend settings** (never committed; set in the host's dashboard):

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres connection string (use the direct, non-pooled one: migrations use a session advisory lock) |
| `API_KEYS` | `<secret key>:<account uuid>`, comma-separated for several. The part before `:` is the key clients send; the part after is the account whose data it can see |
| `CORS_ORIGIN` | the frontend's origin, exactly, with no trailing slash (comma-separate several) |
| `TRUST_PROXY` | `1` behind Render's proxy |

The server **refuses to start** with a malformed `API_KEYS` (for example only an account id), and in production also rejects the built-in demo keys and keys shorter than 16 characters, with a message that never prints the secret.

**Frontend settings** (build-time, so changing them needs a redeploy): `VITE_API_URL` (the backend's address) and `VITE_API_KEY` (the secret key only, **without** the `:account` part).

To create the demo data in a fresh database: `DATABASE_URL=<url> SEED_COUNT=10000 npm run seed` from `backend/` (this replaces the demo accounts' data, so use it only on a demo database).

## Tech stack and why

| Choice | Why |
|---|---|
| **PostgreSQL** | The data is relational (contacts ↔ tags ↔ activity) and needs hard guarantees: a partial unique index for "email unique when present", transactions for bulk tagging, row locks for concurrency. `pg_trgm` GIN indexes make substring search over millions of rows fast. |
| **NestJS** | Structured modules, DTO validation (`class-validator`), guards for auth and throttling, global exception filter. Same TypeScript on both sides. |
| **Raw SQL via `pg`** (no ORM) | Keyset pagination, generated columns, trigram indexes and `INSERT … ON CONFLICT` CTEs are the heart of this task. Writing them directly keeps the query plans visible and reviewable (see `docs/explain-1m.txt`). Column names that reach SQL come from a fixed whitelist; every value is a bound parameter. |
| **Vue 3 + `<script setup>` + TypeScript** | Preferred stack. |
| **TanStack Vue Query** | Server-state caching, loading/error states, retries and invalidation without hand-rolled plumbing. |
| **Vite** | Fast dev server and proxy. |

**Why not the alternatives?** SQLite is the easiest to run but serialises writers and has no trigram search, so it undersells the
"millions of contacts" requirement. MongoDB's flexible schema buys nothing here and loses the unique-when-present index
semantics, multi-row transactions and join-based tag filters. Elasticsearch is the right *next* step at very large scale
(see below) but is unnecessary operational weight for this scope.

## Data model

```
contacts(id uuid PK, account_id, first_name, last_name, email NULL, phone NULL, company NULL,
         version int, created_at, updated_at, deleted_at NULL,   -- deleted_at set = in the trash
         name_sort, search_name, phone_digits, company_lower   -- generated columns)
tags(id uuid PK, account_id, name)                -- unique (account_id, lower(name))
contact_tags(contact_id FK, tag_id FK, created_at) -- PK (contact_id, tag_id)
contact_activity(id bigserial PK, account_id, contact_id FK, type, payload jsonb, created_at)
import_jobs(id uuid PK, account_id, mode create|update, filename, status, file bytea NULL, header text[], total_rows, valid_rows,
            error_rows, processed_rows, created_count, updated_count, unchanged_count, notes text[], failure_reason, lease_until, ...)
import_job_errors(id, job_id FK, row_number, phase validate|import, field, message, row_data jsonb)   -- the rejected rows as uploaded
```

Key indexes (see `backend/migrations/001_init.sql` and `002_soft_delete.sql`):

- `UNIQUE (account_id, email) WHERE email IS NOT NULL AND deleted_at IS NULL` - email uniqueness among **active** contacts, enforced by the database so races cannot create duplicates. Emails are trimmed and lower-cased on write.
- Partial `(account_id, created_at, id)` and `(account_id, name_sort, id)` indexes `WHERE deleted_at IS NULL` - keyset pagination for the active list, which never reads trashed rows. A separate partial index on `(account_id, deleted_at, id) WHERE deleted_at IS NOT NULL` serves the Trash.
- GIN trigram on `search_name`, `email`, `phone_digits`, `company_lower` - substring search.
- `(tag_id, contact_id)` on the join table, `(contact_id, created_at DESC, id DESC)` on activity.

Every table carries `account_id` and every query is scoped by it (multi-tenancy). Generated columns keep search and sort
expressions simple so plain indexes match them.

## API

All routes need `Authorization: Bearer <key>` except `GET /health`. Interactive docs at `/docs`.

| Method & path | Purpose |
|---|---|
| `GET /contacts?status&q&tags&company&attention&createdFrom&createdTo&sort&order&limit&cursor` | search / filter / sort / page. `status=active` (default) or `deleted` (the trash, sorted by `deletedAt`) |
| `POST /contacts` | create, with optional initial `tags` |
| `GET /contacts/:id` | view, also for trashed contacts (returns `ETag: "<version>"`) |
| `PATCH /contacts/:id` | update; **requires `If-Match: "<version>"`**; 409 `CONTACT_DELETED` if in the trash |
| `DELETE /contacts/:id` | **soft delete** to the trash; requires `If-Match`; idempotent |
| `POST /contacts/:id/restore` | restore from the trash; requires `If-Match`; idempotent |
| `POST /contacts/bulk/delete` `{contactIds[1..1000]}` | bulk soft delete |
| `GET /contacts/export.csv?<list filters>` | streams matching contacts as CSV (max 50,000 rows), in the update-import column order |
| `GET /imports/formats` · `GET /imports/templates/:mode` | column specs for the format guide · downloadable sample CSV (`create` / `update`) |
| `POST /imports` (multipart `file`, `mode`) | upload; returns **202** at once while a worker validates the file |
| `GET /imports` · `GET /imports/:id` | history · one job (poll it for progress) |
| `GET /imports/:id/errors` · `GET /imports/:id/errors.csv` | problems as JSON (paged) · rejected rows + an `error` column, ready to fix and re-upload |
| `POST /imports/:id/confirm` · `POST /imports/:id/cancel` | start the import after review · discard it before it starts |
| `GET /metrics?range=7\|30\|90` | every dashboard number in one payload |
| `GET /contacts/:id/activity?limit` | recent activity, newest first |
| `POST /contacts/:id/tags` `{names: [...]}` (or `{name}`) | add up to 20 tags in one atomic request (201 if any were new, 200 if all were already there); the response includes the contact's full current tag list |
| `DELETE /contacts/:id/tags/:tagId` | remove tag (204, idempotent) |
| `POST /contacts/bulk/tags` `{contactIds[1..1000], tag}` | bulk assign |
| `GET /tags?q` | tag names for the account |

Errors always look like `{ statusCode, code, message, details?, current? }`, with stable `code`s the UI branches on:
`VALIDATION_ERROR` (400, with per-field `details`), `INVALID_CURSOR` (400), `UNAUTHORIZED` (401), `NOT_FOUND` (404),
`VERSION_CONFLICT` (409, includes the server's `current` copy), `EMAIL_TAKEN` (409, includes `existing`: the contact that owns the email), `CONTACT_DELETED` (409, the contact is in the trash), `IMPORT_NOT_READY` / `NOTHING_TO_IMPORT` / `IMPORT_NOT_CANCELLABLE` (409), `PAYLOAD_TOO_LARGE` (413), `PRECONDITION_REQUIRED` (428),
`RATE_LIMITED` (429), `INTERNAL_ERROR` (500, no internals leaked).

## Important technical decisions

**Keyset (cursor) pagination, not `OFFSET`.** `OFFSET n` reads and discards n rows, so deep pages get slower as the account grows.
A cursor encodes the last row's sort value plus its `id` as a tiebreaker, and the query is `WHERE (sort_key, id) > (…)`, which
is an index range scan whatever the depth. The tiebreaker is what keeps pages stable when many rows share a name or timestamp
(the tests deliberately create heavy ties). Timestamps travel as text so microsecond precision survives JSON/JS. Cursors are
bound to the sort that produced them. The UI keeps the cursor of every visited page so "Previous" works; the trade-off is
no "jump to page 500".

**Bounded count.** `COUNT(*)` over millions of rows is slow, so the first page returns `total` capped at 10,000
(`totalCapped: true` → UI shows "10,000+"). It is only computed on the first page and the client keeps it while paging.

**Search.** Case-insensitive substring over `first + last name`, `email` and (when the input looks like a phone number) digits-only `phone`.
Minimum 2 characters so trigram lookups stay selective. `%`/`_`/`\` are escaped, so a user searching `%` finds literal percent signs, not everything.

**Filters.** Tag (any of), company (contains), and created-date range, all combinable with search and sort.

**Input validation.** Server-side DTOs with whitelisting (unknown fields are rejected, so `version`/`accountId` can't be
mass-assigned). Empty strings become `null`. `PATCH` semantics: a missing key leaves a field alone, `null`/`""` clears an optional field,
names can be changed but never cleared. The client mirrors the rules for instant feedback but the server stays authoritative
and its field errors are rendered inline.

## Async CSV import (add or update many contacts)

**Flow.** Pick a type → upload → *review* → import. The upload returns `202` immediately; a background worker checks every row and the
UI polls the job. **Nothing touches your contacts until you confirm the review**, so a bad file costs nothing.

| | Add new contacts | Update existing contacts |
|---|---|---|
| Needs | `first_name`, `last_name` | `email` (the match key) plus at least one column to change |
| Blank cell | field left empty | field left **unchanged** |
| Empty a field | n/a | write `[clear]` (phone, company) |
| Tags (`VIP;Lead`) | added | added, **never removed** |
| Email already in use / not found | row skipped and reported, **never overwritten** | row skipped and reported |

The format guide in the UI is generated from one spec (`backend/src/imports/formats.ts`) that also produces the downloadable samples and is
exercised by tests (the shipped samples are imported in the test suite), so the docs cannot drift from the rules. Header names are case-insensitive
and accept aliases (`First Name`, `E-mail`, ...); unknown columns are ignored with a note.

**Worker design (`imports.worker.ts`).** The queue is a Postgres table, so it needs no extra infrastructure and is durable across restarts:
- A job is claimed with `FOR UPDATE SKIP LOCKED` plus a **lease**. Several API instances can run workers safely, and if one dies mid-job its lease expires and another resumes it (tested by simulating a crashed worker).
- The import writes in chunks of 500 rows. `processed_rows` advances **in the same transaction** as each chunk's writes, so a job is resumable and no chunk is applied twice (tested: stop mid-import, resume, every row exactly once, including rows without an email, which the unique index can't deduplicate).
- Both phases revalidate against the live database. The review checks existing emails; the import re-checks, so an email taken *between review and import* is reported for that row while the rest still import (tested).
- Creation uses `INSERT ... ON CONFLICT DO NOTHING` on the unique index as the final arbiter, with set-based SQL for contacts, tags and activity; updates lock each contact `FOR UPDATE` and skip rows that change nothing (no version bump, no activity).
- Per-row history: imported contacts get the normal `CONTACT_CREATED` / `CONTACT_UPDATED` / `TAG_ADDED` activity, tagged with the import id.
- Row problems are stored with the original row, so "Download rejected rows" returns exactly those rows plus an `error` column: fix and upload again.

**Safety.** Uploads are limited to 5 MB / 50,000 rows and must be `.csv` text (binary content is rejected); the file is parsed by a standard RFC 4180 parser (quotes, embedded newlines, BOM, mixed line endings);
the stored file is deleted when the job finishes or is cancelled; jobs are private to the account (tested); and exported or rejected cells that start with `=`, `@`, `-` or `+` followed by text are prefixed with `'` to neutralise spreadsheet formula injection (phone numbers like `+1 415 ...` are left intact so exports round-trip).

**Concurrency note.** Import is a *set* operation like bulk tagging: it applies the file on top of the current data row by row, atomically per chunk, and does not use the per-contact `If-Match` version
(a file has no single version to compare). Edits made in the app while an import is running are not lost: the import only writes the columns present in the file.

## Metrics

The tab answers "is my contact data healthy and is the team using it?" It deliberately avoids vanity numbers. Every metric is something you can act on:

| Metric | Why it matters | Acts on it |
|---|---|---|
| Active contacts, new in the period (+ % vs the previous period) | growth | |
| **Reachable %** (email or phone) | a contact with neither can't be contacted | **No email and no phone** → list |
| **Untagged %** | untagged contacts can't be segmented | **Untagged** → list |
| Data completeness (email / phone / company) | where data quality is weakest | |
| Contacts by tag (top 10) | how the base splits (leads, customers, ...) | |
| **Possible duplicates** (contacts sharing a phone number) | inflate counts, cause double outreach | **Possible duplicates** → list |
| **Stale** (not updated in 90+ days) | data decays | **Not updated in 90+ days** → list |
| New contacts and edits per day (UTC) | whether the CRM is actually being used | |
| Activity by type, trash size, moved-to-trash and restored | spots accidental deletes | |
| Imports: jobs, failed, rows added/updated/rejected, success rate | whether uploads are working | |

**Numbers and links can't disagree.** The "Needs attention" counts and the Contacts list's `?attention=` filter are built from the *same SQL predicates* (`contacts/attention.ts`),
and a test asserts that each metric equals the `total` and the exact contacts of its filtered list. Trashed contacts never count.

The payload is computed on demand and cached for 30 s per account and period (`METRICS_CACHE_TTL_MS`). At scale it becomes incrementally maintained rollups (see below).

## Create, soft delete and restore

**Soft delete only.** There is no hard delete anywhere. `DELETE /contacts/:id` stamps `deleted_at` and bumps the version; nothing is
removed, so tags and history survive and a restore brings everything back. Trashed contacts are kept indefinitely (a purge
job is a production follow-up, see Known issues).

- **Hidden everywhere except the Trash.** Active list, search, tag/company/date filters, tag counts and bulk tagging all exclude trashed rows.
  Opening a trashed contact directly gives a read-only view with a Restore button, and its history stays readable.
- **Read-only while trashed.** Edits and tag changes on a trashed contact return `409 CONTACT_DELETED`, including the case where *someone trashes a contact while you are editing it*:
  the page switches to read-only instead of silently failing.
- **Same concurrency rules.** Delete and restore require `If-Match` like an update, so deleting a contact someone just edited gives the same
  409 `VERSION_CONFLICT` (the UI says so and reloads the latest). Both are idempotent: repeating them changes nothing and logs nothing.
- **Email reuse.** The unique index only covers active contacts, so a new contact can take a trashed contact's email. Restoring into an email an
  active contact now owns fails with `409 EMAIL_TAKEN` and points at that contact; the UI explains it and links there.
  If two trashed contacts with the same email are restored at once, exactly one wins (tested).
- **Create is atomic.** The contact, its initial tags and the `CONTACT_CREATED` / `TAG_ADDED` activity commit in one transaction; a duplicate email creates nothing, not even the tags.
- **Undo.** Moving a contact to trash shows an "Undo" toast that restores it using the version returned by the delete.
- **Bulk delete** is a set operation like bulk tagging: idempotent, one `CONTACT_DELETED` per contact actually moved, and it reports contacts that were already in the trash or not found.
  It ignores per-contact versions (there is no single version to compare), which is why it asks for confirmation.

## Tags on a contact

Several tags can be added in one request (`names`, up to 20): they are validated together, de-duplicated case-insensitively, written in one transaction (one invalid name adds none), and each tag that is actually new gets its own
`TAG_ADDED` event. In the UI, type tags separated by commas (or press Enter after each), see them line up as chips, and add them together; a failed save keeps them lined up.

The response carries the complete tag list as of that transaction, and the page applies it directly instead of re-fetching the contact. Tag changes for a page also run strictly one after another, so a slow older response can never overwrite a newer one
(this was a real bug: a tag was saved and logged but not shown because a late re-fetch replaced the list; there is a test that reproduces out-of-order responses).
Activity is always newest first (`created_at DESC, id DESC`), and the card says so.

## Concurrent update approach: optimistic locking

Each contact has an integer `version`. The scenario from the brief:

1. A and B both load the contact at **version 1** (`ETag: "1"`).
2. B saves → `PATCH` with `If-Match: "1"` → version becomes **2**.
3. A saves with `If-Match: "1"` → **409 `VERSION_CONFLICT`**, with the current server copy in the body. Nothing is overwritten.

Implementation (`ContactsService.update`): in one transaction, `SELECT … FOR UPDATE` locks the row, the version is compared, then
the update and the activity row are written. Because the check and write happen under the row lock, two simultaneous updates
with the same version cannot both succeed (there is a test firing four at once: exactly one 200, three 409).

**The UI** shows a dialog listing each field A changed with three values: what A started from, what is now on the server, and
A's change. Fields both users edited are highlighted. A can *apply their changes on top of the latest* (only A's edited fields
are sent, re-based on the new version, so B's non-overlapping edits survive: in the demo B's phone number is kept while A's company wins),
*discard and load latest*, or keep editing.

Other rules worth knowing:
- Missing `If-Match` → 428. A no-op update (nothing actually changed) does not bump the version or write activity.
- **Tag operations deliberately don't use the version.** Adding or removing a tag is a set operation that commutes with other
  edits, so it should not make someone's unrelated field edit fail. Tags are idempotent instead (`ON CONFLICT DO NOTHING`).
- Email uniqueness under concurrency is enforced by the unique index; the `23505` violation is mapped to `409 EMAIL_TAKEN` with a field error.

## Activity history

`CONTACT_CREATED`, `CONTACT_UPDATED` (payload has a per-field `{from, to}` diff and the new version), `CONTACT_DELETED`, `CONTACT_RESTORED`, `TAG_ADDED`, `TAG_REMOVED`. Each row has
`contact_id` and `created_at`, written in the same transaction as the change so history can't drift from reality. Activity is only
recorded for real changes: re-adding an existing tag, removing an absent one, or a no-op update logs nothing. Bulk assignment
writes one `TAG_ADDED` per contact that actually received the tag.

## Authentication and rate limiting

**Authentication (demo-grade).** `Authorization: Bearer <api key>`; each key in `API_KEYS` is bound to one account, and that
account id scopes every query, so a key can never read or modify another tenant's contacts (covered by tests). Keys are compared in constant time
over SHA-256 digests. Two demo keys are seeded (`demo-key`, `demo-key-2`) so tenant isolation can be demonstrated.
This is a stand-in, not a production design - see Known issues.

**Rate limiting.** `@nestjs/throttler`: 300 requests/min per IP globally, 60/min on write endpoints (`PATCH`, tag add/remove, bulk), both configurable via
env. Exceeding it returns `429` with the standard error body and `Retry-After`. The throttler runs *before* authentication so unauthenticated floods are limited too.

## Configuration

`backend/.env.example` lists everything. Beyond the database and API keys: `IMPORT_WORKER_ENABLED` (turn the in-process worker off to run it elsewhere), `IMPORT_MAX_ROWS` (50,000),
`IMPORT_MAX_BYTES` (5 MB), `IMPORT_CHUNK_SIZE` (500) and `METRICS_CACHE_TTL_MS` (30,000).

## Scale considerations (not implemented)

**Millions of contacts per large account.** The 1M-row run in `docs/explain-1m.txt` (re-measured after the soft-delete indexes) shows keyset pages in ~0.06-0.07 ms,
trigram search in ~1-7 ms (the high end is a broad term matching ~13,600 rows), the capped count in ~2 ms, and the Trash view in ~0.02 ms.
These are single local runs on a laptop, not a benchmark.
New in this round, measured on the same 1M-contact dataset: the metrics payload takes ~1.6 s uncached (then ~4 ms from the 30 s cache); the "needs attention" lists take 0.1-0.2 s, except
"possible duplicates" at ~1.1 s because it groups all phone numbers; exporting 50,000 contacts streams in ~0.6 s.

**Imports and metrics at scale.** Move the queue to SQS/BullMQ with the file in S3 (the job table, leases and chunking carry over unchanged) and run workers as a separate autoscaled service; add per-account concurrency limits so one tenant's
50,000-row file can't starve others; for very large files stream-parse instead of loading the file. Metrics become rollup tables (daily counts per account, updated by the worker or change events), with
the `untagged` / `duplicates` figures maintained incrementally instead of scanned. Beyond that: partition
`contacts` by `account_id` hash for very large tenants; and when relevance ranking, typo tolerance or faceting are needed, move
search to OpenSearch fed by change events, keeping Postgres as the source of truth.

**Millions of updates per day.** Row-level optimistic locking contends only on the same contact, so write throughput scales
with the number of distinct contacts. `contact_activity` is append-only and should be partitioned by time (cheap retention: drop old
partitions) and could be written asynchronously via a transactional outbox → queue, with batching for bulk operations. Bulk tagging should
become a background job for very large selections ("tag all 2M results") with progress reporting.

**Frequent searches and filters.** Read replicas for the list endpoint; a short-TTL Redis cache for tag lists and first-page
results of hot filters; materialise tag filters (array column or a search index) once tag cardinality makes `EXISTS` joins costly;
keep totals approximate.

**Many simultaneous users.** The API is stateless, so scale it horizontally behind a load balancer; use PgBouncer for connection
pooling; move rate limiting from per-process memory to Redis so limits hold across instances; add per-account limits and
request IDs/metrics for observability.

## Known issues / incomplete

- **No hard delete, purge or merge.** Trash is kept forever; production would add a retention job that permanently removes old trash. There is no duplicate detection beyond exact email.
- **Import limits.** CSV only (no XLSX), comma-delimited, UTF-8, 5 MB / 50,000 rows; update matches by **email only**, so contacts without an email can't be updated by file and the email itself can't be changed by import. There is no undo of a finished import (the rejected-rows file and the activity history, which records the import id, are the audit trail), no scheduled or recurring imports, and a worker processes one job at a time per API instance.
- **Imported files live in Postgres** (`bytea`, deleted when the job finishes) rather than object storage, which is fine at the 5 MB cap but not at scale.
- **Metrics are approximations of "health".** Duplicates only means an identical phone number (email is already unique), the stale threshold is fixed at 90 days, days are UTC, and the figures are cached for 30 s per API instance, not per tenant globally.
- **Export** is capped at 50,000 rows, and a value that really starts with `=` or `@` is exported with a leading `'` (so a re-import would keep it).
- **No bulk restore** (restore is one at a time, which keeps email-clash handling simple), and **bulk delete ignores versions**.
- **The Trash can only be sorted by deletion time**, and search is its only filter: other sort orders have no index over trashed rows.
- **Auth is demo-grade.** Static API keys from env, no users, roles, expiry or rotation. Production would use OIDC/JWT with short-lived tokens and RBAC, and would put the actor on every activity row (activity currently has no "who").
- **Rate limiter is in-memory**, so it is per instance and resets on restart.
- **Substring search needs ≥ 2 characters** and broad terms cost more (tens of ms at 1M rows) because many rows match before the top page is chosen.
- **Total is capped at 10,000** and only on the first page; there is no jump-to-page-N.
- **Bulk actions** (tag, delete) are limited to 1,000 selected contacts per request, and there is no "select all N results" or bulk tag *remove*.
- **Tag filter** is "any of"; there is no "all of" mode. Tag changes do not bump a contact's `updated_at`.
- **Activity** shows the latest 20 (API max 100) with no paging, and is not capped or archived.
- **Seed data are synthetic.**
- **The theme is an approximation** built from the public marketing palette; HighLevel's actual app UI is behind a login and was not inspected.
- **No browser E2E suite** (e.g. Playwright). The UI flows were exercised manually and by component tests; the API is covered by integration tests against real Postgres.

## AI usage

- **Tool:** Claude Code (Claude Sonnet 5.5).
- **Used for:** analysing the assignment, proposing the architecture, and generating the first draft of the backend, frontend, tests and this README. I reviewed the design decisions and ran the system to verify behaviour.
- **A suggestion I changed:** the generated setup pulled in the newest framework releases (NestJS 12 and TypeScript 7). They proved incompatible with the Jest/ts-jest test toolchain (ESM-only packages, no compiler JS API), so I pinned the stable NestJS 11 / TypeScript 5.9 line instead.
- **A slip it made and I caught:** while building the import feature the assistant edited a migration that had already been applied to my development database, so the worker failed there with `column "header" does not exist` while the tests (which build a fresh database) passed. I reproduced it from the worker log and fixed it forward with an idempotent migration (`004`) instead of rewriting history, and the project rule is now "applied migrations are never edited".
- **Another:** the first frontend left the list on "Loading…" forever when the browser reported offline, because Vue Query pauses requests by default. I switched to `networkMode: 'always'` and added a component test so the error + Retry state is guaranteed.

> *(Edit this section in your own words before submitting; you should be able to explain every decision above.)*
