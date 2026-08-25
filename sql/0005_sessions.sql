-- 0005_sessions.sql — opaque bearer sessions, the auth seam's storage half.
--
-- A session is GLOBAL infrastructure, not tenant data: resolving "who is this
-- request" necessarily happens BEFORE any tenant context exists, so the lookup
-- runs on the privileged connection (the bare operator door) and `app_user`
-- gets no grant here at all. The table deliberately names its tenant column
-- `active_tenant_id` — it records which tenant the session ACTS AS, it is not
-- a tenant-scoped row, and the catalog-driven coverage suite (which discovers
-- tenant-scoped tables by their `tenant_id` column) is right not to claim it.
--
-- Only a digest of the token is stored. The raw token exists twice: once in
-- the minting response and once in the caller's Authorization header. A read
-- of this table — a backup, a misdirected query — yields nothing replayable.

CREATE TABLE sessions (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_digest      text        NOT NULL UNIQUE,
  user_id           uuid        NOT NULL REFERENCES users (id)   ON DELETE CASCADE,
  active_tenant_id  uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);

-- Fail closed even if a future migration grants broadly by accident.
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON sessions FROM PUBLIC;
