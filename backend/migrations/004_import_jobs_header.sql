-- Repairs databases that applied an earlier draft of 003 without this column; a no-op everywhere else.
-- (Applied migrations are never edited; later changes go in a new file.)
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS header text[];
