-- Soft delete: contacts are never removed, only stamped with deleted_at.
ALTER TABLE contacts ADD COLUMN deleted_at timestamptz;

-- Email must stay unique among *active* contacts only, so a trashed contact's email can be reused.
DROP INDEX contacts_account_email_uq;
CREATE UNIQUE INDEX contacts_account_email_uq ON contacts (account_id, email)
  WHERE email IS NOT NULL AND deleted_at IS NULL;

-- Keyset indexes become partial: the hot list path never reads trashed rows.
DROP INDEX contacts_account_name_idx;
DROP INDEX contacts_account_created_idx;
CREATE INDEX contacts_active_name_idx    ON contacts (account_id, name_sort, id)  WHERE deleted_at IS NULL;
CREATE INDEX contacts_active_created_idx ON contacts (account_id, created_at, id) WHERE deleted_at IS NULL;
-- Trash view is ordered by deletion time.
CREATE INDEX contacts_trash_deleted_idx  ON contacts (account_id, deleted_at, id) WHERE deleted_at IS NOT NULL;

ALTER TABLE contact_activity DROP CONSTRAINT contact_activity_type_check;
ALTER TABLE contact_activity ADD CONSTRAINT contact_activity_type_check CHECK (
  type IN ('CONTACT_CREATED', 'CONTACT_UPDATED', 'CONTACT_DELETED', 'CONTACT_RESTORED', 'TAG_ADDED', 'TAG_REMOVED')
);
