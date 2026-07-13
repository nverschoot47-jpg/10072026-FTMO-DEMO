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


-- ═══════════════════════════════════════════════════════════════════════
--  HET HEDGE-VRAAGSTUK — beantwoord het met data, niet met een mening
--
--  De enige vraag die telt:
--    "Heeft een tegensignaal dat vuurt terwijl er een positie openstaat,
--     op zichzelf positieve EV?"
--
--  Bij 1.5RR is de break-even winrate 40%.
--    > 40%  -> gewoon nemen. De hedge-framing is irrelevant (EV is lineair).
--    < 40%  -> SKIPPEN. Dat is een chop-filter, geen hedge.
-- ═══════════════════════════════════════════════════════════════════════

-- 1) Hoe vaak komt dit uberhaupt voor? (Is het relevant of academisch?)
SELECT
  has_counter_pos,
  counter_safe_hedge,
  COUNT(*)                                   AS signalen,
  ROUND(AVG(counter_gap_r)::numeric, 2)      AS gem_gap_r,
  ROUND(AVG(counter_age_min)::numeric, 0)    AS gem_leeftijd_min
FROM signal_log
WHERE outcome = 'PLACED'
GROUP BY 1, 2
ORDER BY 1 DESC, 2 DESC NULLS LAST;

-- 2) DE KERNVRAAG: winnen die tegensignalen, of verliezen ze?
SELECT
  CASE
    WHEN NOT s.has_counter_pos              THEN 'geen tegenpositie (normaal)'
    WHEN s.counter_safe_hedge IS TRUE       THEN 'tegensignaal, gap > 0.5R (veilige hedge)'
    ELSE                                         'tegensignaal, gap <= 0.5R (onveilig)'
  END                                                        AS soort,
  COUNT(*)                                                   AS n,
  SUM(CASE WHEN c.close_reason = 'tp' THEN 1 ELSE 0 END)     AS wins,
  ROUND(100.0 * SUM(CASE WHEN c.close_reason='tp' THEN 1 ELSE 0 END)
        / NULLIF(COUNT(*),0), 1)                             AS winrate_pct,
  -- EV in R bij 1.5RR:  winrate * 1.5 - (1 - winrate) * 1.0
  ROUND(( (1.5 * SUM(CASE WHEN c.close_reason='tp' THEN 1 ELSE 0 END)
           - 1.0 * SUM(CASE WHEN c.close_reason='sl' THEN 1 ELSE 0 END))
          / NULLIF(COUNT(*),0) )::numeric, 3)                AS ev_in_R,
  '40% = break-even'                                         AS referentie
FROM signal_log s
JOIN closed_trades c ON c.position_id = s.position_id
WHERE s.outcome = 'PLACED' AND c.close_reason IN ('tp','sl')
GROUP BY 1
ORDER BY ev_in_R DESC;

-- 3) Wat deed de EERSTE positie ondertussen? (Verliezen ze allebei = chop?)
SELECT
  c_new.close_reason AS uitkomst_tegensignaal,
  c_old.close_reason AS uitkomst_eerste,
  COUNT(*)           AS n
FROM signal_log s
JOIN closed_trades c_new ON c_new.position_id = s.position_id
JOIN closed_trades c_old ON c_old.position_id = s.counter_pos_id
WHERE s.has_counter_pos IS TRUE
GROUP BY 1, 2
ORDER BY n DESC;


-- ═══════════════════════════════════════════════════════════════════════
--  RR-GRID: is "choppy" wel choppy bij een ANDERE TP?
--
--  De vorige queries meten win/loss via closed_trades.close_reason — en dat is
--  de uitkomst bij 1.5RR. Dat is precies de aanname die dit systeem wil vervangen.
--
--  De ghost lost dat op. peak_rr_pos = hoe ver de prijs liep VOOR de fantoom-SL,
--  oftewel: "wat had ik gehaald met een oneindige TP". Dus voor ELK doel T:
--
--      peak_rr_pos >= T   ->  win van +T
--      peak_rr_pos <  T   ->  verlies van -1R
--      EV(T) = P(peak >= T) * T - P(peak < T)
--
--  Zo reken je elke TP door zonder een enkele trade opnieuw te doen.
--  De SL blijft ongemoeid -> dit is EERLIJK met de huidige 10s-meting.
--  (SL verlagen kan NIET eerlijk: daarvoor moet de ghost M1 high/low zien.)
-- ═══════════════════════════════════════════════════════════════════════

-- 4) EV per TP-doel, GESPLITST naar tegensignaal ja/nee.
--    Hier zie je of chop-signalen op een ANDERE RR wel werken.
WITH schoon AS (
  SELECT g.position_id, g.optimizer_key, g.symbol, g.session, g.peak_rr_pos,
         COALESCE(s.has_counter_pos, FALSE) AS tegensignaal
  FROM ghost_trades g
  LEFT JOIN signal_log s ON s.position_id = g.position_id
  WHERE g.data_complete IS TRUE
    AND COALESCE(g.milestones_estimated, 0) = 0
),
doelen AS (SELECT generate_series(10, 40, 5) / 10.0 AS T)   -- 1.0 t/m 4.0R
SELECT
  d.T                                                         AS tp_doel_R,
  s.tegensignaal,
  COUNT(*)                                                    AS n,
  ROUND(100.0 * AVG((s.peak_rr_pos >= d.T)::int), 1)          AS winrate_pct,
  ROUND(AVG(CASE WHEN s.peak_rr_pos >= d.T
                 THEN d.T ELSE -1 END)::numeric, 3)           AS ev_in_R,
  ROUND((100.0 / (1 + d.T))::numeric, 1)                      AS breakeven_winrate_pct
FROM schoon s CROSS JOIN doelen d
GROUP BY d.T, s.tegensignaal
HAVING COUNT(*) >= 20
ORDER BY s.tegensignaal, d.T;

-- 5) DE ECHTE VRAAG: wat is de BESTE TP per bucket, per uur?
--    Niet "werkt 1.5R", maar "welke T maximaliseert EV hier".
WITH schoon AS (
  SELECT optimizer_key, EXTRACT(HOUR FROM opened_at)::int AS uur, peak_rr_pos
  FROM ghost_trades
  WHERE data_complete IS TRUE AND COALESCE(milestones_estimated,0) = 0
),
doelen AS (SELECT generate_series(10, 40, 5) / 10.0 AS T),
grid AS (
  SELECT s.optimizer_key, s.uur, d.T,
         COUNT(*) AS n,
         AVG(CASE WHEN s.peak_rr_pos >= d.T THEN d.T ELSE -1 END) AS ev
  FROM schoon s CROSS JOIN doelen d
  GROUP BY 1,2,3
  HAVING COUNT(*) >= 30          -- NOOIT optimaliseren op ruis
)
SELECT DISTINCT ON (optimizer_key, uur)
  optimizer_key, uur, n,
  T                          AS beste_tp_R,
  ROUND(ev::numeric, 3)      AS ev_in_R,
  ROUND((SELECT ev FROM grid g2
         WHERE g2.optimizer_key = grid.optimizer_key
           AND g2.uur = grid.uur AND g2.T = 1.5)::numeric, 3) AS ev_bij_1_5R
FROM grid
ORDER BY optimizer_key, uur, ev DESC;

-- 6) Chop-diagnose: is het chop (niets loopt) of gewoon een verkeerde TP?
--    Een trade die piekt op +0.3R is CHOP -- geen enkele TP redt hem.
--    Een trade die piekt op +2.8R is GEEN chop -- je TP stond te laag.
SELECT
  COALESCE(s.has_counter_pos, FALSE)                          AS tegensignaal,
  COUNT(*)                                                    AS n,
  ROUND(AVG(g.peak_rr_pos)::numeric, 2)                       AS gem_piek_R,
  ROUND(100.0 * AVG((g.peak_rr_pos < 0.5)::int), 1)           AS pct_dood_onder_0_5R,
  ROUND(100.0 * AVG((g.peak_rr_pos >= 1.5)::int), 1)          AS pct_haalt_1_5R,
  ROUND(100.0 * AVG((g.peak_rr_pos >= 3.0)::int), 1)          AS pct_haalt_3R
FROM ghost_trades g
LEFT JOIN signal_log s ON s.position_id = g.position_id
WHERE g.data_complete IS TRUE AND COALESCE(g.milestones_estimated,0) = 0
GROUP BY 1;


-- ═══════════════════════════════════════════════════════════════════════
--  7) DE OPTIMALE RR — VOLLEDIG UIT DE DATA, GEEN VERZONNEN GRID
--
--  Query 5 gebruikte generate_series(1.0 ... 4.0). Dat is een VERZONNEN bereik.
--  Niet doen. De kandidaten moeten uit de dataset komen.
--
--  Wiskundig feit: tussen twee waargenomen pieken verandert P(piek >= T) niet,
--  dus EV(T) = P * T - (1-P) stijgt daar LINEAIR met T. De kans klapt pas omlaag
--  zodra T over een waargenomen piek heen gaat.
--
--      => Het EV-optimum ligt ALTIJD precies op een waargenomen piek.
--
--  Dus: elke geobserveerde peak_rr_pos in een bucket is een kandidaat-TP.
--  Geen aanname, geen 1.5, geen 3.0. De data kiest.
--
--  Buy/sell zitten al gescheiden: direction zit IN optimizer_key.
--  Sessie ook. We voegen alleen het uur toe.
-- ═══════════════════════════════════════════════════════════════════════

WITH schoon AS (
  SELECT
    optimizer_key, symbol, session, direction,
    EXTRACT(HOUR FROM opened_at)::int AS uur,
    peak_rr_pos,
    rr_milestones
  FROM ghost_trades
  WHERE data_complete IS TRUE
    AND COALESCE(milestones_estimated, 0) = 0
    AND finalize_reason IN ('sl_hit','mt5_sl')     -- alleen ECHT waargenomen
),
-- Kandidaat-TP's = de waargenomen pieken zelf, afgerond op de 0.1R-raster
-- waarop de ghost sowieso meet.
kandidaten AS (
  SELECT DISTINCT optimizer_key, uur,
         ROUND(peak_rr_pos::numeric, 1) AS T
  FROM schoon
  WHERE peak_rr_pos >= 0.5              -- onder 0.5R is er niets te oogsten
),
ev_grid AS (
  SELECT
    k.optimizer_key, k.uur, k.T,
    COUNT(*)                                                        AS n,
    ROUND(100.0 * AVG((s.peak_rr_pos >= k.T)::int), 1)              AS winrate_pct,
    ROUND(AVG(CASE WHEN s.peak_rr_pos >= k.T THEN k.T ELSE -1 END)::numeric, 3) AS ev,
    -- mediane tijd tot dat doel: "max gain in fastest time"
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (
      ORDER BY (s.rr_milestones->>('+' || TO_CHAR(k.T,'FM990.0')))::numeric
    )::numeric, 0)                                                  AS med_min_tot_T
  FROM kandidaten k
  JOIN schoon s
    ON s.optimizer_key = k.optimizer_key AND s.uur = k.uur
  GROUP BY 1,2,3
  HAVING COUNT(*) >= 30            -- NOOIT optimaliseren op ruis
)
SELECT DISTINCT ON (optimizer_key, uur)
  optimizer_key,
  uur,
  n,
  T                AS beste_tp_R,          -- <- GEVONDEN, niet aangenomen
  winrate_pct,
  ev               AS ev_in_R,
  med_min_tot_T    AS mediane_minuten,
  -- vergelijking met de huidige vaste 1.5R
  (SELECT e2.ev FROM ev_grid e2
    WHERE e2.optimizer_key = ev_grid.optimizer_key
      AND e2.uur = ev_grid.uur
      AND e2.T = 1.5)                      AS ev_bij_1_5R,
  ROUND((ev - COALESCE((SELECT e3.ev FROM ev_grid e3
    WHERE e3.optimizer_key = ev_grid.optimizer_key
      AND e3.uur = ev_grid.uur AND e3.T = 1.5), 0))::numeric, 3) AS winst_tov_1_5R
FROM ev_grid
ORDER BY optimizer_key, uur, ev DESC;

-- ═══════════════════════════════════════════════════════════════════════
--  ⚠️  WAARSCHUWING BIJ QUERY 7 — LEES DIT VOOR JE HANDELT
--
--  Deze query zoekt per bucket het maximum over TIENTALLEN kandidaat-TP's.
--  Maximaliseren over veel opties vindt ALTIJD iets moois -- ook in pure ruis.
--  De gevonden "beste TP" is dus per definitie te optimistisch (winner's curse).
--
--  Verplicht voor gebruik:
--    1. WALK-FORWARD: bepaal T op maand 1-3, TOETS hem op maand 4.
--       Houdt de EV stand op ongeziene data? Zo nee: het was ruis.
--    2. Kijk of T STABIEL is over de tijd. Springt hij van 1.4 naar 3.1 naar 2.0
--       tussen periodes, dan meet je ruis, geen structuur.
--    3. n >= 30 is een ONDERGRENS, geen comfort. Bij 30 samples is de
--       standaardfout op de winrate ~9 procentpunt.
--    4. Kosten (commissie/swap) zitten hier NIET in. Elke EV is te rooskleurig.
--
--  De ghost meet met 10s-polls. Dat is EERLIJK voor TP-verandering (de SL blijft
--  waar hij stond). Het is NIET eerlijk zodra je de SL wilt verkleinen -- daarvoor
--  moet de ghost M1 high/low zien, anders mis je precies de wicks die je uitstoppen.
-- ═══════════════════════════════════════════════════════════════════════
