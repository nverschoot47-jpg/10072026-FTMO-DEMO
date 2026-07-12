-- ═══════════════════════════════════════════════════════════════════════
--  PRONTO-AI — DATA INTEGRITY CHECK
--  Run this against any firm's Postgres before you train anything on it.
--  Every check should return 0. Anything above 0 is data you cannot trust.
--
--  Usage (Railway -> Postgres -> Data / Query):
--      paste the whole file, run, read the `bad` column.
-- ═══════════════════════════════════════════════════════════════════════

WITH checks AS (

-- ── UNITS ────────────────────────────────────────────────────────────
-- peak_rr_neg must be NEGATIVE R (-0.70), never a legacy percent (70).
SELECT '01 peak_rr_neg looks like a PERCENT in ghost_trades' AS check, COUNT(*) AS bad
FROM ghost_trades WHERE peak_rr_neg > 1
UNION ALL
SELECT '02 peak_rr_neg looks like a PERCENT in closed_trades', COUNT(*)
FROM closed_trades WHERE peak_rr_neg > 1

-- ── MILESTONES ───────────────────────────────────────────────────────
-- Must be NUMBERS (minutes), never display strings ("1h47m") and never epoch ms.
UNION ALL
SELECT '03 rr_milestones holds a STRING instead of minutes', COUNT(*)
FROM ghost_trades, jsonb_each(COALESCE(rr_milestones,'{}'::jsonb)) e
WHERE jsonb_typeof(e.value) <> 'number'
UNION ALL
SELECT '04 rr_milestones holds an EPOCH timestamp (>1e6 min)', COUNT(*)
FROM ghost_trades, jsonb_each(COALESCE(rr_milestones,'{}'::jsonb)) e
WHERE jsonb_typeof(e.value) = 'number' AND (e.value)::text::numeric > 1000000
UNION ALL
SELECT '05 milestone time is NEGATIVE', COUNT(*)
FROM ghost_trades, jsonb_each(COALESCE(rr_milestones,'{}'::jsonb)) e
WHERE jsonb_typeof(e.value) = 'number' AND (e.value)::text::numeric < 0

-- ── HONESTY FLAGS ────────────────────────────────────────────────────
-- A row claiming to be complete must actually contain observations.
UNION ALL
SELECT '06 data_complete=TRUE but rr_milestones is EMPTY', COUNT(*)
FROM ghost_trades
WHERE data_complete IS TRUE AND COALESCE(rr_milestones,'{}'::jsonb) = '{}'::jsonb
UNION ALL
SELECT '07 data_complete=TRUE but milestones were ESTIMATED', COUNT(*)
FROM ghost_trades
WHERE data_complete IS TRUE AND COALESCE(milestones_estimated,0) > 0
UNION ALL
SELECT '08 forced finalize still flagged complete', COUNT(*)
FROM ghost_trades
WHERE finalize_reason LIKE 'forced%' AND data_complete IS TRUE

-- ── MONOTONICITY ─────────────────────────────────────────────────────
-- Price cannot reach -0.5R before it reached -0.4R.
UNION ALL
SELECT '09 negative milestones NOT monotonic (-0.5 before -0.4)', COUNT(*)
FROM ghost_trades
WHERE (rr_milestones->>'-0.5')::numeric < (rr_milestones->>'-0.4')::numeric
   OR (rr_milestones->>'-1.0')::numeric < (rr_milestones->>'-0.9')::numeric
UNION ALL
SELECT '10 positive milestones NOT monotonic (+1.5 before +1.0)', COUNT(*)
FROM ghost_trades
WHERE (rr_milestones->>'+1.5')::numeric < (rr_milestones->>'+1.0')::numeric

-- ── CONSISTENCY BETWEEN TABLES ───────────────────────────────────────
UNION ALL
SELECT '11 ghost peak disagrees with closed_trades peak', COUNT(*)
FROM ghost_trades g JOIN closed_trades c USING (position_id)
WHERE ABS(COALESCE(g.peak_rr_pos,0) - COALESCE(c.peak_rr_pos,0)) > 0.05
UNION ALL
SELECT '12 optimizer_key disagrees with its own columns', COUNT(*)
FROM ghost_trades
WHERE optimizer_key IS NOT NULL
  AND optimizer_key <> (symbol||'_'||session||'_'||direction||'_'||vwap_position)

-- ── WIN/LOSS TRUTH (the 1.3R bug) ────────────────────────────────────
-- A trade marked TP whose exit price sat on the SL is a fabricated win.
UNION ALL
SELECT '13 marked TP but exit price is at the SL', COUNT(*)
FROM closed_trades
WHERE close_reason = 'tp' AND exit_price IS NOT NULL AND sl IS NOT NULL AND tp IS NOT NULL
  AND ABS(exit_price - sl) < ABS(exit_price - tp)
UNION ALL
SELECT '14 win/loss decided WITHOUT an MT5 reason', COUNT(*)
FROM closed_trades
WHERE close_source IS DISTINCT FROM 'mt5_reason'
UNION ALL
SELECT '15 marked TP but the ghost never even reached 1.0R', COUNT(*)
FROM closed_trades c JOIN ghost_trades g USING (position_id)
WHERE c.close_reason = 'tp' AND COALESCE(g.peak_rr_pos,0) < 1.0

-- ── COMPLETENESS ─────────────────────────────────────────────────────
UNION ALL
SELECT '16 PLACED signal with no VWAP context', COUNT(*)
FROM signal_log WHERE outcome = 'PLACED' AND vwap_mid IS NULL
UNION ALL
SELECT '17 signals carrying data_flags', COUNT(*)
FROM signal_log WHERE data_flags IS NOT NULL
UNION ALL
SELECT '18 closed trade with NO ghost row', COUNT(*)
FROM closed_trades c
WHERE NOT EXISTS (SELECT 1 FROM ghost_trades g WHERE g.position_id = c.position_id)
UNION ALL
SELECT '19 ghost STUCK in ghost_state > 72h', COUNT(*)
FROM ghost_state WHERE opened_at < NOW() - INTERVAL '72 hours'
UNION ALL
SELECT '20 webhook received but never processed', COUNT(*)
FROM signals_inbox WHERE processed = FALSE AND received_at < NOW() - INTERVAL '1 hour'
)
SELECT check, bad, CASE WHEN bad = 0 THEN 'OK' ELSE 'INVESTIGATE' END AS status
FROM checks ORDER BY bad DESC, check;


-- ═══════════════════════════════════════════════════════════════════════
--  THE CLEAN TRAINING SET
--  This is the ONLY thing you should fit SL/TP/risk on.
-- ═══════════════════════════════════════════════════════════════════════
-- SELECT
--   g.optimizer_key,
--   EXTRACT(HOUR FROM g.opened_at) AS hour_utc,
--   COUNT(*)                                          AS n,
--   ROUND(AVG(g.peak_rr_pos)::numeric, 2)             AS avg_peak_r,
--   ROUND(AVG(g.peak_rr_neg)::numeric, 2)             AS avg_heat_r,
--   -- how tight could the SL have been on trades that WON?
--   ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (
--         ORDER BY ABS(g.peak_rr_neg))::numeric, 2)   AS heat_p90,
--   -- how much did a 1.5R TP leave on the table?
--   ROUND(AVG(GREATEST(g.peak_rr_pos - 1.5, 0))::numeric, 2) AS left_on_table_r,
--   ROUND(AVG((g.rr_milestones->>'+1.5')::numeric), 0)       AS median_min_to_1_5R
-- FROM ghost_trades g
-- WHERE g.data_complete IS TRUE            -- observed, not inferred
--   AND COALESCE(g.milestones_estimated,0) = 0   -- no blackout guesses
--   AND g.finalize_reason IN ('sl_hit','mt5_sl') -- a real, watched outcome
-- GROUP BY 1,2
-- HAVING COUNT(*) >= 30                    -- never optimise on noise
-- ORDER BY avg_peak_r DESC;
