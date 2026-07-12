// ── migrate.js ────────────────────────────────────────────────────
// Zero-dependency migration runner (#12).
//
// Keeps the proven 6-table initDB() untouched. Every NEW table/column
// (added for high-water-mark, signals_inbox, model_decisions, data-quality)
// lives in an ordered .sql file under ./migrations and is applied exactly
// once, in filename order, each inside its own transaction. A schema_version
// row records what has run so re-deploys are safe and idempotent.
//
// To add a schema change later: drop a new NNN_name.sql in ./migrations.
// It runs automatically on the next boot. Never edit an already-applied file.
// ───────────────────────────────────────────────────────────────────
const fs   = require("fs");
const path = require("path");

async function runMigrations(pool) {
  if (!pool) { console.log("[Migrate] no pool — skipped"); return; }
  const dir = path.join(__dirname, "migrations");
  if (!fs.existsSync(dir)) { console.log("[Migrate] no migrations/ dir — skipped"); return; }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const done  = new Set((await pool.query("SELECT filename FROM schema_version")).rows.map(r => r.filename));
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".sql")).sort();

  let applied = 0;
  for (const f of files) {
    if (done.has(f)) continue;
    const sql    = fs.readFileSync(path.join(dir, f), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_version (filename) VALUES ($1)", [f]);
      await client.query("COMMIT");
      applied++;
      console.log(`[Migrate] applied ${f}`);
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(`[Migrate] FAILED ${f}: ${e.message}`);
      throw e;               // stop the boot — a broken migration must be visible
    } finally {
      client.release();
    }
  }
  console.log(applied ? `[Migrate] ${applied} new migration(s) applied` : "[Migrate] schema up to date");
}

module.exports = { runMigrations };
