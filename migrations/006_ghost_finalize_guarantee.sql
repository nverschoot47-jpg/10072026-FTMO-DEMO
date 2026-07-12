-- 006_ghost_finalize_guarantee.sql
-- A ghost must ALWAYS end up in ghost_trades. Never left hanging.
--
-- Before this, a ghost only finalized when price polling saw the phantom SL hit.
-- If MetaAPI was down (circuit open), the symbol went quiet, or the trade simply
-- never came back to the stop, the ghost sat in ghost_state forever and its data
-- was never written — silently lost.
--
-- Now every ghost is force-finalized by the reaper if it goes stale or too old.
-- These two columns record HOW it ended, so incomplete rows can be excluded
-- (or down-weighted) when training the model.
--
--   finalize_reason : sl_hit          - clean: phantom SL actually observed
--                     mt5_sl          - MT5 closed at SL (negatives backfilled)
--                     forced_stale    - no price updates for too long
--                     forced_max_age  - ran past the max ghost lifetime
--                     forced_shutdown - flushed on process shutdown
--   data_complete   : TRUE only for a genuinely observed outcome.

ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS finalize_reason TEXT;
ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS data_complete   BOOLEAN DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_ghost_trades_complete ON ghost_trades (data_complete);
