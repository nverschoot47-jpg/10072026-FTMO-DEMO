# PRONTO ORB bridge — TradingView → Railway → MetaApi → MT5

Ontvangt de webhook van `PRONTO_ORB_multislot_live`, zet elke order door naar
MT5 via MetaApi, en logt alles onderweg in Postgres.

**Deze versie draait op FTMO.** De Vantage- en FundedNext-mappings staan er nog
in; je wisselt met de `FIRM`-variabele.

```
TradingView alert  (MGC1! / MNQ1! / GER40 / UK100, één bericht per bar)
        │  POST /webhook?secret=...
        │  {"orders":[ {...}, {...} ]}
        ▼
   server.js   valideren → symbool mappen → dedup → risicoremmen
        │
        ├─ equity ophalen bij MT5
        ├─ lots = risicobedrag ÷ (sl_points × waarde per prijs-eenheid)
        ├─ marktorder met SL en TP, berekend vanaf de ECHTE fill
        ├─ alles wegschrijven: signals / orders (incl. slippage)
        ▼
   tracker.js  poll elke 60s → gesloten posities → closes (winst, R, duur, reden)
```

## Bestanden

| Bestand | Doel |
|---|---|
| `server.js` | webhook, validatie, risicoremmen, order plaatsen, dashboard |
| `session.js` | **de enige plek met instellingen** — symbolen, specs, sizing |
| `broker.js` | MetaApi-verbinding, quotes, orders, historie |
| `guard.js` | circuit breaker + datavaliditeit |
| `tracker.js` | poller die uitkomsten wegschrijft |
| `db.js` | Postgres-laag |
| `migrate.js` | schema los draaien |
| `migrations/*.sql` | tabellen, views, breaker |
| `pine/` | de PineScript die de webhook vult |

## Railway

1. Nieuw project → deploy from GitHub repo
2. **+ New → Database → PostgreSQL** (zet `DATABASE_URL` automatisch)
3. Variables uit `.env.example` invullen
4. Webhook-URL: `https://<app>.up.railway.app/webhook?secret=<WEBHOOK_SECRET>`

Zet in TradingView: alert op `PRONTO ORB · Multi-Slot Live` → **Any alert()
function call** → webhook aan → **berichtveld leeg laten**.

## Symbolen bij FTMO

| TradingView | MT5 (FTMO) |
|---|---|
| `MGC1!` | `XAUUSD` |
| `MNQ1!` | `US100.cash` |
| `GER40` | `GER40.cash` |
| `UK100` | `UK100.cash` |

Meer dan dit staat er niet in Market Watch. Zilver, olie en de vier crypto's uit
de Vantage-opzet bestaan hier (nog) niet — vuurt de PineScript daarop, dan wordt
het signaal geweigerd met `geen symboolmapping` en gelogd. Wil je ze erbij: eerst
in MT5 toevoegen (Symbols → Show All), specs aflezen, dan in `session.js` bij
`FIRMS.ftmo.symbols` **én** bij `SPECS` invullen.

## Vóór de eerste live order: contract sizes controleren

De `SPECS` voor de vier FTMO-symbolen zijn **aannames** (contract size 1, min lot
0.01). Lees ze af — MT5 app: lang drukken op het symbool → *Specificatie* — en
corrigeer wat afwijkt.

Dit is niet optioneel. `broker.verifySpecs()` controleert bij het opstarten
`volMin`, `volMax`, `volStep` en `tickSize` tegen MetaApi en zet verschillen in
de bootlog, maar **contract size kan hij niet controleren** — en juist die bepaalt
je lotgrootte. Zit die er een factor 10 naast, dan staat er 10× te veel of te
weinig op tafel zonder dat er iets alarm slaat.

De vorige versie had precies dat probleem: een handmatig ingetypte
`US100.cash`-spec uit de FundedNext-tijd die ~11× afweek van de berekende waarde.
Die is nu weg; alles loopt door `spec()`.

## Valuta van de rekening

`ACCOUNT_CCY` stuurt élke positiegrootte aan. Staat hij verkeerd, dan zijn alle
lots fout én kloppen de R-multiples in `closes` niet meer.

- Vantage = EUR-rekening
- FTMO = meestal USD — **controleer het** en zet het expliciet

Bij het opstarten vergelijkt de app `ACCOUNT_CCY` met wat MetaApi teruggeeft en
schrijft een fout weg als het niet klopt. Kijk in de bootlog naar:

```
[MT5] verbonden — <broker> | equity <bedrag> USD
[MT5] rekeningvaluta USD komt overeen
```

## Risico

Vast bedrag per trade, in de valuta van de rekening. Geen percentage: bij een
kleine rekening dwingt het minimum lot het percentage toch al vast.

| Variabele | Doet |
|---|---|
| `RISK_PER_TRADE` | bedrag per trade (nu 150) |
| `MAX_OPEN_POSITIONS` | aantal tegelijk open (nu 10) |
| `MAX_RISK_TOTAL` | som van open risico (nu 1500) |

Loopt een van de twee remmen vol, dan wordt het signaal geweigerd en met reden
gelogd. Niets gaat stilletjes verloren. `/health` toont de actuele stand.

**Waarom de remmen hier aan staan en op Vantage uit stonden.** Houdtijd is
onbegrensd — een positie loopt tot SL of TP. Met meerdere symbolen × 48 slots
kunnen er tientallen posities tegelijk openstaan, elk met het volle risicobedrag.
Op je eigen rekening is dat jouw keuze. Op FTMO staat er een daily loss limit op,
en 17 gelijktijdige posities van 150 is een gebroken account voordat je achter het
scherm zit. Reken `MAX_RISK_TOTAL` na tegen je eigen saldo en houd ruim marge.

Let ook op `[MIN LOT]` in de orderlog: als de stop te wijd is voor 150, wordt het
minimum lot genomen en valt het werkelijke risico hóger uit. Dat bedrag staat in
`orders.risk_amount`, dus je kunt achteraf zien welke trades eroverheen gingen.

## Wat het bewust NIET doet

**`sl_points` wordt niet aangepast.** De PineScript rekent de stopafstand al
volledig uit (ORB-afstand × multiplier). Er wordt hier geen buffer overheen
gelegd — dat zou de gemeten strategie veranderen.

**`entry`, `sl` en `tp` uit de payload worden alleen gelogd.** MGC1! en XAUUSD
zijn niet hetzelfde instrument; er zit een basis tussen futures en CFD. Alleen
de *afstanden* zijn overdraagbaar, dus SL en TP worden opnieuw berekend vanaf de
werkelijke MT5-fill. Voor GER40/UK100 is die basis ≈ 0% en gebeurt er feitelijk
niets.

**Houdtijd is onbegrensd.** Een positie loopt tot SL of TP. `expires_at` wordt
gelogd maar niet afgedwongen, tenzij je `ENFORCE_EXPIRY=true` zet.

**De circuit breaker is handmatig.** `guard.js` stopt de handel als je hem omzet
(`POST /breaker/trip` of de knop in het dashboard), en onthoudt dat in Postgres
zodat een herstart hem niet stilletjes weer aanzet. Er zit **geen** automatische
trip op dagverlies in. Op een prop-rekening is dat het volgende dat je wilt
bouwen.

## Eindpunten

| Route | Doel |
|---|---|
| `POST /webhook?secret=` | ontvangt TradingView |
| `GET /health` | verbinding, open posities, gebruikt risico |
| `GET /slots` | per slot: n, winst, win%, gem. R, gem. slippage |
| `GET /dashboard` | volledig overzicht |
| `POST /breaker/trip` · `/breaker/reset` | handel stoppen / hervatten |

## Controles na de eerste dag

1. `/health` — staat `broker: true`?
2. Bootlog — komen de contractspecificaties overeen met `session.js`, en klopt
   de rekeningvaluta? Een afwijkende `tickValue` betekent verkeerde
   positiegroottes.
3. `/slots` — vergelijk `avg_slippage` met je stopafstand. Is slippage een
   noemenswaardig deel van `sl_points`, dan is de live-uitkomst structureel
   slechter dan de backtest.
4. `signals WHERE status <> 'accepted'` — wat werd geweigerd en waarom.

## Swap

Bij open-eind posities telt swap op, en die zit in geen enkele backtest.
`closes.swap` houdt bij wat het werkelijk gekost heeft — vergelijk dat na een
maand met `closes.profit`. FTMO's swaptarieven staan in MT5 onder Specificatie
per symbool; de tabel uit de FundedNext-versie geldt hier niet.
