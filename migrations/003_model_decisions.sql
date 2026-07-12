-- 003_model_decisions.sql  (feature 10 — shadow model interface)
-- Records what the model WOULD have decided on every signal, alongside the
-- feature snapshot it saw. In MODEL_MODE=shadow (default) the decision is
-- logged but never blocks a trade; in MODEL_MODE=live a "skip" blocks.
-- actual_outcome is backfilled later (from closed_trades / ghost_trades)
-- so the model's real precision can be measured on your own history before
-- it is ever trusted to gate live capital.

CREATE TABLE IF NOT EXISTS model_decisions (
  id             BIGSERIAL PRIMARY KEY,
  received_at    TIMESTAMPTZ DEFAULT NOW(),
  position_id    TEXT,                 -- linked after a trade is placed (nullable)
  optimizer_key  TEXT,
  symbol         TEXT,
  features       JSONB,                -- exact input vector the model scored
  model_score    NUMERIC,             -- 0..1
  model_decision TEXT,                 -- take | skip
  reason         TEXT,
  mode           TEXT,                 -- off | shadow | live (what was active)
  actual_outcome TEXT,                 -- backfilled: tp | sl | ...
  resolved_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_model_dec_key ON model_decisions (optimizer_key);
CREATE INDEX IF NOT EXISTS idx_model_dec_ts  ON model_decisions (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_dec_pos ON model_decisions (position_id);
