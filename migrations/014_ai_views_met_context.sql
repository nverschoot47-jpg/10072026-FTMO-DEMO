-- 014_ai_views_met_context.sql
-- ═══════════════════════════════════════════════════════════════════════════
--  De views uit 012 kenden de genormaliseerde features (013) nog niet.
--  Zonder deze update ziet de AI ze niet -- en dat zijn juist de features
--  waarmee hij MARKTCONDITIES kan onderzoeken, niet alleen tijdstippen.
--
--  Nieuw beschikbaar voor de AI (allemaal in R of dimensieloos):
--    vwap_dist_r        entry t.o.v. de VWAP, in R
--    sess_range_r       hoe BREED is het ochtendkanaal, in R   <- de chop-vraag
--    sess_high_dist_r   ruimte omhoog tot de sessie-high
--    sess_low_dist_r    ruimte omlaag tot de sessie-low
--    pos_in_sess_range  0 = op de low, 1 = op de high
--    day_range_r        dagrange in R
--    pos_in_day_range   0 = day low, 1 = day high
--
--  Nog steeds GEEN valuta. risk_eur en lots komen hier niet in voor.
-- ═══════════════════════════════════════════════════════════════════════════


CREATE OR REPLACE VIEW v_ghost_clean AS
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

  -- ── UITKOMST (alles in R) ──
  g.peak_rr_pos,          -- hoe ver liep hij ECHT (oneindige TP)
  g.peak_rr_neg,          -- hoeveel pijn nam hij eerst (negatieve R)
  g.rr_milestones,        -- R-stap -> MINUTEN (getallen)
  g.time_to_sl_min,

  -- ── MARKTCONDITIE bij entry (uit de webhook, genormaliseerd) ──
  -- De webhook geeft FUTURES-prijzen. Die zijn via het percentage geprojecteerd
  -- op de brokerfill en gedeeld door slDist -> dus in R, en dus vergelijkbaar
  -- tussen goud en nasdaq.
  s.vwap_dist_r,          -- + = entry ligt BOVEN de vwap
  s.sess_range_r,         -- breedte van het ochtendkanaal
  s.sess_high_dist_r,     -- ruimte omhoog
  s.sess_low_dist_r,      -- ruimte omlaag
  s.pos_in_sess_range,    -- 0 = low, 1 = high
  s.day_range_r,
  s.pos_in_day_range,
  s.vwap_band_pct_r,

  -- ── TEGENSIGNAAL-context ──
  s.has_counter_pos,
  s.counter_gap_r,
  s.counter_safe_hedge
FROM ghost_trades g
LEFT JOIN signal_log s ON s.position_id = g.position_id
WHERE g.data_complete IS TRUE                       -- echt waargenomen
  AND COALESCE(g.milestones_estimated, 0) = 0       -- geen gaten door blackouts
  AND g.finalize_reason IN ('sl_hit', 'mt5_sl')     -- geen reaper-forceringen
  AND g.peak_rr_pos IS NOT NULL;

COMMENT ON VIEW v_ghost_clean IS
  'DE bron voor alle AI-analyse. Alleen WAARGENOMEN trades. ALLES IN R -- risk_eur en lots ontbreken hier BEWUST: XAUUSD en US100.cash hebben andere contractgroottes en zijn in valuta ONVERGELIJKBAAR. In R wel. Gebruik NOOIT ghost_trades direct.';


-- ── NIEUW: presteren bepaalde MARKTCONDITIES beter? ────────────────────────
-- Dit is waar de genormaliseerde features hun waarde bewijzen. Niet "wanneer"
-- (uur/sessie) maar "onder welke omstandigheden".
CREATE OR REPLACE VIEW v_conditie_analyse AS
SELECT
  symbol,
  direction,
  -- Kanaalbreedte: is een SMAL kanaal chop, en een BREED kanaal een echte breakout?
  CASE
    WHEN sess_range_r IS NULL     THEN 'onbekend'
    WHEN sess_range_r <  1.5      THEN 'smal kanaal (<1.5R)'
    WHEN sess_range_r <  3.0      THEN 'gemiddeld (1.5-3R)'
    ELSE                               'breed kanaal (>3R)'
  END                                                   AS kanaalbreedte,
  -- Waar in de dagrange stapte je in?
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
  ROUND(AVG(ABS(peak_rr_neg))::numeric, 2)              AS gem_pijn_r,
  -- EV bij de huidige vaste 1.5R TP
  ROUND(AVG(CASE WHEN peak_rr_pos >= 1.5 THEN 1.5 ELSE -1 END)::numeric, 3) AS ev_bij_1_5r
FROM v_ghost_clean
GROUP BY 1,2,3,4
HAVING COUNT(*) >= 20
ORDER BY ev_bij_1_5r DESC;

COMMENT ON VIEW v_conditie_analyse IS
  'Beantwoordt de vraag: is een SMAL kanaal echte chop? Werken breakouts alleen bovenin de dagrange? Dit gaat over marktcondities, niet over tijdstippen.';


-- ── VWAP-afstand: maakt het uit hoe ver de entry van de VWAP ligt? ─────────
CREATE OR REPLACE VIEW v_vwap_analyse AS
SELECT
  symbol,
  direction,
  CASE
    WHEN vwap_dist_r IS NULL      THEN 'onbekend'
    WHEN vwap_dist_r < -1.0       THEN 'ver ONDER vwap (< -1R)'
    WHEN vwap_dist_r <  0         THEN 'iets onder vwap'
    WHEN vwap_dist_r <  1.0       THEN 'iets boven vwap'
    ELSE                               'ver BOVEN vwap (> +1R)'
  END                                                   AS vwap_zone,
  COUNT(*)                                              AS n,
  ROUND(AVG(peak_rr_pos)::numeric, 2)                   AS gem_piek_r,
  ROUND(100.0 * AVG((peak_rr_pos >= 1.5)::int), 1)      AS pct_haalt_1_5r,
  ROUND(AVG(CASE WHEN peak_rr_pos >= 1.5 THEN 1.5 ELSE -1 END)::numeric, 3) AS ev_bij_1_5r
FROM v_ghost_clean
GROUP BY 1,2,3
HAVING COUNT(*) >= 20
ORDER BY ev_bij_1_5r DESC;
