-- 001_high_water_mark.sql  (feature 1C)
-- Tracks peak account P&L. Two grains:
--   hwm_daily    — one row per Brussels date; peak & trough of intraday
--                  open (floating) P&L, resets naturally each new day.
--   hwm_alltime  — single row (id=1); highest equity/balance the account
--                  has ever reached, plus the best open P&L ever seen.
-- Written every equity sync (~5 min). Read-only for now; the future
-- drawdown guard will compare live equity against these + each firm's
-- daily-loss / max-drawdown limits.

CREATE TABLE IF NOT EXISTS hwm_daily (
  date_str        TEXT PRIMARY KEY,          -- Brussels YYYY-MM-DD
  peak_open_pnl   NUMERIC DEFAULT 0,         -- highest floating P&L that day
  trough_open_pnl NUMERIC DEFAULT 0,         -- lowest floating P&L that day (daily-loss basis)
  peak_equity     NUMERIC,
  peak_balance    NUMERIC,
  start_balance   NUMERIC,                   -- first balance seen that day
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hwm_alltime (
  id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  peak_equity     NUMERIC,
  peak_balance    NUMERIC,
  peak_open_pnl   NUMERIC DEFAULT 0,
  achieved_at     TIMESTAMPTZ,               -- when peak_equity was last beaten
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO hwm_alltime (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
