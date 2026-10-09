-- Clones the 1M-contact account into two more "enterprises" (new ids, same shape), so the multi-tenant test
-- has three tenants of ~1M contacts each (about 3.2M rows in the table). Email uniqueness is per account, so the
-- same emails may exist in every tenant.
\timing on
CREATE TEMP TABLE src AS
  SELECT id AS old_id, gen_random_uuid() AS c_id, gen_random_uuid() AS d_id FROM contacts
  WHERE account_id = '11111111-1111-4111-8111-111111111111' AND deleted_at IS NULL;
CREATE INDEX ON src (old_id);

CREATE TEMP TABLE tmap AS
  SELECT id AS old_id, gen_random_uuid() AS c_id, gen_random_uuid() AS d_id, name FROM tags
  WHERE account_id = '11111111-1111-4111-8111-111111111111';

INSERT INTO tags (id, account_id, name) SELECT c_id, '33333333-3333-4333-8333-333333333333', name FROM tmap;
INSERT INTO tags (id, account_id, name) SELECT d_id, '44444444-4444-4444-8444-444444444444', name FROM tmap;

INSERT INTO contacts (id, account_id, first_name, last_name, email, phone, company, created_at, updated_at)
  SELECT s.c_id, '33333333-3333-4333-8333-333333333333', c.first_name, c.last_name, c.email, c.phone, c.company, c.created_at, c.updated_at
  FROM contacts c JOIN src s ON s.old_id = c.id;
INSERT INTO contacts (id, account_id, first_name, last_name, email, phone, company, created_at, updated_at)
  SELECT s.d_id, '44444444-4444-4444-8444-444444444444', c.first_name, c.last_name, c.email, c.phone, c.company, c.created_at, c.updated_at
  FROM contacts c JOIN src s ON s.old_id = c.id;

INSERT INTO contact_tags (contact_id, tag_id)
  SELECT s.c_id, t.c_id FROM contact_tags ct JOIN src s ON s.old_id = ct.contact_id JOIN tmap t ON t.old_id = ct.tag_id;
INSERT INTO contact_tags (contact_id, tag_id)
  SELECT s.d_id, t.d_id FROM contact_tags ct JOIN src s ON s.old_id = ct.contact_id JOIN tmap t ON t.old_id = ct.tag_id;
VACUUM ANALYZE contacts;
VACUUM ANALYZE contact_tags;
SELECT account_id, count(*) FROM contacts GROUP BY 1 ORDER BY 1;
