-- Async CSV import jobs (a Postgres-backed queue: durable, resumable, no extra infrastructure).
CREATE TABLE import_jobs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid        NOT NULL,
  mode            text        NOT NULL CHECK (mode IN ('create', 'update')),
  filename        text        NOT NULL,
  -- validating -> ready -> importing -> completed;  failed / cancelled are terminal
  status          text        NOT NULL CHECK (status IN ('validating', 'ready', 'importing', 'completed', 'failed', 'cancelled')),
  file            bytea,                          -- the uploaded CSV; cleared once the job is finished
  header          text[],                         -- original header cells, to rebuild rejected rows in order
  total_rows      integer,
  valid_rows      integer,
  error_rows      integer     NOT NULL DEFAULT 0,
  processed_rows  integer     NOT NULL DEFAULT 0, -- advanced in the same transaction as each chunk's writes => resumable, exactly-once per chunk
  created_count   integer     NOT NULL DEFAULT 0,
  updated_count   integer     NOT NULL DEFAULT 0,
  unchanged_count integer     NOT NULL DEFAULT 0,
  notes           text[]      NOT NULL DEFAULT '{}',
  failure_reason  text,
  lease_until     timestamptz,                    -- a worker owns the job until this time; expired leases are re-claimed (crash recovery)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
CREATE INDEX import_jobs_account_idx ON import_jobs (account_id, created_at DESC);
CREATE INDEX import_jobs_queue_idx   ON import_jobs (created_at) WHERE status IN ('validating', 'importing');

CREATE TABLE import_job_errors (
  id          bigserial PRIMARY KEY,
  job_id      uuid    NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  row_number  integer NOT NULL,                   -- 1-based data row (the header is row 0)
  phase       text    NOT NULL CHECK (phase IN ('validate', 'import')),
  field       text,
  message     text    NOT NULL,
  row_data    jsonb   NOT NULL DEFAULT '[]'::jsonb -- the original cells, so rejected rows can be downloaded, fixed and re-uploaded
);
CREATE INDEX import_job_errors_job_idx ON import_job_errors (job_id, row_number);

-- Metrics support
CREATE INDEX contact_activity_account_time_idx ON contact_activity (account_id, created_at DESC);
CREATE INDEX contacts_active_phone_idx ON contacts (account_id, phone_digits) WHERE deleted_at IS NULL AND phone_digits <> '';
