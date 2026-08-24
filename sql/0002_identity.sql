-- 0002_identity — users, memberships, invites and entitlement flags.
--
-- Follows the shape 0001 established: a NOT NULL tenant_id, ENABLE + FORCE ROW
-- LEVEL SECURITY, a policy keyed to app_current_tenant(), grants to app_user.
-- Three things are new here:
--
--   * `users` is GLOBAL — one person can belong to many tenants — so it carries
--     no tenant_id. Its policy keys off "shares a membership with the acting
--     tenant" instead, which is why it is created after `memberships`.
--   * writes to memberships and invites are gated on `app.role`, the second
--     context setting the seam publishes. Reads are not: any member of a tenant
--     may see the roster, only an owner or admin may change it.
--   * tenant_id DEFAULTs to app_current_tenant(), so the data layer never has to
--     name the tenant at all — and NOT NULL turns a tenantless INSERT into an
--     error rather than a silent orphan.

-- ---------------------------------------------------------- request context --
-- The other two settings the seam publishes, read the same fail-closed way as
-- app_current_tenant(): unset -> NULL -> every comparison is NULL -> refused.
CREATE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql
  STABLE
AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE FUNCTION app_current_role() RETURNS text
  LANGUAGE sql
  STABLE
AS $$
  SELECT nullif(current_setting('app.role', true), '')
$$;

-- coalesce() is what makes an unpublished role a refusal instead of a NULL that
-- some future policy might accidentally treat as permissive.
CREATE FUNCTION app_is_admin() RETURNS boolean
  LANGUAGE sql
  STABLE
AS $$
  SELECT coalesce(app_current_role() IN ('owner', 'admin'), false)
$$;

-- ------------------------------------------------------------------- users --
CREATE TABLE users (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text        NOT NULL UNIQUE,
  display_name  text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lowercase CHECK (email = lower(email))
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

GRANT SELECT ON users TO app_user;
-- Policy below, once memberships exists to key it against.

-- ------------------------------------------------------------- memberships --
CREATE TABLE memberships (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL DEFAULT app_current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        text        NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE INDEX memberships_tenant_id_idx ON memberships (tenant_id);
CREATE INDEX memberships_user_id_idx ON memberships (user_id);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

-- Permissive policies OR together, and each statement only consults the
-- policies that apply to it. So SELECT is satisfied by either policy below,
-- while INSERT / UPDATE / DELETE can only be satisfied by the admin-gated one.
CREATE POLICY memberships_read ON memberships
  FOR SELECT
  USING (tenant_id = app_current_tenant());

CREATE POLICY memberships_write ON memberships
  FOR ALL
  USING (tenant_id = app_current_tenant() AND app_is_admin())
  WITH CHECK (tenant_id = app_current_tenant() AND app_is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO app_user;

-- ------------------------------------------------------------ users policy --
-- A tenant may see a person only through a membership it can already see. The
-- subquery is itself RLS-bound, so this cannot become a back door into the
-- global user list.
CREATE POLICY users_shared_membership ON users
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
       WHERE m.user_id = users.id
         AND m.tenant_id = app_current_tenant()
    )
  );

-- ----------------------------------------------------------------- invites --
CREATE TABLE invites (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL DEFAULT app_current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  email       text        NOT NULL,
  role        text        NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  token       text        NOT NULL UNIQUE,
  state       text        NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'revoked')),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invites_email_lowercase CHECK (email = lower(email))
);

CREATE INDEX invites_tenant_id_idx ON invites (tenant_id);

-- At most one live invite per address per tenant — a constraint, not a UI check.
CREATE UNIQUE INDEX invites_one_pending_per_email_idx
  ON invites (tenant_id, email)
  WHERE state = 'pending';

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites FORCE ROW LEVEL SECURITY;

CREATE POLICY invites_read ON invites
  FOR SELECT
  USING (tenant_id = app_current_tenant());

CREATE POLICY invites_write ON invites
  FOR ALL
  USING (tenant_id = app_current_tenant() AND app_is_admin())
  WITH CHECK (tenant_id = app_current_tenant() AND app_is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON invites TO app_user;

-- ------------------------------------------------------------ entitlements --
-- One row per tenant, created by the trigger below so "every tenant has
-- entitlements" is a database property rather than an application habit.
-- Deliberately read-only to tenants: there is no write policy and no write
-- grant, so a tenant owner cannot raise its own seat cap. The operator lane
-- gets that door in a later phase.
CREATE TABLE entitlements (
  tenant_id   uuid        PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  seat_cap    integer     NOT NULL DEFAULT 5 CHECK (seat_cap > 0),
  features    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlements FORCE ROW LEVEL SECURITY;

CREATE POLICY entitlements_read ON entitlements
  FOR SELECT
  USING (tenant_id = app_current_tenant());

GRANT SELECT ON entitlements TO app_user;

-- SECURITY DEFINER because the row belongs to the tenant being created, which
-- by definition is not the tenant the acting transaction is scoped to — the
-- read-only policy above would otherwise refuse the insert.
CREATE FUNCTION tenant_default_entitlements() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO entitlements (tenant_id) VALUES (NEW.id)
    ON CONFLICT (tenant_id) DO NOTHING;
  RETURN NULL;
END
$$;

CREATE TRIGGER tenants_default_entitlements
  AFTER INSERT ON tenants
  FOR EACH ROW
  EXECUTE FUNCTION tenant_default_entitlements();
