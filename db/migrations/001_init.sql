-- Migration 001: initial schema
--
-- Migrations run once each, in filename order, inside a transaction, and are
-- recorded in the schema_migrations table — so this file is never re-applied
-- after it succeeds. Never edit a migration that has already run anywhere:
-- add a new file with the next number instead.

CREATE TABLE IF NOT EXISTS items (
    id         SERIAL      PRIMARY KEY,
    title      TEXT        NOT NULL CHECK (title <> ''),
    done       BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS items_created_at_idx ON items (created_at DESC);
