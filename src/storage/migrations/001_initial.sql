-- Initial schema (idempotent — safe to re-run).
--
-- Inalterability is enforced at TWO layers:
--
--   1. Application role nf525_app has only INSERT and SELECT — no UPDATE, no
--      DELETE. The package always connects as nf525_app, so a bug or compromise
--      of the app process cannot mutate history.
--
--   2. A BEFORE UPDATE/DELETE trigger fires for ALL roles (including superuser)
--      and raises an exception. This is the structural guarantee we present
--      during a DGFIP inspection — even an admin connecting via psql cannot
--      mutate a row. The only way to bypass it is to ALTER TABLE ... DISABLE
--      TRIGGER, which is itself loggable and detectable.
--
-- The chain hash is the THIRD layer of defense: even if an attacker disables
-- triggers, REVOKE-grants, and rewrites a row, verifyChainIntegrity will
-- recompute the hash and detect the divergence.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── Application role ────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nf525_app') THEN
        CREATE ROLE nf525_app NOLOGIN;
    END IF;
END $$;

-- ─── Single discriminated event table ────────────────────────────────
CREATE TABLE IF NOT EXISTS nf525_event (
    id              text PRIMARY KEY,
    workspace_id    text NOT NULL,
    stream          text NOT NULL,
    sequence        bigint NOT NULL,
    previous_hash   text NOT NULL,
    hash            text NOT NULL,
    recorded_at     timestamptz NOT NULL,
    payload         jsonb NOT NULL,
    inserted_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT nf525_event_seq_positive CHECK (sequence > 0),
    CONSTRAINT nf525_event_hash_len CHECK (char_length(hash) = 64),
    CONSTRAINT nf525_event_prev_hash_len CHECK (char_length(previous_hash) = 64),
    CONSTRAINT nf525_event_stream_known CHECK (
        stream IN ('encaissement', 'jet', 'closure-day', 'closure-month', 'closure-year')
    ),
    CONSTRAINT nf525_event_unique_seq UNIQUE (workspace_id, stream, sequence)
);

CREATE INDEX IF NOT EXISTS nf525_event_workspace_stream_recorded_idx
    ON nf525_event (workspace_id, stream, recorded_at);

CREATE INDEX IF NOT EXISTS nf525_event_workspace_stream_seq_idx
    ON nf525_event (workspace_id, stream, sequence);

-- ─── Inalterability trigger ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION nf525_refuse_mutation()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'NF525_INALTERABLE: row in nf525_event cannot be modified (op=%, id=%)',
        TG_OP, COALESCE(OLD.id, NEW.id)
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS nf525_refuse_update ON nf525_event;
CREATE TRIGGER nf525_refuse_update
    BEFORE UPDATE ON nf525_event
    FOR EACH ROW EXECUTE FUNCTION nf525_refuse_mutation();

DROP TRIGGER IF EXISTS nf525_refuse_delete ON nf525_event;
CREATE TRIGGER nf525_refuse_delete
    BEFORE DELETE ON nf525_event
    FOR EACH ROW EXECUTE FUNCTION nf525_refuse_mutation();

DROP TRIGGER IF EXISTS nf525_refuse_truncate ON nf525_event;
CREATE TRIGGER nf525_refuse_truncate
    BEFORE TRUNCATE ON nf525_event
    FOR EACH STATEMENT EXECUTE FUNCTION nf525_refuse_mutation();

-- ─── Grants for nf525_app ────────────────────────────────────────────
-- Defense in depth: even if someone disabled the triggers, the app role
-- still cannot UPDATE/DELETE.
REVOKE ALL ON nf525_event FROM nf525_app;
GRANT SELECT, INSERT ON nf525_event TO nf525_app;

-- ─── Migration metadata ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nf525_migration (
    id            text PRIMARY KEY,
    applied_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO nf525_migration (id) VALUES ('001_initial')
    ON CONFLICT (id) DO NOTHING;
