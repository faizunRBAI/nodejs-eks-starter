'use strict';

const express = require('express');
const db = require('./db');

const app = express();
app.use(express.json());

// ── Observability ────────────────────────────────────────────────────────────

/**
 * GET /health
 *
 * Liveness probe — the process is alive and the event loop is not wedged.
 * Never checks downstream dependencies; a failing DB should not restart pods.
 */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

/**
 * GET /ready
 *
 * Readiness probe — the pod should only receive traffic when the database is
 * reachable. Kubernetes removes the pod from the Service endpoints while this
 * returns non-200, so traffic is never sent to a pod that cannot serve it.
 */
app.get('/ready', async (_req, res) => {
  if (!process.env.DATABASE_URL) {
    // No database configured — report ready so stateless deployments work.
    return res.json({ status: 'ok', db: 'not configured' });
  }
  try {
    await db.ping();
    return res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    return res.status(503).json({ status: 'error', db: err.message });
  }
});

/**
 * GET /api/info
 *
 * Version and runtime information — useful for verifying which image is
 * running after a deploy.
 */
app.get('/api/info', (_req, res) => {
  res.json({
    name: 'nodejs-eks-starter',
    version: process.env.npm_package_version || '0.1.0',
    node: process.version,
    uptime: Math.floor(process.uptime()),
    env: process.env.NODE_ENV || 'development',
  });
});

// ── Items resource ───────────────────────────────────────────────────────────
//
// A simple todo-style items table demonstrating full CRUD with Postgres.
// Schema: db/migrations/001_init.sql

/**
 * GET /api/items
 *
 * List all items, newest first.
 */
app.get('/api/items', async (_req, res) => {
  try {
    const result = await db.query(
      'SELECT id, title, done, created_at FROM items ORDER BY created_at DESC',
      [],
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /api/items]', err.message);
    res.status(500).json({ error: 'Failed to list items' });
  }
});

/**
 * POST /api/items
 *
 * Create a new item.
 * Body: { "title": "..." }
 */
app.post('/api/items', async (req, res) => {
  const { title } = req.body || {};
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  try {
    const result = await db.query(
      'INSERT INTO items (title) VALUES ($1) RETURNING id, title, done, created_at',
      [title.trim()],
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[POST /api/items]', err.message);
    return res.status(500).json({ error: 'Failed to create item' });
  }
});

/**
 * GET /api/items/:id
 *
 * Retrieve a single item by id.
 */
app.get('/api/items/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      'SELECT id, title, done, created_at FROM items WHERE id = $1',
      [id],
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Item not found' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('[GET /api/items/:id]', err.message);
    return res.status(500).json({ error: 'Failed to get item' });
  }
});

/**
 * PATCH /api/items/:id
 *
 * Update an item's title and/or done flag.
 * Body: { "title": "...", "done": true|false }
 */
app.patch('/api/items/:id', async (req, res) => {
  const { id } = req.params;
  const { title, done } = req.body || {};

  if (title === undefined && done === undefined) {
    return res.status(400).json({ error: 'Provide title and/or done' });
  }

  try {
    // Build a partial update — only touch the fields the caller provided.
    const fields = [];
    const values = [];
    let idx = 1;
    if (title !== undefined) {
      fields.push(`title = $${idx++}`);
      values.push(title);
    }
    if (done !== undefined) {
      fields.push(`done = $${idx++}`);
      values.push(done);
    }
    values.push(id);
    const result = await db.query(
      `UPDATE items SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, title, done, created_at`,
      values,
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Item not found' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('[PATCH /api/items/:id]', err.message);
    return res.status(500).json({ error: 'Failed to update item' });
  }
});

/**
 * DELETE /api/items/:id
 *
 * Delete an item by id.
 */
app.delete('/api/items/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      'DELETE FROM items WHERE id = $1 RETURNING id',
      [id],
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Item not found' });
    }
    return res.sendStatus(204);
  } catch (err) {
    console.error('[DELETE /api/items/:id]', err.message);
    return res.status(500).json({ error: 'Failed to delete item' });
  }
});

// ── 404 catch-all ────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Error handler ────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
