ALTER TABLE enrollments ADD COLUMN note text NOT NULL DEFAULT '' CHECK(length(note)<=500);
CREATE TABLE holiday_exceptions (date date PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
