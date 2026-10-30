-- Provider metadata only. No prompts, responses or API keys.
ALTER TABLE maca_requests ADD COLUMN groq_calls integer NOT NULL DEFAULT 0;
ALTER TABLE maca_requests ADD COLUMN provider text NOT NULL DEFAULT 'internal' CHECK(provider IN ('internal','gemini','groq'));
ALTER TABLE maca_requests ADD COLUMN fallback_reason text;
UPDATE maca_requests SET provider='gemini' WHERE gemini_calls>0;
