-- 011_counter_position.sql
--
-- MEET het hedge-vraagstuk in plaats van het te gokken.
--
-- Bij elk signaal loggen we of er op dat moment een TEGENGESTELDE positie open stond
-- op hetzelfde symbool, en zo ja: hoe ver de twee entries uit elkaar lagen.
--
-- De meetkunde (rr = 1.5):
--   De TP van de hedge ligt VOORBIJ de SL van de open positie, TENZIJ
--       gap > (rr - 1) x slDist   ->   gap > 0.5 x slDist
--   Alleen boven die drempel kan de hedge zijn doel halen zonder dat de eerste
--   trade gegarandeerd al gestopt is.
--
-- BELANGRIJK: dit BLOKKEERT of VERANDERT niets. De demo neemt in collect-mode
-- gewoon elk signaal, precies zoals nu. We leggen alleen vast wat er gebeurde,
-- zodat je over een paar maanden de enige vraag kunt beantwoorden die telt:
--
--   "Heeft een tegensignaal dat vuurt terwijl er een positie openstaat,
--    op zichzelf positieve EV?"
--
--   Bij 1.5RR is de break-even winrate 40%.
--     boven 40%  -> gewoon nemen (hedge-framing is irrelevant)
--     onder 40%  -> SKIPPEN. Dat is een chop-filter, geen hedge.

ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS has_counter_pos    BOOLEAN DEFAULT FALSE;
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS counter_pos_id     TEXT;
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS counter_gap        NUMERIC;  -- |entry_nieuw - entry_open| in prijs
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS counter_gap_r      NUMERIC;  -- diezelfde gap uitgedrukt in R van de OPEN positie
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS counter_safe_hedge BOOLEAN;  -- gap_r > (rr - 1) = 0.5 ?
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS counter_age_min    NUMERIC;  -- hoe lang stond de eerste al open
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS open_pos_count     INTEGER;  -- hoeveel posities stonden er open

CREATE INDEX IF NOT EXISTS idx_signal_counter ON signal_log (has_counter_pos);
