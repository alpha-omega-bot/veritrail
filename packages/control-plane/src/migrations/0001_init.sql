-- Veritrail control-plane initial schema (Postgres).
--
-- This is the SaaS-management layer — orgs, users, projects, API keys,
-- sessions, magic-link tokens, usage meters. Lives in a separate schema
-- (`control_plane`) from the ledger to keep concerns clean.

CREATE SCHEMA IF NOT EXISTS control_plane;

SET search_path TO control_plane, public;

CREATE TABLE IF NOT EXISTS organizations (
    id                      TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    slug                    TEXT NOT NULL UNIQUE,
    created_at              BIGINT NOT NULL,
    tier                    TEXT NOT NULL CHECK (tier IN ('free','starter','pro','enterprise')),
    subscription_status     TEXT NOT NULL CHECK (subscription_status IN ('active','trialing','past_due','canceled','incomplete','paused')),
    stripe_customer_id      TEXT,
    stripe_subscription_id  TEXT
);

CREATE TABLE IF NOT EXISTS users (
    id                  TEXT PRIMARY KEY,
    email               TEXT NOT NULL UNIQUE,
    email_verified_at   BIGINT,
    display_name        TEXT,
    created_at          BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
    org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('org:owner','org:admin','org:member','org:billing')),
    created_at  BIGINT NOT NULL,
    PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    created_at  BIGINT NOT NULL,
    UNIQUE (org_id, slug)
);

CREATE TABLE IF NOT EXISTS api_keys (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    prefix         TEXT NOT NULL UNIQUE,
    hash           TEXT NOT NULL,
    label          TEXT NOT NULL DEFAULT '',
    created_at     BIGINT NOT NULL,
    revoked_at     BIGINT,
    last_used_at   BIGINT
);
CREATE INDEX IF NOT EXISTS api_keys_project_idx ON api_keys(project_id);

CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  BIGINT NOT NULL,
    expires_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS magic_links (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  BIGINT NOT NULL,
    expires_at  BIGINT NOT NULL,
    consumed_at BIGINT
);
CREATE INDEX IF NOT EXISTS magic_links_expires_idx ON magic_links(expires_at);

-- Monthly usage meter, one row per (org, project, month).
-- Updated by an hourly flush job; idempotent webhook handlers read it for billing.
CREATE TABLE IF NOT EXISTS usage_meters (
    org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    period_start_ms  BIGINT NOT NULL,
    period_end_ms    BIGINT NOT NULL,
    events_count     BIGINT NOT NULL DEFAULT 0,
    updated_at       BIGINT NOT NULL,
    PRIMARY KEY (org_id, project_id, period_start_ms)
);

-- Stripe webhook event idempotency table.
CREATE TABLE IF NOT EXISTS stripe_event_dedup (
    event_id    TEXT PRIMARY KEY,
    received_at BIGINT NOT NULL
);

-- Outgoing webhooks subscribed by users
CREATE TABLE IF NOT EXISTS webhooks (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    url             TEXT NOT NULL,
    secret          TEXT NOT NULL,
    events_filter   TEXT NOT NULL DEFAULT '*',
    created_at      BIGINT NOT NULL,
    paused_at       BIGINT
);

-- Outbox table consumed by the webhook worker
CREATE TABLE IF NOT EXISTS webhook_outbox (
    id              TEXT PRIMARY KEY,
    webhook_id      TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    payload         JSONB NOT NULL,
    queued_at       BIGINT NOT NULL,
    delivered_at    BIGINT,
    failed_at       BIGINT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at BIGINT
);
CREATE INDEX IF NOT EXISTS webhook_outbox_pending_idx ON webhook_outbox(next_attempt_at)
    WHERE delivered_at IS NULL AND failed_at IS NULL;
