-- Operational metadata only: no prompts, names or conversation transcripts.
CREATE TABLE maca_requests (
  session_hash text NOT NULL REFERENCES access_sessions(token_hash) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  gemini_calls integer NOT NULL DEFAULT 0,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  outcome text NOT NULL DEFAULT 'processing',
  PRIMARY KEY(session_hash, request_id)
);
CREATE INDEX maca_requests_created ON maca_requests(created_at);
CREATE INDEX lessons_date ON lessons(date);
