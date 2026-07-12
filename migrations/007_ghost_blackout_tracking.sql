-- 007_ghost_blackout_tracking.sql
-- Honest handling of OBSERVATION GAPS.
--
-- The ghost only knows what it saw. If MetaAPI dies (circuit open) between
-- -0.2 and -0.6, the levels -0.3 / -0.4 / -0.5 were genuinely crossed — but we
-- never watched them happen. Previously every one of those got stamped with the
-- recovery timestamp, so the data claimed price teleported 0.4R in a single tick,
-- and the row still said data_complete = TRUE. A silent lie in the training set.
--
-- Now: levels crossed during a blackout are INTERPOLATED across the blackout
-- window (between the last price we actually saw and the first one after
-- recovery), and the row records exactly how much of it was guessed.
--
--   milestones_estimated : how many R-levels were inferred, not observed
--   blackout_min         : total minutes the ghost was blind
--
-- A ghost with milestones_estimated > 0 is still useful — but it is NOT clean.
-- Filter or down-weight these when fitting SL/TP from the ghost data.

ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS milestones_estimated INTEGER DEFAULT 0;
ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS blackout_min         NUMERIC DEFAULT 0;

-- ghost_state must survive a restart knowing when it last actually saw a price,
-- otherwise a redeploy looks like a zero-length gap.
ALTER TABLE ghost_state  ADD COLUMN IF NOT EXISTS last_price_at        BIGINT;
ALTER TABLE ghost_state  ADD COLUMN IF NOT EXISTS estimated_count      INTEGER DEFAULT 0;
ALTER TABLE ghost_state  ADD COLUMN IF NOT EXISTS blackout_min         NUMERIC DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ghost_trades_estimated ON ghost_trades (milestones_estimated);
