"use strict";
// ================================================================
// db.js  v2.0.0  |  PRONTO-AI
// Clean schema for XAUUSD & US100 ghost trading
// ================================================================

const { Pool } = require("pg");
const { runMigrations } = require("./migrate");

const DB_URL = process.env.DATABASE_URL;
const DB_ENABLED = !!DB_URL;

// numeric coercion: returns a finite number or null (matches server.js safeNum)
function safeNum(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

if (!DB_ENABLED) {
  console.warn("[DB] DATABASE_URL not set — running WITHOUT persistence (in-memory only). " +
               "Signal log, closed trades, ghost history, and equity curve will NOT survive a restart.");
}

const pool = DB_ENABLED
  ? new Pool({
      connectionString:        DB_URL,
      ssl:                     DB_URL.includes(".railway.internal") ? false : { rejectUnauthorized: false },
      max:                     8,
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis:       30000,
      statement_timeout:       10000,
    })
  : null;

if (pool) pool.on("error", (err) => console.error("[DB Pool] error:", err.message));

// Runs a "best effort" statement inside its own SAVEPOINT, so that if it
// fails, only that statement is rolled back — the surrounding transaction
// stays healthy and every later query keeps working. A plain .catch(()=>{})
// around client.query() is NOT enough: Postgres still marks the whole
// transaction as aborted on error, and .catch() only hides the JS-side
// rejection while every subsequent query keeps failing with
// "current transaction is aborted, commands ignored until end of
// transaction block". This helper actually clears that state.
async function safeRun(client, sql, label) {
  await client.query("SAVEPOINT sp_safe_run");
  try {
    await client.query(sql);
    await client.query("RELEASE SAVEPOINT sp_safe_run");
  } catch (e) {
    await client.query("ROLLBACK TO SAVEPOINT sp_safe_run");
    await client.query("RELEASE SAVEPOINT sp_safe_run");
    console.warn(`[DB] safeRun skipped (${label}): ${e.message}`);
  }
}

// ── initDB ────────────────────────────────────────────────────────
async function initDB() {
  if (!DB_ENABLED) {
    console.log("[DB] Skipping initDB — running without persistence");
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // signal_log: every webhook that arrives (PLACED or blocked)
    await client.query(`
      CREATE TABLE IF NOT EXISTS signal_log (
        id            SERIAL       PRIMARY KEY,
        received_at   TIMESTAMPTZ  DEFAULT NOW(),
        daily_label   TEXT,                         -- "01/06-#3" only for PLACED
        symbol        TEXT,
        asset_type    TEXT,
        direction     TEXT,
        session       TEXT,
        vwap_position TEXT,
        optimizer_key TEXT,
        tv_entry      NUMERIC,
        sl_pct        NUMERIC,
        sl_points     NUMERIC,
        vwap_mid      NUMERIC,
        vwap_upper    NUMERIC,
        vwap_lower    NUMERIC,
        vwap_band_pct NUMERIC,
        session_high  NUMERIC,
        session_low   NUMERIC,
        day_high      NUMERIC,
        day_low       NUMERIC,
        outcome       TEXT,                         -- PLACED / SYMBOL_NOT_ALLOWED / WEEKEND / ORDER_NOT_CONFIRMED / ERROR / DUPLICATE
        reject_reason TEXT,
        latency_ms    INTEGER,
        position_id   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_signal_log_ts  ON signal_log (received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_signal_log_sym ON signal_log (symbol, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_signal_log_out ON signal_log (outcome);
    `);

    // closed_trades: MT5 position closed (TP or SL)
    await client.query(`
      CREATE TABLE IF NOT EXISTS closed_trades (
        id              SERIAL       PRIMARY KEY,
        position_id     TEXT         UNIQUE,
        daily_label     TEXT,
        symbol          TEXT         NOT NULL,
        asset_type      TEXT,
        direction       TEXT         NOT NULL,
        session         TEXT,
        vwap_position   TEXT,
        optimizer_key   TEXT,
        entry           NUMERIC      NOT NULL,
        sl              NUMERIC      NOT NULL,
        tp              NUMERIC,
        lots            NUMERIC,
        risk_pct        NUMERIC,
        risk_eur        NUMERIC,
        sl_pct          NUMERIC,
        sl_points       NUMERIC,
        sl_dist         NUMERIC,
        vwap_mid        NUMERIC,
        vwap_upper      NUMERIC,
        vwap_lower      NUMERIC,
        vwap_band_pct   NUMERIC,
        session_high    NUMERIC,
        session_low     NUMERIC,
        day_high        NUMERIC,
        day_low         NUMERIC,
        tv_entry        NUMERIC,
        execution_price NUMERIC,
        slippage        NUMERIC,
        exit_price      NUMERIC,
        close_reason    TEXT,                       -- "tp" or "sl"
        peak_rr_pos     NUMERIC      DEFAULT 0,
        peak_rr_neg     NUMERIC      DEFAULT 0,
        mt5_comment     TEXT,
        opened_at       TIMESTAMPTZ,
        closed_at       TIMESTAMPTZ  DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_closed_trades_opened ON closed_trades (opened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_closed_trades_key    ON closed_trades (optimizer_key);
      CREATE INDEX IF NOT EXISTS idx_closed_trades_sym    ON closed_trades (symbol);
    `);

    // ghost_state: active ghost trackers (persist across restarts)
    await client.query(`
      CREATE TABLE IF NOT EXISTS ghost_state (
        position_id     TEXT         PRIMARY KEY,
        daily_label     TEXT,
        optimizer_key   TEXT         NOT NULL,
        symbol          TEXT         NOT NULL,
        asset_type      TEXT,
        direction       TEXT         NOT NULL,
        session         TEXT,
        vwap_position   TEXT,
        entry           NUMERIC      NOT NULL,
        sl              NUMERIC      NOT NULL,
        tp              NUMERIC,
        lots            NUMERIC,
        risk_eur        NUMERIC,
        sl_pct          NUMERIC,
        sl_dist         NUMERIC,
        vwap_mid        NUMERIC,
        vwap_upper      NUMERIC,
        vwap_lower      NUMERIC,
        vwap_band_pct   NUMERIC,
        session_high    NUMERIC,
        session_low     NUMERIC,
        day_high        NUMERIC,
        day_low         NUMERIC,
        tv_entry        NUMERIC,
        mt5_comment     TEXT,
        max_rr          NUMERIC      DEFAULT 0,
        peak_rr_pos     NUMERIC      DEFAULT 0,
        peak_rr_neg     NUMERIC      DEFAULT 0,
        rr_milestones   JSONB        DEFAULT '{}',
        mt5_closed_tp   BOOLEAN      DEFAULT FALSE,
        mt5_close_at    TIMESTAMPTZ,
        phantom_sl_hit  BOOLEAN      DEFAULT FALSE,
        sl_hit_at       TIMESTAMPTZ,
        time_to_sl_min  INTEGER,
        opened_at       TIMESTAMPTZ,
        updated_at      TIMESTAMPTZ  DEFAULT NOW()
      );
    `);

    // ghost_trades: finalized ghost trackers (phantom SL hit)
    await client.query(`
      CREATE TABLE IF NOT EXISTS ghost_trades (
        id              SERIAL       PRIMARY KEY,
        position_id     TEXT         UNIQUE,
        daily_label     TEXT,
        optimizer_key   TEXT         NOT NULL,
        symbol          TEXT         NOT NULL,
        asset_type      TEXT,
        direction       TEXT         NOT NULL,
        session         TEXT,
        vwap_position   TEXT,
        entry           NUMERIC      NOT NULL,
        sl              NUMERIC      NOT NULL,
        tp              NUMERIC,
        lots            NUMERIC,
        risk_eur        NUMERIC,
        sl_pct          NUMERIC,
        sl_dist         NUMERIC,
        vwap_mid        NUMERIC,
        vwap_upper      NUMERIC,
        vwap_lower      NUMERIC,
        vwap_band_pct   NUMERIC,
        session_high    NUMERIC,
        session_low     NUMERIC,
        day_high        NUMERIC,
        day_low         NUMERIC,
        tv_entry        NUMERIC,
        mt5_comment     TEXT,
        peak_rr_pos     NUMERIC      DEFAULT 0,
        rr_milestones   JSONB        DEFAULT '{}',
        time_to_sl_min  INTEGER,
        mt5_close_reason TEXT,                      -- "tp" or "sl" — the MT5 close, ghost always ends on phantom SL
        opened_at       TIMESTAMPTZ,
        closed_at       TIMESTAMPTZ,                -- when phantom SL was hit
        created_at      TIMESTAMPTZ  DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ghost_trades_key    ON ghost_trades (optimizer_key);
      CREATE INDEX IF NOT EXISTS idx_ghost_trades_sym    ON ghost_trades (symbol);
      CREATE INDEX IF NOT EXISTS idx_ghost_trades_opened ON ghost_trades (opened_at DESC);
    `);

    // equity_curve: balance/equity snapshots every 5 min
    await client.query(`
      CREATE TABLE IF NOT EXISTS equity_curve (
        id          SERIAL       PRIMARY KEY,
        balance     NUMERIC,
        equity      NUMERIC,
        open_pnl    NUMERIC      DEFAULT 0,
        open_count  INTEGER      DEFAULT 0,
        recorded_at TIMESTAMPTZ  DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_equity_curve_ts ON equity_curve (recorded_at DESC);
    `);

    // daily_counter: track trade # per day
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_counter (
        date_str    TEXT         PRIMARY KEY,        -- "2026-06-01"
        count       INTEGER      DEFAULT 0
      );
    `);

    // ── Step 2: Migrations (add missing columns to existing tables) ──
    await client.query(`
      ALTER TABLE signal_log     ADD COLUMN IF NOT EXISTS optimizer_key   TEXT;
      ALTER TABLE signal_log     ADD COLUMN IF NOT EXISTS daily_label     TEXT;
      ALTER TABLE signal_log     ADD COLUMN IF NOT EXISTS vwap_position   TEXT;
      ALTER TABLE signal_log     ADD COLUMN IF NOT EXISTS vwap_mid        NUMERIC;
      ALTER TABLE signal_log     ADD COLUMN IF NOT EXISTS vwap_upper      NUMERIC;
      ALTER TABLE signal_log     ADD COLUMN IF NOT EXISTS vwap_lower      NUMERIC;
      ALTER TABLE signal_log     ADD COLUMN IF NOT EXISTS vwap_band_pct   NUMERIC;
      ALTER TABLE signal_log     ADD COLUMN IF NOT EXISTS session_high    NUMERIC;
      ALTER TABLE signal_log     ADD COLUMN IF NOT EXISTS session_low     NUMERIC;
      ALTER TABLE signal_log     ADD COLUMN IF NOT EXISTS day_high        NUMERIC;
      ALTER TABLE signal_log     ADD COLUMN IF NOT EXISTS day_low         NUMERIC;
    `);
    await client.query(`
      ALTER TABLE closed_trades  ADD COLUMN IF NOT EXISTS optimizer_key   TEXT;
      ALTER TABLE closed_trades  ADD COLUMN IF NOT EXISTS daily_label     TEXT;
      ALTER TABLE closed_trades  ADD COLUMN IF NOT EXISTS asset_type      TEXT;
      ALTER TABLE closed_trades  ADD COLUMN IF NOT EXISTS vwap_position   TEXT;
      ALTER TABLE closed_trades  ADD COLUMN IF NOT EXISTS vwap_band_pct   NUMERIC;
      ALTER TABLE closed_trades  ADD COLUMN IF NOT EXISTS session_high    NUMERIC;
      ALTER TABLE closed_trades  ADD COLUMN IF NOT EXISTS session_low     NUMERIC;
      ALTER TABLE closed_trades  ADD COLUMN IF NOT EXISTS day_high        NUMERIC;
      ALTER TABLE closed_trades  ADD COLUMN IF NOT EXISTS day_low         NUMERIC;
      ALTER TABLE closed_trades  ADD COLUMN IF NOT EXISTS peak_rr_pos     NUMERIC DEFAULT 0;
      ALTER TABLE closed_trades  ADD COLUMN IF NOT EXISTS peak_rr_neg     NUMERIC DEFAULT 0;
      ALTER TABLE closed_trades  ADD COLUMN IF NOT EXISTS mt5_comment     TEXT;
      ALTER TABLE closed_trades  ADD COLUMN IF NOT EXISTS tv_entry        NUMERIC;
      ALTER TABLE closed_trades  ADD COLUMN IF NOT EXISTS sl_dist         NUMERIC;
    `);
    await client.query(`
      ALTER TABLE ghost_state    ADD COLUMN IF NOT EXISTS optimizer_key   TEXT;
      ALTER TABLE ghost_state    ADD COLUMN IF NOT EXISTS daily_label     TEXT;
      ALTER TABLE ghost_state    ADD COLUMN IF NOT EXISTS asset_type      TEXT;
      ALTER TABLE ghost_state    ADD COLUMN IF NOT EXISTS vwap_position   TEXT;
      ALTER TABLE ghost_state    ADD COLUMN IF NOT EXISTS vwap_band_pct   NUMERIC;
      ALTER TABLE ghost_state    ADD COLUMN IF NOT EXISTS session_high    NUMERIC;
      ALTER TABLE ghost_state    ADD COLUMN IF NOT EXISTS session_low     NUMERIC;
      ALTER TABLE ghost_state    ADD COLUMN IF NOT EXISTS day_high        NUMERIC;
      ALTER TABLE ghost_state    ADD COLUMN IF NOT EXISTS day_low         NUMERIC;
      ALTER TABLE ghost_state    ADD COLUMN IF NOT EXISTS tv_entry        NUMERIC;
      ALTER TABLE ghost_state    ADD COLUMN IF NOT EXISTS mt5_comment     TEXT;
      ALTER TABLE ghost_state    ADD COLUMN IF NOT EXISTS mt5_close_at    TIMESTAMPTZ;
      ALTER TABLE ghost_state    ADD COLUMN IF NOT EXISTS time_to_sl_min  INTEGER;
    `);
    await client.query(`
      ALTER TABLE ghost_trades   ADD COLUMN IF NOT EXISTS optimizer_key   TEXT;
      ALTER TABLE ghost_trades   ADD COLUMN IF NOT EXISTS daily_label     TEXT;
      ALTER TABLE ghost_trades   ADD COLUMN IF NOT EXISTS asset_type      TEXT;
      ALTER TABLE ghost_trades   ADD COLUMN IF NOT EXISTS vwap_position   TEXT;
      ALTER TABLE ghost_trades   ADD COLUMN IF NOT EXISTS vwap_band_pct   NUMERIC;
      ALTER TABLE ghost_trades   ADD COLUMN IF NOT EXISTS session_high    NUMERIC;
      ALTER TABLE ghost_trades   ADD COLUMN IF NOT EXISTS session_low     NUMERIC;
      ALTER TABLE ghost_trades   ADD COLUMN IF NOT EXISTS day_high        NUMERIC;
      ALTER TABLE ghost_trades   ADD COLUMN IF NOT EXISTS day_low         NUMERIC;
      ALTER TABLE ghost_trades   ADD COLUMN IF NOT EXISTS tv_entry        NUMERIC;
      ALTER TABLE ghost_trades   ADD COLUMN IF NOT EXISTS mt5_comment     TEXT;
      ALTER TABLE ghost_trades   ADD COLUMN IF NOT EXISTS time_to_sl_min  INTEGER;
      ALTER TABLE ghost_trades   ADD COLUMN IF NOT EXISTS mt5_close_reason TEXT;
    `);

    // Fix: drop phantom_sl_hit NOT NULL (no-op if already nullable/default)
    await safeRun(client, `ALTER TABLE ghost_trades ALTER COLUMN phantom_sl_hit DROP NOT NULL`, "drop phantom_sl_hit NOT NULL");
    // Fix: tp nullable in ghost_state
    await safeRun(client, `ALTER TABLE ghost_state ALTER COLUMN tp DROP NOT NULL`, "drop ghost_state.tp NOT NULL");
    // Fix: UNIQUE constraint on ghost_trades.position_id (required for ON CONFLICT)
    await safeRun(client, `
      DO $d$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
          WHERE c.conrelid='ghost_trades'::regclass
            AND c.contype IN ('u','p') AND a.attname='position_id'
        ) THEN
          ALTER TABLE ghost_trades ADD CONSTRAINT ghost_trades_position_id_key UNIQUE (position_id);
        END IF;
      END $d$
    `, "add ghost_trades.position_id UNIQUE constraint");

    // Data recovery: copy closed_trades → ghost_trades on every startup
    // Ensures FINISHED data survives every redeploy forever
    // NOTE: the old "copy closed_trades -> ghost_trades" recovery lived here.
    // It was moved to migrations/009_recover_ghosts.sql because it ran BEFORE the
    // migrations, so the data_complete / finalize_reason columns did not exist yet —
    // meaning recovered rows silently landed with rr_milestones = '{}' and
    // data_complete = TRUE. i.e. fake "fully observed" ghosts with zero milestones,
    // straight into the AI training set. It now runs once, after the schema is complete,
    // and flags every recovered row as incomplete.
    console.log("[DB] Migrations applied + data recovery done");

    // ── Step 3: Indexes (now safe — columns exist) ─────────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_signal_log_ts     ON signal_log     (received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_signal_log_sym    ON signal_log     (symbol, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_signal_log_out    ON signal_log     (outcome);
      CREATE INDEX IF NOT EXISTS idx_closed_trades_opened ON closed_trades (opened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_closed_trades_key    ON closed_trades (optimizer_key);
      CREATE INDEX IF NOT EXISTS idx_closed_trades_sym    ON closed_trades (symbol);
      CREATE INDEX IF NOT EXISTS idx_ghost_trades_key     ON ghost_trades  (optimizer_key);
      CREATE INDEX IF NOT EXISTS idx_ghost_trades_sym     ON ghost_trades  (symbol);
      CREATE INDEX IF NOT EXISTS idx_ghost_trades_opened  ON ghost_trades  (opened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_equity_curve_ts      ON equity_curve  (recorded_at DESC);
    `);

    await client.query("COMMIT");
    console.log("[DB] Schema v2.0 ready");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // ── Step 3: ordered migrations for v3.1 tables (#12) ──
  // Base 6-table schema above is untouched; every new table/column added for
  // high-water-mark, signals_inbox, model_decisions and data-quality lives in
  // ./migrations and is applied exactly once here.
  await runMigrations(pool);
}

// ── Daily trade counter ────────────────────────────────────────────
const _memDailyCounter = {};
async function getNextDailyCount(dateStr) {
  if (!DB_ENABLED) {
    _memDailyCounter[dateStr] = (_memDailyCounter[dateStr] || 0) + 1;
    return _memDailyCounter[dateStr];
  }
  const r = await pool.query(`
    INSERT INTO daily_counter (date_str, count) VALUES ($1, 1)
    ON CONFLICT (date_str) DO UPDATE SET count = daily_counter.count + 1
    RETURNING count
  `, [dateStr]);
  return parseInt(r.rows[0].count);
}

// ── Signal log ─────────────────────────────────────────────────────
// Feature 11a: non-blocking per-row validation. Returns an array of flag
// strings for anything that looks wrong. NEVER rejects — the row is always
// stored; the flags just let bad rows be filtered out at training time.
function validateSignal(d) {
  const flags = [];
  const finite = (v) => v != null && Number.isFinite(Number(v));
  if (d.outcome === "PLACED") {
    if (!finite(d.vwapMid))      flags.push("vwap_mid_missing");
    if (!finite(d.sessionHigh))  flags.push("session_high_missing");
    if (!finite(d.sessionLow))   flags.push("session_low_missing");
    if (!finite(d.dayHigh))      flags.push("day_high_missing");
    if (!finite(d.dayLow))       flags.push("day_low_missing");
    if (!finite(d.tvEntry))      flags.push("tv_entry_missing");
  }
  if (d.direction && d.direction !== "buy" && d.direction !== "sell") flags.push("bad_direction");
  if (finite(d.slPct) && (Number(d.slPct) <= 0 || Number(d.slPct) > 0.1)) flags.push("sl_pct_out_of_range");
  if (d.sessionHigh != null && d.sessionLow != null && Number(d.sessionHigh) < Number(d.sessionLow)) flags.push("session_high_lt_low");
  return flags;
}

async function logSignal(data) {
  if (!DB_ENABLED) return;
  try {
    const flags = validateSignal(data);
    await pool.query(`
      INSERT INTO signal_log (
        daily_label, symbol, asset_type, direction, session, vwap_position, optimizer_key,
        tv_entry, sl_pct, sl_points, vwap_mid, vwap_upper, vwap_lower, vwap_band_pct,
        session_high, session_low, day_high, day_low,
        outcome, reject_reason, latency_ms, position_id, data_flags,
        has_counter_pos, counter_pos_id, counter_gap, counter_gap_r,
        counter_safe_hedge, counter_age_min, open_pos_count,
        vwap_dist_pct, vwap_dist_r, vwap_band_pct_r, sess_high_pct, sess_low_pct, sess_high_dist_r, sess_low_dist_r, sess_range_r, sess_range_pct, pos_in_sess_range, day_high_pct, day_low_pct, day_high_dist_r, day_low_dist_r, day_range_r, day_range_pct, pos_in_day_range, futures_broker_basis_pct, broker_vwap, broker_vwap_upper, broker_vwap_lower, broker_sess_high, broker_sess_low, broker_day_high, broker_day_low
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50,$51,$52,$53,$54,$55)
    `, [
      data.dailyLabel    ?? null,
      data.symbol        ?? null, data.assetType  ?? null,
      data.direction     ?? null, data.session    ?? null,
      data.vwapPosition  ?? null, data.optimizerKey ?? null,
      data.tvEntry       ?? null, data.slPct      ?? null, data.slPoints  ?? null,
      data.vwapMid       ?? null, data.vwapUpper  ?? null, data.vwapLower ?? null,
      data.vwapBandPct   ?? null,
      data.sessionHigh   ?? null, data.sessionLow ?? null,
      data.dayHigh       ?? null, data.dayLow     ?? null,
      data.outcome       ?? null, data.rejectReason ?? null,
      data.latencyMs     ?? null, data.positionId ?? null,
      flags.length ? JSON.stringify(flags) : null,
      data.hasCounterPos ?? false,
      data.counterPosId ?? null,
      data.counterGap ?? null,
      data.counterGapR ?? null,
      data.counterSafeHedge ?? null,
      data.counterAgeMin ?? null,
      data.openPosCount ?? null,
      data.vwapDistPct ?? null,
      data.vwapDistR ?? null,
      data.vwapBandPctR ?? null,
      data.sessHighPct ?? null,
      data.sessLowPct ?? null,
      data.sessHighDistR ?? null,
      data.sessLowDistR ?? null,
      data.sessRangeR ?? null,
      data.sessRangePct ?? null,
      data.posInSessRange ?? null,
      data.dayHighPct ?? null,
      data.dayLowPct ?? null,
      data.dayHighDistR ?? null,
      data.dayLowDistR ?? null,
      data.dayRangeR ?? null,
      data.dayRangePct ?? null,
      data.posInDayRange ?? null,
      data.futuresBrokerBasisPct ?? null,
      data.brokerVwap ?? null,
      data.brokerVwapUpper ?? null,
      data.brokerVwapLower ?? null,
      data.brokerSessHigh ?? null,
      data.brokerSessLow ?? null,
      data.brokerDayHigh ?? null,
      data.brokerDayLow ?? null,
    ]);
  } catch (e) { console.warn("[!] logSignal:", e.message); }
}

async function loadSignalLog(limit = 200) {
  if (!DB_ENABLED) return [];
  try {
    const r = await pool.query(`
      SELECT
        id, received_at AS "receivedAt", daily_label AS "dailyLabel",
        symbol, asset_type AS "assetType", direction, session,
        vwap_position AS "vwapPosition", optimizer_key AS "optimizerKey",
        CAST(tv_entry     AS FLOAT) AS "tvEntry",
        CAST(sl_pct       AS FLOAT) AS "slPct",
        CAST(sl_points    AS FLOAT) AS "slPoints",
        CAST(vwap_mid     AS FLOAT) AS "vwapMid",
        CAST(vwap_upper   AS FLOAT) AS "vwapUpper",
        CAST(vwap_lower   AS FLOAT) AS "vwapLower",
        CAST(vwap_band_pct AS FLOAT) AS "vwapBandPct",
        CAST(session_high AS FLOAT) AS "sessionHigh",
        CAST(session_low  AS FLOAT) AS "sessionLow",
        CAST(day_high     AS FLOAT) AS "dayHigh",
        CAST(day_low      AS FLOAT) AS "dayLow",
        outcome, reject_reason AS "rejectReason",
        latency_ms AS "latencyMs", position_id AS "positionId"
      FROM signal_log
      ORDER BY received_at DESC
      LIMIT $1
    `, [limit]);
    return r.rows;
  } catch (e) { console.warn("[!] loadSignalLog:", e.message); return []; }
}

// ── Closed trades ──────────────────────────────────────────────────
async function saveClosedTrade(t) {
  if (!DB_ENABLED) return;
  try {
    await pool.query(`
      INSERT INTO closed_trades (
        position_id, daily_label, symbol, asset_type, direction, session, vwap_position, optimizer_key,
        entry, sl, tp, lots, risk_pct, risk_eur, sl_pct, sl_points, sl_dist,
        vwap_mid, vwap_upper, vwap_lower, vwap_band_pct,
        session_high, session_low, day_high, day_low,
        tv_entry, execution_price, slippage, exit_price, close_reason, close_source,
        peak_rr_pos, peak_rr_neg, mt5_comment, opened_at, closed_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,
        $9,$10,$11,$12,$13,$14,$15,$16,$17,
        $18,$19,$20,$21,$22,$23,$24,$25,
        $26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36
      )
      ON CONFLICT (position_id) DO UPDATE SET
        exit_price    = EXCLUDED.exit_price,
        close_reason  = EXCLUDED.close_reason,
        peak_rr_pos   = EXCLUDED.peak_rr_pos,
        peak_rr_neg   = EXCLUDED.peak_rr_neg,
        closed_at     = EXCLUDED.closed_at
    `, [
      t.positionId, t.dailyLabel,
      t.symbol, t.assetType, t.direction, t.session, t.vwapPosition, t.optimizerKey,
      t.entry, t.sl, t.tp ?? null, t.lots ?? null, t.riskPct ?? null, t.riskEur ?? null,
      t.slPct ?? null, t.slPoints ?? null, t.slDist ?? null,
      t.vwapMid ?? null, t.vwapUpper ?? null, t.vwapLower ?? null, t.vwapBandPct ?? null,
      t.sessionHigh ?? null, t.sessionLow ?? null, t.dayHigh ?? null, t.dayLow ?? null,
      t.tvEntry ?? null, t.executionPrice ?? null, t.slippage ?? null,
      t.exitPrice ?? null, t.closeReason ?? "sl", t.closeSource ?? null,
      t.peakRRPos ?? 0, t.peakRRNeg ?? 0,
      t.mt5Comment ?? null, t.openedAt ?? null, t.closedAt ?? new Date().toISOString(),
    ]);
  } catch (e) { console.warn("[!] saveClosedTrade:", e.message); }
}

async function loadClosedTrades(limit = 200) {
  if (!DB_ENABLED) return [];
  try {
    const r = await pool.query(`
      SELECT
        position_id AS "positionId", daily_label AS "dailyLabel",
        symbol, asset_type AS "assetType", direction, session,
        vwap_position AS "vwapPosition", optimizer_key AS "optimizerKey",
        CAST(entry AS FLOAT) AS entry, CAST(sl AS FLOAT) AS sl, CAST(tp AS FLOAT) AS tp,
        CAST(lots AS FLOAT) AS lots, CAST(risk_eur AS FLOAT) AS "riskEur",
        CAST(sl_pct AS FLOAT) AS "slPct", CAST(sl_points AS FLOAT) AS "slPoints",
        CAST(sl_dist AS FLOAT) AS "slDist",
        CAST(vwap_mid AS FLOAT) AS "vwapMid",
        CAST(vwap_band_pct AS FLOAT) AS "vwapBandPct",
        CAST(session_high AS FLOAT) AS "sessionHigh", CAST(session_low AS FLOAT) AS "sessionLow",
        CAST(day_high AS FLOAT) AS "dayHigh", CAST(day_low AS FLOAT) AS "dayLow",
        CAST(tv_entry AS FLOAT) AS "tvEntry",
        CAST(exit_price AS FLOAT) AS "exitPrice",
        close_reason AS "closeReason",
        close_source AS "closeSource",
        CAST(peak_rr_pos AS FLOAT) AS "peakRRPos",
        CAST(peak_rr_neg AS FLOAT) AS "peakRRNeg",
        mt5_comment AS "mt5Comment",
        opened_at AS "openedAt", closed_at AS "closedAt"
      FROM closed_trades
      ORDER BY opened_at DESC NULLS LAST
      LIMIT $1
    `, [limit]);
    return r.rows;
  } catch (e) { console.warn("[!] loadClosedTrades:", e.message); return []; }
}

// ── Ghost state ────────────────────────────────────────────────────
async function saveGhostState(g) {
  if (!DB_ENABLED) return;
  try {
    await pool.query(`
      INSERT INTO ghost_state (
        position_id, daily_label, optimizer_key, symbol, asset_type, direction, session, vwap_position,
        entry, sl, tp, lots, risk_eur, sl_pct, sl_dist,
        vwap_mid, vwap_upper, vwap_lower, vwap_band_pct,
        session_high, session_low, day_high, day_low, tv_entry, mt5_comment,
        max_rr, peak_rr_pos, peak_rr_neg, rr_milestones,
        mt5_closed_tp, mt5_close_at, phantom_sl_hit, sl_hit_at, time_to_sl_min,
        opened_at, last_price_at, estimated_count, blackout_min,
        mt5_close_reason, current_rr, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,
        $9,$10,$11,$12,$13,$14,$15,
        $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
        $26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,NOW()
      )
      ON CONFLICT (position_id) DO UPDATE SET
        max_rr          = EXCLUDED.max_rr,
        peak_rr_pos     = EXCLUDED.peak_rr_pos,
        peak_rr_neg     = EXCLUDED.peak_rr_neg,
        rr_milestones   = EXCLUDED.rr_milestones,
        mt5_closed_tp   = EXCLUDED.mt5_closed_tp,
        mt5_close_at    = EXCLUDED.mt5_close_at,
        phantom_sl_hit  = EXCLUDED.phantom_sl_hit,
        sl_hit_at       = EXCLUDED.sl_hit_at,
        time_to_sl_min  = EXCLUDED.time_to_sl_min,
        last_price_at   = EXCLUDED.last_price_at,
        estimated_count = EXCLUDED.estimated_count,
        blackout_min    = EXCLUDED.blackout_min,
        mt5_close_reason = EXCLUDED.mt5_close_reason,
        current_rr      = EXCLUDED.current_rr,
        lots            = COALESCE(EXCLUDED.lots, ghost_state.lots),
        updated_at      = NOW()
    `, [
      g.positionId, g.dailyLabel,
      g.optimizerKey, g.symbol, g.assetType, g.direction, g.session, g.vwapPosition,
      g.entry, g.sl, g.tp ?? null, g.lots ?? null, g.riskEur ?? null,
      g.slPct ?? null, g.slDist ?? null,
      g.vwapMid ?? null, g.vwapUpper ?? null, g.vwapLower ?? null, g.vwapBandPct ?? null,
      g.sessionHigh ?? null, g.sessionLow ?? null, g.dayHigh ?? null, g.dayLow ?? null,
      g.tvEntry ?? null, g.mt5Comment ?? null,
      g.maxRR ?? 0, g.peakRRPos ?? 0, g.peakRRNeg ?? 0,
      JSON.stringify(g.rrMilestones ?? {}),
      g.mt5ClosedTP ?? false, g.mt5CloseAt ?? null,
      g.phantomSLHit ?? false, g.slHitAt ?? null, g.timeToSLMin ?? null,
      g.openedAt ?? null,
      g.lastPriceAt ?? null, g.estimatedCount ?? 0, g.blackoutMin ?? 0,
      g.mt5CloseReason ?? null, g.currentRR ?? null,
    ]);
  } catch (e) { console.warn("[!] saveGhostState:", e.message); }
}

async function loadAllGhostStates() {
  if (!DB_ENABLED) return [];
  try {
    const r = await pool.query(`
      SELECT
        position_id AS "positionId", daily_label AS "dailyLabel",
        optimizer_key AS "optimizerKey", symbol, asset_type AS "assetType",
        direction, session, vwap_position AS "vwapPosition",
        CAST(entry AS FLOAT) AS entry, CAST(sl AS FLOAT) AS sl, CAST(tp AS FLOAT) AS tp,
        CAST(lots AS FLOAT) AS lots, CAST(risk_eur AS FLOAT) AS "riskEur",
        CAST(sl_pct AS FLOAT) AS "slPct", CAST(sl_dist AS FLOAT) AS "slDist",
        CAST(vwap_mid AS FLOAT) AS "vwapMid",
        CAST(vwap_upper AS FLOAT) AS "vwapUpper",
        CAST(vwap_lower AS FLOAT) AS "vwapLower",
        CAST(vwap_band_pct AS FLOAT) AS "vwapBandPct",
        CAST(session_high AS FLOAT) AS "sessionHigh",
        CAST(session_low AS FLOAT) AS "sessionLow",
        CAST(day_high AS FLOAT) AS "dayHigh",
        CAST(day_low AS FLOAT) AS "dayLow",
        CAST(tv_entry AS FLOAT) AS "tvEntry",
        mt5_comment AS "mt5Comment",
        CAST(max_rr AS FLOAT) AS "maxRR",
        CAST(peak_rr_pos AS FLOAT) AS "peakRRPos",
        CAST(peak_rr_neg AS FLOAT) AS "peakRRNeg",
        rr_milestones AS "rrMilestones",
        mt5_closed_tp AS "mt5ClosedTP", mt5_close_at AS "mt5CloseAt",
        phantom_sl_hit AS "phantomSLHit", sl_hit_at AS "slHitAt",
        time_to_sl_min AS "timeToSLMin",
        last_price_at AS "lastPriceAt",
        mt5_close_reason AS "mt5CloseReason",
        CAST(current_rr AS FLOAT) AS "currentRR",
        estimated_count AS "estimatedCount",
        CAST(blackout_min AS FLOAT) AS "blackoutMin",
        opened_at AS "openedAt"
      FROM ghost_state
    `);
    return r.rows;
  } catch (e) { console.warn("[!] loadAllGhostStates:", e.message); return []; }
}

async function deleteGhostState(positionId) {
  if (!DB_ENABLED) return;
  try {
    await pool.query("DELETE FROM ghost_state WHERE position_id = $1", [positionId]);
  } catch (e) { console.warn("[!] deleteGhostState:", e.message); }
}

// ── Ghost trades (finalized) ───────────────────────────────────────
async function saveGhostTrade(g) {
  if (!DB_ENABLED) return;
  try {
    await pool.query(`
      INSERT INTO ghost_trades (
        position_id, daily_label, optimizer_key, symbol, asset_type, direction, session, vwap_position,
        entry, sl, tp, lots, risk_eur, sl_pct, sl_dist,
        vwap_mid, vwap_upper, vwap_lower, vwap_band_pct,
        session_high, session_low, day_high, day_low, tv_entry, mt5_comment,
        peak_rr_pos, rr_milestones, time_to_sl_min,
        mt5_close_reason, opened_at, closed_at, peak_rr_neg,
        finalize_reason, data_complete, milestones_estimated, blackout_min,
        vwap_dist_r, sess_range_r, sess_high_dist_r, sess_low_dist_r,
        pos_in_sess_range, day_range_r, pos_in_day_range
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,
        $9,$10,$11,$12,$13,$14,$15,
        $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
        $26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43
      )
      ON CONFLICT (position_id) DO UPDATE SET
        peak_rr_pos     = EXCLUDED.peak_rr_pos,
        peak_rr_neg     = EXCLUDED.peak_rr_neg,
        finalize_reason = EXCLUDED.finalize_reason,
        data_complete   = EXCLUDED.data_complete,
        milestones_estimated = EXCLUDED.milestones_estimated,
        blackout_min    = EXCLUDED.blackout_min,
        rr_milestones   = EXCLUDED.rr_milestones,
        time_to_sl_min  = EXCLUDED.time_to_sl_min,
        closed_at       = EXCLUDED.closed_at,
        lots            = COALESCE(EXCLUDED.lots, ghost_trades.lots)
    `, [
      g.positionId, g.dailyLabel,
      g.optimizerKey, g.symbol, g.assetType, g.direction, g.session, g.vwapPosition,
      g.entry, g.sl, g.tp ?? null, g.lots ?? null, g.riskEur ?? null,
      g.slPct ?? null, g.slDist ?? null,
      g.vwapMid ?? null, g.vwapUpper ?? null, g.vwapLower ?? null, g.vwapBandPct ?? null,
      g.sessionHigh ?? null, g.sessionLow ?? null, g.dayHigh ?? null, g.dayLow ?? null,
      g.tvEntry ?? null, g.mt5Comment ?? null,
      g.peakRRPos ?? 0,
      JSON.stringify(g.rrMilestones ?? {}),
      g.timeToSLMin ?? null,
      g.mt5CloseReason ?? null,
      g.openedAt ?? null, g.closedAt ?? new Date().toISOString(),
      g.peakRRNeg ?? 0,
      g.finalizeReason ?? null,
      g.dataComplete !== false,
      g.estimatedCount ?? 0,
      g.blackoutMin ?? 0,
      g.ctx?.vwapDistR ?? null, g.ctx?.sessRangeR ?? null,
      g.ctx?.sessHighDistR ?? null, g.ctx?.sessLowDistR ?? null,
      g.ctx?.posInSessRange ?? null, g.ctx?.dayRangeR ?? null,
      g.ctx?.posInDayRange ?? null,
    ]);
  } catch (e) {
    if (e.message.includes('ON CONFLICT') || e.message.includes('constraint')) {
      // Fallback: plain UPDATE if unique constraint not yet in DB
      try {
        await pool.query(
          `UPDATE ghost_trades SET
            peak_rr_pos=GREATEST(peak_rr_pos,$1), rr_milestones=$2,
            time_to_sl_min=COALESCE($3,time_to_sl_min),
            closed_at=COALESCE($4,closed_at),
            lots=COALESCE($5,lots),
            peak_rr_neg=LEAST(COALESCE(peak_rr_neg,0),$7)
           WHERE position_id=$6`,
          [g.peakRRPos??0, JSON.stringify(g.rrMilestones??{}),
           g.timeToSLMin??null, g.closedAt??null, g.lots??null, g.positionId,
           g.peakRRNeg??0]
        );
      } catch(e2) { console.warn("[!] saveGhostTrade fallback:", e2.message); }
    } else { console.warn("[!] saveGhostTrade:", e.message); }
  }
}

async function loadGhostTrades(from = null, to = null, limit = 300) {
  if (!DB_ENABLED) return [];
  try {
    const params = [];
    const conds  = [];
    if (from) { params.push(from); conds.push(`opened_at >= $${params.length}`); }
    if (to)   { params.push(to);   conds.push(`opened_at <= $${params.length}`); }
    const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
    params.push(limit);
    const r = await pool.query(`
      SELECT
        position_id AS "positionId", daily_label AS "dailyLabel",
        optimizer_key AS "optimizerKey", symbol, asset_type AS "assetType",
        direction, session, vwap_position AS "vwapPosition",
        CAST(entry AS FLOAT) AS entry, CAST(sl AS FLOAT) AS sl,
        CAST(tp AS FLOAT) AS tp,
        CAST(lots AS FLOAT) AS lots,
        CAST(sl_pct AS FLOAT) AS "slPct",
        CAST(sl_dist AS FLOAT) AS "slDist",
        CAST(tv_entry AS FLOAT) AS "tvEntry",
        CAST(vwap_mid AS FLOAT) AS "vwapMid",
        CAST(vwap_upper AS FLOAT) AS "vwapUpper",
        CAST(vwap_lower AS FLOAT) AS "vwapLower",
        CAST(vwap_band_pct AS FLOAT) AS "vwapBandPct",
        CAST(session_high AS FLOAT) AS "sessionHigh",
        CAST(session_low AS FLOAT) AS "sessionLow",
        CAST(day_high AS FLOAT) AS "dayHigh",
        CAST(day_low AS FLOAT) AS "dayLow",
        CAST(peak_rr_pos AS FLOAT) AS "peakRRPos",
        CAST(peak_rr_neg AS FLOAT) AS "peakRRNeg",
        finalize_reason AS "finalizeReason",
        data_complete AS "dataComplete",
        milestones_estimated AS "estimatedCount",
        CAST(blackout_min AS FLOAT) AS "blackoutMin",
        rr_milestones AS "rrMilestones",
        time_to_sl_min AS "timeToSLMin",
        mt5_close_reason AS "mt5CloseReason",
        mt5_comment AS "mt5Comment",
        opened_at AS "openedAt", COALESCE(closed_at, created_at) AS "closedAt",
        -- genormaliseerde marktcontext (staat in signal_log, hier bijgevoegd)
        CAST(vwap_dist_r AS FLOAT)       AS "vwapDistR",
        CAST(sess_range_r AS FLOAT)      AS "sessRangeR",
        CAST(sess_high_dist_r AS FLOAT)  AS "sessHighDistR",
        CAST(sess_low_dist_r AS FLOAT)   AS "sessLowDistR",
        CAST(pos_in_sess_range AS FLOAT) AS "posInSessRange",
        CAST(day_range_r AS FLOAT)       AS "dayRangeR",
        CAST(pos_in_day_range AS FLOAT)  AS "posInDayRange"
      FROM ghost_trades
      ${where}
      ORDER BY opened_at DESC NULLS LAST
      LIMIT $${params.length}
    `, params);
    return r.rows;
  } catch (e) { console.warn("[!] loadGhostTrades:", e.message); return []; }
}

// ── Equity curve ───────────────────────────────────────────────────
async function saveEquity(balance, equity, openPnl, openCount) {
  if (!DB_ENABLED) return;
  try {
    await pool.query(
      "INSERT INTO equity_curve (balance, equity, open_pnl, open_count) VALUES ($1,$2,$3,$4)",
      [balance, equity, openPnl ?? 0, openCount ?? 0]
    );
  } catch (e) { console.warn("[!] saveEquity:", e.message); }
}

async function loadEquityCurve(limit = 200) {
  if (!DB_ENABLED) return [];
  try {
    const r = await pool.query(`
      SELECT
        CAST(balance AS FLOAT), CAST(equity AS FLOAT),
        CAST(open_pnl AS FLOAT) AS "openPnl",
        open_count AS "openCount",
        recorded_at AS "recordedAt"
      FROM equity_curve
      ORDER BY recorded_at DESC
      LIMIT $1
    `, [limit]);
    return r.rows.reverse();
  } catch (e) { return []; }
}

// ── Performance stats per optimizer key ───────────────────────────
async function loadPerformanceByKey() {
  if (!DB_ENABLED) return [];
  try {
    // Get all ghost trades grouped by optimizer key
    const r = await pool.query(`
      SELECT
        optimizer_key AS "optimizerKey",
        symbol,
        COUNT(*) AS trades,
        AVG(peak_rr_pos) AS avg_peak,
        MAX(peak_rr_pos) AS max_peak,
        COUNT(*) FILTER (WHERE mt5_close_reason = 'tp') AS mt5_tp_count,
        CAST(AVG(time_to_sl_min) AS FLOAT) AS avg_time_to_sl
      FROM ghost_trades
      WHERE optimizer_key IS NOT NULL
      GROUP BY optimizer_key, symbol
      ORDER BY symbol, optimizer_key
    `);
    return r.rows;
  } catch (e) { return []; }
}

// ════════════════════════════════════════════════════════════════════
// v3.1 additions — high-water-mark (1C), inbox (5A), model (10), health (11)
// ════════════════════════════════════════════════════════════════════

// ── 1C: High-water-mark ────────────────────────────────────────────
// Called every equity sync. Updates today's peak/trough open P&L (resets
// naturally per date_str) and the all-time equity/balance peak on the account.
async function updateHwm(dateStr, balance, equity, openPnl) {
  if (!DB_ENABLED) return;
  const bal = safeNum(balance), eq = safeNum(equity), pnl = safeNum(openPnl) ?? 0;
  try {
    await pool.query(`
      INSERT INTO hwm_daily (date_str, peak_open_pnl, trough_open_pnl, peak_equity, peak_balance, start_balance, updated_at)
      VALUES ($1, $2::numeric, $2::numeric, $3::numeric, $4::numeric, $4::numeric, NOW())
      ON CONFLICT (date_str) DO UPDATE SET
        peak_open_pnl   = GREATEST(hwm_daily.peak_open_pnl,   EXCLUDED.peak_open_pnl),
        trough_open_pnl = LEAST   (hwm_daily.trough_open_pnl, EXCLUDED.trough_open_pnl),
        peak_equity     = GREATEST(hwm_daily.peak_equity,     EXCLUDED.peak_equity),
        peak_balance    = GREATEST(hwm_daily.peak_balance,    EXCLUDED.peak_balance),
        updated_at      = NOW()
    `, [dateStr, pnl, eq, bal]);

    await pool.query(`
      UPDATE hwm_alltime SET
        peak_balance  = GREATEST(COALESCE(peak_balance, 0),  COALESCE($1::numeric, 0)),
        peak_open_pnl = GREATEST(COALESCE(peak_open_pnl, 0), COALESCE($3::numeric, 0)),
        achieved_at   = CASE WHEN COALESCE($2::numeric, 0) > COALESCE(peak_equity, -1e18) THEN NOW() ELSE achieved_at END,
        peak_equity   = GREATEST(COALESCE(peak_equity, 0),   COALESCE($2::numeric, 0)),
        updated_at    = NOW()
      WHERE id = 1
    `, [bal, eq, pnl]);
  } catch (e) { console.warn("[!] updateHwm:", e.message); }
}

async function loadHwmDaily(dateStr) {
  if (!DB_ENABLED) return null;
  try {
    const r = await pool.query(`
      SELECT date_str AS "dateStr",
             CAST(peak_open_pnl   AS FLOAT) AS "peakOpenPnl",
             CAST(trough_open_pnl AS FLOAT) AS "troughOpenPnl",
             CAST(peak_equity     AS FLOAT) AS "peakEquity",
             CAST(peak_balance    AS FLOAT) AS "peakBalance",
             CAST(start_balance   AS FLOAT) AS "startBalance",
             updated_at AS "updatedAt"
      FROM hwm_daily WHERE date_str = $1
    `, [dateStr]);
    return r.rows[0] ?? null;
  } catch (e) { console.warn("[!] loadHwmDaily:", e.message); return null; }
}

async function loadHwmAlltime() {
  if (!DB_ENABLED) return null;
  try {
    const r = await pool.query(`
      SELECT CAST(peak_equity   AS FLOAT) AS "peakEquity",
             CAST(peak_balance  AS FLOAT) AS "peakBalance",
             CAST(peak_open_pnl AS FLOAT) AS "peakOpenPnl",
             achieved_at AS "achievedAt", updated_at AS "updatedAt"
      FROM hwm_alltime WHERE id = 1
    `);
    return r.rows[0] ?? null;
  } catch (e) { console.warn("[!] loadHwmAlltime:", e.message); return null; }
}

// ── 5A: Signals inbox (persist-first durability) ───────────────────
async function saveInbox(rawBody) {
  if (!DB_ENABLED) return null;
  try {
    const b = rawBody ?? {};
    const r = await pool.query(`
      INSERT INTO signals_inbox (raw_body, symbol, action)
      VALUES ($1,$2,$3) RETURNING id
    `, [JSON.stringify(b), b.symbol ?? null, (b.action ?? b.direction ?? null)]);
    return r.rows[0]?.id ?? null;
  } catch (e) { console.warn("[!] saveInbox:", e.message); return null; }
}

async function markInboxProcessed(id, outcome, positionId = null, error = null) {
  if (!DB_ENABLED || !id) return;
  try {
    await pool.query(`
      UPDATE signals_inbox
      SET processed = TRUE, processed_at = NOW(), outcome = $2, position_id = $3, error = $4
      WHERE id = $1
    `, [id, outcome ?? null, positionId, error]);
  } catch (e) { console.warn("[!] markInboxProcessed:", e.message); }
}

async function loadUnprocessedInbox(limit = 50) {
  if (!DB_ENABLED) return [];
  try {
    const r = await pool.query(`
      SELECT id, received_at AS "receivedAt", raw_body AS "rawBody", symbol, action
      FROM signals_inbox WHERE processed = FALSE
      ORDER BY received_at ASC LIMIT $1
    `, [limit]);
    return r.rows;
  } catch (e) { console.warn("[!] loadUnprocessedInbox:", e.message); return []; }
}

// ── 10: Model decisions (shadow) ───────────────────────────────────
async function saveModelDecision(d) {
  if (!DB_ENABLED) return null;
  try {
    const r = await pool.query(`
      INSERT INTO model_decisions (position_id, optimizer_key, symbol, features, model_score, model_decision, reason, mode)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [
      d.positionId ?? null, d.optimizerKey ?? null, d.symbol ?? null,
      d.features ? JSON.stringify(d.features) : null,
      d.score ?? null, d.decision ?? null, d.reason ?? null, d.mode ?? null,
    ]);
    return r.rows[0]?.id ?? null;
  } catch (e) { console.warn("[!] saveModelDecision:", e.message); return null; }
}

async function linkModelDecision(id, positionId) {
  if (!DB_ENABLED || !id) return;
  try { await pool.query(`UPDATE model_decisions SET position_id = $2 WHERE id = $1`, [id, positionId]); }
  catch (e) { console.warn("[!] linkModelDecision:", e.message); }
}

async function loadModelDecisions(limit = 200) {
  if (!DB_ENABLED) return [];
  try {
    const r = await pool.query(`
      SELECT id, received_at AS "receivedAt", position_id AS "positionId",
             optimizer_key AS "optimizerKey", symbol, features,
             CAST(model_score AS FLOAT) AS "modelScore",
             model_decision AS "modelDecision", reason, mode,
             actual_outcome AS "actualOutcome", resolved_at AS "resolvedAt"
      FROM model_decisions ORDER BY received_at DESC LIMIT $1
    `, [limit]);
    return r.rows;
  } catch (e) { console.warn("[!] loadModelDecisions:", e.message); return []; }
}

// ── 11: Daily data-health scan ─────────────────────────────────────
// Runs a handful of cheap integrity checks over the last window and writes
// one row to data_health. STUCK_GHOST_HOURS = a ghost sitting live too long.
async function computeDataHealth(windowHours = 24, stuckGhostHours = 12) {
  if (!DB_ENABLED) return null;
  try {
    const sinceSql = `NOW() - INTERVAL '${windowHours} hours'`;
    const tot = await pool.query(`SELECT COUNT(*)::int AS n, COUNT(data_flags)::int AS f
                                  FROM signal_log WHERE received_at > ${sinceSql}`);
    const signalsTotal = tot.rows[0].n, flaggedTotal = tot.rows[0].f;

    const nulls = await pool.query(`
      SELECT
        SUM(CASE WHEN outcome='PLACED' AND vwap_mid  IS NULL THEN 1 ELSE 0 END)::int AS vwap_null,
        SUM(CASE WHEN outcome='PLACED' AND session_high IS NULL THEN 1 ELSE 0 END)::int AS sess_null
      FROM signal_log WHERE received_at > ${sinceSql}`);

    const stuck = await pool.query(`
      SELECT COUNT(*)::int AS n FROM ghost_state
      WHERE opened_at < NOW() - INTERVAL '${stuckGhostHours} hours'`);

    const future = await pool.query(`SELECT COUNT(*)::int AS n FROM signal_log WHERE received_at > NOW() + INTERVAL '5 minutes'`);

    // equity_curve gaps > 30 min in the window
    const gaps = await pool.query(`
      SELECT COUNT(*)::int AS n FROM (
        SELECT recorded_at - LAG(recorded_at) OVER (ORDER BY recorded_at) AS d
        FROM equity_curve WHERE recorded_at > ${sinceSql}
      ) q WHERE d > INTERVAL '30 minutes'`);

    const flaggedPct = signalsTotal ? parseFloat(((flaggedTotal / signalsTotal) * 100).toFixed(2)) : 0;
    const notes = {
      vwap_null_placed: nulls.rows[0].vwap_null ?? 0,
      session_null_placed: nulls.rows[0].sess_null ?? 0,
      stuck_ghost_hours: stuckGhostHours,
    };

    await pool.query(`
      INSERT INTO data_health (window_hours, signals_total, flagged_total, flagged_pct, stuck_ghosts, equity_gaps, future_rows, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [windowHours, signalsTotal, flaggedTotal, flaggedPct, stuck.rows[0].n, gaps.rows[0].n, future.rows[0].n, JSON.stringify(notes)]);

    const summary = { windowHours, signalsTotal, flaggedTotal, flaggedPct, stuckGhosts: stuck.rows[0].n, equityGaps: gaps.rows[0].n, futureRows: future.rows[0].n, notes };
    console.log(`[DataHealth] ${windowHours}h: ${signalsTotal} signals, ${flaggedPct}% flagged, ${stuck.rows[0].n} stuck ghosts, ${gaps.rows[0].n} equity gaps, ${future.rows[0].n} future rows`);
    return summary;
  } catch (e) { console.warn("[!] computeDataHealth:", e.message); return null; }
}

async function loadDataHealth(limit = 30) {
  if (!DB_ENABLED) return [];
  try {
    const r = await pool.query(`
      SELECT id, checked_at AS "checkedAt", window_hours AS "windowHours",
             signals_total AS "signalsTotal", flagged_total AS "flaggedTotal",
             CAST(flagged_pct AS FLOAT) AS "flaggedPct",
             stuck_ghosts AS "stuckGhosts", equity_gaps AS "equityGaps",
             future_rows AS "futureRows", notes
      FROM data_health ORDER BY checked_at DESC LIMIT $1
    `, [limit]);
    return r.rows;
  } catch (e) { console.warn("[!] loadDataHealth:", e.message); return []; }
}

module.exports = {
  pool, initDB, DB_ENABLED,
  getNextDailyCount,
  logSignal, loadSignalLog, validateSignal,
  saveClosedTrade, loadClosedTrades,
  saveGhostState, loadAllGhostStates, deleteGhostState,
  saveGhostTrade, loadGhostTrades,
  saveEquity, loadEquityCurve,
  loadPerformanceByKey,
  // v3.1
  updateHwm, loadHwmDaily, loadHwmAlltime,
  saveInbox, markInboxProcessed, loadUnprocessedInbox,
  saveModelDecision, linkModelDecision, loadModelDecisions,
  computeDataHealth, loadDataHealth,
};
