-- 012_ai_views.sql
-- ═══════════════════════════════════════════════════════════════════════════
--  DE MCP-LAAG: wat de AI mag zien
--
--  Filosofie: de eerlijkheidsfilters staan in de DATABASE, niet in de SQL die de
--  AI toevallig schrijft. Eén vergeten "WHERE data_complete = TRUE" en hij traint
--  op geraden data. Deze views maken dat onmogelijk.
--
--  Twee harde regels, hier afgedwongen:
--    1. ALLEEN waargenomen data. Geen reaper-gissingen, geen blackout-interpolaties.
--    2. ALLES IN R. Geen euro's, geen lots, geen contractgroottes.
--
--       rr = (prijs - entry) / slDist   -> dimensieloos.
--
--       GOUD EN NASDAQ VERGELIJK JE UITSLUITEND IN R.
--       XAUUSD en US100.cash hebben andere contractgroottes, tickwaarden en
--       prijsniveaus. Een punt goud is iets anders dan een punt nasdaq. In VALUTA
--       zijn die twee onvergelijkbaar -- appels en peren. In R wel vergelijkbaar,
--       want R normaliseert precies dat weg.
--
--       Bovendien: risk_eur en lots zijn op dit moment ONBETROUWBAAR (de lot-
--       berekening mist de contractgrootte). De R-statistiek is daar ongevoelig
--       voor -- R meet de kansverdeling, niet het bedrag. Elk GELDBEDRAG uit deze
--       database is echter fout. Daarom staan risk_eur en lots NIET in de views.
--
--  De AI praat met de views. Nooit met de ruwe tabellen.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. DE BASIS: alleen data die de ghost ECHT heeft gezien ────────────────
CREATE OR REPLACE VIEW v_ghost_clean AS
SELECT
  g.position_id,
  g.optimizer_key,          -- symbol_session_direction_vwapposition
  g.symbol,
  g.session,
  g.direction,
  g.vwap_position,
  EXTRACT(HOUR FROM g.opened_at)::int AS uur_utc,
  EXTRACT(DOW  FROM g.opened_at)::int AS weekdag,   -- 0 = zondag
  g.opened_at,
  -- ── ALLES IN R ──
  g.peak_rr_pos,            -- hoe ver liep hij ECHT (oneindige TP)
  g.peak_rr_neg,            -- hoeveel pijn nam hij eerst (negatieve R)
  g.rr_milestones,          -- R-stap -> MINUTEN (pure getallen)
  g.time_to_sl_min,
  -- ── context van het signaal ──
  s.vwap_band_pct,
  s.has_counter_pos,
  s.counter_gap_r,
  s.counter_safe_hedge
FROM ghost_trades g
LEFT JOIN signal_log s ON s.position_id = g.position_id
WHERE g.data_complete IS TRUE                       -- echt waargenomen
  AND COALESCE(g.milestones_estimated, 0) = 0       -- geen blackout-gissingen
  AND g.finalize_reason IN ('sl_hit', 'mt5_sl')     -- geen reaper-forceringen
  AND g.peak_rr_pos IS NOT NULL;

COMMENT ON VIEW v_ghost_clean IS
  'DE bron voor alle AI-analyse. Alleen waargenomen trades. ALLES IN R -- risk_eur en lots zijn HIER BEWUST WEGGELATEN. XAUUSD en US100.cash hebben verschillende contractgroottes en tickwaarden: in valuta zijn ze ONVERGELIJKBAAR. In R wel, want R is dimensieloos en normaliseert dat weg. Gebruik NOOIT ghost_trades direct.';


-- ── 2. EV per TP-doel, per bucket, per uur — DATAGEDREVEN ──────────────────
-- Wiskundig: tussen twee waargenomen pieken verandert P(piek >= T) niet, dus
-- EV(T) = P*T - (1-P) stijgt daar lineair. Het optimum ligt ALTIJD op een
-- waargenomen piek. Geen verzonnen grid nodig -- de data levert de kandidaten.
CREATE OR REPLACE VIEW v_ev_grid AS
WITH kandidaten AS (
  SELECT DISTINCT optimizer_key, uur_utc, ROUND(peak_rr_pos::numeric, 1) AS tp_doel
  FROM v_ghost_clean
  WHERE peak_rr_pos >= 0.5
)
SELECT
  k.optimizer_key,
  k.uur_utc,
  k.tp_doel,
  COUNT(*)                                                       AS n,
  ROUND(100.0 * AVG((c.peak_rr_pos >= k.tp_doel)::int), 1)       AS winrate_pct,
  ROUND((100.0 / (1 + k.tp_doel))::numeric, 1)                   AS breakeven_winrate_pct,
  ROUND(AVG(CASE WHEN c.peak_rr_pos >= k.tp_doel
                 THEN k.tp_doel ELSE -1 END)::numeric, 3)        AS ev_in_r,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (
    ORDER BY (c.rr_milestones->>('+' || TO_CHAR(k.tp_doel,'FM990.0')))::numeric
  )::numeric, 0)                                                 AS med_minuten_tot_doel
FROM kandidaten k
JOIN v_ghost_clean c
  ON c.optimizer_key = k.optimizer_key AND c.uur_utc = k.uur_utc
GROUP BY 1,2,3
HAVING COUNT(*) >= 30;      -- NOOIT optimaliseren op ruis

COMMENT ON VIEW v_ev_grid IS
  'EV per TP-doel. De kandidaat-TPs komen uit de data (waargenomen pieken), niet uit een verzonnen bereik. n >= 30 afgedwongen.';


-- ── 3. HET OPTIMUM per bucket, met vergelijking tegen de huidige 1.5R ──────
CREATE OR REPLACE VIEW v_optimale_rr AS
SELECT DISTINCT ON (optimizer_key, uur_utc)
  optimizer_key,
  uur_utc,
  n,
  tp_doel                AS beste_tp_r,        -- GEVONDEN, niet aangenomen
  winrate_pct,
  breakeven_winrate_pct,
  ev_in_r,
  med_minuten_tot_doel,
  (SELECT e.ev_in_r FROM v_ev_grid e
    WHERE e.optimizer_key = v_ev_grid.optimizer_key
      AND e.uur_utc = v_ev_grid.uur_utc
      AND e.tp_doel = 1.5)                     AS ev_bij_huidige_1_5r
FROM v_ev_grid
ORDER BY optimizer_key, uur_utc, ev_in_r DESC;

COMMENT ON VIEW v_optimale_rr IS
  'WAARSCHUWING: dit maximaliseert over tientallen kandidaten -> winners curse. Valideer ALTIJD walk-forward (v_walkforward) voordat je hierop handelt.';


-- ── 4. CHOP-DIAGNOSE: is het chop, of stond je TP gewoon verkeerd? ─────────
-- Een trade die piekt op +0.3R is CHOP -- geen enkele TP redt hem.
-- Een trade die piekt op +2.8R is GEEN chop -- je TP stond te laag.
CREATE OR REPLACE VIEW v_chop_diagnose AS
SELECT
  optimizer_key,
  uur_utc,
  COUNT(*)                                              AS n,
  ROUND(AVG(peak_rr_pos)::numeric, 2)                   AS gem_piek_r,
  ROUND(100.0 * AVG((peak_rr_pos < 0.5)::int), 1)       AS pct_dood_onder_0_5r,   -- echte chop
  ROUND(100.0 * AVG((peak_rr_pos >= 1.5)::int), 1)      AS pct_haalt_1_5r,
  ROUND(100.0 * AVG((peak_rr_pos >= 3.0)::int), 1)      AS pct_haalt_3r,          -- TP stond te laag
  ROUND(AVG(ABS(peak_rr_neg))::numeric, 2)              AS gem_pijn_r,
  ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (
        ORDER BY ABS(peak_rr_neg))::numeric, 2)         AS pijn_p90_r
FROM v_ghost_clean
GROUP BY 1,2
HAVING COUNT(*) >= 20;

COMMENT ON VIEW v_chop_diagnose IS
  'Scheidt ECHTE chop (niets loopt, geen TP helpt) van een verkeerd gekozen TP (het liep wel, je stapte te vroeg uit).';


-- ── 5. WALK-FORWARD: houdt een gevonden TP stand op ONGEZIENE data? ────────
-- Dit is de belangrijkste view. Zonder deze stap maakt de AI je met veel
-- zelfvertrouwen ARMER: een grid van tientallen kandidaten vindt ALTIJD iets
-- moois -- ook in pure ruis.
--
-- Train = alles behalve de laatste 30 dagen. Test = de laatste 30 dagen.
-- Bepaal de beste TP op TRAIN, en meet zijn EV op TEST.
CREATE OR REPLACE VIEW v_walkforward AS
WITH grens AS (
  SELECT (MAX(opened_at) - INTERVAL '30 days') AS cutoff FROM v_ghost_clean
),
train AS (SELECT c.* FROM v_ghost_clean c, grens g WHERE c.opened_at <  g.cutoff),
test  AS (SELECT c.* FROM v_ghost_clean c, grens g WHERE c.opened_at >= g.cutoff),
kand AS (
  SELECT DISTINCT optimizer_key, ROUND(peak_rr_pos::numeric,1) AS tp FROM train WHERE peak_rr_pos >= 0.5
),
train_ev AS (
  SELECT k.optimizer_key, k.tp, COUNT(*) AS n_train,
         AVG(CASE WHEN t.peak_rr_pos >= k.tp THEN k.tp ELSE -1 END) AS ev_train
  FROM kand k JOIN train t ON t.optimizer_key = k.optimizer_key
  GROUP BY 1,2 HAVING COUNT(*) >= 30
),
beste AS (
  SELECT DISTINCT ON (optimizer_key) optimizer_key, tp, n_train, ev_train
  FROM train_ev ORDER BY optimizer_key, ev_train DESC
)
SELECT
  b.optimizer_key,
  b.tp                                       AS gekozen_tp_op_train,
  b.n_train,
  ROUND(b.ev_train::numeric, 3)              AS ev_op_train,
  COUNT(t.*)                                 AS n_test,
  ROUND(AVG(CASE WHEN t.peak_rr_pos >= b.tp
                 THEN b.tp ELSE -1 END)::numeric, 3) AS ev_op_test,   -- DE WAARHEID
  ROUND((AVG(CASE WHEN t.peak_rr_pos >= b.tp THEN b.tp ELSE -1 END)
         - b.ev_train)::numeric, 3)          AS verval,
  CASE
    WHEN COUNT(t.*) < 20 THEN 'TE WEINIG TESTDATA'
    WHEN AVG(CASE WHEN t.peak_rr_pos >= b.tp THEN b.tp ELSE -1 END) > 0
     AND AVG(CASE WHEN t.peak_rr_pos >= b.tp THEN b.tp ELSE -1 END) > b.ev_train * 0.5
      THEN 'HOUDT STAND'
    ELSE 'WAARSCHIJNLIJK RUIS -- NIET GEBRUIKEN'
  END                                        AS oordeel
FROM beste b
LEFT JOIN test t ON t.optimizer_key = b.optimizer_key
GROUP BY b.optimizer_key, b.tp, b.n_train, b.ev_train;

COMMENT ON VIEW v_walkforward IS
  'VERPLICHT voor de AI. Bepaalt de TP op oude data en TOETST hem op de laatste 30 dagen. Alleen oordeel = HOUDT STAND mag naar ai_config.';


-- ── 6. DATAKWALITEIT: wat gooit de AI weg, en waarom? ──────────────────────
CREATE OR REPLACE VIEW v_data_kwaliteit AS
SELECT
  COUNT(*)                                                            AS totaal_ghosts,
  SUM((data_complete IS TRUE)::int)                                   AS waargenomen,
  SUM((data_complete IS NOT TRUE)::int)                               AS afgeleid,
  SUM((COALESCE(milestones_estimated,0) > 0)::int)                    AS met_blackout_gissingen,
  SUM((finalize_reason LIKE 'forced%')::int)                          AS geforceerd_afgesloten,
  ROUND(AVG(COALESCE(blackout_min,0))::numeric, 1)                    AS gem_blinde_minuten,
  (SELECT COUNT(*) FROM v_ghost_clean)                                AS bruikbaar_voor_ai,
  ROUND(100.0 * (SELECT COUNT(*) FROM v_ghost_clean)
        / NULLIF(COUNT(*),0), 1)                                      AS pct_bruikbaar
FROM ghost_trades;

COMMENT ON VIEW v_data_kwaliteit IS
  'Draai dit EERST. Is pct_bruikbaar laag, dan is de meting stuk en is elke conclusie waardeloos.';
