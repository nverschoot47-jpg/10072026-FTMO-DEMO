-- 010_ghost_state_truth.sql
--
-- BUG A (silent falsification):
--   ghost_state never persisted mt5_close_reason. On restart the ghost was rebuilt with
--       mt5CloseReason: g.mt5ClosedTP ? "tp" : null
--   so ANY ghost whose MT5 position was already closed came back as "tp" — including
--   trades force-closed with reason "unknown". A redeploy silently converted an unknown
--   close into a take-profit, and that fabricated reason was then written to
--   ghost_trades.mt5_close_reason and used as ground truth by the AI.
--   Now the real reason is stored and restored verbatim.
--
-- BUG B (mislabelled metric):
--   The dashboard showed maxRR as "RR Now", but maxRR is the PEAK, not the current
--   value. A finished loser showed "+0.44R" when it was actually sitting at -1.00R.
--   current_rr is now tracked and persisted separately from the peak.

ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS mt5_close_reason TEXT;
ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS current_rr       NUMERIC;
