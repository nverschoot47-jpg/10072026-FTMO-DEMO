-- 013_genormaliseerde_features.sql
-- ═══════════════════════════════════════════════════════════════════════════
--  DE ONTBREKENDE SCHAKEL: webhook-context als BRUIKBARE features
--
--  Het probleem:
--  De webhook levert FUTURES-prijzen (MGC1! / MNQ1!): vwap 4116.1, session_high
--  4144.8, day_low 4066.0. Die stonden als RUWE PRIJZEN in de database.
--
--  Als feature is een rauwe prijs WAARDELOOS:
--    - "vwap = 4116.1" betekent over drie maanden iets totaal anders
--    - het is een FUTURES-prijs, maar je handelt op de BROKER (XAUUSD != MGC1!)
--    - goud (4100) en nasdaq (29800) zijn onderling onvergelijkbaar
--
--  De oplossing -- dezelfde als bij de rest van het systeem: normaliseren.
--
--    pct    = (x - tv_entry) / tv_entry          <- futures, dimensieloos
--    broker = execPrice * (1 + pct)              <- geprojecteerd op de broker
--    in R   = (broker - execPrice) / slDist      <- in R, vergelijkbaar met alles
--
--  Het PERCENTAGE is de brug. Een VWAP die 0,12% onder de futures-entry ligt,
--  ligt ook 0,12% onder de broker-entry -- ongeacht het basisverschil tussen
--  MGC1! en XAUUSD. Zo wordt elk webhook-getal een feature in R.
--
--  Resultaat: de AI kan straks vragen als
--    "presteren buys beter als de entry ver BOVEN de VWAP ligt (> +1.5R)?"
--    "is de sessie-range breed (> 4R) of smal, en maakt dat uit?"
--    "waar in de dagrange zit de entry (0 = low, 1 = high)?"
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Afstanden tot de VWAP ─────────────────────────────────────────────────
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS vwap_dist_pct        NUMERIC;  -- (entry - vwap)/entry. + = entry BOVEN vwap
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS vwap_dist_r          NUMERIC;  -- diezelfde afstand, in R
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS vwap_band_pct_r      NUMERIC;  -- breedte van de VWAP-band, in R

-- ── Afstanden tot de sessie-range (het ochtendkanaal) ─────────────────────
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS sess_high_dist_r     NUMERIC;  -- (session_high - entry) in R. + = ruimte omhoog
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS sess_low_dist_r      NUMERIC;  -- (entry - session_low) in R. + = ruimte omlaag
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS sess_range_r         NUMERIC;  -- hoe BREED is het kanaal, in R
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS pos_in_sess_range    NUMERIC;  -- 0 = op de low, 1 = op de high

-- ── Afstanden tot de dag-range ────────────────────────────────────────────
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS day_high_dist_r      NUMERIC;
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS day_low_dist_r       NUMERIC;
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS day_range_r          NUMERIC;
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS pos_in_day_range     NUMERIC;  -- 0 = op de day low, 1 = op de day high

-- ── De futures->broker brug, vastgelegd voor controle ─────────────────────
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS futures_broker_basis_pct NUMERIC;  -- (execPrice - tv_entry)/tv_entry

-- Dezelfde features op ghost_trades, zodat de AI ze direct naast peak_rr_pos ziet
-- zonder te hoeven joinen.
ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS vwap_dist_r        NUMERIC;
ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS sess_high_dist_r   NUMERIC;
ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS sess_low_dist_r    NUMERIC;
ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS sess_range_r       NUMERIC;
ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS pos_in_sess_range  NUMERIC;
ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS day_range_r        NUMERIC;
ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS pos_in_day_range   NUMERIC;


-- ── LAAG 2: dezelfde niveaus, omgezet naar de ECHTE BROKERPRIJS ───────────
-- Het percentage is schaalvrij, maar soms wil je gewoon een prijs zien waarmee je
-- kunt werken: "waar ligt de VWAP op XAUUSD?" Die projecteren we uit het futures-
-- percentage op de broker-fill (bid voor sell, ask voor buy):
--
--     broker_x = execPrice * (1 + pct_x)
--
-- Zo krijg je concrete, verhandelbare niveaus op de broker-chart -- afgeleid uit
-- de TradingView-chart, zonder ooit een futures-prijs te verwarren met een
-- brokerprijs.
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS broker_vwap          NUMERIC;
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS broker_vwap_upper    NUMERIC;
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS broker_vwap_lower    NUMERIC;
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS broker_sess_high     NUMERIC;
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS broker_sess_low      NUMERIC;
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS broker_day_high      NUMERIC;
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS broker_day_low       NUMERIC;

-- ── LAAG 1 (compleet): elk niveau ook als ruw PERCENTAGE t.o.v. de entry ──
-- Positief = het niveau ligt BOVEN de entry. Dit is de laag waarmee je zelf kunt
-- rekenen, ongeacht instrument of prijsniveau.
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS sess_high_pct        NUMERIC;
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS sess_low_pct         NUMERIC;
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS day_high_pct         NUMERIC;
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS day_low_pct          NUMERIC;
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS sess_range_pct       NUMERIC;
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS day_range_pct        NUMERIC;
