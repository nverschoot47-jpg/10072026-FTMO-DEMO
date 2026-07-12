// ── model.js ──────────────────────────────────────────────────────
// Feature 10 — the AI decision interface, in shadow form.
//
// This is deliberately a PURE, dependency-free module: given a feature
// object it returns a decision. No DB, no network, no side effects — so it
// is trivial to unit-test and to swap out later for a real model (even a
// Python service behind the MCP layer) without touching server.js.
//
// The CONTRACT is what matters here, not the cleverness:
//   buildFeatures(ctx) -> flat feature object (the exact vector the model sees)
//   scoreSignal(feats) -> { score: 0..1, decision: "take"|"skip", reason }
//
// The current body is a pass-through stub (always "take"). When the real
// model exists you replace ONLY the body of scoreSignal — the plumbing,
// the logging table (model_decisions), and the MODEL_MODE gate all stay.
// ───────────────────────────────────────────────────────────────────

// Assemble the feature vector from a signal's context. Keep this in sync
// with what you want the model to learn from — it is snapshotted verbatim
// into model_decisions.features as JSONB.
function buildFeatures(ctx = {}) {
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  return {
    symbol:        ctx.symbol        ?? null,
    session:       ctx.session       ?? null,
    direction:     ctx.direction     ?? null,
    vwapPosition:  ctx.vwapPosition  ?? null,
    optimizerKey:  ctx.optimizerKey  ?? null,
    vwapBandPct:   ctx.vwapBandPct   ?? null,
    sessionHigh:   ctx.sessionHigh   ?? null,
    sessionLow:    ctx.sessionLow    ?? null,
    dayHigh:       ctx.dayHigh       ?? null,
    dayLow:        ctx.dayLow        ?? null,
    hourUtc:       now.getUTCHours(),
    dowUtc:        now.getUTCDay(),   // 0=Sun
  };
}

// Return a decision for a feature vector.
// STUB: always take. Replace this body with the real model later.
function scoreSignal(_feats) {
  return { score: 1, decision: "take", reason: "stub-passthrough" };
}

module.exports = { buildFeatures, scoreSignal };
