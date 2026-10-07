-- Contacts domain schema. Every row is scoped by account_id (multi-tenant).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE contacts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid        NOT NULL,
  first_name  text        NOT NULL,
  last_name   text        NOT NULL,
  email       text,                       -- stored lower-cased; NULL when absent
  phone       text,
  company     text,
  -- optimistic-locking token, bumped on every field update
  version     integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- derived columns so search/sort can use plain indexes
  name_sort    text GENERATED ALWAYS AS (lower(last_name) || ' ' || lower(first_name)) STORED,
  search_name  text GENERATED ALWAYS AS (lower(first_name) || ' ' || lower(last_name)) STORED,
  phone_digits text GENERATED ALWAYS AS (regexp_replace(coalesce(phone, ''), '\D', '', 'g')) STORED,
  company_lower text GENERATED ALWAYS AS (lower(coalesce(company, ''))) STORED
);

-- "email is unique when present": enforced by the database, so races cannot create duplicates.
CREATE UNIQUE INDEX contacts_account_email_uq ON contacts (account_id, email) WHERE email IS NOT NULL;

-- keyset pagination indexes (account_id first: every query is tenant-scoped)
CREATE INDEX contacts_account_name_idx    ON contacts (account_id, name_sort, id);
CREATE INDEX contacts_account_created_idx ON contacts (account_id, created_at, id);

-- substring search (LIKE '%term%') via trigrams
CREATE INDEX contacts_search_name_trgm ON contacts USING gin (search_name gin_trgm_ops);
CREATE INDEX contacts_email_trgm       ON contacts USING gin (email gin_trgm_ops);
CREATE INDEX contacts_phone_trgm       ON contacts USING gin (phone_digits gin_trgm_ops);
CREATE INDEX contacts_company_trgm     ON contacts USING gin (company_lower gin_trgm_ops);

CREATE TABLE tags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tags_account_name_uq ON tags (account_id, lower(name));

CREATE TABLE contact_tags (
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id     uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, tag_id)
);
CREATE INDEX contact_tags_tag_idx ON contact_tags (tag_id, contact_id);

CREATE TABLE contact_activity (
  id          bigserial   PRIMARY KEY,
  account_id  uuid        NOT NULL,
  contact_id  uuid        NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  type        text        NOT NULL CHECK (type IN ('CONTACT_UPDATED', 'TAG_ADDED', 'TAG_REMOVED')),
  payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_activity_contact_idx ON contact_activity (contact_id, created_at DESC, id DESC);
