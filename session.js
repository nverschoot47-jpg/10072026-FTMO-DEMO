// ═══════════════════════════════════════════════════════════════════════════
// session.js — alle configuratie op één plek
//
// Hier staat WAT er verhandeld wordt en HOE groot. De rest van de app leest
// alleen uit dit bestand; je hoeft nergens anders te zoeken als een symbool
// verandert of een broker andere contractspecificaties heeft.
//
// v2 — FTMO. Drie dingen veranderd t.o.v. de Vantage-versie:
//   1. FTMO-mapping uitgebreid van 2 naar 4 symbolen (US100/GER40/UK100 .cash)
//   2. ACCOUNT_CCY toegevoegd — tickValues rekenden hard naar EUR om, wat op
//      een USD-rekening elke positie ~16% te groot maakte
//   3. De hardcoded US100.cash-spec (erfenis van FundedNext, ~11x fout) is weg;
//      alles loopt nu door spec()
// ═══════════════════════════════════════════════════════════════════════════

export const FIRM             = process.env.FIRM || 'ftmo';
export const TRADING_ENABLED  = (process.env.TRADING_ENABLED ?? 'true') === 'true';
export const ENFORCE_EXPIRY   = (process.env.ENFORCE_EXPIRY ?? 'false') === 'true';

// ── Valuta van de rekening ────────────────────────────────────────────────
// Dit stuurt ALLE positiegroottes aan. Staat het verkeerd, dan is elke lot
// verkeerd en klopt geen enkele R-multiple in de statistiek.
//
// Vantage = EUR-rekening. FTMO is meestal USD, maar controleer dat in MT5
// (Toolbox -> Handel, of de valuta achter je saldo) en zet het expliciet.
// De bootlog print wat MetaApi zegt: "[MT5] verbonden — <broker> | equity X USD".
// Wijkt dat af van ACCOUNT_CCY, dan waarschuwt de app.
export const ACCOUNT_CCY = (process.env.ACCOUNT_CCY
  || (FIRM === 'vantage' ? 'EUR' : 'USD')).toUpperCase();

// ── Risico: VAST BEDRAG PER TRADE ─────────────────────────────────────────
// Niet een percentage van de equity, maar een vast bedrag in de valuta van de
// rekening (ACCOUNT_CCY). Bij een kleine rekening dwingt de minimale lotgrootte
// het percentage toch al vast, en dan verhult een percentage alleen maar wat je
// werkelijk riskeert.
//
// RISK_EUR blijft als naam bestaan zodat server.js ongewijzigd blijft; lees hem
// als "risicobedrag in rekeningvaluta".
export const RISK_EUR = parseFloat(
  process.env.RISK_PER_TRADE || process.env.RISK_EUR || '150');

// ── Remmen ────────────────────────────────────────────────────────────────
// Op Vantage stonden deze op 0 (= uit). Dat kan daar: het is je eigen geld en
// een slechte dag is een slechte dag.
//
// Op FTMO kan dat niet. Er staat een daily loss limit op de rekening, en met
// onbeperkte houdtijd stapelen posities op. 8 symbolen x 48 slots kan in theorie
// tientallen posities tegelijk openzetten, elk met RISK_EUR aan risico — genoeg
// om de dagbreuk te raken voordat jij achter het scherm zit.
//
// Standaard nu AAN. Reken ze zelf na tegen je eigen accountgrootte:
//   MAX_RISK_TOTAL moet ruim ONDER je daily loss limit blijven.
//   Bij ~49.000 saldo is de 5%-dagbreuk ~2.450; 1.500 laat marge over.
// Op 0 zetten = weer uit, maar doe dat op een prop-rekening niet.
export const MAX_OPEN       = parseInt(process.env.MAX_OPEN_POSITIONS || '10', 10);
export const MAX_RISK_TOTAL = parseFloat(process.env.MAX_RISK_TOTAL
  || process.env.MAX_RISK_EUR_TOTAL || '1500');

/** Het risicobedrag voor deze order. De payload doet er niet meer toe. */
export function resolveRisk() {
  return { eur: RISK_EUR, bron: `RISK_PER_TRADE (${ACCOUNT_CCY})` };
}

export const TRACK_INTERVAL   = parseInt(process.env.TRACK_INTERVAL_SEC  || '60', 10) * 1000;
// Maximaal toegestaan verschil tussen de futures-prijs van TradingView en de
// CFD-prijs van de broker. Klopt de mapping niet (MGC1! -> een Nasdaq-symbool),
// dan is dat verschil enorm en wordt de order geweigerd in plaats van geplaatst.
export const MAX_BASIS_PCT    = parseFloat(process.env.MAX_BASIS_PCT || '5');

// ── Symboolvertaling ───────────────────────────────────────────────────────
// TradingView handelt in futures (MGC1!, MNQ1!), de prop firm in CFD's. De
// prijzen liggen dicht bij elkaar maar zijn niet identiek: er zit een basis
// tussen futures en spot. sl_points en tp_points uit de PineScript zijn
// AFSTANDEN, geen niveaus — die vertalen wél één-op-één. De absolute `entry`,
// `sl` en `tp` uit de payload zijn daarom alleen logging; de echte SL/TP
// worden hier herrekend vanaf de werkelijke MT5-fill.
//
// Symbolen die de PineScript stuurt maar die hieronder NIET staan, worden
// geweigerd met "geen symboolmapping" — gelogd, niet geplaatst. Dat is de
// bedoeling: liever niets dan het verkeerde instrument.
const FIRMS = {
  // ── FTMO — LIVE ──────────────────────────────────────────────────────────
  // Afgelezen uit Market Watch (4 sep 2026). FTMO hangt er een `.cash`-suffix
  // aan bij indices; goud niet. Drie brokers, drie namen voor dezelfde Nasdaq:
  // NAS100 (Vantage), NDX100 (FundedNext), US100.cash (FTMO).
  //
  // LET OP wat hier NIET staat: zilver, olie en de vier crypto's stonden wél in
  // de Vantage-mapping maar niet in jouw FTMO Market Watch. Vuurt de PineScript
  // op die charts, dan worden die signalen geweigerd. Wil je ze meenemen, voeg
  // ze dan eerst in MT5 toe (Symbols -> Show All), lees de specs af, en zet ze
  // hieronder én in SPECS bij.
  ftmo: {
    label: 'FTMO',
    symbols: {
      'MGC1!' : 'XAUUSD',      // Micro Gold   -> futures→CFD, wordt geschaald
      'MNQ1!' : 'US100.cash',  // Micro Nasdaq -> futures→CFD, wordt geschaald
      'GER40' : 'GER40.cash',  // DAX          -> 1-op-1, basis ~0%
      'UK100' : 'UK100.cash',  // FTSE 100     -> 1-op-1, basis ~0%
    },
  },

  // ── Vantage — bewaard, ongewijzigd ───────────────────────────────────────
  vantage: {
    label: 'Vantage',
    symbols: {
      'MGC1!' : 'XAUUSD',   // Micro Gold
      'MNQ1!' : 'NAS100',   // Micro Nasdaq
      'SIL1!' : 'XAGUSD',   // Micro Silver
      'MCL1!' : 'CL-OIL',   // Micro WTI -> future-CFD, kleinste basis
      'BTCUSD': 'BTCUSD',   // 1-op-1, geen futures-omweg
      'ETHUSD': 'ETHUSD',
      'XRPUSD': 'XRPUSD',
      'SOLUSD': 'SOLUSD',
      'GER40' : 'GER40',
      'UK100' : 'UK100',
    },
  },

  // ── FundedNext — historisch, niet meer in gebruik ────────────────────────
  fundednext: {
    label: 'FundedNext',
    symbols: {
      'MGC1!': 'XAUUSD',
      'MNQ1!': 'NDX100',
    },
  },
};

// ── Wisselkoersen ──────────────────────────────────────────────────────────
// Alle tickValues worden hieruit berekend. Dit zijn de enige getallen die je
// moet bijstellen als de koersen ver weglopen. Een paar procent drift is
// onschadelijk; tien procent scheelt tien procent in je positiegrootte.
//
// Uitgedrukt als: hoeveel USD is één eenheid van deze valuta waard.
const USD_PER = {
  USD: 1,
  EUR: parseFloat(process.env.EURUSD || '1.16'),
  GBP: parseFloat(process.env.GBPUSD || '1.33'),
};

/**
 * Contractspecificatie uit de MT5-symboolgegevens.
 *
 * Alle velden zijn AFGELEZEN, niet geraden:
 *   contract  = "Contract grootte"
 *   digits    = "Digits"          -> tickSize = 10^-digits
 *   valuta    = "Winst valuta"
 *   volMin/volMax/volStep = "Minimale/Maximale volume", "Volume stap"
 *
 * tickValue wordt eruit berekend: contract x tickSize, omgerekend naar de
 * valuta van de REKENING. Dat is beter dan losse getallen intypen — bij een
 * koerswijziging pas je één getal aan en schuift alles mee.
 */
function spec({ contract, digits, valuta, volMin, volMax, volStep }) {
  const tickSize = Math.pow(10, -digits);
  const from = USD_PER[valuta];
  const to   = USD_PER[ACCOUNT_CCY];
  if (!from) throw new Error(`onbekende winstvaluta "${valuta}" in spec()`);
  if (!to)   throw new Error(`onbekende ACCOUNT_CCY "${ACCOUNT_CCY}"`);
  const fx = from / to;
  return {
    tickSize,
    tickValue: +(contract * tickSize * fx).toFixed(8),
    volMin, volMax, volStep,
    digits,
    contract, valuta,          // alleen ter controle in /health en de bootlog
  };
}

export const SPECS = {
  // ── FTMO ─────────────────────────────────────────────────────────────────
  // LET OP: contract, volMin, volMax en volStep hieronder zijn AANNAMES totdat
  // je ze hebt afgelezen. Doe dat vóór de eerste live order:
  //   MT5 app -> lang drukken op het symbool -> Specificatie
  //   (of desktop: Market Watch -> rechtermuis -> Specification)
  // en corrigeer wat afwijkt. broker.verifySpecs() controleert volMin/volMax/
  // volStep/tickSize bij het opstarten tegen MetaApi en zet verschillen in de
  // bootlog — maar contract size kan hij NIET controleren, en juist die bepaalt
  // je lotgrootte. Zit die factor er 10x naast, dan staat er 10x te veel of te
  // weinig op tafel zonder dat iets alarm slaat.
  XAUUSD:       spec({ contract:  100, digits: 2, valuta: 'USD', volMin: 0.01, volMax: 100, volStep: 0.01 }),
  'US100.cash': spec({ contract:    1, digits: 2, valuta: 'USD', volMin: 0.01, volMax: 100, volStep: 0.01 }),
  'GER40.cash': spec({ contract:    1, digits: 2, valuta: 'EUR', volMin: 0.01, volMax: 100, volStep: 0.01 }),
  'UK100.cash': spec({ contract:    1, digits: 2, valuta: 'GBP', volMin: 0.01, volMax: 100, volStep: 0.01 }),

  // ── Vantage — afgelezen uit het MT5 symbool-informatiescherm ─────────────
  XAGUSD:   spec({ contract: 5000, digits: 3, valuta: 'USD', volMin: 0.01, volMax:  20, volStep: 0.01 }),
  NAS100:   spec({ contract:    1, digits: 2, valuta: 'USD', volMin: 0.10, volMax: 500, volStep: 0.10 }),
  'CL-OIL': spec({ contract: 1000, digits: 3, valuta: 'USD', volMin: 0.01, volMax:  20, volStep: 0.01 }),
  BTCUSD:   spec({ contract:    1, digits: 2, valuta: 'USD', volMin: 0.01, volMax: 100, volStep: 0.01 }),
  ETHUSD:   spec({ contract:    1, digits: 2, valuta: 'USD', volMin: 0.01, volMax: 100, volStep: 0.01 }),
  XRPUSD:   spec({ contract: 10000, digits: 4, valuta: 'USD', volMin: 0.01, volMax: 100, volStep: 0.01 }),
  SOLUSD:   spec({ contract:   10, digits: 2, valuta: 'USD', volMin: 0.01, volMax: 100, volStep: 0.01 }),
  GER40:    spec({ contract:    1, digits: 2, valuta: 'EUR', volMin: 0.10, volMax: 500, volStep: 0.10 }),
  UK100:    spec({ contract:    1, digits: 2, valuta: 'GBP', volMin: 0.10, volMax: 500, volStep: 0.10 }),

  // ── FundedNext — historisch ──────────────────────────────────────────────
  NDX100:   spec({ contract:    1, digits: 2, valuta: 'USD', volMin: 0.01, volMax:  40, volStep: 0.01 }),
};

/** Alleen de symbolen die deze firm daadwerkelijk gebruikt. De opstartcontrole
 *  liep eerst over ALLE specs heen, inclusief die van een andere firm — vandaar
 *  de "US100.cash niet gevonden" ruis bij FundedNext. */
export function actieveSymbolen() {
  return [...new Set(Object.values(firmConfig().symbols))];
}

export function firmConfig() {
  const f = FIRMS[FIRM];
  if (!f) throw new Error(`Onbekende FIRM "${FIRM}". Bekend: ${Object.keys(FIRMS).join(', ')}`);
  return f;
}

/** TradingView-ticker -> MT5-symbool. Onbekend = null (signaal wordt geweigerd). */
export function mapSymbol(tvSymbol) {
  const f = firmConfig();
  return f.symbols[tvSymbol] || f.symbols[String(tvSymbol).toUpperCase()] || null;
}

/**
 * Waarschuwt als de valuta die de broker teruggeeft niet is wat we hier hebben
 * aangenomen. Wordt aangeroepen vanuit server.js na het verbinden. Dit is de
 * enige plek waar een verkeerde ACCOUNT_CCY nog zichtbaar wordt vóór er geld
 * mee gemoeid is.
 */
export function controleerValuta(brokerCurrency) {
  if (!brokerCurrency) return null;
  if (String(brokerCurrency).toUpperCase() === ACCOUNT_CCY) return null;
  const msg = `ACCOUNT_CCY staat op ${ACCOUNT_CCY} maar de rekening luidt in ` +
              `${brokerCurrency}. Elke positiegrootte is hierdoor fout. ` +
              `Zet ACCOUNT_CCY=${String(brokerCurrency).toUpperCase()} in Railway.`;
  console.error(`[Session] ${msg}`);
  return msg;
}

/**
 * Positiegrootte uit risico en stopafstand.
 *
 *   waarde van 1.0 prijsbeweging per lot = tickValue / tickSize
 *   XAUUSD      : 1.00 / 0.01 = 100 per 1.00 dollar goudbeweging per lot
 *   US100.cash  : 0.01 / 0.01 =   1 per 1.00 indexpunt per lot (bij contract 1)
 *
 * lots = risicobedrag / (stopafstand × waarde per prijsbeweging)
 */
export function calcLots({ symbol, riskEur, slPoints }) {
  const spec = SPECS[symbol];
  if (!spec) return { lots: null, reason: `geen contractspecificatie voor ${symbol}` };
  if (!(slPoints > 0)) return { lots: null, reason: `ongeldige sl_points: ${slPoints}` };

  const valuePerUnit = spec.tickValue / spec.tickSize;   // bedrag per 1.0 prijsbeweging per lot
  const raw          = riskEur / (slPoints * valuePerUnit);

  // Naar beneden afronden op volStep: liever iets minder risico dan iets meer.
  // De +1e-9 vangt drijvende-kommaruis: 0.3 / 0.1 geeft in JavaScript
  // 2.9999999999999996, en dan zou Math.floor er 2 stappen van maken.
  const steps = Math.floor(raw / spec.volStep + 1e-9);
  let   lots  = +(steps * spec.volStep).toFixed(8);

  // ── Stop te wijd voor het risicobedrag ──────────────────────────────────
  // De order wordt niet geweigerd: we nemen het minimum lot en accepteren dat
  // het risico HOGER uitvalt dan RISK_EUR. Bij een brede stop is dit een swing
  // waar je zelf naar kijkt.
  //
  // Het werkelijke risico wordt teruggegeven en weggeschreven, zodat je achteraf
  // kunt zien welke trades boven het bedrag uitkwamen en hoeveel. Zonder die
  // registratie zou een trade van 220 er in de statistiek uitzien als 150, en
  // klopt elke R-multiple niet meer.
  let forced = false;
  if (lots < spec.volMin) {
    lots   = spec.volMin;
    forced = true;
  }
  if (lots > spec.volMax) lots = spec.volMax;

  // Wat er ECHT op het spel staat bij deze lotgrootte.
  const riskAmount = +(lots * slPoints * valuePerUnit).toFixed(2);

  return {
    lots,
    riskAmount,          // werkelijk risico in rekeningvaluta
    riskTarget: riskEur, // wat je vroeg
    forced,              // true = minimum lot afgedwongen, risico is hoger
    valuePerUnit,
    raw,
  };
}

/** Bedrag dat één prijsbeweging waard is — gebruikt om R uit te rekenen bij close. */
export function valuePerUnit(symbol) {
  const spec = SPECS[symbol];
  return spec ? spec.tickValue / spec.tickSize : null;
}

/**
 * Futures -> CFD omrekening.
 *
 * TradingView rekent op MGC1! / MNQ1!, de order gaat naar XAUUSD / US100.cash.
 * Daar zit een basis tussen: bij goud een paar tienden van een procent, bij
 * Nasdaq al snel 1,5–2%. Een stopafstand van 100 futurespunten is op de CFD dus
 * NIET 100 punten — hij is 100/28620 = 0,3494% van de prijs, en dat percentage
 * toegepast op 29100 geeft 101,7 punten.
 *
 * Daarom wordt alles als PERCENTAGE overgezet en pas op de werkelijke MT5-prijs
 * weer in punten omgerekend. De multiplier zit al in sl_points verwerkt door de
 * PineScript; hier wordt alleen geschaald, nooit vermenigvuldigd.
 *
 * Voor GER40.cash en UK100.cash verandert hier feitelijk niets: entry_tv en
 * mt5Ref liggen (op normale slippage na) al bij elkaar, dus ratio ≈ 1 en
 * basisPct ≈ 0%. Geen aparte tak nodig.
 */
export function convertToMt5({ tvEntry, mt5Ref, slPointsTv, tpPointsTv }) {
  const tv = parseFloat(tvEntry);
  if (!(tv > 0) || !(mt5Ref > 0)) {
    // Zonder geldige TV-prijs kunnen we niet schalen; dan maar 1-op-1, en dat
    // wordt zo gelogd zodat het achteraf zichtbaar is.
    return {
      ratio: 1, basis: null, basisPct: null,
      slPct: null, tpPct: null,
      slPointsMt5: slPointsTv, tpPointsMt5: tpPointsTv,
      scaled: false,
    };
  }
  const ratio    = mt5Ref / tv;
  const slPct    = slPointsTv / tv;          // fractie van de prijs
  const tpPct    = tpPointsTv / tv;
  return {
    ratio,
    basis:    +(mt5Ref - tv).toFixed(5),
    basisPct: +(ratio - 1).toFixed(8),
    slPct:    +slPct.toFixed(8),
    tpPct:    +tpPct.toFixed(8),
    slPointsMt5: +(mt5Ref * slPct).toFixed(5),
    tpPointsMt5: +(mt5Ref * tpPct).toFixed(5),
    scaled: true,
  };
}

/** Schaalt een los prijsniveau (ORB-hoog, VWAP, ...) mee naar CFD-schaal. */
export function scaleLevel(level, ratio) {
  const v = parseFloat(level);
  return (v > 0 && ratio > 0) ? +(v * ratio).toFixed(5) : null;
}
