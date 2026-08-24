-- 0001_tenancy_core — tenants, the first tenant-scoped table, and the RLS
-- enforcement layer that makes isolation a proven property.
--
-- The shape every later migration copies:
--   1. table with a NOT NULL tenant_id
--   2. ENABLE + FORCE ROW LEVEL SECURITY  (FORCE is what makes the policy bind
--      even for the role that owns the table)
--   3. a policy keyed to app_current_tenant()
--   4. grants to app_user — which owns nothing and is not a superuser

-- ---------------------------------------------------------------- app_user --
-- The role the application runs as. It owns no tables, so FORCE RLS is not even
-- needed for it — but the tables set FORCE anyway so that the owner is bound
-- too. NOLOGIN: a real deployment grants it to the connecting login role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END
$$;

-- The migrating role must be able to SET ROLE app_user, which is how a request
-- drops its privileges at the start of every transaction.
DO $$
BEGIN
  IF current_user <> 'app_user' AND NOT pg_has_role(current_user, 'app_user', 'MEMBER') THEN
    EXECUTE format('GRANT app_user TO %I', current_user);
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;

-- --------------------------------------------------------- request context --
-- The single source of truth for "which tenant is this transaction acting as".
-- Unset -> NULL -> every policy comparison is NULL -> no rows. Fail closed.
CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql
  STABLE
AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

-- ----------------------------------------------------------------- tenants --
CREATE TABLE tenants (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text        NOT NULL UNIQUE,
  name        text        NOT NULL,
  state       text        NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

-- A tenant may read exactly one row of this table: its own.
CREATE POLICY tenants_self ON tenants
  FOR ALL
  USING (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());

GRANT SELECT ON tenants TO app_user;

-- ---------------------------------------------------------------- projects --
-- The first tenant-scoped resource: enough to demonstrate isolation end to end.
CREATE TABLE projects (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX projects_tenant_id_idx ON projects (tenant_id);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

-- USING gates what is visible to SELECT/UPDATE/DELETE; WITH CHECK gates what
-- INSERT/UPDATE may write. Both are required: without WITH CHECK a tenant could
-- write a row it then could not see.
CREATE POLICY projects_tenant_isolation ON projects
  FOR ALL
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO app_user;
