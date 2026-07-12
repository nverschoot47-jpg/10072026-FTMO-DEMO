# PRONTO-AI v3 — Unified Multi-Firm Trading Template

**One codebase, deployed identically to every firm's Railway service.** The only
difference between services is environment variables. Selected by `FIRM`.

Built on the proven v2.1 engine (MetaAPI REST layer, ghost tracker, clean DB
schema, dashboard) — restructured so all firms share exactly the same files.

---

## 1. How it works

```
TradingView alert (MGC1! / MNQ1!)
        │  POST /webhook   (secret via x-webhook-secret header, or ?secret=)
        ▼
  This service  ──►  normalize symbol ──►  reroute to THIS firm's MT5 symbol
        │                                   (XAUUSD / US100.cash / NAS100 / NDX100)
        │
        ├─ get live MT5 quote → fill at ask/bid, record slippage
        ├─ SL  = sl_pct × 1.5 × exec price   (from the broker's own price)
        ├─ TP  = time-of-day RR window (default 1.5R)
        ├─ lots = risk% of equity ÷ SL distance → volMin/volStep rounded → ×LOT_MULTIPLIER
        ├─ place order on MT5 (MetaAPI)
        ├─ start a GHOST → tracks true excursion (−1R … +20R) even after TP
        └─ log EVERYTHING → this firm's Postgres
```

**FTMO-DEMO** runs in `collect` mode — no filters, ever. It takes every signal
to build years of clean, unbiased data. The other firms feed off that data later.

## 2. The five firms (one `FIRM` value each)

| `FIRM` | Label | Mode | Gold MT5 | Nasdaq MT5 |
|---|---|---|---|---|
| `ftmo_demo` | FTMO-DEMO | **collect** (take everything) | XAUUSD | US100.cash |
| `ftmo_eval` | FTMO-EVAL | live | XAUUSD | US100.cash |
| `maven` | MAVEN | live | XAUUSD | US100.cash ⚠️ |
| `vantage` | VANTAGE | live | XAUUSD | NAS100 |
| `fundednext` | FUNDEDNEXT | live | XAUUSD | NDX100 ⚠️ |

⚠️ **Two values to confirm** (marked `CONFIRM` in `session.js`):
- **Maven Nasdaq** — your list said `US100.cash`, your old v2.1 code said `US100`. Set the right one.
- **Fundednext Nasdaq** — confirm the exact string `NDX100` and its `volMin`/`volStep`.

Both are one-line edits in `session.js` → `FIRMS`.

## 3. Webhook payload (from the new PineScript)

`MGC1!` → gold, `MNQ1!` → nasdaq. Both are aliased internally, so the script
needs no change. Example:

```json
{ "action": "buy", "symbol": "MGC1!", "entry": 4115.9, "sl": 4104.37,
  "sl_pct": 0.002, "sl_points": 11.53, "vwap": 4116.1, "vwap_upper": 4125.9,
  "vwap_lower": 4108.0, "session_high": 4144.8, "session_low": 4100.0,
  "day_high": 4148.8, "day_low": 4066.0 }
```

Note: `entry`/`sl` are *futures* prices (reference/logging only). Execution uses
the broker's live price; SL is recomputed as `sl_pct × 1.5` from that fill.

## 4. Deploy — same repo, every service

1. Push these files to each firm's GitHub repo (identical for all).
2. Add the **Postgres plugin** to each service → `DATABASE_URL` auto-set.
3. Set env vars per service (see `.env.example`). **Only `FIRM`, `META_ACCOUNT`,
   `META_API_TOKEN` differ** — `WEBHOOK_SECRET` is the same everywhere.
4. In TradingView, make **2 alerts per firm** (one `MGC1!`, one `MNQ1!`) pointing
   at that service's `/webhook`, with header `x-webhook-secret: <secret>`.
5. Check `/health`, send a test alert, watch it land in `/` (dashboard).

| Env var | Same on all? | Notes |
|---|---|---|
| `FIRM` | ❌ one per service | ftmo_demo / ftmo_eval / maven / vantage / fundednext |
| `META_ACCOUNT` / `META_API_TOKEN` | ❌ per account | MetaAPI credentials |
| `WEBHOOK_SECRET` | ✅ | same everywhere (your choice) |
| `META_BASE` | usually ✅ | MetaAPI region endpoint |
| `RISK_EQUITY` | optional | fixed sizing base; blank = live equity |
| `DATABASE_URL` | auto | Railway sets it |

## 5. What you can tweak later (all in `session.js`)

- `DEFAULT_RISK_PCT` — currently `0.000375` (0.0375%).
- `SL_BUFFER_MULT` — currently `1.5`.
- `LOT_MULTIPLIER` — single multiplier after lot calc (currently `1.0`).
- `RISK_WINDOWS` — **boost risk per firm + ticker + hour** (empty = flat). The hook you asked for.
- `TP_RR_WINDOWS` — TP reward per ticker per hour.
- `TIME_BLOCK_WINDOWS` — block a ticker in a window (LIVE firms only; DEMO ignores).

## 6. Files

| File | Role |
|---|---|
| `session.js` | **All config** — firms, symbol reroute, risk, TP, time blocks, `FIRM_LIMITS`, `MODEL_MODE` |
| `db.js` | Postgres schema + all DB functions (your proven version) |
| `migrate.js` + `migrations/` | Ordered, run-once schema migrations for v3.1 tables |
| `model.js` | Pure, swappable model interface (shadow gate) |
| `server.js` | Express webhook, MetaAPI, ghost tracker, dashboard, API |
| `package.json` / `nixpacks.toml` / `railway.toml` | Build + deploy |
| `.env.example` | Environment variable template |
| `RUNBOOK.md` | Deploy order, rollback, incident checklist |

## 7. Next (separate build)

- **DATA COLLECTOR** service — aggregates every firm's `signal_log` + `ghost_trades`
  into one place for the AI loop (the MCP servers read from there).
- **The model gate** — the interface now exists in **shadow** (see §8). Once the
  demo has data, swap the real model into `model.js` and flip `MODEL_MODE=live`.

## 8. v3.1 additions

All additive and safe — nothing changes live execution behaviour by default.
See `RUNBOOK.md` for operating them.

- **High-water-mark (1C):** tracks daily peak/trough open P&L (resets each day)
  and all-time equity peak per account → `hwm_daily`, `hwm_alltime`, `GET /api/hwm`.
  Feeds the future drawdown guard.
- **Persist-first inbox (5A):** every signal is written to `signals_inbox` before
  execution and marked processed at every terminal outcome. After a crash,
  unprocessed signals are surfaced on boot (`GET /api/inbox-unprocessed`) — not
  auto re-executed (needs idempotency, #6).
- **Shadow model (10):** `model.js` scores every signal into `model_decisions`;
  `MODEL_MODE=shadow` logs but never blocks. `off` / `live` also supported.
- **Data-quality guards (11):** non-blocking per-row `data_flags` on `signal_log`,
  plus a daily 06:00 UTC integrity scan → `data_health`, `GET /api/data-health`.
- **Migrations (12):** `migrate.js` applies ordered `migrations/*.sql` once each,
  tracked in `schema_version`. The proven 6-table `initDB` is untouched.
- **One-repo/five-services (14A):** documented as the standard in `RUNBOOK.md`.

**Still pending your input:** confirm the two ⚠️ symbols, and fill `FIRM_LIMITS`
in `session.js` with each firm's daily-loss / max-drawdown numbers to activate
the drawdown block (tracking already runs).
