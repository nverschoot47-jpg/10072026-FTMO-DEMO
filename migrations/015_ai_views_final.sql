-- 015_ai_views_final.sql
-- ═══════════════════════════════════════════════════════════════════════════
--  DE DEFINITIEVE AI-LAAG — alle 8 views, in één bestand
--
--  Waarom hier en niet in 012:
--  012 draaide VOOR 013, dus de genormaliseerde contextkolommen (vwap_dist_r,
--  sess_range_r, pos_in_day_range, ...) bestonden daar nog niet. En toen 012
--  alsnog draaide na 014, weigerde Postgres met "cannot drop columns from view"
--  -- CREATE OR REPLACE VIEW mag kolommen TOEVOEGEN, nooit VERWIJDEREN.
--
--  Deze migratie DROPT eerst alles en bouwt daarna schoon opnieuw op. Dat is
--  veilig: views bevatten geen data, alleen een definitie.
--
--  TWEE HARDE REGELS, hier afgedwongen in de DATABASE (niet in de SQL die de
--  AI toevallig schrijft):
--
--    1. ALLEEN WAARGENOMEN DATA. Geen reaper-gissingen, geen gaten uit blackouts.
--    2. ALLES IN R. risk_eur en lots komen NERGENS voor.
--       XAUUSD en US100.cash hebben andere contractgroottes en zijn in VALUTA
--       onvergelijkbaar. In R wel -- R is dimensieloos en normaliseert dat weg.
--       Bovendien is de lot-berekening momenteel FOUT (mist de contractgrootte),
--       dus elk geldbedrag uit deze database is onbetrouwbaar. De R-statistiek
--       is daar ongevoelig voor: R meet de kansverdeling, niet het bedrag.
-- ═══════════════════════════════════════════════════════════════════════════

DROP VIEW IF EXISTS v_walkforward      CASCADE;
DROP VIEW IF EXISTS v_optimale_rr      CASCADE;
DROP VIEW IF EXISTS v_ev_grid          CASCADE;
DROP VIEW IF EXISTS v_chop_diagnose    CASCADE;
DROP VIEW IF EXISTS v_conditie_analyse CASCADE;
DROP VIEW IF EXISTS v_vwap_analyse     CASCADE;
DROP VIEW IF EXISTS v_data_kwaliteit   CASCADE;
DROP VIEW IF EXISTS v_ghost_clean      CASCADE;


-- ── 1. DE BASIS ────────────────────────────────────────────────────────────
CREATE VIEW v_ghost_clean AS
SELECT
  g.position_id,
  g.optimizer_key,
  g.symbol,
  g.session,
  g.direction,
  g.vwap_position,
  EXTRACT(HOUR FROM g.opened_at)::int AS uur_utc,
  EXTRACT(DOW  FROM g.opened_at)::int AS weekdag,
  g.opened_at,

  -- UITKOMST (alles in R)
  g.peak_rr_pos,          -- hoe ver liep hij ECHT (oneindige TP)
  g.peak_rr_neg,          -- hoeveel pijn nam hij eerst (negatieve R)
  g.rr_milestones,        -- R-stap -> MINUTEN (pure getallen)
  g.time_to_sl_min,

  -- MARKTCONDITIE bij entry (webhook-futures -> % -> brokerfill -> R)
  s.vwap_dist_r,          -- + = entry ligt BOVEN de vwap
  s.sess_range_r,         -- breedte van het ochtendkanaal  <- de chop-vraag
  s.sess_high_dist_r,     -- ruimte omhoog
  s.sess_low_dist_r,      -- ruimte omlaag
  s.pos_in_sess_range,    -- 0 = op de low, 1 = op de high
  s.day_range_r,
  s.pos_in_day_range,     -- 0 = day low, 1 = day high
  s.vwap_band_pct_r,

  -- TEGENSIGNAAL
  s.has_counter_pos,
  s.counter_gap_r,
  s.counter_safe_hedge
FROM ghost_trades g
LEFT JOIN signal_log s ON s.position_id = g.position_id
WHERE g.data_complete IS TRUE
  AND COALESCE(g.milestones_estimated, 0) = 0
  AND g.finalize_reason IN ('sl_hit', 'mt5_sl')
  AND g.peak_rr_pos IS NOT NULL;

COMMENT ON VIEW v_ghost_clean IS
  'DE bron voor alle AI-analyse. Alleen WAARGENOMEN trades. ALLES IN R -- risk_eur en lots ontbreken BEWUST: goud en nasdaq zijn in valuta onvergelijkbaar, en de lot-berekening is fout. Gebruik NOOIT ghost_trades direct.';


-- ── 2. DATAKWALITEIT — draai dit ALTIJD eerst ──────────────────────────────
CREATE VIEW v_data_kwaliteit AS
SELECT
  COUNT(*)                                                  AS totaal_ghosts,
  SUM((data_complete IS TRUE)::int)                         AS waargenomen,
  SUM((data_complete IS NOT TRUE)::int)                     AS afgeleid,
  SUM((COALESCE(milestones_estimated,0) > 0)::int)          AS met_gaten,
  SUM((finalize_reason LIKE 'forced%')::int)                AS geforceerd,
  ROUND(AVG(COALESCE(blackout_min,0))::numeric, 1)          AS gem_blinde_minuten,
  (SELECT COUNT(*) FROM v_ghost_clean)                      AS bruikbaar_voor_ai,
  ROUND(100.0 * (SELECT COUNT(*) FROM v_ghost_clean)
        / NULLIF(COUNT(*),0), 1)                            AS pct_bruikbaar
FROM ghost_trades;

COMMENT ON VIEW v_data_kwaliteit IS
  'ALTIJD EERST DRAAIEN. Is pct_bruikbaar laag, dan is de meting stuk en is elke conclusie waardeloos.';


-- ── 3. CHOP-DIAGNOSE ───────────────────────────────────────────────────────
-- Scheidt ECHTE chop (niets beweegt, geen TP redt het) van een verkeerd
-- gekozen TP (hij liep wel, je stapte te vroeg uit).
CREATE VIEW v_chop_diagnose AS
SELECT
  optimizer_key,
  uur_utc,
  COUNT(*)                                              AS n,
  ROUND(AVG(peak_rr_pos)::numeric, 2)                   AS gem_piek_r,
  ROUND(100.0 * AVG((peak_rr_pos < 0.5)::int), 1)       AS pct_dood_onder_0_5r,
  ROUND(100.0 * AVG((peak_rr_pos >= 1.5)::int), 1)      AS pct_haalt_1_5r,
  ROUND(100.0 * AVG((peak_rr_pos >= 3.0)::int), 1)      AS pct_haalt_3r,
  ROUND(AVG(ABS(peak_rr_neg))::numeric, 2)              AS gem_pijn_r,
  ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (
        ORDER BY ABS(peak_rr_neg))::numeric, 2)         AS pijn_p90_r
FROM v_ghost_clean
GROUP BY 1,2
HAVING COUNT(*) >= 20;


-- ── 4. MARKTCONDITIES ──────────────────────────────────────────────────────
CREATE VIEW v_conditie_analyse AS
SELECT
  symbol,
  direction,
  CASE
    WHEN sess_range_r IS NULL THEN 'onbekend'
    WHEN sess_range_r <  1.5  THEN 'smal kanaal (<1.5R)'
    WHEN sess_range_r <  3.0  THEN 'gemiddeld (1.5-3R)'
    ELSE                           'breed kanaal (>3R)'
  END                                                   AS kanaalbreedte,
  CASE
    WHEN pos_in_day_range IS NULL THEN 'onbekend'
    WHEN pos_in_day_range < 0.33  THEN 'onderin de dag'
    WHEN pos_in_day_range < 0.67  THEN 'midden'
    ELSE                               'bovenin de dag'
  END                                                   AS positie_in_dag,
  COUNT(*)                                              AS n,
  ROUND(AVG(peak_rr_pos)::numeric, 2)                   AS gem_piek_r,
  ROUND(100.0 * AVG((peak_rr_pos >= 1.5)::int), 1)      AS pct_haalt_1_5r,
  ROUND(100.0 * AVG((peak_rr_pos >= 3.0)::int), 1)      AS pct_haalt_3r,
  ROUND(100.0 * AVG((peak_rr_pos < 0.5)::int), 1)       AS pct_dood_chop,
  ROUND(AVG(CASE WHEN peak_rr_pos >= 1.5 THEN 1.5 ELSE -1 END)::numeric, 3) AS ev_bij_1_5r
FROM v_ghost_clean
GROUP BY 1,2,3,4
HAVING COUNT(*) >= 20;

COMMENT ON VIEW v_conditie_analyse IS
  'Is een SMAL kanaal echte chop? Werken breakouts alleen bovenin de dagrange? Gaat over marktcondities, niet over tijdstippen.';


-- ── 5. VWAP-AFSTAND ────────────────────────────────────────────────────────
CREATE VIEW v_vwap_analyse AS
SELECT
  symbol,
  direction,
  CASE
    WHEN vwap_dist_r IS NULL THEN 'onbekend'
    WHEN vwap_dist_r < -1.0  THEN 'ver ONDER vwap (< -1R)'
    WHEN vwap_dist_r <  0    THEN 'iets onder vwap'
    WHEN vwap_dist_r <  1.0  THEN 'iets boven vwap'
    ELSE                          'ver BOVEN vwap (> +1R)'
  END                                                   AS vwap_zone,
  COUNT(*)                                              AS n,
  ROUND(AVG(peak_rr_pos)::numeric, 2)                   AS gem_piek_r,
  ROUND(100.0 * AVG((peak_rr_pos >= 1.5)::int), 1)      AS pct_haalt_1_5r,
  ROUND(AVG(CASE WHEN peak_rr_pos >= 1.5 THEN 1.5 ELSE -1 END)::numeric, 3) AS ev_bij_1_5r
FROM v_ghost_clean
GROUP BY 1,2,3
HAVING COUNT(*) >= 20;


-- ── 6. EV-GRID ─────────────────────────────────────────────────────────────
-- Wiskundig: tussen twee waargenomen pieken verandert P(piek >= T) niet, dus
-- EV(T) = P*T - (1-P) stijgt daar LINEAIR. Het optimum ligt ALTIJD op een
-- waargenomen piek. De kandidaten komen dus UIT DE DATA, niet uit een
-- verzonnen bereik.
CREATE VIEW v_ev_grid AS
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


-- ── 7. HET OPTIMUM (⚠️ HYPOTHESE, GEEN CONCLUSIE) ──────────────────────────
CREATE VIEW v_optimale_rr AS
SELECT DISTINCT ON (optimizer_key, uur_utc)
  optimizer_key,
  uur_utc,
  n,
  tp_doel                AS beste_tp_r,       -- GEVONDEN, niet aangenomen
  winrate_pct,
  breakeven_winrate_pct,
  ev_in_r,
  med_minuten_tot_doel,
  (SELECT e.ev_in_r FROM v_ev_grid e
    WHERE e.optimizer_key = v_ev_grid.optimizer_key
      AND e.uur_utc = v_ev_grid.uur_utc
      AND e.tp_doel = 1.5)                    AS ev_bij_huidige_1_5r,
  ROUND((ev_in_r - COALESCE((SELECT e2.ev_in_r FROM v_ev_grid e2
    WHERE e2.optimizer_key = v_ev_grid.optimizer_key
      AND e2.uur_utc = v_ev_grid.uur_utc
      AND e2.tp_doel = 1.5), 0))::numeric, 3) AS winst_tov_1_5r
FROM v_ev_grid
ORDER BY optimizer_key, uur_utc, ev_in_r DESC;

COMMENT ON VIEW v_optimale_rr IS
  'WAARSCHUWING: maximaliseert over TIENTALLEN kandidaten -> winners curse. Een gevonden TP is per constructie te optimistisch. Valideer ALTIJD met v_walkforward voordat je hierop handelt.';


-- ── 8. WALK-FORWARD — de enige view die telt voor een BESLISSING ───────────
-- Zonder deze stap maakt de AI je met veel zelfvertrouwen ARMER: een grid van
-- tientallen kandidaten vindt ALTIJD iets moois, ook in pure ruis.
-- Train = alles behalve de laatste 30 dagen. Test = de laatste 30 dagen.
CREATE VIEW v_walkforward AS
WITH grens AS (
  SELECT (MAX(opened_at) - INTERVAL '30 days') AS cutoff FROM v_ghost_clean
),
train AS (SELECT c.* FROM v_ghost_clean c, grens g WHERE c.opened_at <  g.cutoff),
test  AS (SELECT c.* FROM v_ghost_clean c, grens g WHERE c.opened_at >= g.cutoff),
kand AS (
  SELECT DISTINCT optimizer_key, ROUND(peak_rr_pos::numeric,1) AS tp
  FROM train WHERE peak_rr_pos >= 0.5
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
  'VERPLICHT. Bepaalt de TP op oude data en TOETST hem op de laatste 30 dagen. Alleen oordeel = HOUDT STAND mag naar ai_config.';
