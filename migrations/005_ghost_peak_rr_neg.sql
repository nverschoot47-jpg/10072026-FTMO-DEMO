-- 005_ghost_peak_rr_neg.sql  (BUGFIX)
-- ghost_state tracks peak_rr_neg (the worst heat a trade took before it worked),
-- but ghost_trades never had the column — so on finalize that value was silently
-- discarded, and the startup "copy closed_trades -> ghost_trades" recovery failed
-- every boot with: column "peak_rr_neg" of relation "ghost_trades" does not exist.
--
-- peak_rr_neg is the field that answers "how tight could my SL have been?" — it is
-- worth keeping. Adding it fixes both the data loss and the recovery query.

ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS peak_rr_neg NUMERIC DEFAULT 0;
