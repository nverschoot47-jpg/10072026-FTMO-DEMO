-- 002_signals_inbox.sql  (feature 5A — persist-first durability)
-- Every valid webhook is written here the instant it arrives, BEFORE any
-- MetaAPI / execution work. It is marked processed once the handler reaches
-- a terminal outcome. If the process dies mid-flight, the row stays
-- processed=false and is surfaced on the next boot for operator review
-- (reconciled against live MetaAPI positions, which are re-adopted on start).
-- Auto re-execution is intentionally NOT done here — that needs idempotency
-- (feature #6) to be safe against double orders.

CREATE TABLE IF NOT EXISTS signals_inbox (
  id           BIGSERIAL PRIMARY KEY,
  received_at  TIMESTAMPTZ DEFAULT NOW(),
  raw_body     JSONB,
  symbol       TEXT,
  action       TEXT,
  processed    BOOLEAN DEFAULT FALSE,
  processed_at TIMESTAMPTZ,
  outcome      TEXT,
  position_id  TEXT,
  error        TEXT
);

-- Partial index: the boot-time "what was left unprocessed?" query stays fast
-- no matter how many millions of processed rows accumulate.
CREATE INDEX IF NOT EXISTS idx_inbox_unprocessed
  ON signals_inbox (received_at) WHERE processed = FALSE;
