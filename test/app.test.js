'use strict';

/**
 * Unit tests for the Express application.
 *
 * The pg pool is mocked so tests run without a real database, making them
 * fast and suitable for the CI test gate.
 */

// Mock the db module BEFORE requiring app so the pool is never created.
jest.mock('../src/db', () => ({
  query: jest.fn(),
  ping: jest.fn(),
  end: jest.fn(),
}));

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');

afterEach(() => {
  jest.clearAllMocks();
});

// ── /health ──────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.ts).toBeDefined();
  });
});

// ── /ready ───────────────────────────────────────────────────────────────────

describe('GET /ready', () => {
  const originalUrl = process.env.DATABASE_URL;

  afterAll(() => {
    if (originalUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalUrl;
    }
  });

  it('returns ok when DATABASE_URL is not set', async () => {
    delete process.env.DATABASE_URL;
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.db).toBe('not configured');
  });

  it('returns ok when the db ping succeeds', async () => {
    process.env.DATABASE_URL = 'postgres://fake/test';
    db.ping.mockResolvedValue();
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('returns 503 when the db ping fails', async () => {
    process.env.DATABASE_URL = 'postgres://fake/test';
    db.ping.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
  });
});

// ── /api/info ────────────────────────────────────────────────────────────────

describe('GET /api/info', () => {
  it('returns the expected shape', async () => {
    const res = await request(app).get('/api/info');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'nodejs-eks-starter',
      node: expect.stringMatching(/^v\d+/),
      uptime: expect.any(Number),
    });
  });
});

// ── /api/items — list ────────────────────────────────────────────────────────

describe('GET /api/items', () => {
  it('returns an array of items', async () => {
    db.query.mockResolvedValue({
      rows: [
        { id: 1, title: 'Buy milk', done: false, created_at: new Date() },
      ],
    });
    const res = await request(app).get('/api/items');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].title).toBe('Buy milk');
  });

  it('returns 500 on a database error', async () => {
    db.query.mockRejectedValue(new Error('DB down'));
    const res = await request(app).get('/api/items');
    expect(res.status).toBe(500);
  });
});

// ── /api/items — create ──────────────────────────────────────────────────────

describe('POST /api/items', () => {
  it('creates an item and returns 201', async () => {
    const row = { id: 2, title: 'Walk the dog', done: false, created_at: new Date() };
    db.query.mockResolvedValue({ rows: [row] });
    const res = await request(app)
      .post('/api/items')
      .send({ title: 'Walk the dog' });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Walk the dog');
  });

  it('returns 400 when title is missing', async () => {
    const res = await request(app).post('/api/items').send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 when title is blank', async () => {
    const res = await request(app).post('/api/items').send({ title: '   ' });
    expect(res.status).toBe(400);
  });
});

// ── /api/items/:id — get ─────────────────────────────────────────────────────

describe('GET /api/items/:id', () => {
  it('returns the item', async () => {
    db.query.mockResolvedValue({
      rows: [{ id: 1, title: 'Buy milk', done: false, created_at: new Date() }],
    });
    const res = await request(app).get('/api/items/1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(1);
  });

  it('returns 404 when the item does not exist', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).get('/api/items/999');
    expect(res.status).toBe(404);
  });
});

// ── /api/items/:id — patch ───────────────────────────────────────────────────

describe('PATCH /api/items/:id', () => {
  it('updates and returns the item', async () => {
    db.query.mockResolvedValue({
      rows: [{ id: 1, title: 'Buy milk', done: true, created_at: new Date() }],
    });
    const res = await request(app)
      .patch('/api/items/1')
      .send({ done: true });
    expect(res.status).toBe(200);
    expect(res.body.done).toBe(true);
  });

  it('returns 400 when no fields are provided', async () => {
    const res = await request(app).patch('/api/items/1').send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 when the item does not exist', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).patch('/api/items/1').send({ done: true });
    expect(res.status).toBe(404);
  });
});

// ── /api/items/:id — delete ──────────────────────────────────────────────────

describe('DELETE /api/items/:id', () => {
  it('returns 204 on success', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 1 }] });
    const res = await request(app).delete('/api/items/1');
    expect(res.status).toBe(204);
  });

  it('returns 404 when the item does not exist', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).delete('/api/items/999');
    expect(res.status).toBe(404);
  });
});

// ── 404 catch-all ────────────────────────────────────────────────────────────

describe('unknown routes', () => {
  it('returns 404', async () => {
    const res = await request(app).get('/not-a-real-route');
    expect(res.status).toBe(404);
  });
});
