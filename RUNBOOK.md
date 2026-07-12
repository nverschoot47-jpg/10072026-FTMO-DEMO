# PRONTO-AI v3 — RUNBOOK

Operational guide for deploying and running the unified trading template.
One codebase runs all five firms; behaviour differs only by environment variables.

---

## 1. Deployment model (#14A — one repo, five services)

**Standard:** a single Git repository is deployed as five separate Railway
services. The code is identical on every service. Only environment variables
differ. Never hand-copy files between services — push once, all services build
from the same commit.

```
        one GitHub repo (this template)
                     │
   ┌────────┬────────┼────────┬────────────┐
 ftmo_demo ftmo_eval maven  vantage   fundednext   ← 5 Railway services
   │         │        │        │           │
 own PG    own PG   own PG   own PG      own PG     ← 5 Postgres plugins
```

Rationale: no config drift. A fix deploys everywhere at once. Each firm keeps
an isolated database so one account can never corrupt another's data.

---

## 2. Environment variables per service

| Variable          | ftmo_demo | ftmo_eval | maven | vantage | fundednext |
|-------------------|-----------|-----------|-------|---------|------------|
| `FIRM`            | ftmo_demo | ftmo_eval | maven | vantage | fundednext |
| `META_ACCOUNT`    | ⟨unique⟩  | ⟨unique⟩  | ⟨unique⟩ | ⟨unique⟩ | ⟨unique⟩ |
| `META_API_TOKEN`  | ⟨unique⟩  | ⟨unique⟩  | ⟨unique⟩ | ⟨unique⟩ | ⟨unique⟩ |
| `WEBHOOK_SECRET`  | shared    | shared    | shared | shared  | shared     |
| `DATABASE_URL`    | auto      | auto      | auto   | auto    | auto       |
| `MODEL_MODE`      | shadow    | shadow    | shadow | shadow  | shadow     |
| `RISK_EQUITY`     | optional  | optional  | optional | optional | optional |
| `META_BASE`       | default   | default   | default | default | default    |

`DATABASE_URL` is injected automatically by each service's Postgres plugin.
`WEBHOOK_SECRET` is the same everywhere so one TradingView alert body works on
all services (the secret rides in the `x-webhook-secret` header / `?secret=`).

---

## 3. First deploy (do this once, on ftmo_demo)

1. Create the Railway service from the repo. Add the Postgres plugin.
2. Set env vars (section 2). `FIRM=ftmo_demo`.
3. Deploy. Watch logs for, in order:
   - `[DB] Schema v2.0 ready`
   - `[Migrate] 4 new migration(s) applied` (first boot) / `schema up to date` (later)
   - `[MetaAPI] Connected — <balance> <currency>`
   - `[Inbox] no unprocessed signals`
   - `[PRONTO-AI] Cron active — 10s sync, daily data-health 06:00 UTC`
4. Hit `GET /health` → expect ok. Open `/` for the dashboard.
5. Send a test alert from TradingView (or `curl` the webhook). Confirm:
   - a row in `signal_log` (`GET /api/signal-log`)
   - the order on MT5, with SL and TP attached
   - `GET /api/hwm` returns today + all-time objects
6. Only after ftmo_demo is verified end-to-end, clone to the other four
   services by repeating with the right `FIRM` + MetaAPI pair.

---

## 4. TradingView alerts

Two alerts per firm: one on `MGC1!`, one on `MNQ1!`, both pointing at that
service's `/webhook` URL with the shared secret. The payload contract is frozen
(see the README). No distributor is needed.

---

## 5. Routine operations

- **Dashboard:** `/` — Overview / Signals / Ghost / Performance.
- **New read endpoints (v3.1):**
  - `GET /api/hwm` — today's peak/trough open P&L + all-time equity peak.
  - `GET /api/model-decisions` — shadow model verdicts.
  - `GET /api/data-health` — daily integrity scan rows.
  - `GET /api/inbox-unprocessed` — signals not yet terminal (should be empty).
- **Force a data-health scan now:** `POST /api/data-health/run` (needs secret).
- **Force a position sync:** `POST /api/force-sync` (needs secret).

---

## 6. Rollback

Because every service tracks the same repo:

1. In Railway, open the affected service → Deployments → redeploy the last
   known-good commit. (Do it per service, or all five if the bad change was
   global.)
2. **Migrations do not auto-revert.** They are additive-only (new tables /
   columns), so a code rollback is safe — the older code simply ignores the
   newer columns. Never delete an applied migration file or a `schema_version`
   row.
3. If a migration itself failed, the boot aborts loudly (`[Migrate] FAILED …`).
   Fix the `.sql`, redeploy; only unapplied files run.

---

## 7. Incident checklist

When something looks wrong, work down this list:

1. **Is it up?** `GET /health`. Check Railway logs for the boot sequence in §3.
2. **DB reachable?** Look for `DATABASE_URL not set` or repeated `[DB] init
   failed`. A missing DB downgrades to in-memory (no persistence) — signals
   still execute but nothing is logged.
3. **MetaAPI down?** `[MetaAPI] Startup failed` or circuit-breaker warnings.
   Orders are blocked while the circuit is open; it self-resets after ~30s.
4. **Signals arriving but no orders?** Check `GET /api/signal-log` outcomes:
   `SYMBOL_NOT_ALLOWED` (symbol map), `WEEKEND`, `DUPLICATE`, `MODEL_SKIP`
   (only if `MODEL_MODE=live`), `ORDER_NOT_CONFIRMED` (MetaAPI), `ERROR`.
5. **After a crash / redeploy:** check `[Inbox]` boot line and
   `GET /api/inbox-unprocessed`. Unprocessed rows are signals that arrived but
   never reached a terminal state. **They are NOT auto re-executed** (that
   needs idempotency, feature #6). Live positions are re-adopted automatically;
   reconcile any unprocessed signal by hand against MT5 before clearing it.
6. **Data looks thin/odd?** `GET /api/data-health`. High `flaggedPct`, growing
   `stuckGhosts`, or `equityGaps` point at a collection problem worth fixing
   while the demo is still gathering the training set.

---

## 8. Model gate (feature 10)

- `MODEL_MODE=shadow` (default): the model scores every signal and logs to
  `model_decisions`, but **never blocks**. Safe to run indefinitely.
- `MODEL_MODE=off`: skip scoring entirely.
- `MODEL_MODE=live`: a model `skip` blocks the trade (`MODEL_SKIP`). Do not set
  this until a real model has proven itself in shadow against actual outcomes.
- The model lives in `model.js` as a pure stub (always "take"). Swapping in the
  real model means replacing only the body of `scoreSignal`.

---

## 9. Open items before going fully live

- **Confirm two symbols** in `session.js` (marked ⚠️): Maven Nasdaq
  (`US100.cash` vs `US100`) and Fundednext Nasdaq (`NDX100` + its
  `volMin`/`volStep`). Verify from each MT5 Market Watch when creating that
  firm's service.
- **Fill `FIRM_LIMITS`** in `session.js` with each firm's real daily-loss and
  max-drawdown numbers. The high-water-mark tracker already records the data;
  wiring the block is a one-liner in `canOpenNewTrade` once the limits exist.
- **Rotate `WEBHOOK_SECRET`** if the previously exposed value was ever live.
