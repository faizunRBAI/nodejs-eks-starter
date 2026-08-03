'use strict';

const { Pool } = require('pg');

/**
 * Build the TLS configuration for Postgres connections.
 *
 * DATABASE_SSL env var controls the mode:
 *   "require"  — TLS on, server certificate NOT verified (default for RDS
 *                when no CA bundle is configured)
 *   "verify"   — TLS on, certificate verified against the RDS global bundle
 *                baked into the image at DATABASE_SSL_CA
 *   "disable"  — TLS off (local dev only; never use in production)
 *   (unset)    — same as "require" when DATABASE_URL is set; no TLS otherwise
 *
 * The image bakes the Amazon RDS CA bundle at /app/certs/rds-global-bundle.pem
 * and sets DATABASE_SSL_CA to that path, so DATABASE_SSL=verify works in the
 * cluster without any manual certificate management.
 *
 * @returns {Object|false} pg ssl option
 */
function sslConfig() {
  if (!process.env.DATABASE_URL) return false;

  const mode = (process.env.DATABASE_SSL || 'require').toLowerCase();

  if (mode === 'disable') return false;

  if (mode === 'verify') {
    const fs = require('fs');
    const caPath = process.env.DATABASE_SSL_CA;
    if (caPath) {
      try {
        return { ca: fs.readFileSync(caPath).toString() };
      } catch (_e) {
        // CA file missing — fall back to require-mode rather than crashing.
      }
    }
    return { rejectUnauthorized: true };
  }

  // Default: TLS on, certificate not verified (matches RDS defaults and avoids
  // the "self-signed certificate in chain" error when the CA bundle is absent).
  return { rejectUnauthorized: false };
}

/**
 * Singleton pg Pool.
 *
 * DATABASE_URL is written into the Kubernetes Secret by the configure stage
 * from the terraform `database_url` output. The app never constructs it.
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig(),
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  // Log but do not crash — a transient connection error should not kill the
  // process. The readiness probe will reflect the unhealthy state.
  console.error('[db] idle client error', err.message);
});

/**
 * Execute a single query.
 *
 * @param {string} text   SQL text (parameterised with $1, $2 …)
 * @param {Array}  params Query parameters
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Ping the database — used by the /ready probe.
 *
 * @returns {Promise<void>} Resolves when the connection is healthy.
 */
async function ping() {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}

/**
 * Drain the pool — called on SIGTERM before the process exits.
 *
 * @returns {Promise<void>}
 */
async function end() {
  await pool.end();
}

module.exports = { query, ping, end, sslConfig };
