-- 008_close_source.sql
-- Records HOW each closed trade's win/loss was determined, so you can audit it.
--
-- BUGFIX CONTEXT: the old code contained
--     if (ghost.peakRRPos >= tpRR - 0.2) closeReason = "tp";
-- With tpRR = 1.5 that meant a GHOST peak of 1.3R booked the trade as a WIN in
-- closed_trades. Worse, it ran LAST in the chain, so it OVERRODE an explicit MT5
-- STOP_LOSS — real losing trades were recorded as wins, and the win-rate on the
-- dashboard was inflated.
--
-- closed_trades must reflect what the ACCOUNT actually did. The ghost is a separate,
-- parallel research track and must never touch it.
--
--   close_source : mt5_reason  - MT5 deal said TAKE_PROFIT / STOP_LOSS (definitive)
--                  exit_price  - inferred from which level the exit price landed on
--                  profit_sign - inferred from realized P&L sign
--                  assumed_sl  - nothing available; defaulted to SL (conservative)

ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS close_source TEXT;

CREATE INDEX IF NOT EXISTS idx_closed_trades_source ON closed_trades (close_source);
