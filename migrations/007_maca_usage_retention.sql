-- Keep quota counters after logout/session expiry; never retain conversation text.
ALTER TABLE maca_requests DROP CONSTRAINT maca_requests_session_hash_fkey;
