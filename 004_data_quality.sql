-- 004_data_quality.sql  (feature 11 — data-quality guards)
-- (a) signal_log.data_flags — per-row, non-blocking self-labelling. When a
--     signal arrives with a missing/absurd critical field, the row is STILL
--     inserted (never dropped) but carries a JSONB list of what looked wrong,
--     so questionable rows can be filtered out at training time.
-- (b) data_health — one row per daily integrity scan: null-rates, stuck
--     ghosts (in ghost_state but never finalized), equity-curve gaps, etc.
--     Turns slow-burn corruption into a next-day signal instead of a
--     year-later surprise.

ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS data_flags JSONB;

CREATE TABLE IF NOT EXISTS data_health (
  id            BIGSERIAL PRIMARY KEY,
  checked_at    TIMESTAMPTZ DEFAULT NOW(),
  window_hours  INTEGER,
  signals_total INTEGER,
  flagged_total INTEGER,
  flagged_pct   NUMERIC,
  stuck_ghosts  INTEGER,       -- ghost_state rows older than the stuck threshold
  equity_gaps   INTEGER,       -- gaps > 30 min in equity_curve
  future_rows   INTEGER,       -- rows time-stamped in the future (clock issues)
  notes         JSONB          -- full detail per check
);

CREATE INDEX IF NOT EXISTS idx_data_health_ts ON data_health (checked_at DESC);
