"use strict";
// ================================================================
// session.js  v3.0.0  |  PRONTO-AI — UNIFIED TEMPLATE
//
// One codebase for every account. Pick the account with the FIRM env var:
//   FIRM = ftmo_demo | ftmo_eval | maven | vantage | fundednext
//
// Webhook sends TradingView futures:  MGC1! (Micro Gold) and MNQ1! (Micro Nasdaq)
//   -> canonical keys:  XAUUSD (gold)  and  US100.cash (nasdaq)
//   -> per firm, each canonical key is re-routed to that broker's MT5 symbol.
// ================================================================

const TIMEZONE = "Europe/Brussels";

// ======================================================================
//  CONFIG — EDIT HERE
// ======================================================================

// Risk per trade as a fraction of equity. 0.000375 = 0.0375%.
const DEFAULT_RISK_PCT = 0.000375;

// Server SL = sl_pct (from webhook) × SL_BUFFER_MULT × broker execution price.
// The 1.5 buffer covers spread + timing lag. Lower later if you want.
const SL_BUFFER_MULT = 1.5;

// ONE lot multiplier, applied AFTER lot calc + volume rounding.
// Same for every firm, every ticker, every hour. 1.0 = no change.
const LOT_MULTIPLIER = 1.0;

// ── Per-firm MT5 reroute + broker volume rules ────────────────────────
//   mt5     = the exact symbol string on THAT broker's MT5
//   type    = "commodity" (gold) or "index" (nasdaq) — drives lot math
//   volMin  = smallest lot the broker allows (HARD floor to trade)
//   volStep = lot must be a multiple of this
//   mode    = "collect" (take EVERYTHING, never filtered) or "live"
const FIRMS = {
  ftmo_demo: {
    label: "FTMO-DEMO", mode: "collect",
    symbols: {
      "XAUUSD":     { mt5: "XAUUSD",     type: "commodity", pip: 0.01, volMin: 0.01, volStep: 0.01 },
      "US100.cash": { mt5: "US100.cash", type: "index",     pip: 0.10, volMin: 0.01, volStep: 0.01 },
    },
  },
  ftmo_eval: {
    label: "FTMO-EVAL", mode: "live",
    symbols: {
      "XAUUSD":     { mt5: "XAUUSD",     type: "commodity", pip: 0.01, volMin: 0.01, volStep: 0.01 },
      "US100.cash": { mt5: "US100.cash", type: "index",     pip: 0.10, volMin: 0.01, volStep: 0.01 },
    },
  },
  maven: {
    label: "MAVEN", mode: "live",
    symbols: {
      "XAUUSD":     { mt5: "XAUUSD", type: "commodity", pip: 0.01, volMin: 0.01, volStep: 0.01 },
      // ⚠️ CONFIRM: your list said "US100.cash", your v2.1 code said "US100". Set the correct one.
      "US100.cash": { mt5: "US100.cash", type: "index", pip: 0.10, volMin: 0.01, volStep: 0.01 },
    },
  },
  vantage: {
    label: "VANTAGE", mode: "live",
    symbols: {
      "XAUUSD":     { mt5: "XAUUSD", type: "commodity", pip: 0.01, volMin: 0.01, volStep: 0.01 },
      "US100.cash": { mt5: "NAS100", type: "index",     pip: 0.10, volMin: 0.10, volStep: 0.10 },
    },
  },
  fundednext: {
    label: "FUNDEDNEXT", mode: "live",
    symbols: {
      "XAUUSD":     { mt5: "XAUUSD", type: "commodity", pip: 0.01, volMin: 0.01, volStep: 0.01 },
      // ⚠️ CONFIRM: exact Fundednext Nasdaq string + its volMin/volStep.
      "US100.cash": { mt5: "NDX100", type: "index",     pip: 0.10, volMin: 0.01, volStep: 0.01 },
    },
  },
};

// ── Prop-firm drawdown limits (feature #1 — block wiring pending) ──────
// The high-water-mark tracker (1C) already records daily peak/trough open P&L
// and all-time equity peak. When you give the real numbers per firm, fill these
// in and the drawdown guard becomes a one-liner in canOpenNewTrade. Left null =
// no block (tracking only). Values are fractions, e.g. 0.05 = 5%.
const FIRM_LIMITS = {
  ftmo_demo:  { dailyLossPct: null, maxTotalDDPct: null, trailing: false }, // demo: no guard, collect everything
  ftmo_eval:  { dailyLossPct: null, maxTotalDDPct: null, trailing: false }, // ⚠️ e.g. daily 0.05 / total 0.10
  maven:      { dailyLossPct: null, maxTotalDDPct: null, trailing: false }, // ⚠️ fill from firm rules
  vantage:    { dailyLossPct: null, maxTotalDDPct: null, trailing: false }, // ⚠️ fill from firm rules
  fundednext: { dailyLossPct: null, maxTotalDDPct: null, trailing: false }, // ⚠️ fill from firm rules
};
//    hour window (Brussels, hhmm, end-exclusive). Empty = flat 1.0 everywhere.
//    Fill later from your data. Example:
//    vantage: { "US100.cash": [{ start: 1500, end: 1700, mult: 1.5 }] }
const RISK_WINDOWS = {
  // ftmo_demo:  {},   // demo stays flat — clean data
};

// ── TP risk-reward per canonical ticker per Brussels hour window ───────
//    (end-exclusive). Falls through to DEFAULT_TP_RR. Same for all firms.
const DEFAULT_TP_RR = 1.5;
const TP_RR_WINDOWS = {
  "XAUUSD": [
    { start: 1300, end: 1500, rr: 1.25 },
    { start: 1500, end: 1700, rr: 3.0 },
  ],
  "US100.cash": [
    { start: 800,  end: 1100, rr: 2.25 },
    { start: 1600, end: 1800, rr: 1.25 },
    { start: 1800, end: 2300, rr: 2.75 },
  ],
};

// ── Time blocks (per canonical ticker). DEMO (collect mode) IGNORES these.
//    Empty = nothing blocked (all live firms take everything until the model).
const TIME_BLOCK_WINDOWS = {
  // "US100.cash": [{ start: 1100, end: 1600 }],
};

// Symbols we explicitly refuse (other indices that must never be traded).
const BLOCKED_SYMBOLS = new Set([
  "US30USD","US30","DOW","DJI","DJIA",
  "DE30EUR","DE30","DAX","GER30","GER40",
  "UK100GBP","UK100","FTSE","FTSE100",
  "SP500","SPX","US500","SPX500",
  "JP225","JPN225","NIKKEI",
]);

// TradingView symbol → canonical key. Includes the new futures tickers.
const SYMBOL_ALIASES = {
  // Gold
  "MGC1":  "XAUUSD", "MGC1!": "XAUUSD", "MGC": "XAUUSD",
  "GOLD":  "XAUUSD", "XAUUSD": "XAUUSD", "XAU/USD": "XAUUSD", "XAUUSD.": "XAUUSD",
  // Nasdaq
  "MNQ1":  "US100.cash", "MNQ1!": "US100.cash", "MNQ": "US100.cash",
  "US100": "US100.cash", "US100.CASH": "US100.cash",
  "NAS100": "US100.cash", "NAS100USD": "US100.cash", "NASDAQ": "US100.cash",
  "NDX": "US100.cash", "USTEC": "US100.cash", "US100USD": "US100.cash", "NASDAQ100": "US100.cash",
};

// ======================================================================
//  END CONFIG
// ======================================================================

// ── Resolve the active firm from the env var ──────────────────────────
const FIRM = (process.env.FIRM || process.env.BROKER || "ftmo_demo").toLowerCase().trim();
if (!FIRMS[FIRM]) {
  throw new Error(`[session.js] Unknown FIRM="${FIRM}". Must be: ${Object.keys(FIRMS).join(" | ")}`);
}
const FIRM_CFG        = FIRMS[FIRM];

// ── Model gate mode (feature 10) ──────────────────────────────────────
//   off    — model never runs
//   shadow — model runs and is logged to model_decisions, but never blocks (default)
//   live   — a model "skip" verdict blocks the trade
const MODEL_MODE = (process.env.MODEL_MODE || "shadow").toLowerCase().trim();const MODE            = FIRM_CFG.mode;                 // "collect" | "live"
const SYMBOL_CATALOG  = FIRM_CFG.symbols;             // canonical -> { mt5, type, volMin, volStep }
const BROKER          = FIRM;                          // back-compat alias for server.js
const BROKER_SYMBOL_MAP = { [FIRM]: FIRM_CFG.symbols };// back-compat shape for server.js

console.log(`[session.js] FIRM="${FIRM}" (${FIRM_CFG.label}) mode=${MODE} | ` +
  `gold->"${SYMBOL_CATALOG["XAUUSD"].mt5}" nasdaq->"${SYMBOL_CATALOG["US100.cash"].mt5}"`);

// ── Volume rounding: round DOWN to volStep, enforce volMin, apply multiplier ──
function roundLots(rawLots, symInfo) {
  const step = symInfo.volStep ?? 0.01;
  const min  = symInfo.volMin  ?? 0.01;
  const stepStr  = step.toString();
  const decimals = stepStr.includes(".") ? stepStr.split(".")[1].length : 0;
  const stepsCount = Math.floor(rawLots / step + 1e-9);         // guard float drift
  const stepped    = parseFloat((stepsCount * step).toFixed(decimals));
  let result = Math.max(min, stepped);                          // never below broker minimum
  if (LOT_MULTIPLIER !== 1) result = parseFloat((result * LOT_MULTIPLIER).toFixed(decimals));
  return parseFloat(result.toFixed(decimals));
}

// ── Brussels time helpers ─────────────────────────────────────────────
function getBrusselsComponents(date = null) {
  const d = date ? new Date(date) : new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "long", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (type) => parts.find(p => p.type === type)?.value;
  const dayMap = { Sunday:0, Monday:1, Tuesday:2, Wednesday:3, Thursday:4, Friday:5, Saturday:6 };
  const day    = dayMap[get("weekday")] ?? 0;
  const hour   = parseInt(get("hour")) % 24;
  const minute = parseInt(get("minute"));
  const second = parseInt(get("second"));
  return { day, hour, minute, second, hhmm: hour * 100 + minute };
}

function getBrusselsDateStr(date = null) {
  const d = date ? new Date(date) : new Date();
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TIMEZONE }).format(d);
}

function getSession(date = null) {
  const { hhmm } = getBrusselsComponents(date);
  if (hhmm >= 200 && hhmm < 800)  return "asia";
  if (hhmm >= 800 && hhmm < 1530) return "london";
  return "ny";
}

function isWeekend(date = null) {
  const { day } = getBrusselsComponents(date);
  return day === 0 || day === 6;
}

// ── Symbol normalization ──────────────────────────────────────────────
function normalizeSymbol(raw) {
  if (!raw) return null;
  const upper = raw.toString().toUpperCase().trim().replace(/[^A-Z0-9./]/g, "");
  if (SYMBOL_ALIASES[upper]) return SYMBOL_ALIASES[upper];
  const noDot = upper.replace(/\./g, "");
  for (const [alias, target] of Object.entries(SYMBOL_ALIASES)) {
    if (alias.replace(/[./]/g, "") === noDot) return target;
  }
  return null;
}

function getSymbolInfo(raw) {
  const key = normalizeSymbol(raw);
  if (!key || !SYMBOL_CATALOG[key]) return null;
  return { ...SYMBOL_CATALOG[key], key };
}

function getVwapPosition(price, vwapMid) {
  if (price == null || vwapMid == null || vwapMid === 0) return "unknown";
  return parseFloat(price) >= parseFloat(vwapMid) ? "above" : "below";
}

// Optimizer key = "XAUUSD_london_buy_above" — the analytics bucket the AI learns from.
function buildOptimizerKey(symbol, session, direction, vwapPos) {
  return `${symbol}_${session}_${direction}_${vwapPos}`;
}

function buildDailyLabel(date, count) {
  const s = getBrusselsDateStr(date);
  return `${s.slice(8, 10)}/${s.slice(5, 7)}-#${count}`;
}

function _fmtHHMM(n) {
  const s = String(n).padStart(4, "0");
  return s.slice(0, 2) + ":" + s.slice(2);
}

function isTimeBlocked(symbolKey, date = null) {
  const windows = TIME_BLOCK_WINDOWS[symbolKey];
  if (!windows) return null;
  const { hhmm } = getBrusselsComponents(date);
  for (const w of windows) if (hhmm >= w.start && hhmm < w.end) return w;
  return null;
}

// TP risk-reward for a ticker at a given time.
function getTpRR(symbolKey, date = null) {
  const windows = TP_RR_WINDOWS[symbolKey];
  if (windows) {
    const { hhmm } = getBrusselsComponents(date);
    for (const w of windows) if (hhmm >= w.start && hhmm < w.end) return w.rr;
  }
  return DEFAULT_TP_RR;
}

// Risk multiplier for this firm + ticker at a given time (default 1.0).
function getRiskMult(symbolKey, date = null) {
  const byFirm = RISK_WINDOWS[FIRM];
  const windows = byFirm && byFirm[symbolKey];
  if (!windows || !windows.length) return 1.0;
  const { hhmm } = getBrusselsComponents(date);
  for (const w of windows) if (hhmm >= w.start && hhmm < w.end) return w.mult ?? 1.0;
  return 1.0;
}

// Gate: weekends + unknown/blocked symbols always refused.
// Time blocks apply to LIVE firms only — DEMO (collect) takes everything.
function canOpenNewTrade(rawSymbol, date = null) {
  if (isWeekend(date)) return { allowed: false, reason: "WEEKEND" };
  const upper = (rawSymbol || "").toString().toUpperCase().trim().replace(/[^A-Z0-9./]/g, "");
  if (BLOCKED_SYMBOLS.has(upper)) return { allowed: false, reason: `SYMBOL_NOT_ALLOWED: "${rawSymbol}" — explicitly blocked` };
  const sym = normalizeSymbol(rawSymbol);
  if (!sym) return { allowed: false, reason: `SYMBOL_NOT_ALLOWED: "${rawSymbol}" — only gold & nasdaq` };
  if (MODE !== "collect") {
    const blk = isTimeBlocked(sym, date);
    if (blk) return { allowed: false, reason: `TIME_BLOCK: ${sym} ${_fmtHHMM(blk.start)}\u2013${_fmtHHMM(blk.end)} Brussels` };
  }
  return { allowed: true, reason: null };
}

module.exports = {
  TIMEZONE, DEFAULT_RISK_PCT, SL_BUFFER_MULT, LOT_MULTIPLIER,
  FIRM, MODE, MODEL_MODE, BROKER, BROKER_SYMBOL_MAP, FIRMS, FIRM_LIMITS,
  SYMBOL_CATALOG, SYMBOL_ALIASES,
  getBrusselsComponents, getBrusselsDateStr,
  getSession, isWeekend,
  normalizeSymbol, getSymbolInfo,
  getVwapPosition, buildOptimizerKey, buildDailyLabel,
  canOpenNewTrade, TIME_BLOCK_WINDOWS, isTimeBlocked,
  DEFAULT_TP_RR, TP_RR_WINDOWS, getTpRR,
  RISK_WINDOWS, getRiskMult, roundLots,
};
