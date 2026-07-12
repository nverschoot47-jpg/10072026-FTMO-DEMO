"use strict";
// ================================================================
// server.js  v2.0.0  |  PRONTO-AI
//
// Flow:
// 1. TradingView webhook → /webhook
//    - symbol filter (XAUUSD / US100 only)
//    - SL + TP calculation (sl_pct × 1.5 × execPrice)
//    - lot calculation (riskEUR / slDist)
//    - placeOrder on MT5 via MetaAPI
//    - start ghost tracker
//    - log to signal_log
//
// 2. syncPositions() every 5s
//    - poll MT5 for open positions
//    - update ghost tracker with current price
//    - track 0.1R milestones (-1.0 → +max)
//    - detect MT5 close (TP or SL)
//    - if MT5 SL: finalize ghost (phantom SL = MT5 SL)
//    - if MT5 TP: keep ghost running until phantom SL
//
// 3. Ghost phantom SL:
//    - price crosses SL level
//    - backfill all ADV milestones proportionally
//    - save to ghost_trades
//    - delete from ghost_state
//
// 4. Dashboard: server.js contains all HTML/JS inline
// ================================================================

const express = require("express");
const helmet  = require("helmet");
const cron    = require("node-cron");

const db = require("./db");
const { buildFeatures, scoreSignal } = require("./model");
const {
  DEFAULT_RISK_PCT, SL_BUFFER_MULT,
  FIRM, MODE, BROKER, BROKER_SYMBOL_MAP, MODEL_MODE, FIRM_LIMITS,
  getBrusselsDateStr, getSession,
  normalizeSymbol, getSymbolInfo,
  getVwapPosition, buildOptimizerKey,
  buildDailyLabel, canOpenNewTrade,
  getTpRR, roundLots, getRiskMult,
} = require("./session");

const VERSION = "3.1.0";

// ── Safe numeric parser (handles NaN, null, undefined, "") ────────
function safeNum(val) {
  if (val === null || val === undefined || val === "") return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

// ── Config from Railway env vars ─────────────────────────────────
const PORT           = process.env.PORT           || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const META_API_TOKEN = process.env.META_API_TOKEN || "";
const META_ACCOUNT   = process.env.META_ACCOUNT   || "";
const META_BASE      = process.env.META_BASE
  || "https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai";

// ── App state ────────────────────────────────────────────────────
let dbReady       = false;
let openPositions = new Map();
let latestEquity  = 50000;
let latestCurrency = "USD";
let _acctCache    = null;
let _acctCacheTs  = 0;
let _syncRunning  = false;
let _lastEquitySave = 0;

// ── Express: start immediately so Railway health check passes ────
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use((req, res, next) => {
  if (req.method === "POST" && req.headers["content-type"]?.includes("application/json")) {
    let raw = "";
    req.on("data", chunk => raw += chunk);
    req.on("end", () => {
      try {
        const sanitized = raw.replace(/: *NaN/g, ": null").replace(/: *nan/g, ": null");
        req.body = JSON.parse(sanitized);
      } catch { try { req.body = JSON.parse(raw); } catch { req.body = {}; } }
      next();
    });
  } else {
    express.json({ limit: "1mb" })(req, res, next);
  }
});

const server = app.listen(PORT, () => {
  console.log(`[PRONTO-AI v${VERSION}] port ${PORT} | broker=${BROKER}`);
});

// ── MetaAPI helpers ───────────────────────────────────────────────
let _metaFails = 0;
let _circuitOpen = false;
let _circuitOpenAt = 0;
const CIRCUIT_THRESHOLD = 15;
const _recentWebhooks = new Map();
const _zeroDealsCount = new Map();
const _processingWebhooks = new Set();

function isDuplicateWebhook(sym, dir) {
  const key = sym+"_"+dir, now = Date.now();
  if (_processingWebhooks.has(key)) return true;
  const last = _recentWebhooks.get(key);
  if (last && now-last < 60000) return true;
  _processingWebhooks.add(key);
  setTimeout(() => _processingWebhooks.delete(key), 5000);
  for (const [k,v] of _recentWebhooks) if (now-v>120000) _recentWebhooks.delete(k);
  return false;
}

function markWebhookPlaced(sym, dir) {
  const key = sym+"_"+dir;
  _recentWebhooks.set(key, Date.now());
}

const CIRCUIT_RESET_MS = 45000;

function circuitOpen() {
  if (!_circuitOpen) return false;
  if (Date.now() - _circuitOpenAt > CIRCUIT_RESET_MS) {
    _circuitOpen = false; _metaFails = 0;
    console.log("[MetaAPI] Circuit reset");
    return false;
  }
  return true;
}

async function metaFetch(path, method = "GET", body = null, retries = 2) {
  if (circuitOpen()) throw new Error("MetaAPI circuit open");
  const url  = `${META_BASE}${path}`;
  const opts = {
    method,
    headers: { "auth-token": META_API_TOKEN, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(12000),
  };
  if (body) opts.body = JSON.stringify(body);
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`${res.status} ${txt.slice(0, 100)}`);
      }
      _metaFails = 0;
      return res.json().catch(() => null);
    } catch (e) {
      if (i < retries) { await new Promise(r => setTimeout(r, 1000 * (i + 1))); continue; }
      const isServerDown = e.message.includes('503') || e.message.includes('Service Unavailable');
      if (!isServerDown) {
        _metaFails++;
        if (_metaFails >= CIRCUIT_THRESHOLD) { _circuitOpen = true; _circuitOpenAt = Date.now(); console.error("[MetaAPI] Circuit OPEN"); }
      } else {
        console.warn("[MetaAPI] 503 outage — not counting toward circuit");
      }
      throw e;
    }
  }
}

async function getAccountInfo() {
  const now = Date.now();
  if (_acctCache && now - _acctCacheTs < 60000) return _acctCache;
  if (!META_API_TOKEN || !META_ACCOUNT) return null;
  try {
    const d = await metaFetch(`/users/current/accounts/${META_ACCOUNT}/account-information`);
    if (d?.balance !== undefined) {
      _acctCache = d; _acctCacheTs = now;
      latestEquity   = parseFloat(d.equity ?? d.balance ?? latestEquity);
      latestCurrency = d.currency ?? latestCurrency;
    }
    return d;
  } catch (e) { return _acctCache ?? null; }
}

async function getPositions() {
  if (!META_API_TOKEN || !META_ACCOUNT) return [];
  try {
    const d = await metaFetch(`/users/current/accounts/${META_ACCOUNT}/positions`);
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

async function placeOrder(order) {
  const result = await metaFetch(`/users/current/accounts/${META_ACCOUNT}/trade`, "POST", order);
  if (result) console.log(`[PlaceOrder] Response:`, JSON.stringify(result).slice(0,200));
  return result;
}

async function getDeals(positionId) {
  if (!META_API_TOKEN || !META_ACCOUNT) return [];
  if (circuitOpen()) return [];
  try {
    const from = new Date(Date.now() - 30 * 86400000).toISOString();
    const to   = new Date().toISOString();
    const url  = `${META_BASE}/users/current/accounts/${META_ACCOUNT}/history-deals/position/${positionId}?from=${from}&to=${to}`;
    const res  = await fetch(url, {
      headers: { "auth-token": META_API_TOKEN, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      if (res.status === 503) console.warn(`[MetaAPI] getDeals 503 for ${positionId} — MetaAPI outage`);
      return [];
    }
    const d = await res.json().catch(() => null);
    return Array.isArray(d) ? d : (d?.deals ?? []);
  } catch { return []; }
}

// ── Ghost tracker ─────────────────────────────────────────────────
function initGhost(pos) {
  return {
    positionId:    pos.positionId,
    dailyLabel:    pos.dailyLabel,
    optimizerKey:  pos.optimizerKey,
    symbol:        pos.symbol,
    assetType:     pos.assetType,
    direction:     pos.direction,
    session:       pos.session,
    vwapPosition:  pos.vwapPosition,
    entry:         pos.entry,
    sl:            pos.sl,
    tp:            pos.tp,
    lots:          pos.lots,
    riskEur:       pos.riskEur,
    slPct:         pos.slPct,
    slDist:        pos.slDist,
    vwapMid:       pos.vwapMid,
    vwapUpper:     pos.vwapUpper,
    vwapLower:     pos.vwapLower,
    vwapBandPct:   pos.vwapBandPct,
    sessionHigh:   pos.sessionHigh,
    sessionLow:    pos.sessionLow,
    dayHigh:       pos.dayHigh,
    dayLow:        pos.dayLow,
    tvEntry:       pos.tvEntry,
    mt5Comment:    pos.mt5Comment,
    openedAt:      pos.openedAt,
    maxRR:         0,
    currentRR:     0,
    peakRRPos:     0,
    peakRRNeg:     0,
    rrMilestones:  {},
    mt5ClosedTP:   false,
    mt5CloseAt:    null,
    mt5CloseReason: null,
    phantomSLHit:  false,
    slHitAt:       null,
    timeToSLMin:   null,
  };
}

// Any gap longer than this between two observed prices counts as a BLACKOUT.
// Normal sync is every 10s, so 2 minutes means we genuinely went blind.
const GHOST_BLACKOUT_MS = 120000;

// Deepest / highest level already stamped — tells us where price WAS before a gap.
function _lastKnownLevel(ms, sign, max) {
  let best = 0;
  for (let v = 0.1; v <= max + 1e-9; v = Math.round((v + 0.1) * 10) / 10) {
    if (ms[sign + v.toFixed(1)] != null) best = Math.round(v * 10) / 10;
  }
  return best;
}

// Stamp every newly-crossed level between `from` (where price was) and `to` (where
// price is now). If we were BLIND for the interval, we cannot honestly claim all of
// them happened at the recovery instant — price passed through them somewhere inside
// the blackout. So we spread them proportionally across [gapStart, now] and count
// them as ESTIMATED, so the row can be filtered out of clean training data later.
function _stampCrossings(ghost, sign, from, to, max, now, gapStart, isBlackout) {
  for (let v = 0.1; v <= max + 1e-9; v = Math.round((v + 0.1) * 10) / 10) {
    const key = sign + v.toFixed(1);
    if (ghost.rrMilestones[key] != null) continue;
    if (to < v - 1e-9) continue;                       // not reached yet

    if (!isBlackout || v <= from + 1e-9) {
      ghost.rrMilestones[key] = now;                   // observed live
      continue;
    }
    // Crossed while we were blind: place it inside the blackout window.
    const span = to - from;
    const frac = span > 1e-9 ? Math.min(1, Math.max(0, (v - from) / span)) : 1;
    ghost.rrMilestones[key] = Math.round(gapStart + (now - gapStart) * frac);
    ghost.estimatedCount = (ghost.estimatedCount || 0) + 1;
    ghost.dataComplete   = false;                      // honest: this was inferred
  }
}

function updateGhost(ghost, currentPrice) {
  const now = Date.now();
  if (ghost.phantomSLHit) { ghost.lastPriceAt = now; return false; }
  const price  = parseFloat(currentPrice);
  const entry  = parseFloat(ghost.entry);
  const sl     = parseFloat(ghost.sl);
  const slDist = Math.abs(entry - sl);
  if (slDist <= 0) { ghost.lastPriceAt = now; return false; }
  const isBuy  = ghost.direction === "buy";

  // ── Blackout detection ──────────────────────────────────────────────
  // gapStart = the last moment we actually SAW a price. On a fresh restart this
  // comes from ghost_state.last_price_at, so a redeploy is not mistaken for zero gap.
  const gapStart    = ghost.lastPriceAt ?? new Date(ghost.openedAt ?? now).getTime();
  const gapMs       = now - gapStart;
  const isBlackout  = gapMs > GHOST_BLACKOUT_MS;
  if (isBlackout) {
    ghost.blackoutMin = (ghost.blackoutMin || 0) + gapMs / 60000;
    console.warn(`[Ghost] ${ghost.positionId} blind for ${(gapMs/60000).toFixed(1)}min — crossings will be interpolated`);
  }

  const fav = isBuy ? price - entry : entry - price;
  const rr  = fav / slDist;
  ghost.currentRR = rr;                       // where it is NOW (maxRR is the PEAK — not the same thing)
  if (rr > ghost.maxRR)     ghost.maxRR     = rr;
  if (rr > ghost.peakRRPos) ghost.peakRRPos = rr;

  const advRR  = isBuy ? (entry - price) / slDist : (price - entry) / slDist;
  const advPct = Math.max(0, advRR * 100);
  if (advPct > ghost.peakRRNeg) ghost.peakRRNeg = advPct;

  // Where price was BEFORE this update (derived from what we already stamped).
  const prevPos = _lastKnownLevel(ghost.rrMilestones, "+", 20.0);
  const prevNeg = _lastKnownLevel(ghost.rrMilestones, "-", 1.0);

  _stampCrossings(ghost, "+", prevPos, rr,    20.0, now, gapStart, isBlackout);
  _stampCrossings(ghost, "-", prevNeg, advRR,  1.0, now, gapStart, isBlackout);

  ghost.lastPriceAt = now;

  const hitSL = isBuy ? price <= sl : price >= sl;
  if (hitSL) {
    ghost.phantomSLHit = true;
    ghost.slHitAt      = new Date().toISOString();
    backfillNegatives(ghost);   // monotonic gap-fill; real stamps preserved
    return true;
  }
  return false;
}

// Convert absolute milestone timestamps -> ELAPSED MINUTES (plain numbers).
//
// TWO BUGS FIXED HERE:
//  1. It used to return the raw object when openedAt was missing — writing raw epoch
//     milliseconds (1783850400000) into rr_milestones as if they were elapsed times.
//     Silent, catastrophic corruption. Now it derives t0 from the earliest milestone
//     instead, and never emits an absolute timestamp.
//  2. It used to emit DISPLAY STRINGS ("12m", "1h47m"). That is formatting leaking into
//     the data layer: the AI would have to string-parse "1h47m" in SQL. Now it stores
//     NUMBERS, so you can query straight:
//         (rr_milestones->>'+1.5')::numeric  AS minutes_to_1_5R
//     Formatting is the dashboard's job, not the database's.
function msToElapsed(rrMilestones, openedAt) {
  const ms = rrMilestones ?? {};
  let openedTs = openedAt ? new Date(openedAt).getTime() : null;
  if (!openedTs || !Number.isFinite(openedTs)) {
    // Fall back to the earliest stamp we have — never emit absolute epoch values.
    const stamps = Object.values(ms)
      .map(v => (typeof v === "number" ? v : new Date(v).getTime()))
      .filter(n => Number.isFinite(n));
    if (!stamps.length) return {};
    openedTs = Math.min(...stamps);
    console.warn("[Ghost] msToElapsed: openedAt missing — using earliest milestone as t0");
  }
  const out = {};
  for (const [key, val] of Object.entries(ms)) {
    const tsMs = typeof val === "number" ? val : new Date(val).getTime();
    if (!Number.isFinite(tsMs)) continue;
    out[key] = Math.max(0, Math.round((tsMs - openedTs) / 60000));   // minutes, numeric
  }
  return out;
}

// Backfill the -0.1 .. -1.0 milestones. Used whenever we KNOW price went to the
// stop but never observed every step (MT5 closed at SL, or the ghost was forced).
//
// MONOTONIC by construction. Real (observed) milestones are NEVER overwritten and
// are used as anchors; only the GAPS are interpolated, strictly between the anchors
// on either side. This matters when price dips to -0.4, recovers, then later breaks
// to -0.7: the real -0.1..-0.4 stamps stay put, and anything filled below them can
// never be given an earlier timestamp than the real level above it.
function backfillNegatives(ghost) {
  const openedTs = ghost.openedAt ? new Date(ghost.openedAt).getTime() : Date.now() - 60000;
  const endTs    = ghost.slHitAt ? new Date(ghost.slHitAt).getTime() : Date.now();
  if (ghost.timeToSLMin == null) ghost.timeToSLMin = Math.max(1, Math.round((endTs - openedTs) / 60000));

  const levels = [];
  for (let v = 0.1; v <= 1.0 + 1e-9; v = Math.round((v + 0.1) * 10) / 10) levels.push(Math.round(v * 10) / 10);

  // Anchors: depth 0 = open. Depth 1.0 = the stop (endTs) if not already observed.
  const known = levels.map(v => {
    const ts = ghost.rrMilestones["-" + v.toFixed(1)];
    return ts != null ? Number(ts) : null;
  });

  for (let i = 0; i < levels.length; i++) {
    if (known[i] != null) continue;
    // nearest observed anchor ABOVE (shallower) — or the open
    let loT = openedTs, loV = 0;
    for (let j = i - 1; j >= 0; j--) if (known[j] != null) { loT = known[j]; loV = levels[j]; break; }
    // nearest observed anchor BELOW (deeper) — or the stop
    let hiT = endTs, hiV = 1.0;
    for (let j = i + 1; j < levels.length; j++) if (known[j] != null) { hiT = known[j]; hiV = levels[j]; break; }

    const span = hiV - loV;
    const frac = span > 1e-9 ? (levels[i] - loV) / span : 1;
    let ts = Math.round(loT + (hiT - loT) * frac);
    if (ts < loT) ts = loT;                 // never before the level above it
    if (ts > hiT) ts = hiT;                 // never after the level below it
    known[i] = ts;
  }

  // Enforce non-decreasing depth->time, then write back.
  let prev = openedTs;
  levels.forEach((v, i) => {
    const ts = Math.max(known[i], prev);
    ghost.rrMilestones["-" + v.toFixed(1)] = ts;
    prev = ts;
  });

  if (!(ghost.peakRRNeg > 0)) ghost.peakRRNeg = 100;   // it reached the stop
  ghost.phantomSLHit = true;
  if (!ghost.slHitAt) ghost.slHitAt = new Date().toISOString();
}

// Force a ghost to finish and be WRITTEN, even if we never saw the SL hit.
// A ghost must never be lost just because MetaAPI went down or price went quiet.
async function forceFinalizeGhost(ghost, reason) {
  if (!ghost || ghost._finalizing) return;
  ghost._finalizing = true;
  backfillNegatives(ghost);
  ghost.finalizeReason = reason;
  ghost.dataComplete   = false;          // flag it: outcome inferred, not observed
  await finalizeGhost(ghost);
  console.warn(`[Ghost] FORCE-finalized ${ghost.positionId} ${ghost.symbol} (${reason}) peak=+${(ghost.peakRRPos||0).toFixed(2)}R`);
}

async function finalizeGhost(ghost) {
  const elapsedMilestones = msToElapsed(ghost.rrMilestones, ghost.openedAt);
  await db.saveGhostTrade({
    positionId:     ghost.positionId,
    dailyLabel:     ghost.dailyLabel,
    optimizerKey:   ghost.optimizerKey,
    symbol:         ghost.symbol,
    assetType:      ghost.assetType,
    direction:      ghost.direction,
    session:        ghost.session,
    vwapPosition:   ghost.vwapPosition,
    entry:          ghost.entry,
    sl:             ghost.sl,
    tp:             ghost.tp,
    lots:           ghost.lots,
    riskEur:        ghost.riskEur,
    slPct:          ghost.slPct,
    slDist:         ghost.slDist,
    vwapMid:        ghost.vwapMid,
    vwapUpper:      ghost.vwapUpper,
    vwapLower:      ghost.vwapLower,
    vwapBandPct:    ghost.vwapBandPct,
    sessionHigh:    ghost.sessionHigh,
    sessionLow:     ghost.sessionLow,
    dayHigh:        ghost.dayHigh,
    dayLow:         ghost.dayLow,
    tvEntry:        ghost.tvEntry,
    mt5Comment:     ghost.mt5Comment,
    peakRRPos:      ghost.peakRRPos,
    // peakRRNeg is tracked as % of the way to SL (0-100). Store it as NEGATIVE R
    // so it reads like the dashboard: -0.83R = went 83% toward the stop.
    peakRRNeg:      ghost.peakRRNeg != null ? -(ghost.peakRRNeg / 100) : 0,
    rrMilestones:   elapsedMilestones,
    timeToSLMin:    ghost.timeToSLMin,
    mt5CloseReason: ghost.mt5CloseReason,
    openedAt:       ghost.openedAt,
    closedAt:       ghost.slHitAt ?? new Date().toISOString(),
    finalizeReason: ghost.finalizeReason ?? (ghost.mt5CloseReason === "sl" ? "mt5_sl" : "sl_hit"),
    dataComplete:   ghost.dataComplete !== false,
  });
  await db.deleteGhostState(ghost.positionId);
  const pos = openPositions.get(ghost.positionId);
  if (pos) {
    pos.finalizedAt = Date.now();
    pos.ghostFinalized = true;
    pos.ghost.finalizedAt = Date.now();
  }
  console.log(`[Ghost] Finalized ${ghost.positionId} ${ghost.symbol} peakRR=${ghost.peakRRPos.toFixed(2)}R SL=${ghost.timeToSLMin}m`);
}

// ── GHOST REAPER ──────────────────────────────────────────────────────
// Guarantees every ghost eventually lands in ghost_trades. A ghost is force-
// finalized (negatives backfilled, flagged data_complete=false) when either:
//   - it has had NO price update for GHOST_STALE_MIN minutes (MetaAPI down,
//     circuit open, symbol quiet), or
//   - it has been alive longer than GHOST_MAX_HOURS (never came back to the stop).
// Runs every 5 min, and is safe while the circuit is open (no MetaAPI needed).
const GHOST_STALE_MIN = parseInt(process.env.GHOST_STALE_MIN) || 90;    // minutes with no price
const GHOST_MAX_HOURS = parseInt(process.env.GHOST_MAX_HOURS) || 72;    // hard lifetime cap

async function cleanupFinalizedGhosts() {
  const now = Date.now();
  for (const [id, pos] of [...openPositions.entries()]) {
    const g = pos.ghost;
    if (!g || pos.ghostFinalized || g.phantomSLHit || g._finalizing) continue;

    const ageH    = g.openedAt ? (now - new Date(g.openedAt).getTime()) / 3600000 : 0;
    const staleMin = (now - (g.lastPriceAt ?? new Date(g.openedAt ?? now).getTime())) / 60000;

    // Only reap ghosts whose MT5 position is already gone — a live MT5 position
    // is still being tracked normally and must never be force-closed.
    if (!pos.mt5Closed) {
      if (ageH > GHOST_MAX_HOURS) console.warn(`[Reaper] ${id} still OPEN on MT5 after ${ageH.toFixed(1)}h — left alone`);
      continue;
    }

    if (staleMin > GHOST_STALE_MIN) {
      await forceFinalizeGhost(g, "forced_stale");
      pos.ghostFinalized = true;
    } else if (ageH > GHOST_MAX_HOURS) {
      await forceFinalizeGhost(g, "forced_max_age");
      pos.ghostFinalized = true;
    }
  }
}

// On shutdown, flush every unfinished ghost so a redeploy never drops data.
let _shuttingDown = false;
async function flushGhostsOnShutdown() {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log("[Shutdown] flushing ghost states...");
  for (const [, pos] of [...openPositions.entries()]) {
    const g = pos.ghost;
    if (!g || pos.ghostFinalized) continue;
    try {
      // Live MT5 position: just persist state, it resumes after restart.
      if (!pos.mt5Closed) { await db.saveGhostState(g); continue; }
      // MT5 already closed and still no SL seen: persist state so it can resume.
      await db.saveGhostState(g);
    } catch (e) { console.warn("[Shutdown] flush:", e.message); }
  }
  console.log("[Shutdown] done");
  process.exit(0);
}
process.on("SIGTERM", flushGhostsOnShutdown);
process.on("SIGINT",  flushGhostsOnShutdown);

// ── syncPositions ─────────────────────────────────────────────────
async function syncPositions() {
  if (!dbReady || _syncRunning || circuitOpen()) return;
  _syncRunning = true;
  try {
    const now = Date.now();
    if (now - _acctCacheTs > 60000) {
      const acct = await getAccountInfo();
      if (acct?.equity) {
        latestEquity = parseFloat(acct.equity);
        if (now - _lastEquitySave > 300000) {
          _lastEquitySave = now;
          const openPnl = [...openPositions.values()].reduce((s, p) => s + (p.livePnl ?? 0), 0);
          db.saveEquity(acct.balance, acct.equity, openPnl, openPositions.size).catch(() => {});
          // 1C: high-water-mark (daily peak/trough open P&L + all-time equity peak)
          db.updateHwm(getBrusselsDateStr(), acct.balance, acct.equity, openPnl).catch(() => {});
        }
      }
    }

    const liveMT5 = await getPositions();
    const liveIds = new Set(
      (liveMT5.length === 0 && openPositions.size > 0 && !_circuitOpen)
        ? (console.warn(`[Sync] MetaAPI 0 positions but ${openPositions.size} in memory — skipping close detection`), [])
        : liveMT5.map(p => String(p.id))
    );

    const closedIds = [...openPositions.keys()].filter(id => !liveIds.has(id));
    await Promise.all(closedIds.map(async id => {
      const pos = openPositions.get(id);
      if (!pos) return;
      if (pos.mt5Closed || pos.ghostFinalized) return;

      const ageMs = pos.openedAt ? Date.now() - new Date(pos.openedAt).getTime() : 999999;
      if (ageMs < 90000) {
        console.log(`[Sync] Skipping close check for ${id} — only ${Math.round(ageMs/1000)}s old`);
        return;
      }

      let closeReason = "sl";
      let closeSource = "assumed_sl";   // how we decided — audited in closed_trades
      try {
        if (_circuitOpen) { return; }
        const deals = await getDeals(id);

        if (!deals.length) {
          const zeroCount = (_zeroDealsCount.get(id) || 0) + 1;
          _zeroDealsCount.set(id, zeroCount);
          if (zeroCount >= 3) {
            console.warn(`[Sync] ${id} 0 deals for ${zeroCount} syncs — forcing mt5Closed`);
            const pos2 = openPositions.get(id);
            if (pos2 && !pos2.mt5Closed) {
              pos2.mt5Closed = true;
              if (pos2.ghost) { pos2.ghost.mt5ClosedTP = true; pos2.ghost.mt5CloseReason = "unknown"; }
            }
            _zeroDealsCount.delete(id);
          } else {
            console.log(`[Sync] ${id} 0 deals (${zeroCount}/3) — skipping`);
          }
          return;
        }

        const outDeals = deals.filter(d =>
          (d.entryType || "").toUpperCase().includes("OUT") ||
          (d.type || "").toUpperCase().includes("OUT") ||
          (d.entry || "").toUpperCase().includes("OUT")
        );

        if (!outDeals.length) {
          console.log(`[Sync] ${id} missing from live but no OUT deal found — keeping open`);
          return;
        }

        const closing = outDeals.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))[0];
        if (closing) {
          const r = (closing.reason || "").toUpperCase();
          if (r.includes("TP") || r.includes("TAKE_PROFIT")) { closeReason = "tp"; closeSource = "mt5_reason"; }
          else if (r.includes("SL") || r.includes("STOP_LOSS")) { closeReason = "sl"; closeSource = "mt5_reason"; }
          if (closing.price)  pos._exitPrice  = parseFloat(closing.price);
          if (closing.profit != null) pos._exitProfit = parseFloat(closing.profit);
        }
      } catch {}

      // ══════════════════════════════════════════════════════════════════
      // closed_trades = MT5 REALITY. The GHOST NEVER DECIDES WIN/LOSS.
      //
      // (Removed: the old rule `ghost.peakRRPos >= tpRR - 0.2 -> "tp"`, i.e. a
      //  ghost peak of 1.3R marked the trade a WIN. Worse, it ran LAST and so
      //  overrode an explicit MT5 STOP_LOSS — booking real losers as winners.)
      //
      // The ghost still runs on past the exit; that is its whole job. But what
      // the ACCOUNT actually did is decided only by MT5, in this order:
      //   1. MT5 deal reason (TAKE_PROFIT / STOP_LOSS)   <- definitive
      //   2. exit price: which level did it land on      <- geometric
      //   3. realized profit sign                        <- last resort
      // ══════════════════════════════════════════════════════════════════
      if (closeSource !== "mt5_reason" && pos._exitPrice && pos.tp && pos.sl) {
        const exitP  = pos._exitPrice;
        const tp     = parseFloat(pos.tp);
        const sl     = parseFloat(pos.sl);
        const entry  = parseFloat(pos.entry);
        const slDist = Math.abs(entry - sl);
        const distToTP = Math.abs(exitP - tp);
        const distToSL = Math.abs(exitP - sl);
        if (distToTP < distToSL) { closeReason = "tp"; closeSource = "exit_price"; }
        else                     { closeReason = "sl"; closeSource = "exit_price"; }
      }
      if (closeSource === "assumed_sl" && pos._exitProfit != null) {
        closeReason = parseFloat(pos._exitProfit) > 0 ? "tp" : "sl";
        closeSource = "profit_sign";
      }
      if (closeSource === "assumed_sl") {
        console.warn(`[Close] ${id} ${pos.symbol}: no MT5 reason, no exit price, no profit — defaulting to SL (conservative)`);
      }
      if (pos.ghost && pos.ghost.peakRRPos >= 1.3 && closeReason === "sl") {
        console.log(`[Close] ${id} ghost peaked +${pos.ghost.peakRRPos.toFixed(2)}R but MT5 says SL — logged as SL (correct). Ghost keeps running.`);
      }

      const ghost = pos.ghost;
      await db.saveClosedTrade({
        positionId: id, dailyLabel: pos.dailyLabel, symbol: pos.symbol,
        assetType: pos.assetType, direction: pos.direction, session: pos.session,
        vwapPosition: pos.vwapPosition, optimizerKey: pos.optimizerKey,
        entry: pos.entry, sl: pos.sl, tp: pos.tp, lots: pos.lots,
        riskPct: pos.riskPct, riskEur: pos.riskEur, slPct: pos.slPct,
        slPoints: pos.slPoints, slDist: pos.slDist, vwapMid: pos.vwapMid,
        vwapUpper: pos.vwapUpper, vwapLower: pos.vwapLower, vwapBandPct: pos.vwapBandPct,
        sessionHigh: pos.sessionHigh, sessionLow: pos.sessionLow,
        dayHigh: pos.dayHigh, dayLow: pos.dayLow, tvEntry: pos.tvEntry,
        executionPrice: pos.executionPrice, slippage: pos.slippage,
        exitPrice: pos._exitPrice ?? null, closeReason, closeSource,
        peakRRPos: ghost?.peakRRPos ?? 0,
        // UNITS: ghost.peakRRNeg is tracked as % of the way to SL (0-100).
        // Store it as NEGATIVE R here so closed_trades and ghost_trades agree.
        // (Was storing the raw percent -> 70 here vs -0.70 there for the SAME trade.)
        peakRRNeg: ghost?.peakRRNeg != null ? -(ghost.peakRRNeg / 100) : 0,
        mt5Comment: pos.mt5Comment, openedAt: pos.openedAt,
        closedAt: new Date().toISOString(),
      });

      if (closeReason === "sl") {
        if (ghost && !ghost.phantomSLHit) {
          // MT5 closed at SL -> we KNOW price reached the stop. Fill the negative
          // side monotonically, preserving every real stamp we already observed.
          backfillNegatives(ghost);
        }
        ghost.mt5CloseReason = "sl";
        await finalizeGhost(ghost);
      } else {
        if (ghost) {
          ghost.mt5ClosedTP    = true;
          ghost.mt5CloseAt     = new Date().toISOString();
          ghost.mt5CloseReason = "tp";
          pos.mt5Closed = true;
          await db.saveGhostState(ghost);
          console.log(`[Ghost] MT5 TP hit for ${id} ${pos.symbol} — ghost tracking on`);
        } else {
          openPositions.delete(id);
        }
      }
    }));

    for (const lp of liveMT5) {
      const id  = String(lp.id);
      const pos = openPositions.get(id);

      if (!pos) { await adoptPosition(lp); continue; }

      if (pos.mt5Closed && !pos.ghostFinalized) {
        console.log(`[Sync] Resetting false-close for ${id} ${pos.symbol}`);
        pos.mt5Closed = false;
        if (pos.ghost) {
          pos.ghost.mt5ClosedTP = false;
          pos.ghost.mt5CloseAt = null;
          pos.ghost.mt5CloseReason = null;
        }
      }

      if (lp.volume != null) pos.lots = parseFloat(lp.volume);
      if (lp.currentPrice)   pos.currentPrice = parseFloat(lp.currentPrice);
      const rawPnl = lp.profit ?? lp.unrealizedProfit ?? null;
      if (rawPnl != null) pos.livePnl = parseFloat(rawPnl);

      if (pos.ghost && lp.currentPrice) {
        const prevPeak = pos.ghost.peakRRPos;
        const prevMsCount = Object.keys(pos.ghost.rrMilestones).length;
        const justHit = updateGhost(pos.ghost, lp.currentPrice);
        if (justHit) {
          pos.ghost.mt5CloseReason = pos.mt5Closed ? "tp" : "sl";
          await finalizeGhost(pos.ghost);
          continue;
        }
        const changed = pos.ghost.peakRRPos !== prevPeak
          || Object.keys(pos.ghost.rrMilestones).length !== prevMsCount;
        if (changed) await db.saveGhostState(pos.ghost);
      }
    }

    const _now30 = Date.now();
    const _skipGhost = syncPositions._lastGhostPriceFetch && _now30 - syncPositions._lastGhostPriceFetch < 30000;
    if (!_skipGhost) {
      syncPositions._lastGhostPriceFetch = _now30;
      const ghostOnlySyms = new Set(
        [...openPositions.values()]
          .filter(p => p.mt5Closed && p.ghost && !p.ghost.phantomSLHit)
          .map(p => p.symbol)
      );
      const symPrices = new Map();
      for (const sym of ghostOnlySyms) {
        try {
          const symInfo = getSymbolInfo(sym);
          if (!symInfo) continue;
          const q = await metaFetch(`/users/current/accounts/${META_ACCOUNT}/symbols/${symInfo.mt5}/current-price`);
          if (q?.bid && q?.ask) symPrices.set(sym, { bid: parseFloat(q.bid), ask: parseFloat(q.ask) });
        } catch {}
      }
      for (const [id, pos] of openPositions) {
        if (!pos.mt5Closed || !pos.ghost || pos.ghost.phantomSLHit) continue;
        const prices = symPrices.get(pos.symbol);
        if (!prices) continue;
        const curPrice = pos.direction === "buy" ? prices.bid : prices.ask;
        pos.currentPrice = curPrice;
        const justHit = updateGhost(pos.ghost, curPrice);
        if (justHit) {
          pos.ghost.mt5CloseReason = "tp";
          await finalizeGhost(pos.ghost);
        } else {
          await db.saveGhostState(pos.ghost);
        }
      }
    }

  } catch(syncErr) {
    console.warn('[Sync] Non-critical error:', syncErr.message);
  } finally {
    _syncRunning = false;
  }
}

// ── Adopt MT5 position not in memory ─────────────────────────────
const MT5_TO_CATALOG = Object.fromEntries(
  Object.entries(BROKER_SYMBOL_MAP[BROKER]).map(([key, val]) => [val.mt5, key])
);

async function adoptPosition(lp) {
  const id     = String(lp.id);
  const rawSym = lp.symbol || "";
  const symbol = MT5_TO_CATALOG[rawSym] ?? normalizeSymbol(rawSym) ?? rawSym;
  const symInfo = getSymbolInfo(symbol);
  if (!symInfo) return;

  const lpType  = (lp.type || lp.positionType || "").toString().toUpperCase();
  const isBuy   = lpType.includes("BUY") || lpType === "POSITION_TYPE_BUY";
  const direction = isBuy ? "buy" : "sell";
  const entry   = parseFloat(lp.openPrice ?? lp.currentPrice ?? 0);
  const sl      = parseFloat(lp.stopLoss ?? 0);
  const tp      = parseFloat(lp.takeProfit ?? 0) || null;
  const lots    = parseFloat(lp.volume ?? 0);
  const openedAt = lp.time ? new Date(lp.time).toISOString() : new Date().toISOString();
  const session  = getSession(new Date(openedAt));
  const slDist   = Math.abs(entry - sl);
  const slPct    = entry > 0 && slDist > 0 ? slDist / entry : 0.003;
  let vwapPos = "unknown";
  if (lp.comment) {
    if (lp.comment.includes("ABV")) vwapPos = "above";
    else if (lp.comment.includes("BLW")) vwapPos = "below";
  }
  const optimizerKey = buildOptimizerKey(symbol, session, direction, vwapPos);

  const pos = {
    positionId: id, dailyLabel: lp.comment?.match(/\d{2}\/\d{2}-#\d+/)?.[0] ?? null,
    symbol, assetType: symInfo.type, direction, session,
    vwapPosition: vwapPos, optimizerKey, entry, sl, tp, lots,   // was hardcoded "unknown" while optimizerKey used the REAL vwapPos -> the two disagreed
    riskPct: DEFAULT_RISK_PCT, riskEur: null, slPct, slDist, slPoints: null,
    vwapMid: null, vwapUpper: null, vwapLower: null, vwapBandPct: null,
    sessionHigh: null, sessionLow: null, dayHigh: null, dayLow: null,
    tvEntry: entry, executionPrice: entry, slippage: 0,
    mt5Comment: lp.comment ?? null, openedAt,
    currentPrice: parseFloat(lp.currentPrice ?? entry),
    livePnl: parseFloat(lp.profit ?? 0), mt5Closed: false,
  };
  pos.ghost = initGhost(pos);
  openPositions.set(id, pos);
  if (dbReady) await db.saveGhostState(pos.ghost);
  if (dbReady) {
    try {
      const sig = await db.pool.query(
        "SELECT vwap_mid,vwap_upper,vwap_lower,vwap_band_pct,session_high,session_low,day_high,day_low,tv_entry,sl_pct FROM signal_log WHERE position_id=$1 LIMIT 1", [id]
      );
      if (sig.rows.length) {
        const s=sig.rows[0];
        const en={vwapMid:parseFloat(s.vwap_mid)||null,vwapUpper:parseFloat(s.vwap_upper)||null,
          vwapLower:parseFloat(s.vwap_lower)||null,vwapBandPct:parseFloat(s.vwap_band_pct)||null,
          sessionHigh:parseFloat(s.session_high)||null,sessionLow:parseFloat(s.session_low)||null,
          dayHigh:parseFloat(s.day_high)||null,dayLow:parseFloat(s.day_low)||null,
          tvEntry:parseFloat(s.tv_entry)||pos.tvEntry,slPct:parseFloat(s.sl_pct)||pos.slPct};
        Object.assign(pos,en);if(pos.ghost)Object.assign(pos.ghost,en);
      }
    } catch(e){}
  }
  console.log(`[Adopt] ${id} ${symbol} ${direction} entry=${entry}`);
}

// ── Webhook secret check ──────────────────────────────────────────
function checkSecret(req, res) {
  if (!WEBHOOK_SECRET) { res.status(401).json({ error: "WEBHOOK_SECRET not set" }); return false; }
  const provided = req.headers["x-webhook-secret"] || req.headers["x-secret"]
    || req.body?.secret || req.query?.secret;
  if (provided !== WEBHOOK_SECRET) { res.status(401).json({ error: "Unauthorized" }); return false; }
  return true;
}

// ── Routes ────────────────────────────────────────────────────────
app.get("/", (req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.send(dashboardHTML()); });
app.get("/dashboard", (req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.send(dashboardHTML()); });
app.get("/health", (req, res) => {
  res.json({ ok: true, version: VERSION, broker: BROKER, dbReady, openPositions: openPositions.size, circuitOpen: _circuitOpen, uptime: Math.round(process.uptime()), ts: new Date().toISOString() });
});
app.get("/status", async (req, res) => {
  const acct = circuitOpen() ? _acctCache : await getAccountInfo().catch(() => _acctCache);
  res.json({ version: VERSION, broker: BROKER, dbReady, openPositions: openPositions.size, account: acct ? { balance: acct.balance, equity: acct.equity, currency: acct.currency } : null, ts: new Date().toISOString() });
});

// ── Main webhook ──────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const t0 = Date.now();
  if (!checkSecret(req, res)) return;
  if (!dbReady) return res.status(503).json({ error: "DB not ready, retry shortly" });
  console.log(`[Webhook] Received: ${JSON.stringify(req.body).slice(0,120)}`);

  const body = req.body ?? {};
  const { symbol: rawSym, direction: _dir, action: _action, sl_pct, sl_points, vwap, vwap_upper, vwap_lower, session_high, session_low, day_high, day_low } = body;
  const tvClose = body.close ?? body.entry ?? null;
  const direction = (_dir ?? _action ?? "").toLowerCase().trim();
  if (direction !== "buy" && direction !== "sell") return res.status(400).json({ error: `Invalid direction: "${direction}"` });

  // 5A: persist-first durability — record the raw signal BEFORE any MetaAPI /
  // execution work, so a mid-flight crash leaves a recoverable trail. Marked
  // processed at every terminal outcome below.
  let _inboxId = null;
  try { _inboxId = await db.saveInbox(body); } catch {}

  if (isDuplicateWebhook(rawSym||"", direction)) {
    console.log(`[Webhook] Duplicate skipped: ${rawSym} ${direction}`);
    await db.logSignal({ symbol: rawSym, direction, session: getSession(), outcome: "DUPLICATE", rejectReason: "Duplicate signal within 60s window", tvEntry: safeNum(tvClose), slPct: safeNum(sl_pct), latencyMs: Date.now() - t0 }).catch(() => {});
    await db.markInboxProcessed(_inboxId, "DUPLICATE").catch(() => {});
    return res.json({ ok:false, reason:"DUPLICATE_SIGNAL" });
  }

  if (_circuitOpen) {
    const circuitAge = Date.now() - _circuitOpenAt;
    if (circuitAge > 30000) { console.warn(`[Webhook] Circuit was open ${Math.round(circuitAge/1000)}s — resetting`); _circuitOpen = false; _metaFails = 0; }
    else { console.warn(`[Webhook] Circuit OPEN — order blocked for ${rawSym} ${direction}`); }
  }

  const { allowed, reason: blockReason } = canOpenNewTrade(rawSym);
  if (!allowed) {
    const blockOutcome = blockReason.startsWith("SYMBOL") ? "SYMBOL_NOT_ALLOWED" : blockReason.startsWith("TIME_BLOCK") ? "TIME_BLOCKED" : "WEEKEND";
    await db.logSignal({ symbol: rawSym, direction, session: getSession(), outcome: blockOutcome, rejectReason: blockReason, tvEntry: safeNum(tvClose), slPct: safeNum(sl_pct), latencyMs: Date.now() - t0, slPoints: safeNum(sl_points), vwapMid: safeNum(vwap), vwapUpper: safeNum(vwap_upper), vwapLower: safeNum(vwap_lower), sessionHigh: safeNum(session_high), sessionLow: safeNum(session_low), dayHigh: safeNum(day_high), dayLow: safeNum(day_low) });
    await db.markInboxProcessed(_inboxId, blockOutcome).catch(() => {});
    return res.json({ ok: false, reason: blockReason });
  }

  const symbol   = normalizeSymbol(rawSym);
  const symInfo  = getSymbolInfo(symbol);
  const session  = getSession();
  const tvEntry  = safeNum(tvClose);
  const vwapMid  = safeNum(vwap);
  const vwapPos  = getVwapPosition(tvEntry, vwapMid);
  const optKey   = buildOptimizerKey(symbol, session, direction, vwapPos);
  const slPctRaw = safeNum(sl_pct);
  const slPct    = slPctRaw ?? 0.003;   // fallback only — it CHANGES position size, so flag it
  if (slPctRaw == null) console.warn(`[Webhook] ${rawSym} ${direction}: no sl_pct in payload — sizing off fallback 0.003`);

  const _sH = safeNum(session_high), _sL = safeNum(session_low);
  const wh = {
    slPoints:    safeNum(sl_points),
    vwapUpper:   safeNum(vwap_upper),
    vwapLower:   safeNum(vwap_lower),
    sessionHigh: _sH ?? safeNum(day_high) ?? null,
    sessionLow:  _sL ?? safeNum(day_low) ?? null,
    dayHigh:     safeNum(day_high),
    dayLow:      safeNum(day_low),
  };

  let vwapBandPct = null;
  if (tvEntry != null && vwapMid != null && wh.vwapUpper != null) {
    const halfBand = Math.abs(wh.vwapUpper - vwapMid);
    if (halfBand > 0.001) vwapBandPct = parseFloat(((Math.abs(tvEntry - vwapMid) / halfBand) * 100).toFixed(2));
  }

  // 10: model gate (shadow by default). Logs what the model WOULD decide on
  // every signal; only blocks when MODEL_MODE=live and the verdict is "skip".
  let _modelDecId = null;
  try {
    const feats  = buildFeatures({ symbol, session, direction, vwapPosition: vwapPos, optimizerKey: optKey, vwapBandPct, sessionHigh: wh.sessionHigh, sessionLow: wh.sessionLow, dayHigh: wh.dayHigh, dayLow: wh.dayLow, now: new Date() });
    const scored = scoreSignal(feats);
    _modelDecId  = await db.saveModelDecision({ optimizerKey: optKey, symbol, features: feats, score: scored.score, decision: scored.decision, reason: scored.reason, mode: MODEL_MODE });
    if (MODEL_MODE === "live" && scored.decision === "skip") {
      await db.logSignal({ symbol, assetType: symInfo.type, direction, session, vwapPosition: vwapPos, optimizerKey: optKey, tvEntry, slPct, vwapMid, vwapBandPct, ...wh, outcome: "MODEL_SKIP", rejectReason: scored.reason, latencyMs: Date.now() - t0 });
      await db.markInboxProcessed(_inboxId, "MODEL_SKIP").catch(() => {});
      console.log(`[Model] LIVE skip: ${optKey} (${scored.reason})`);
      return res.json({ ok: false, reason: "MODEL_SKIP", detail: scored.reason });
    }
  } catch (e) { console.warn("[Model] scoring error:", e.message); }

  if (!circuitOpen()) {
    const acct = await Promise.race([getAccountInfo(), new Promise(r => setTimeout(() => r(null), 5000))]);
    if (acct?.equity) latestEquity = parseFloat(acct.equity);
  }

  // ── Live MT5 quote ────────────────────────────────────────────
  let execPrice   = tvEntry ?? 0;
  let spreadAtEntry = null;
  try {
    const q = await metaFetch(`/users/current/accounts/${META_ACCOUNT}/symbols/${symInfo.mt5}/current-price`);
    if (q?.bid && q?.ask) {
      spreadAtEntry = parseFloat((q.ask - q.bid).toFixed(6));
      execPrice     = direction === "buy" ? parseFloat(q.ask) : parseFloat(q.bid);
    }
  } catch (e) {
    if (e.message?.includes('503') || e.message?.includes('Service Unavailable')) _metaFails = Math.max(0, _metaFails - 1);
  }
  if (!execPrice && tvEntry) execPrice = tvEntry;
  const slippage = tvEntry && execPrice ? Math.abs(execPrice - tvEntry) : 0;

  // ── SL & TP calculation ───────────────────────────────────────
  const slDist  = parseFloat((slPct * SL_BUFFER_MULT * execPrice).toFixed(6));
  const slPrice = direction === "buy"
    ? parseFloat((execPrice - slDist).toFixed(6))
    : parseFloat((execPrice + slDist).toFixed(6));
  const tpRR    = getTpRR(symbol, new Date());
  const tpPrice = direction === "buy"
    ? parseFloat((execPrice + slDist * tpRR).toFixed(6))
    : parseFloat((execPrice - slDist * tpRR).toFixed(6));

  // ── Lot calculation with broker volume constraints ────────────
  // Sizing base: RISK_EQUITY env override (lets a small demo size like a 50k account)
  // or live equity. Risk can be boosted per firm+ticker+hour via getRiskMult (default 1.0).
  const SIZING_EQUITY = safeNum(process.env.RISK_EQUITY) ?? latestEquity;
  const riskMult = getRiskMult(symbol, new Date());
  const riskEur = parseFloat((SIZING_EQUITY * DEFAULT_RISK_PCT * riskMult).toFixed(2));
  const lotNom  = slDist > 0 ? riskEur / slDist : 0.01;
  const lotRaw  = symInfo.type === "index"
    ? parseFloat(lotNom.toFixed(2))
    : parseFloat((lotNom / 100).toFixed(2));
  const lots    = roundLots(lotRaw, symInfo);

  const dateStr    = getBrusselsDateStr();
  const dailyCount = await db.getNextDailyCount(dateStr).catch(() => 1);
  const dailyLabel = buildDailyLabel(null, dailyCount);

  const sessMap = { ny: "NY", london: "LD", asia: "AS" };
  const vwapMap = { above: "ABV", below: "BLW", unknown: "UNK" };
  const mt5Comment = `${symbol.slice(0, 6)} ${direction === "buy" ? "B" : "S"}-${sessMap[session] ?? "NY"}-${vwapMap[vwapPos] ?? "UNK"} ${dailyLabel}`;

  console.log(`[Webhook] ${symbol} ${direction.toUpperCase()} | exec=${execPrice} slDist=${slDist.toFixed(4)} (${(slPct * 100).toFixed(3)}%×${SL_BUFFER_MULT}) | lots=${lots} riskEur=${riskEur} | ${dailyLabel}`);

  // ── Place order ───────────────────────────────────────────────
  let positionId;
  try {
    const r = await placeOrder({
      symbol: symInfo.mt5,
      actionType: direction === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
      volume: lots,
      stopLoss: slPrice,
      takeProfit: tpPrice,
      comment: mt5Comment,
    });
    positionId = r?.positionId ?? r?.orderId ?? null;

    if (!positionId) {
      const placeTime = Date.now();
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise(res => setTimeout(res, 2000));
        const liveNow = await getPositions();
        const match   = liveNow.find(lp => {
          const lpDir = (lp.type || "").includes("BUY") ? "buy" : "sell";
          const ot    = lp.time ? new Date(lp.time).getTime() : 0;
          return lp.symbol === symInfo.mt5 && lpDir === direction && ot >= placeTime - 30000 && !openPositions.has(String(lp.id));
        });
        if (match) { positionId = String(match.id); break; }
      }
    }
    if (!positionId) {
      console.warn(`[Webhook] ORDER_NOT_CONFIRMED: ${symbol} ${direction} session=${session} circuitOpen=${_circuitOpen}`);
      await db.logSignal({ dailyLabel: null, symbol, assetType: symInfo.type, direction, session, vwapPosition: vwapPos, optimizerKey: optKey, tvEntry, slPct, vwapMid, vwapBandPct, ...wh, outcome: "ORDER_NOT_CONFIRMED", rejectReason: "No positionId from MetaAPI", latencyMs: Date.now() - t0 });
      await db.markInboxProcessed(_inboxId, "ORDER_NOT_CONFIRMED").catch(() => {});
      return res.status(202).json({ ok: false, reason: "ORDER_NOT_CONFIRMED" });
    }
  } catch (e) {
    console.error(`[Webhook] placeOrder error: ${e.message}`);
    await db.logSignal({ symbol, assetType: symInfo.type, direction, session, vwapPosition: vwapPos, optimizerKey: optKey, tvEntry, slPct, vwapMid, vwapBandPct, ...wh, outcome: "ERROR", rejectReason: e.message, latencyMs: Date.now() - t0 });
    await db.markInboxProcessed(_inboxId, "ERROR", null, e.message).catch(() => {});
    return res.status(500).json({ error: e.message });
  }

  // ── Build position + ghost ────────────────────────────────────
  const pos = {
    positionId, dailyLabel, symbol, assetType: symInfo.type,
    direction, session, vwapPosition: vwapPos, optimizerKey: optKey,
    entry: execPrice, sl: slPrice, tp: tpPrice, lots, tpRR,
    riskPct: DEFAULT_RISK_PCT, riskEur, slPct, slDist,
    tvEntry, executionPrice: execPrice, slippage,
    vwapMid, vwapBandPct, ...wh,
    mt5Comment, openedAt: new Date().toISOString(),
    currentPrice: execPrice, livePnl: 0, mt5Closed: false,
  };
  pos.ghost = initGhost(pos);
  openPositions.set(positionId, pos);

  await db.saveGhostState(pos.ghost);
  await db.logSignal({ dailyLabel, symbol, assetType: symInfo.type, direction, session, vwapPosition: vwapPos, optimizerKey: optKey, tvEntry, slPct, vwapMid, vwapBandPct, ...wh, outcome: "PLACED", latencyMs: Date.now() - t0, positionId });

  console.log(`[Placed] ${positionId} ${symbol} ${direction} lots=${lots} entry=${execPrice} sl=${slPrice} tp=${tpPrice} ${dailyLabel}`);
  markWebhookPlaced(rawSym||"", direction);
  await db.markInboxProcessed(_inboxId, "PLACED", positionId).catch(() => {});
  if (_modelDecId) db.linkModelDecision(_modelDecId, positionId).catch(() => {});
  res.json({ ok: true, positionId, symbol, direction, lots, entry: execPrice, sl: slPrice, tp: tpPrice, riskEur, dailyLabel, mt5Comment, latencyMs: Date.now() - t0 });
});

// ── API endpoints ─────────────────────────────────────────────────
app.get("/api/open-positions", (req, res) => {
  const out = [];
  for (const [id, pos] of openPositions) {
    const g = pos.ghost;
    out.push({ positionId: id, dailyLabel: pos.dailyLabel, symbol: pos.symbol, assetType: pos.assetType, direction: pos.direction, session: pos.session, vwapPosition: pos.vwapPosition, optimizerKey: pos.optimizerKey, entry: pos.entry, sl: pos.sl, tp: pos.tp, lots: pos.lots, riskEur: pos.riskEur, slPct: pos.slPct, slDist: pos.slDist, tvEntry: pos.tvEntry, vwapMid: pos.vwapMid, vwapUpper: pos.vwapUpper, vwapLower: pos.vwapLower, vwapBandPct: pos.vwapBandPct, sessionHigh: pos.sessionHigh, sessionLow: pos.sessionLow, dayHigh: pos.dayHigh, dayLow: pos.dayLow, mt5Comment: pos.mt5Comment, openedAt: pos.openedAt, currentPrice: pos.currentPrice ?? null, livePnl: pos.livePnl ?? null, mt5Closed: pos.mt5Closed ?? false, ghostFinalized: pos.ghostFinalized ?? false, mt5CloseReason: pos.ghost?.mt5CloseReason ?? null,
      ghost: g ? { maxRR: g.maxRR, currentRR: g.currentRR ?? null, peakRRPos: g.peakRRPos, peakRRNeg: g.peakRRNeg, rrMilestones: msToElapsed(g.rrMilestones, g.openedAt), mt5ClosedTP: g.mt5ClosedTP ?? false, phantomSLHit: g.phantomSLHit, mt5CloseReason: g.mt5CloseReason ?? null, timeToSLMin: g.timeToSLMin ?? null, slHitAt: g.slHitAt ?? null } : null,
    });
  }
  res.json(out);
});

app.get("/api/closed-trades", async (req, res) => { if (!dbReady) return res.json([]); res.json(await db.loadClosedTrades(parseInt(req.query.limit) || 200)); });
app.get("/api/signal-log", async (req, res) => { if (!dbReady) return res.json([]); res.json(await db.loadSignalLog(parseInt(req.query.limit) || 200)); });
app.get("/api/ghost-active", (req, res) => { res.redirect("/api/open-positions"); });
app.get("/api/ghost-history", async (req, res) => { if (!dbReady) return res.json([]); res.json(await db.loadGhostTrades(req.query.from ?? null, req.query.to ?? null, parseInt(req.query.limit) || 300)); });
app.get("/api/equity-curve", async (req, res) => { if (!dbReady) return res.json([]); res.json(await db.loadEquityCurve(200)); });
app.get("/api/performance", async (req, res) => {
  if (!dbReady) return res.json({});
  const trades = await db.loadClosedTrades(500);
  const tp  = trades.filter(t => t.closeReason === "tp").length;
  const sl  = trades.filter(t => t.closeReason === "sl").length;
  const wr  = trades.length ? (tp / trades.length * 100).toFixed(1) : "0.0";
  const peakAvg = trades.length ? (trades.reduce((s, t) => s + (t.peakRRPos || 0), 0) / trades.length).toFixed(2) : "0.00";
  res.json({ total: trades.length, tp, sl, winRate: parseFloat(wr), avgPeakRR: parseFloat(peakAvg), balance: latestEquity, currency: latestCurrency });
});
app.get("/api/performance-by-key", async (req, res) => { if (!dbReady) return res.json([]); res.json(await db.loadPerformanceByKey()); });

// ── v3.1 read-only endpoints ──────────────────────────────────────
app.get("/api/hwm", async (req, res) => {
  if (!dbReady) return res.json({});
  res.json({ today: await db.loadHwmDaily(getBrusselsDateStr()), allTime: await db.loadHwmAlltime() });
});
app.get("/api/firm-limits", (req, res) => { res.json({ firm: FIRM, limits: FIRM_LIMITS }); });
app.get("/api/model-decisions", async (req, res) => { if (!dbReady) return res.json([]); res.json(await db.loadModelDecisions(parseInt(req.query.limit) || 200)); });
app.get("/api/data-health", async (req, res) => { if (!dbReady) return res.json([]); res.json(await db.loadDataHealth(parseInt(req.query.limit) || 30)); });
app.post("/api/data-health/run", async (req, res) => { if (!checkSecret(req, res)) return; res.json(await db.computeDataHealth() ?? {}); });
app.get("/api/inbox-unprocessed", async (req, res) => { if (!dbReady) return res.json([]); res.json(await db.loadUnprocessedInbox(parseInt(req.query.limit) || 50)); });

app.get("/api/db-inspect", async (req, res) => {
  if (!db.DB_ENABLED) return res.json({ dbEnabled: false, message: "Running without a database", openPositionsInMemory: openPositions.size });
  try {
    const tables = await db.pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
    const counts = {};
    for (const t of tables.rows) { try { const r = await db.pool.query(`SELECT COUNT(*) AS n FROM "${t.tablename}"`); counts[t.tablename] = parseInt(r.rows[0].n); } catch { counts[t.tablename] = -1; } }
    res.json({ tables: counts, openPositionsInMemory: openPositions.size });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/force-sync", async (req, res) => { if (!checkSecret(req, res)) return; await syncPositions(); res.json({ ok: true, openPositions: openPositions.size }); });
app.post("/api/recover", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const live = await getPositions();
  let adopted = 0;
  for (const lp of live) { if (!openPositions.has(String(lp.id))) { await adoptPosition(lp); adopted++; } }
  res.json({ ok: true, adopted, total: openPositions.size });
});

// ── Dashboard HTML ────────────────────────────────────────────────
function dashboardHTML() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PRONTO·AI v${VERSION} | ${BROKER.toUpperCase()}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#0d1117;color:#e6edf3;font-size:12px}.hdr{background:#161b22;border-bottom:1px solid rgba(139,148,158,.15);padding:6px 14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;position:sticky;top:0;z-index:100}.brand{font-size:13px;font-weight:700}.brand span{color:#bc8cff}.hkv{font-size:10px;color:#8b949e;white-space:nowrap}.hkv b{color:#e6edf3}.hkv.cg b{color:#3fb950}.hkv.cr b{color:#f85149}.hkv.cb b{color:#388bfd}.hkv.cp b{color:#bc8cff}.hstat{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:10px}.dot-g{width:7px;height:7px;border-radius:50%;background:#3fb950;display:inline-block;animation:blink 2s infinite}.dot-r{width:7px;height:7px;border-radius:50%;background:#f85149;display:inline-block}@keyframes blink{0%,100%{opacity:1}50%{opacity:.4}}.nav{background:#161b22;border-bottom:1px solid rgba(139,148,158,.15);display:flex;padding:0 14px;overflow-x:auto}.ntab{padding:9px 14px;font-size:11px;color:#8b949e;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}.ntab:hover{color:#e6edf3}.ntab.on{color:#3fb950;border-bottom-color:#3fb950;font-weight:600}.pg{display:none;padding:12px 14px}.pg.on{display:block}.card{background:#161b22;border:1px solid rgba(139,148,158,.15);border-radius:6px;margin-bottom:10px;overflow:hidden}.chdr{padding:7px 10px;border-bottom:1px solid rgba(139,148,158,.1);display:flex;align-items:center;gap:8px;flex-wrap:wrap}.ctitle{font-size:11px;font-weight:600;color:#e6edf3;display:flex;align-items:center;gap:6px}.dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}.dot.g{background:#3fb950}.dot.r{background:#f85149}.dot.b{background:#388bfd}.cm{margin-left:auto;font-size:9px;color:#6e7681}.tw{width:100%;overflow-x:auto}table{border-collapse:collapse;width:100%}th{text-align:left;font-size:9px;font-weight:500;color:#6e7681;padding:4px 5px;border-bottom:1px solid rgba(139,148,158,.15);white-space:nowrap;background:#161b22}td{padding:4px 5px;border-bottom:1px solid rgba(139,148,158,.08);font-size:10px;vertical-align:middle;white-space:nowrap}tr:hover td{background:rgba(139,148,158,.04)}.nd{text-align:center;color:#6e7681;padding:20px;font-size:11px}.bd{display:inline-flex;align-items:center;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700;white-space:nowrap}.bd-buy{background:rgba(63,185,80,.15);color:#3fb950;border:1px solid rgba(63,185,80,.3)}.bd-sell{background:rgba(248,81,73,.15);color:#f85149;border:1px solid rgba(248,81,73,.3)}.bd-ab{background:rgba(63,185,80,.1);color:#3fb950}.bd-bw{background:rgba(248,81,73,.1);color:#f85149}.bd-idx{background:rgba(57,211,242,.15);color:#39d3f2;border:1px solid rgba(57,211,242,.3)}.bd-com{background:rgba(188,140,255,.15);color:#bc8cff;border:1px solid rgba(188,140,255,.3)}.bd-placed{background:rgba(63,185,80,.15);color:#3fb950;border:1px solid rgba(63,185,80,.3)}.bd-nopos{background:rgba(248,81,73,.15);color:#f85149;border:1px solid rgba(248,81,73,.3)}.bd-err{background:rgba(248,81,73,.3);color:#ff4444;border:1px solid #f85149;font-weight:700}.bd-live{background:rgba(63,185,80,.12);color:#3fb950;border:1px solid rgba(63,185,80,.25);padding:2px 7px;font-size:9px;font-weight:700}.bd-k{background:rgba(139,148,158,.1);color:#e6edf3;border:1px solid rgba(139,148,158,.25);font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;display:inline-flex}.kst{display:grid;gap:6px;padding:8px 10px}.ks{background:#0d1117;border-radius:4px;padding:6px 10px;border:1px solid rgba(139,148,158,.1)}.ksl{font-size:9px;color:#8b949e;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px}.ksv{font-size:16px;font-weight:700;color:#e6edf3}.cg{color:#3fb950}.cr{color:#f85149}.cb{color:#388bfd}.cp{color:#bc8cff}.cy{color:#d29922}.cd{color:#8b949e}.cw{color:#e6edf3}.fw{font-weight:700}.segs{display:flex;background:#0d1117;border:1px solid rgba(139,148,158,.2);border-radius:4px;overflow:hidden;margin-left:auto}.seg{padding:3px 10px;background:none;border:none;color:#6e7681;cursor:pointer;font-size:10px}.seg.on{background:#21262d;color:#e6edf3}#gh-tbl th{position:sticky;top:0;z-index:3;background:#161b22}#gh-tbl td:nth-child(-n+3),#gh-tbl th:nth-child(-n+3){position:sticky;background:#161b22;z-index:2}#gh-tbl th:nth-child(-n+3){z-index:4}#gh-tbl td:nth-child(1),#gh-tbl th:nth-child(1){left:0}#gh-tbl td:nth-child(2),#gh-tbl th:nth-child(2){left:74px}#gh-tbl td:nth-child(3),#gh-tbl th:nth-child(3){left:136px}#gh-tbl td{text-align:center}#gh-tbl td:nth-child(-n+6){text-align:left}#gh-tbl tr:hover td{background:rgba(139,148,158,.06)}::-webkit-scrollbar{width:4px;height:4px}::-webkit-scrollbar-track{background:#0d1117}::-webkit-scrollbar-thumb{background:#30363d;border-radius:2px}</style>
</head><body>
<div class="hdr">
  <div class="brand">PRONTO<span>·</span>AI <span style="font-size:10px;color:#6e7681;font-weight:400">v${VERSION} | ${BROKER.toUpperCase()}</span></div>
  <div class="hkv">Balance <b id="h-bal">--</b></div>
  <div class="hkv cg">Equity <b id="h-eq">--</b></div>
  <div class="hkv cb">Open <b id="h-open">--</b></div>
  <div class="hkv cp">Ghost <b id="h-ghost">--</b></div>
  <div class="hkv" id="h-db">DB init...</div>
  <div class="hstat"><span id="h-sess-dot" class="dot-g"></span><span id="h-sess" style="font-size:10px;color:#8b949e">--</span><span id="h-time" style="font-size:10px;color:#6e7681;margin-left:4px">--</span></div>
</div>
<div class="nav">
  <div class="ntab on" onclick="go('ov',this)">Overview</div>
  <div class="ntab" onclick="go('sig',this)">Signals <span style="background:rgba(139,148,158,.15);color:#8b949e;border-radius:8px;padding:1px 5px;font-size:9px" id="nb-sig">0</span></div>
  <div class="ntab" onclick="go('gh',this)">Ghost Tracker <span style="background:rgba(188,140,255,.15);color:#bc8cff;border-radius:8px;padding:1px 5px;font-size:9px" id="nb-gh">0</span></div>
  <div class="ntab" onclick="go('perf',this)">Performance</div>
  <div class="ntab" onclick="go('hwm',this)">HWM</div>
  <div class="ntab" onclick="go('model',this)">Model <span style="background:rgba(188,140,255,.15);color:#bc8cff;border-radius:8px;padding:1px 5px;font-size:9px" id="nb-model">0</span></div>
  <div class="ntab" onclick="go('health',this)">Health <span id="nb-health" style="width:7px;height:7px;border-radius:50%;background:#6e7681;display:inline-block;margin-left:2px"></span></div>
</div>
<div style="padding:12px 14px">
<div class="pg on" id="p-ov">
  <div class="card"><div class="chdr"><div class="ctitle"><div class="dot g"></div>Trades</div><span style="font-size:9px;background:rgba(56,139,253,.1);color:#388bfd;border:1px solid rgba(56,139,253,.25);padding:1px 6px;border-radius:3px;margin-left:8px" id="ov-open-badge">0 open</span><span style="font-size:9px;background:rgba(139,148,158,.1);color:#6e7681;border:1px solid rgba(139,148,158,.2);padding:1px 6px;border-radius:3px" id="ov-closed-badge">0 closed</span></div>
  <div class="tw"><table><thead><tr><th>#</th><th>Symbol</th><th>Type</th><th>Dir</th><th>VWAP</th><th>Session</th><th>Entry</th><th style="color:#f85149">SL</th><th style="color:#3fb950">TP</th><th>Lots</th><th>Opened</th><th>Status</th></tr></thead><tbody id="ov-body"><tr><td colspan="12" class="nd">Loading...</td></tr></tbody></table></div></div>
</div>
<div class="pg" id="p-sig">
  <div class="card"><div class="chdr"><div class="ctitle"><div class="dot b"></div>Signal Log</div>
  <div class="segs"><button class="seg on" onclick="filterSig('all',this)">All</button><button class="seg" onclick="filterSig('placed',this)">Placed</button><button class="seg" onclick="filterSig('errors',this)">Errors</button></div></div>
  <div class="tw"><table><thead><tr><th>Time</th><th>Daily#</th><th>Symbol</th><th>Dir</th><th>Session</th><th>VWAP</th><th>Entry</th><th>SL%</th><th>Outcome</th><th>Latency</th></tr></thead><tbody id="sig-body"><tr><td colspan="10" class="nd">Loading...</td></tr></tbody></table></div></div>
</div>
<div class="pg" id="p-gh">
  <div class="card"><div class="chdr"><div class="ctitle"><div class="dot" style="background:#bc8cff"></div>Ghost Intelligence</div><span class="cm">what price ACTUALLY did after entry — past your TP</span></div>
  <div class="kst" style="grid-template-columns:repeat(6,1fr)" id="gh-kpis"></div>
  <div style="padding:0 10px 8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
    <span class="cd" style="font-size:9px">FILTER</span>
    <select id="f-sym" onchange="loadGh()" style="background:#0d1117;color:#e6edf3;border:1px solid rgba(139,148,158,.25);border-radius:4px;font-size:10px;padding:2px 5px"><option value="">All symbols</option><option>XAUUSD</option><option>US100.cash</option></select>
    <select id="f-sess" onchange="loadGh()" style="background:#0d1117;color:#e6edf3;border:1px solid rgba(139,148,158,.25);border-radius:4px;font-size:10px;padding:2px 5px"><option value="">All sessions</option><option value="asia">Asia</option><option value="london">London</option><option value="ny">New York</option></select>
    <select id="f-dir" onchange="loadGh()" style="background:#0d1117;color:#e6edf3;border:1px solid rgba(139,148,158,.25);border-radius:4px;font-size:10px;padding:2px 5px"><option value="">Both</option><option value="buy">Buy</option><option value="sell">Sell</option></select>
    <select id="f-st" onchange="loadGh()" style="background:#0d1117;color:#e6edf3;border:1px solid rgba(139,148,158,.25);border-radius:4px;font-size:10px;padding:2px 5px"><option value="">All status</option><option value="live">Live</option><option value="ghost">Ghost</option><option value="fin">Finished</option></select>
    <span class="cd" style="font-size:9px;margin-left:auto" id="gh-count"></span>
  </div></div>
  <div class="card"><div class="tw" style="max-height:70vh;overflow:auto"><table id="gh-tbl"><thead id="gh-head"></thead><tbody id="gh-body"><tr><td colspan="12" class="nd">Loading...</td></tr></tbody></table></div>
  <div class="cm" style="padding:6px 10px">Cells = minutes to first reach that R level. <span class="cr">Red</span> = heat against you · <span class="cg">Green</span> = in profit. Brighter = faster.</div></div>
</div>
<div class="pg" id="p-perf">
  <div class="card"><div class="chdr"><div class="ctitle"><div class="dot b"></div>Performance</div></div>
  <div class="kst" style="grid-template-columns:repeat(5,1fr)" id="perf-kpis"></div></div>
</div>
<div class="pg" id="p-hwm">
  <div class="card"><div class="chdr"><div class="ctitle"><div class="dot g"></div>Today <span class="bd-k" id="hwm-date" style="margin-left:4px">--</span></div><span class="cm">peak / trough open P&amp;L · resets daily</span></div>
  <div class="kst" style="grid-template-columns:repeat(4,1fr)" id="hwm-today"><div class="nd" style="grid-column:1/-1">Loading...</div></div></div>
  <div class="card"><div class="chdr"><div class="ctitle"><div class="dot b"></div>All-time peak</div><span class="cm">highest the account has ever reached</span></div>
  <div class="kst" style="grid-template-columns:repeat(4,1fr)" id="hwm-all"></div></div>
  <div class="card"><div class="chdr"><div class="ctitle"><div class="dot" style="background:#d29922"></div>Drawdown limits</div><span class="cm">from session.js FIRM_LIMITS</span></div>
  <div class="tw"><table><thead><tr><th>Firm</th><th>Daily loss %</th><th>Max DD %</th><th>Trailing</th><th>Guard</th></tr></thead><tbody id="hwm-limits"><tr><td colspan="5" class="nd">Loading...</td></tr></tbody></table></div></div>
</div>
<div class="pg" id="p-model">
  <div class="card"><div class="chdr"><div class="ctitle"><div class="dot" style="background:#bc8cff"></div>Model Decisions</div><span class="cm" id="model-mode">mode: --</span></div>
  <div class="tw"><table><thead><tr><th>Time</th><th>Symbol</th><th>Optimizer Key</th><th>Decision</th><th>Score</th><th>Mode</th><th>Actual</th></tr></thead><tbody id="model-body"><tr><td colspan="7" class="nd">Loading...</td></tr></tbody></table></div></div>
</div>
<div class="pg" id="p-health">
  <div class="card"><div class="chdr"><div class="ctitle"><div class="dot g"></div>Data Health</div><span class="cm">daily 06:00 UTC integrity scan</span></div>
  <div class="tw"><table><thead><tr><th>Checked</th><th>Window</th><th>Signals</th><th>Flagged</th><th>Flagged%</th><th>Stuck Ghosts</th><th>Equity Gaps</th><th>Future Rows</th></tr></thead><tbody id="health-body"><tr><td colspan="8" class="nd">Loading...</td></tr></tbody></table></div></div>
</div>
</div>
<script>
'use strict';
const $=id=>document.getElementById(id);
const fmt=(v,d=2)=>v==null||isNaN(v)?'--':Number(v).toFixed(d);
const fmtTs=s=>!s?'--':new Date(s).toLocaleString('nl-BE',{timeZone:'Europe/Brussels',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
function bdDir(d){return d==='buy'?'<span class="bd bd-buy">BUY</span>':'<span class="bd bd-sell">SELL</span>';}
function bdType(t){return t==='commodity'?'<span class="bd bd-com">COM</span>':'<span class="bd bd-idx">IDX</span>';}
function bdVwap(v){return v==='above'?'<span class="bd bd-ab">ABOVE</span>':'<span class="bd bd-bw">BELOW</span>';}
function bdSess(s){const m={ny:'NEW YORK',london:'LONDON',asia:'ASIA'};const c={ny:'#f0883e',london:'#3fb950',asia:'#8b949e'};return '<span style="color:'+(c[s]||'#8b949e')+';font-size:10px;font-weight:500">'+(m[s]||s||'--')+'</span>';}
async function api(u){try{const r=await fetch(u);if(!r.ok)return null;return await r.json();}catch{return null;}}
function tick(){const now=new Date();const t=now.toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit',second:'2-digit'});const h=parseInt(now.toLocaleString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',hour12:false}));const m=now.getMinutes();const isNY=(h>=15&&h<21)||(h===15&&m>=30),isLD=(h>=8&&h<15)||(h===15&&m<30);if($('h-sess'))$('h-sess').textContent=isNY?'NEW YORK':isLD?'LONDON':'ASIA';if($('h-time'))$('h-time').textContent=t;}
setInterval(tick,1000);tick();
function go(pg,el){document.querySelectorAll('.pg').forEach(p=>p.classList.remove('on'));document.querySelectorAll('.ntab').forEach(t=>t.classList.remove('on'));const p=$('p-'+pg);if(p)p.classList.add('on');if(el)el.classList.add('on');if(pg==='ov')loadOv();if(pg==='sig')loadSig();if(pg==='gh')loadGh();if(pg==='perf')loadPerf();if(pg==='hwm')loadHwm();if(pg==='model')loadModel();if(pg==='health')loadHealth();}
async function loadHeader(){const s=await api('/status');if(s){if(s.dbReady&&$('h-db'))$('h-db').textContent='DB ✓';if($('h-open'))$('h-open').textContent=s.openPositions||0;if(s.account){if($('h-bal'))$('h-bal').textContent=Math.round(s.account.balance||0).toLocaleString()+' '+s.account.currency;if($('h-eq'))$('h-eq').textContent=Math.round(s.account.equity||0).toLocaleString()+' '+s.account.currency;}}}
async function loadOv(){const[pos,closed]=await Promise.all([api('/api/open-positions'),api('/api/closed-trades')]);const _p=Array.isArray(pos)?pos:[];const _c=Array.isArray(closed)?closed:[];const open=_p.filter(p=>!p.mt5Closed&&!p.ghostFinalized);if($('ov-open-badge'))$('ov-open-badge').textContent=open.length+' open';if($('ov-closed-badge'))$('ov-closed-badge').textContent=_c.length+' closed';if($('nb-gh'))$('nb-gh').textContent=_p.length;const body=$('ov-body');if(!body)return;const rows=open.map(p=>'<tr><td><span class="bd-k">'+(p.dailyLabel||'--')+'</span></td><td class="cw fw">'+p.symbol+'</td><td>'+bdType(p.assetType)+'</td><td>'+bdDir(p.direction)+'</td><td>'+bdVwap(p.vwapPosition)+'</td><td>'+bdSess(p.session)+'</td><td class="cd">'+fmt(p.entry,p.assetType==='index'?2:4)+'</td><td class="cr">'+fmt(p.sl,p.assetType==='index'?2:4)+'</td><td class="cg">'+fmt(p.tp,p.assetType==='index'?2:4)+'</td><td class="cd">'+fmt(p.lots,2)+'</td><td class="cd" style="font-size:9px">'+fmtTs(p.openedAt)+'</td><td><span class="bd-live">● LIVE</span></td></tr>');if(_c.length)rows.push('<tr><td colspan="12" style="padding:5px 10px;font-size:9px;color:#6e7681;background:rgba(248,81,73,.05);border-top:1px solid rgba(139,148,158,.15)">Closed — '+_c.length+' trades</td></tr>');_c.forEach(t=>{const isTP=t.closeReason==='tp';rows.push('<tr><td><span class="bd-k">'+(t.dailyLabel||'--')+'</span></td><td class="cw fw">'+t.symbol+'</td><td>'+bdType(t.assetType)+'</td><td>'+bdDir(t.direction)+'</td><td>'+bdVwap(t.vwapPosition)+'</td><td>'+bdSess(t.session)+'</td><td class="cd">'+fmt(t.entry,t.assetType==='index'?2:4)+'</td><td class="cr">'+fmt(t.sl,t.assetType==='index'?2:4)+'</td><td class="cg">'+fmt(t.tp,t.assetType==='index'?2:4)+'</td><td class="cd">'+fmt(t.lots,2)+'</td><td class="cd" style="font-size:9px">'+fmtTs(t.closedAt)+'</td><td>'+(isTP?'<span class="bd" style="background:rgba(63,185,80,.2);color:#3fb950;border:1px solid rgba(63,185,80,.4)">TP</span>':'<span class="bd" style="background:rgba(248,81,73,.2);color:#f85149;border:1px solid rgba(248,81,73,.4)">SL</span>')+'</td></tr>');});body.innerHTML=rows.join('')||'<tr><td colspan="12" class="nd">No trades yet</td></tr>';}
let _sigAll=[],_sigFilter='all';
async function loadSig(){_sigAll=await api('/api/signal-log?limit=500')||[];if($('nb-sig'))$('nb-sig').textContent=_sigAll.length;renderSig();}
function filterSig(f,el){_sigFilter=f;document.querySelectorAll('.seg').forEach(b=>b.classList.remove('on'));if(el)el.classList.add('on');renderSig();}
function renderSig(){const data=_sigFilter==='placed'?_sigAll.filter(s=>s.outcome==='PLACED'):_sigFilter==='errors'?_sigAll.filter(s=>['ERROR','ORDER_NOT_CONFIRMED'].includes(s.outcome)):_sigAll;const body=$('sig-body');if(!body)return;if(!data.length){body.innerHTML='<tr><td colspan="10" class="nd">No signals yet</td></tr>';return;}body.innerHTML=data.map(s=>{let ob;if(s.outcome==='PLACED')ob='<span class="bd bd-placed">PLACED</span>';else if(s.outcome==='ERROR')ob='<span class="bd bd-err">ERROR</span>';else if(s.outcome==='ORDER_NOT_CONFIRMED')ob='<span class="bd bd-nopos">No Pos</span>';else ob='<span class="bd" style="background:rgba(240,136,62,.15);color:#f0883e;border:1px solid rgba(240,136,62,.3)">'+s.outcome+'</span>';return'<tr><td class="cd" style="font-size:9px">'+fmtTs(s.receivedAt)+'</td><td class="cw">'+(s.dailyLabel||'—')+'</td><td class="cw fw">'+(s.symbol||'--')+'</td><td>'+bdDir(s.direction)+'</td><td>'+bdSess(s.session)+'</td><td>'+bdVwap(s.vwapPosition||'unknown')+'</td><td class="cd">'+fmt(s.tvEntry,s.assetType==='index'?2:5)+'</td><td class="cd">'+(s.slPct?(s.slPct*100).toFixed(3)+'%':'--')+'</td><td>'+ob+'</td><td class="cd">'+(s.latencyMs!=null?s.latencyMs+'ms':'--')+'</td></tr>';}).join('');}
const RR_NEG=[-1.0,-0.9,-0.8,-0.7,-0.6,-0.5,-0.4,-0.3,-0.2,-0.1];
function ghRows(pos,hist){
  const rows=[];
  const seen=new Set();
  (pos||[]).forEach(p=>{const g=p.ghost||{};seen.add(p.positionId);
    rows.push({st:p.ghostFinalized?'fin':(p.mt5Closed?'ghost':'live'),positionId:p.positionId,dailyLabel:p.dailyLabel,symbol:p.symbol,assetType:p.assetType,mt5Comment:p.mt5Comment,direction:p.direction,session:p.session,vwapPosition:p.vwapPosition,entry:p.entry,sl:p.sl,tp:p.tp,lots:p.lots,tpRR:p.tpRR,rrNow:(g.currentRR!=null?g.currentRR:null),peakPos:g.peakRRPos||0,peakNeg:g.peakRRNeg!=null?-(g.peakRRNeg/100):null,ms:g.rrMilestones||{},live:true,openedAt:p.openedAt});});
  (hist||[]).forEach(h=>{if(seen.has(h.positionId))return;
    rows.push({st:'fin',positionId:h.positionId,dailyLabel:h.dailyLabel,symbol:h.symbol,assetType:h.assetType,mt5Comment:h.mt5Comment,direction:h.direction,session:h.session,vwapPosition:h.vwapPosition,entry:h.entry,sl:h.sl,tp:h.tp,lots:h.lots,tpRR:null,rrNow:null,peakPos:h.peakRRPos||0,peakNeg:h.peakRRNeg!=null?h.peakRRNeg:null,ms:h.rrMilestones||{},live:false,openedAt:h.openedAt,timeToSL:h.timeToSLMin});});
  return rows;
}
function cellMin(v){if(v==null)return'';const n=Number(v);if(!isFinite(n))return'';return n>=60?(Math.floor(n/60)+'h'+String(Math.round(n%60)).padStart(2,'0')):(Math.round(n)+'m');}
async function loadGh(){
  const [pos,hist]=await Promise.all([api('/api/open-positions'),api('/api/ghost-history?limit=300')]);
  let rows=ghRows(pos,hist);
  const fS=$('f-sym')?$('f-sym').value:'',fSe=$('f-sess')?$('f-sess').value:'',fD=$('f-dir')?$('f-dir').value:'',fSt=$('f-st')?$('f-st').value:'';
  if(fS) rows=rows.filter(r=>r.symbol===fS);
  if(fSe)rows=rows.filter(r=>r.session===fSe);
  if(fD) rows=rows.filter(r=>r.direction===fD);
  if(fSt)rows=rows.filter(r=>r.st===fSt);
  rows.sort((a,b)=>new Date(b.openedAt||0)-new Date(a.openedAt||0));
  if($('gh-count'))$('gh-count').textContent=rows.length+' trades';

  // ---- Ghost Intelligence KPIs ----
  const fin=rows.filter(r=>r.st!=='live'&&r.peakPos!=null);
  const TP=1.5;
  const avgPk=fin.length?fin.reduce((s,r)=>s+(r.peakPos||0),0)/fin.length:0;
  const hit2=fin.length?fin.filter(r=>(r.peakPos||0)>=2.0).length/fin.length*100:0;
  const hitTP=fin.filter(r=>(r.peakPos||0)>=TP);
  const left=hitTP.length?hitTP.reduce((s,r)=>s+((r.peakPos||0)-TP),0)/hitTP.length:0;
  const heats=hitTP.map(r=>r.peakNeg).filter(v=>v!=null&&isFinite(v)).sort((a,b)=>a-b);
  const heatP90=heats.length?heats[Math.floor(heats.length*0.10)]:null;   // 90% of winners stayed above this
  const t15=fin.map(r=>r.ms&&r.ms['+1.5']).filter(v=>v!=null).map(Number).sort((a,b)=>a-b);
  const medT=t15.length?t15[Math.floor(t15.length/2)]:null;
  if($('gh-kpis'))$('gh-kpis').innerHTML=_ks([
    ['Avg Peak+',fin.length?'+'+avgPk.toFixed(2)+'R':'--',avgPk>=TP?'cg':'cy'],
    ['Reached 2R',fin.length?hit2.toFixed(0)+'%':'--','cb'],
    ['Left on table',hitTP.length?'+'+left.toFixed(2)+'R':'--',left>0.3?'cy':'cd'],
    ['Worst heat (winners)',heatP90!=null?heatP90.toFixed(2)+'R':'--','cr'],
    ['Median time to 1.5R',medT!=null?cellMin(medT):'--','cw'],
    ['Sample',fin.length,fin.length>=30?'cg':'cd'],
  ]);

  // ---- dynamic positive columns: go as far as the data actually went ----
  let maxPos=1.5;
  rows.forEach(r=>Object.keys(r.ms||{}).forEach(k=>{if(k[0]==='+'){const v=parseFloat(k.slice(1));if(v>maxPos)maxPos=v;}}));
  maxPos=Math.min(maxPos,6.0);
  const RR_POS=[];for(let v=0.1;v<=maxPos+1e-9;v=Math.round((v+0.1)*10)/10)RR_POS.push(Math.round(v*10)/10);

  const head='<tr><th>Status</th><th>#</th><th>Symbol</th><th>Dir</th><th>VWAP</th><th>Session</th><th>RR Now</th><th>Peak+</th><th>Peak&minus;</th><th>Left</th><th>TP</th>'
    +RR_NEG.map(v=>'<th style="color:#f85149">'+v.toFixed(1)+'</th>').join('')
    +RR_POS.map(v=>'<th style="color:#3fb950">+'+v.toFixed(1)+'</th>').join('')+'</tr>';
  if($('gh-head'))$('gh-head').innerHTML=head;

  const body=$('gh-body');if(!body)return;
  if(!rows.length){body.innerHTML='<tr><td colspan="12" class="nd">No ghost trades yet — they appear once a signal is placed</td></tr>';return;}
  body.innerHTML=rows.map(r=>{
    const sb=r.st==='fin'?'<span class="bd" style="background:rgba(139,148,158,.15);color:#e6edf3;border:1px solid rgba(139,148,158,.4)">FINISHED</span>'
           :r.st==='ghost'?'<span class="bd" style="background:rgba(188,140,255,.15);color:#bc8cff;border:1px solid rgba(188,140,255,.3)">GHOST</span>'
           :'<span class="bd bd-live">&#9679; LIVE</span>';
    const pk=r.peakPos||0;
    const lft=pk>TP?pk-TP:0;
    const cells=(arr,neg)=>arr.map(v=>{
      const key=(neg?'-':'+')+Math.abs(v).toFixed(1);
      const m=r.ms?r.ms[key]:null;
      if(m==null)return'<td style="color:#21262d">·</td>';
      const mins=Number(m);
      const fast=mins<15?1:mins<60?0.72:mins<180?0.5:0.34;
      const col=neg?'248,81,73':'63,185,80';
      return'<td style="background:rgba('+col+','+(fast*0.16).toFixed(2)+');color:rgba('+col+','+(0.45+fast*0.55).toFixed(2)+');font-size:9px">'+cellMin(mins)+'</td>';
    }).join('');
    return'<tr><td>'+sb+'</td><td><span class="bd-k">'+(r.dailyLabel||'--')+'</span></td>'
      +'<td class="cw fw">'+(r.symbol||'--')+'</td><td>'+bdDir(r.direction)+'</td>'
      +'<td class="cd" style="font-size:9px">'+(r.vwapPosition||'--').toUpperCase()+'</td><td>'+bdSess(r.session)+'</td>'
      +'<td class="'+((r.rrNow||0)>=0?'cg':'cr')+' fw">'+(r.rrNow!=null?(r.rrNow>=0?'+':'')+Number(r.rrNow).toFixed(2)+'R':'--')+'</td>'
      +'<td class="cg fw">'+(pk>0?'+'+pk.toFixed(2)+'R':'--')+'</td>'
      +'<td class="cr">'+(r.peakNeg!=null?Number(r.peakNeg).toFixed(2)+'R':'--')+'</td>'
      +'<td class="'+(lft>0.3?'cy fw':'cd')+'">'+(lft>0?'+'+lft.toFixed(2)+'R':'--')+'</td>'
      +'<td class="cd">'+fmt(r.tp,r.assetType==='index'?2:4)+'</td>'
      +cells(RR_NEG,true)+cells(RR_POS,false)+'</tr>';
  }).join('');
}
async function loadPerf(){const perf=await api('/api/performance');if(perf&&$('perf-kpis')){const kpis=[['Total',perf.total,'cw'],['TP',perf.tp,'cg'],['SL',perf.sl,'cr'],['Win Rate',(perf.winRate||0).toFixed(1)+'%','cy'],['Balance',perf.balance?Math.round(perf.balance).toLocaleString()+' '+perf.currency:'--','cb']];$('perf-kpis').innerHTML=kpis.map(x=>'<div class="ks"><div class="ksl">'+x[0]+'</div><div class="ksv '+x[2]+'">'+(x[1]!=null?x[1]:'--')+'</div></div>').join('');}}
const _pnl=v=>v==null?'--':(v>=0?'+':'')+Number(v).toFixed(2);
const _pnlc=v=>v==null?'cd':(v>=0?'cg':'cr');
const _ks=arr=>arr.map(x=>'<div class="ks"><div class="ksl">'+x[0]+'</div><div class="ksv '+x[2]+'">'+x[1]+'</div></div>').join('');
async function loadHwm(){const h=await api('/api/hwm')||{};const t=h.today||{},a=h.allTime||{};if($('hwm-date'))$('hwm-date').textContent=t.dateStr||'--';if($('hwm-today'))$('hwm-today').innerHTML=_ks([['Peak Open P&L',_pnl(t.peakOpenPnl),_pnlc(t.peakOpenPnl)],['Trough Open P&L',_pnl(t.troughOpenPnl),_pnlc(t.troughOpenPnl)],['Peak Equity',t.peakEquity!=null?Math.round(t.peakEquity).toLocaleString():'--','cw'],['Start Balance',t.startBalance!=null?Math.round(t.startBalance).toLocaleString():'--','cd']]);if($('hwm-all'))$('hwm-all').innerHTML=_ks([['Peak Equity',a.peakEquity!=null?Math.round(a.peakEquity).toLocaleString():'--','cb'],['Peak Balance',a.peakBalance!=null?Math.round(a.peakBalance).toLocaleString():'--','cw'],['Best Open P&L',_pnl(a.peakOpenPnl),_pnlc(a.peakOpenPnl)],['Achieved',a.achievedAt?fmtTs(a.achievedAt):'--','cd']]);const fl=await api('/api/firm-limits')||{};const lim=fl.limits||{};const body=$('hwm-limits');if(body){const keys=Object.keys(lim);body.innerHTML=keys.length?keys.map(k=>{const L=lim[k]||{};const on=(L.dailyLossPct!=null||L.maxTotalDDPct!=null);const cur=k===fl.firm;return'<tr'+(cur?' style="background:rgba(63,185,80,.05)"':'')+'><td class="cw fw">'+k+(cur?' <span class="cd" style="font-size:9px">(this service)</span>':'')+'</td><td class="cd">'+(L.dailyLossPct!=null?(L.dailyLossPct*100).toFixed(1)+'%':'<span class="cd">not set</span>')+'</td><td class="cd">'+(L.maxTotalDDPct!=null?(L.maxTotalDDPct*100).toFixed(1)+'%':'<span class="cd">not set</span>')+'</td><td class="cd">'+(L.trailing?'yes':'no')+'</td><td>'+(on?'<span class="bd bd-buy">ACTIVE</span>':'<span class="bd" style="background:rgba(210,153,34,.15);color:#d29922;border:1px solid rgba(210,153,34,.3)">TRACK-ONLY</span>')+'</td></tr>';}).join(''):'<tr><td colspan="5" class="nd">No limits configured</td></tr>';}}
async function loadModel(){const d=await api('/api/model-decisions?limit=200')||[];if($('nb-model'))$('nb-model').textContent=d.length;if($('model-mode'))$('model-mode').textContent='mode: '+(d.length?d[0].mode:'--');const body=$('model-body');if(!body)return;if(!d.length){body.innerHTML='<tr><td colspan="7" class="nd">No model decisions yet</td></tr>';return;}body.innerHTML=d.map(m=>{const dec=m.modelDecision==='skip'?'<span class="bd bd-sell">SKIP</span>':'<span class="bd bd-buy">TAKE</span>';let act='<span class="cd">pending</span>';if(m.actualOutcome==='tp')act='<span class="cg fw">TP</span>';else if(m.actualOutcome==='sl')act='<span class="cr fw">SL</span>';else if(m.actualOutcome)act='<span class="cd">'+m.actualOutcome+'</span>';return'<tr><td class="cd" style="font-size:9px">'+fmtTs(m.receivedAt)+'</td><td class="cw fw">'+(m.symbol||'--')+'</td><td class="cd" style="font-size:9px">'+(m.optimizerKey||'--')+'</td><td>'+dec+'</td><td class="cw">'+(m.modelScore!=null?Number(m.modelScore).toFixed(2):'--')+'</td><td><span class="bd-k">'+(m.mode||'--')+'</span></td><td>'+act+'</td></tr>';}).join('');}
async function loadHealth(){const d=await api('/api/data-health?limit=30')||[];const dot=$('nb-health');if(dot&&d.length){const h0=d[0];const bad=(h0.flaggedPct||0)>5||(h0.stuckGhosts||0)>0||(h0.equityGaps||0)>0;dot.style.background=bad?'#f85149':'#3fb950';}const body=$('health-body');if(!body)return;if(!d.length){body.innerHTML='<tr><td colspan="8" class="nd">No scans yet — first runs at 06:00 UTC</td></tr>';return;}body.innerHTML=d.map(h=>{const fp=h.flaggedPct||0,fpc=fp>5?'cr':fp>1?'cy':'cg';const sg=h.stuckGhosts||0,sgc=sg>0?'cr':'cd';const eg=h.equityGaps||0,egc=eg>0?'cy':'cd';const fr=h.futureRows||0,frc=fr>0?'cr':'cd';return'<tr><td class="cd" style="font-size:9px">'+fmtTs(h.checkedAt)+'</td><td class="cd">'+(h.windowHours||24)+'h</td><td class="cw">'+(h.signalsTotal||0)+'</td><td class="cw">'+(h.flaggedTotal||0)+'</td><td class="'+fpc+' fw">'+fp.toFixed(2)+'%</td><td class="'+sgc+'">'+sg+'</td><td class="'+egc+'">'+eg+'</td><td class="'+frc+'">'+fr+'</td></tr>';}).join('');}
loadHeader();loadOv();loadModel();loadHealth();
setInterval(loadHeader,15000);
setInterval(()=>{const a=document.querySelector('.pg.on');if(!a)return;if(a.id==='p-ov')loadOv();if(a.id==='p-gh')loadGh();},5000);
setInterval(()=>{const a=document.querySelector('.pg.on');if(a?.id==='p-sig')loadSig();},30000);
</script></body></html>`;
}

// ── Background init ───────────────────────────────────────────────
async function initBackground() {
  console.log(db.DB_ENABLED ? "[PRONTO-AI] DATABASE_URL is set — persistence enabled" : "[PRONTO-AI] No DATABASE_URL — running in-memory only, no persistence across restarts");
  let retries = 0;
  while (retries < 5) {
    try { await db.initDB(); break; }
    catch (e) { retries++; console.error(`[DB] init failed (${retries}/5): ${e.message}`); if (retries < 5) await new Promise(r => setTimeout(r, 5000 * retries)); else throw e; }
  }

  try {
    const states = await db.loadAllGhostStates();
    for (const g of states) {
      if (!g.positionId || !g.entry || !g.sl) continue;
      const pos = { positionId: g.positionId, dailyLabel: g.dailyLabel, symbol: g.symbol, assetType: g.assetType, direction: g.direction, session: g.session, vwapPosition: g.vwapPosition, optimizerKey: g.optimizerKey, entry: g.entry, sl: g.sl, tp: g.tp, lots: g.lots, riskEur: g.riskEur, slPct: g.slPct, slDist: g.slDist, vwapMid: g.vwapMid, vwapUpper: g.vwapUpper, vwapLower: g.vwapLower, vwapBandPct: g.vwapBandPct, sessionHigh: g.sessionHigh, sessionLow: g.sessionLow, dayHigh: g.dayHigh, dayLow: g.dayLow, tvEntry: g.tvEntry, mt5Comment: g.mt5Comment, openedAt: g.openedAt, mt5Closed: g.mt5ClosedTP ?? false, currentPrice: g.entry, livePnl: 0,
        ghost: { positionId: g.positionId, dailyLabel: g.dailyLabel, optimizerKey: g.optimizerKey, symbol: g.symbol, assetType: g.assetType, direction: g.direction, session: g.session, vwapPosition: g.vwapPosition, entry: g.entry, sl: g.sl, tp: g.tp, lots: g.lots, riskEur: g.riskEur, slPct: g.slPct, slDist: g.slDist, vwapMid: g.vwapMid, vwapUpper: g.vwapUpper, vwapLower: g.vwapLower, vwapBandPct: g.vwapBandPct, sessionHigh: g.sessionHigh, sessionLow: g.sessionLow, dayHigh: g.dayHigh, dayLow: g.dayLow, tvEntry: g.tvEntry, mt5Comment: g.mt5Comment, openedAt: g.openedAt, maxRR: g.maxRR ?? 0, peakRRPos: g.peakRRPos ?? 0, peakRRNeg: g.peakRRNeg ?? 0, currentRR: g.currentRR ?? null, lastPriceAt: g.lastPriceAt ?? null, estimatedCount: g.estimatedCount ?? 0, blackoutMin: g.blackoutMin ?? 0, rrMilestones: g.rrMilestones ?? {}, mt5ClosedTP: g.mt5ClosedTP ?? false, mt5CloseAt: g.mt5CloseAt ?? null, mt5CloseReason: g.mt5CloseReason ?? null, phantomSLHit: g.phantomSLHit ?? false, slHitAt: g.slHitAt ?? null, timeToSLMin: g.timeToSLMin ?? null },
      };
      openPositions.set(g.positionId, pos);
    }
    console.log(`[DB] Restored ${openPositions.size} ghost states`);
  } catch (e) { console.error("[DB] restore failed:", e.message); }

  dbReady = true;
  console.log("[PRONTO-AI] DB ready");

  if (META_API_TOKEN && META_ACCOUNT) {
    try {
      const acct = await Promise.race([
        metaFetch(`/users/current/accounts/${META_ACCOUNT}/account-information`),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000)),
      ]);
      if (acct?.balance !== undefined) {
        latestEquity   = parseFloat(acct.equity ?? acct.balance);
        latestCurrency = acct.currency ?? "USD";
        _acctCache = acct; _acctCacheTs = Date.now();
        console.log(`[MetaAPI] Connected — ${acct.balance} ${acct.currency}`);
        const live = await getPositions();
        for (const lp of live) { if (!openPositions.has(String(lp.id))) await adoptPosition(lp); }
      }
    } catch (e) { console.error(`[MetaAPI] Startup failed: ${e.message}`); _metaFails = 0; _circuitOpen = false; }
  } else {
    console.warn("[MetaAPI] META_API_TOKEN or META_ACCOUNT not set — no MetaAPI connection");
  }

  // 5A: surface signals that were received but never reached a terminal outcome
  // (process died mid-flight). Live positions have already been re-adopted above,
  // so anything still unprocessed is flagged for review — NOT auto re-executed
  // (that needs idempotency, feature #6, to be safe against double orders).
  try {
    const pending = await db.loadUnprocessedInbox(50);
    if (pending.length) {
      console.warn(`[Inbox] ${pending.length} unprocessed signal(s) from a prior crash — review /api/inbox-unprocessed`);
      for (const p of pending) console.warn(`[Inbox]   #${p.id} ${p.symbol ?? "?"} ${p.action ?? "?"} @ ${p.receivedAt}`);
    } else {
      console.log("[Inbox] no unprocessed signals");
    }
  } catch (e) { console.error("[Inbox] boot check failed:", e.message); }

  cron.schedule("*/10 * * * * *", syncPositions);
  cron.schedule("*/5 * * * *", () => { cleanupFinalizedGhosts().catch(e => console.warn("[Reaper]", e.message)); });   // runs even when circuit is OPEN
  cron.schedule("0 6 * * *", () => { db.computeDataHealth().catch(e => console.warn("[DataHealth] cron:", e.message)); }); // 11: daily 06:00 UTC integrity scan
  console.log(`[PRONTO-AI] Cron active — 10s sync | ghost reaper 5min (stale>${GHOST_STALE_MIN}m, maxage>${GHOST_MAX_HOURS}h) | data-health 06:00 UTC`);
}

initBackground().catch(e => { console.error("[FATAL] initBackground:", e.message); });
