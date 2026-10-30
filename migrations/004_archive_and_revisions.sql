ALTER TABLE teachers ADD COLUMN archived_at timestamptz;
ALTER TABLE periods ADD COLUMN archived_at timestamptz;
ALTER TABLE books ADD COLUMN archived_at timestamptz;
ALTER TABLE enrollments ADD COLUMN note_revision integer NOT NULL DEFAULT 0;
ALTER TABLE lessons ADD COLUMN revision integer NOT NULL DEFAULT 0;
UPDATE lessons SET revision=1 WHERE id IN (SELECT lesson_id FROM attendance);
