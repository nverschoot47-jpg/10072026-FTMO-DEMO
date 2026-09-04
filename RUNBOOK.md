# RUNBOOK

## Eerste deploy — volgorde

1. Repo naar GitHub, Railway → deploy from repo
2. PostgreSQL-plugin toevoegen (`DATABASE_URL` komt vanzelf)
3. Variables invullen, **maar zet `TRADING_ENABLED=false`**
4. Bootlog lezen (zie hieronder) — vooral valuta en specs
5. Testwebhook sturen, `/dashboard` controleren
6. Pas daarna `TRADING_ENABLED=true`

## Deploy

```
git push            # Railway bouwt automatisch
```

Bootlog moet tonen:

```
[DB] 001_init.sql toegepast
[MT5] verbonden — FTMO | equity <bedrag> USD
[MT5] rekeningvaluta USD komt overeen
[MT5] contractspecificaties komen overeen met session.js
[Tracker] actief, elke 60s
[PRONTO ORB] firm=ftmo luistert op 3000
```

Staat er iets anders bij die derde of vierde regel, **niet live gaan**.

## Webhook testen zonder TradingView

```bash
curl -X POST "https://<app>.up.railway.app/webhook?secret=<SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"orders":[{
    "action":"buy","symbol":"MGC1!","slot_id":"TEST-0230-20m-x2-met-2R",
    "entry":4437.9,"sl_points":13.5,"tp_points":27.0
  }]}'
```

Met `TRADING_ENABLED=false` wordt alles gelogd en niets verstuurd.

Een tweede test die je echt moet doen — de Nasdaq, want daar zit de basis en de
onzekere contract size:

```bash
curl -X POST "https://<app>.up.railway.app/webhook?secret=<SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"orders":[{
    "action":"sell","symbol":"MNQ1!","slot_id":"TEST-NQ",
    "entry":29470.0,"sl_points":120.0,"tp_points":240.0
  }]}'
```

Kijk in de orderlog naar de regel `lots ... | risk USD ...`. Staat daar niet
ongeveer je `RISK_PER_TRADE`, dan klopt de contract size van `US100.cash` niet.

## Veelvoorkomend

**401** → `secret` in de URL komt niet overeen met `WEBHOOK_SECRET`.

**`geen symboolmapping voor X`** → ticker staat niet in `session.js` →
`FIRMS.ftmo.symbols`. Bij FTMO bestaan alleen `XAUUSD`, `US100.cash`,
`GER40.cash`, `UK100.cash`.

**`geen contractspecificatie voor X`** → symbool staat wél in de mapping maar
niet in `SPECS`. Beide moeten kloppen.

**`basis X% overschrijdt MAX_BASIS_PCT`** → de futures-prijs en de CFD-prijs
liggen te ver uit elkaar. Meestal een verkeerde mapping (een goud-ticker die op
een index landt). Controleer eerst de mapping; verhoog de grens niet zomaar.

**`MAX_RISK_TOTAL bereikt`** → te veel openstaand risico. Verwacht bij
onbeperkte houdtijd. Sluit posities of verhoog de grens — maar reken eerst na
tegen je daily loss limit.

**`[MIN LOT — doel was 150]`** → stop te wijd voor het risicobedrag; minimum lot
genomen en het werkelijke risico ligt hóger. Staat in `orders.risk_amount`.

**Specs wijken af** → broker heeft andere `volMin`/`volStep`/`tickSize` dan
`session.js`. Pas `SPECS` aan; laat het niet staan.

**`ACCOUNT_CCY staat op X maar de rekening luidt in Y`** → meteen corrigeren.
Elke positiegrootte is fout tot je dat doet.

## Handel stoppen

```bash
curl -X POST "https://<app>.up.railway.app/breaker/trip?secret=<SECRET>"
curl -X POST "https://<app>.up.railway.app/breaker/reset?secret=<SECRET>"
```

Of de knoppen in `/dashboard`. De stand staat in Postgres, dus een redeploy zet
hem niet stilletjes weer aan. Sneller alternatief bij paniek:
`TRADING_ENABLED=false` in Railway — dan blijft de logging wel doorlopen.

## Nuttige queries

```sql
-- vandaag geweigerd, met reden
SELECT slot_id, status, reason FROM signals
WHERE trade_date = CURRENT_DATE AND status <> 'accepted';

-- per slot
SELECT * FROM slot_performance;

-- trades waar het minimum lot het risico opdreef
SELECT slot_id, mt5_symbol, risk_amount FROM orders
WHERE risk_amount > 150 * 1.2 ORDER BY risk_amount DESC;

-- slippage tegen stopafstand
SELECT slot_id, AVG(ABS(slippage)) AS slip, AVG(sl_points) AS stop,
       ROUND(100*AVG(ABS(slippage))/NULLIF(AVG(sl_points),0),2) AS pct
FROM orders WHERE fill_price IS NOT NULL GROUP BY slot_id;

-- basisdrift per symbool (klopt de futures->CFD omrekening?)
SELECT mt5_symbol, COUNT(*), ROUND(AVG(basis_pct)*100,3) AS gem_pct
FROM orders WHERE basis_pct IS NOT NULL GROUP BY mt5_symbol;

-- swap tegen winst
SELECT slot_id, SUM(profit) AS winst, SUM(swap) AS swap FROM closes GROUP BY slot_id;
```
