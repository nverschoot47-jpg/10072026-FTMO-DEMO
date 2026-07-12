-- 009_recover_ghosts.sql
-- One-time recovery of legacy closed_trades that never produced a ghost row.
--
-- WHY THIS MOVED HERE (this was a serious data-corruption bug):
-- The old version ran inside initDB, BEFORE the migrations. At that point the
-- data_complete / finalize_reason / milestones_estimated columns did not exist yet,
-- so every recovered row landed with:
--     rr_milestones = '{}'   (NO milestones at all)
--     data_complete = TRUE   (the column default)
-- i.e. it manufactured rows that LOOK like fully-observed ghosts but contain zero
-- excursion data — and fed them straight into the AI training set. Any query like
-- "median time to +1.5R" or "worst heat on winners" would be computed over rows
-- that never observed anything.
--
-- It also copied closed_trades.peak_rr_neg directly. That column used to hold a
-- PERCENT (0-100) while ghost_trades.peak_rr_neg holds NEGATIVE R (-0.70).
-- Same trade, two different units, silently joined. Normalised below.
--
-- Now: runs once, after the schema is complete, and every recovered row is
-- honestly flagged data_complete = FALSE / finalize_reason = 'recovered_from_closed'.

INSERT INTO ghost_trades (
  position_id, daily_label, optimizer_key, symbol, asset_type,
  direction, session, vwap_position,
  entry, sl, tp, lots, risk_eur, sl_pct, sl_dist,
  vwap_mid, vwap_upper, vwap_lower, vwap_band_pct,
  session_high, session_low, day_high, day_low,
  tv_entry, mt5_comment,
  peak_rr_pos, peak_rr_neg,
  rr_milestones, mt5_close_reason, opened_at, closed_at,
  finalize_reason, data_complete, milestones_estimated
)
SELECT
  ct.position_id, ct.daily_label, ct.optimizer_key, ct.symbol, ct.asset_type,
  ct.direction, ct.session, ct.vwap_position,
  ct.entry, ct.sl, ct.tp, ct.lots, ct.risk_eur, ct.sl_pct, ct.sl_dist,
  ct.vwap_mid, ct.vwap_upper, ct.vwap_lower, ct.vwap_band_pct,
  ct.session_high, ct.session_low, ct.day_high, ct.day_low,
  ct.tv_entry, ct.mt5_comment,
  COALESCE(ct.peak_rr_pos, 0),
  -- Normalise units: a value > 1 is a legacy PERCENT (70) -> convert to R (-0.70).
  -- Anything <= 0 is already negative R and passes through untouched.
  CASE
    WHEN ct.peak_rr_neg IS NULL THEN 0
    WHEN ct.peak_rr_neg > 1      THEN -(ct.peak_rr_neg / 100.0)
    ELSE ct.peak_rr_neg
  END,
  '{}'::jsonb,               -- no milestones exist for these — and we say so below
  ct.close_reason,
  ct.opened_at, ct.closed_at,
  'recovered_from_closed',   -- finalize_reason
  FALSE,                     -- data_complete: NOT observed. Never train on these.
  0                          -- milestones_estimated
FROM closed_trades ct
WHERE ct.position_id IS NOT NULL
  AND ct.opened_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM ghost_trades gt WHERE gt.position_id = ct.position_id)
ON CONFLICT (position_id) DO NOTHING;
