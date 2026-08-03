'use strict';

/**
 * Database migration runner.
 *
 * Applies every .sql file in db/migrations/ in filename order, each one exactly
 * once, each inside its own transaction, recording what ran in a
 * schema_migrations table. Run by the db-migrate Kubernetes Job during the
 * configure stage, before the new Deployment is applied.
 *
 * Three properties matter here, and each one is a failure this avoids:
 *
 *  - **Run-once, not idempotent-by-convention.** Tracking applied files means a
 *    migration can be a plain ALTER TABLE. Re-running every file on every deploy
 *    only works while every author remembers IF NOT EXISTS, and stops working
 *    the first time someone writes a data backfill.
 *  - **One transaction per file.** A migration that fails half way leaves
 *    nothing behind, so the next attempt starts from a known state.
 *  - **An advisory lock.** Two deploys racing would otherwise both try to apply
 *    the same file; the second waits instead.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const { sslConfig } = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
// Any stable value works; it only has to be the same in every deploy.
const LOCK_KEY = 8274461930572001;

async function main() {
  const connectionString = (process.env.DATABASE_URL || '').trim();
  if (!connectionString) {
    console.log('DATABASE_URL is not set — no database in this configuration, nothing to migrate.');
    return;
  }
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.log(`No db/migrations directory at ${MIGRATIONS_DIR} — nothing to migrate.`);
    return;
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  console.log(`Found ${files.length} migration file(s) in db/migrations.`);
  if (files.length === 0) return;

  const client = new Client({
    connectionString,
    ssl: sslConfig(),
    connectionTimeoutMillis: 10000,
    // A migration that runs longer than ten minutes should be run by a human
    // watching it, not by a deploy pipeline.
    statement_timeout: 600000,
  });

  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip   ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`apply  ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        ran += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`${file} failed and was rolled back: ${err.message}`);
      }
    }
    console.log(ran === 0 ? 'Schema already up to date.' : `Applied ${ran} migration(s).`);
  } finally {
    // Releases the advisory lock with the session.
    await client.end();
  }
}

main().catch((err) => {
  console.error(`Migration failed: ${err.message}`);
  process.exitCode = 1;
});
