CREATE TABLE change_requests (
  id uuid PRIMARY KEY,
  book_id uuid NOT NULL REFERENCES books(id),
  kind text NOT NULL CHECK(kind IN ('student.create','student.update','schedule.update','book.create')),
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  base_state jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  review_note text NOT NULL DEFAULT '',
  result jsonb,
  CHECK((status = 'pending' AND reviewed_at IS NULL) OR (status <> 'pending' AND reviewed_at IS NOT NULL))
);
CREATE UNIQUE INDEX change_requests_pending_unique ON change_requests(book_id,kind,payload_hash) WHERE status='pending';
CREATE INDEX change_requests_queue ON change_requests(status,submitted_at);
