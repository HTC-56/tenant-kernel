-- 0004_operator — operator identity, time-boxed support access, append-only audit.
--
-- SPEC.md feature 5: "Operator identity is distinct from tenant users. Support
-- access to a tenant is granted with a required reason and a TTL; every
-- operator action lands in an append-only audit table; a tenant can read its
-- own audit trail (RLS-scoped)."
--
-- Phase C left `withOperator()` as a bare privileged connection and recorded
-- the reservation. This file pays it. The shape:
--
--   * `app.operator_id` is a FOURTH context setting, published by the operator
--     door only. `app_current_operator()` reads it the same fail-closed way the
--     other three are read: unset -> NULL -> refused.
--   * `operators` is GLOBAL and carries no tenant_id — an operator is not a
--     tenant user and never appears in `memberships`. A tenant may read an
--     operator row only once that operator has touched it, which is what makes
--     the audit trail name a person rather than a uuid.
--   * `support_grants` is the time box. A reason is a NOT NULL column with a
--     non-blank CHECK, the TTL is `expires_at`, and revocation is a timestamp,
--     not a delete — a revoked grant is history, not an absence.
--   * `audit_log` is append-only by TRIGGER, not by convention. No UPDATE or
--     DELETE grant reaches `app_user`, and a BEFORE trigger refuses both even
--     for the table owner, so the rewrite is impossible rather than merely
--     unprivileged.
--
-- The operator lane is opt-in at this layer: publish `app.operator_id` and the
-- doors below demand an identity, a live grant and an audit row; publish
-- nothing and they behave exactly as Phase C shipped them, which is what a
-- migration and a test fixture are. Making it mandatory belongs to the phase
-- that puts an authenticated operator API in front of these functions.

-- ---------------------------------------------------------- request context --
-- The fourth setting. Deliberately NOT part of RequestContext: a transaction
-- is either a tenant request or an operator action, never both.
CREATE FUNCTION app_current_operator() RETURNS uuid
  LANGUAGE sql
  STABLE
AS $$
  SELECT nullif(current_setting('app.operator_id', true), '')::uuid
$$;

-- --------------------------------------------------------------- operators --
-- Mirrors `users` in shape (global, unique lowercase email) and in nothing
-- else: no membership, no role, no tenant. The two populations never mix.
CREATE TABLE operators (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text        NOT NULL UNIQUE,
  display_name  text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operators_email_lowercase CHECK (email = lower(email))
);

ALTER TABLE operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE operators FORCE ROW LEVEL SECURITY;

GRANT SELECT ON operators TO app_user;
-- Policy below, once audit_log exists to key it against.

-- --------------------------------------------------------- support_grants --
-- The time box. `reason` is NOT NULL with a non-blank CHECK because SPEC.md
-- calls the reason REQUIRED, and a required field that accepts '' is not one.
-- No expiry CHECK against granted_at: a fixture must be able to plant a grant
-- that has already lapsed, and `grant_support_access()` below is where a
-- non-positive TTL is refused.
CREATE TABLE support_grants (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  operator_id  uuid        NOT NULL REFERENCES operators (id),
  reason       text        NOT NULL,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  CONSTRAINT support_grants_reason_present CHECK (btrim(reason) <> '')
);

CREATE INDEX support_grants_tenant_id_idx ON support_grants (tenant_id);
CREATE INDEX support_grants_operator_id_idx ON support_grants (operator_id);

ALTER TABLE support_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_grants FORCE ROW LEVEL SECURITY;

-- Read-only to the tenant it names, and readable even while suspended: the
-- 0003 RESTRICTIVE `app_tenant_active()` gate is deliberately NOT applied here
-- or to audit_log. A tenant that has gone dark is exactly the tenant that most
-- needs to see who is in its account and why.
CREATE POLICY support_grants_read ON support_grants
  FOR SELECT
  USING (tenant_id = app_current_tenant());

GRANT SELECT ON support_grants TO app_user;

-- ---------------------------------------------------------------- audit_log --
-- `reason` is copied onto the row rather than joined from the grant: an audit
-- row records why the action was taken AT THE TIME, which a later edit to the
-- grant must not be able to rewrite. operator_id has no ON DELETE clause, so
-- an operator with history cannot be deleted out from under the trail.
CREATE TABLE audit_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  operator_id  uuid        REFERENCES operators (id),
  action       text        NOT NULL,
  reason       text,
  detail       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_tenant_id_created_at_idx ON audit_log (tenant_id, created_at DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

-- The tenant half of feature 5: SELECT and nothing else. There is no write
-- policy and no write grant, so the only way a row enters this table is one of
-- the SECURITY DEFINER doors below.
CREATE POLICY audit_log_read ON audit_log
  FOR SELECT
  USING (tenant_id = app_current_tenant());

GRANT SELECT ON audit_log TO app_user;

-- Append-only, enforced. SECURITY DEFINER for the same reason enforce_seat_cap()
-- is: the EXISTS below must be the true answer, and FORCE RLS binds the table
-- owner. The one permitted DELETE is the cascade from a tenant that is itself
-- being deleted — the parent row is already gone by the time the cascade fires,
-- which is the same test enforce_last_owner() uses to let a tenant delete.
CREATE FUNCTION audit_log_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = OLD.tenant_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit log is append-only: % refused', TG_OP
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER audit_log_no_rewrite
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_append_only();

-- ------------------------------------------------------------ operators policy --
-- A tenant may see an operator only once that operator has acted on it. The
-- subquery is itself RLS-bound — audit_log_read scopes it to the acting tenant
-- — so this cannot become a back door into the operator directory, exactly the
-- way users_shared_membership cannot become one into the user list.
CREATE POLICY operators_touched_tenant ON operators
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM audit_log a
       WHERE a.operator_id = operators.id
         AND a.tenant_id = app_current_tenant()
    )
  );

-- -------------------------------------------------------- the grant predicate --
-- Is the acting operator inside a live time box on this tenant? Revoked and
-- expired are the same answer — no. SECURITY DEFINER because support_grants is
-- RLS-scoped to the acting TENANT, and an operator transaction has no tenant.
CREATE FUNCTION app_support_access(p_tenant_id uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM support_grants g
     WHERE g.tenant_id = p_tenant_id
       AND g.operator_id = app_current_operator()
       AND g.revoked_at IS NULL
       AND g.expires_at > now()
  )
$$;

-- The reason the live grant was given for, so every audited action carries the
-- justification its access was granted under rather than one invented later.
CREATE FUNCTION app_support_reason(p_tenant_id uuid) RETURNS text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT g.reason FROM support_grants g
   WHERE g.tenant_id = p_tenant_id
     AND g.operator_id = app_current_operator()
     AND g.revoked_at IS NULL
     AND g.expires_at > now()
   ORDER BY g.expires_at DESC
   LIMIT 1
$$;

-- Every door below starts here: an operator action with no operator is not an
-- operator action, and a published id that names nobody is a fabrication.
CREATE FUNCTION require_operator() RETURNS uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_operator uuid := app_current_operator();
BEGIN
  IF v_operator IS NULL THEN
    RAISE EXCEPTION 'operator context required: publish app.operator_id'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM operators WHERE id = v_operator) THEN
    RAISE EXCEPTION 'operator not found' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN v_operator;
END
$$;

-- ------------------------------------------------------------- grant/revoke --
CREATE FUNCTION grant_support_access(
  p_tenant_id uuid,
  p_reason    text,
  p_ttl       interval
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_operator uuid := require_operator();
  v_expires  timestamptz;
  v_grant    uuid;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'support access requires a reason'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_ttl IS NULL OR p_ttl <= interval '0' THEN
    RAISE EXCEPTION 'support access requires a positive ttl'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'tenant not found' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_expires := now() + p_ttl;

  INSERT INTO support_grants (tenant_id, operator_id, reason, expires_at)
       VALUES (p_tenant_id, v_operator, p_reason, v_expires)
    RETURNING id INTO v_grant;

  INSERT INTO audit_log (tenant_id, operator_id, action, reason, detail)
       VALUES (p_tenant_id, v_operator, 'support.grant', p_reason,
               jsonb_build_object('grant_id', v_grant, 'expires_at', v_expires));

  RETURN v_grant;
END
$$;

-- Revocation is a timestamp, so a tenant reading its own grants sees that
-- access existed and ended rather than seeing nothing at all.
CREATE FUNCTION revoke_support_access(p_grant_id uuid) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_operator uuid := require_operator();
  v_grant    support_grants%ROWTYPE;
BEGIN
  SELECT * INTO v_grant FROM support_grants WHERE id = p_grant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'support grant not found' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_grant.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'support grant already revoked' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE support_grants SET revoked_at = now() WHERE id = p_grant_id;

  INSERT INTO audit_log (tenant_id, operator_id, action, reason, detail)
       VALUES (v_grant.tenant_id, v_operator, 'support.revoke', v_grant.reason,
               jsonb_build_object('grant_id', p_grant_id));
END
$$;

-- ------------------------------------------------------------ the audit door --
-- The only way an operator records an action against a live tenant, and the
-- reason it fails closed: no grant, no row — which means no audited action.
CREATE FUNCTION log_operator_action(
  p_tenant_id uuid,
  p_action    text,
  p_detail    jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_operator uuid := require_operator();
  v_entry    uuid;
BEGIN
  IF p_action IS NULL OR btrim(p_action) = '' THEN
    RAISE EXCEPTION 'audit entry requires an action'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT app_support_access(p_tenant_id) THEN
    RAISE EXCEPTION 'no active support grant for this tenant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO audit_log (tenant_id, operator_id, action, reason, detail)
       VALUES (p_tenant_id, v_operator, p_action,
               app_support_reason(p_tenant_id), coalesce(p_detail, '{}'::jsonb))
    RETURNING id INTO v_entry;

  RETURN v_entry;
END
$$;

-- ------------------------------------------- the Phase C doors, now audited --
-- Migrations are append-only, so these are CREATE OR REPLACE rather than edits
-- to 0003. Both bodies are the Phase C body plus an operator branch, and both
-- keep the old behaviour exactly when no operator is published — which is what
-- a migration, a fixture and every Phase C test are. CREATE OR REPLACE keeps
-- the privileges 0003 set, so PUBLIC stays revoked.

-- Provisioning is the one operator action that cannot require a support grant:
-- the tenant it would be scoped to does not exist until this function runs. It
-- is audited instead, which is the record the grant would otherwise be.
CREATE OR REPLACE FUNCTION provision_tenant(
  p_slug        text,
  p_name        text,
  p_owner_email text,
  p_owner_name  text
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant   uuid;
  v_user     uuid;
  v_operator uuid;
BEGIN
  IF app_current_operator() IS NOT NULL THEN
    v_operator := require_operator();
  END IF;

  INSERT INTO tenants (slug, name) VALUES (p_slug, p_name) RETURNING id INTO v_tenant;

  -- Users are global, so an owner may already exist. The no-op DO UPDATE is
  -- what makes RETURNING fire on the conflicting row as well as the new one.
  INSERT INTO users (email, display_name)
       VALUES (lower(p_owner_email), p_owner_name)
  ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
    RETURNING id INTO v_user;

  INSERT INTO memberships (tenant_id, user_id, role) VALUES (v_tenant, v_user, 'owner');

  IF v_operator IS NOT NULL THEN
    INSERT INTO audit_log (tenant_id, operator_id, action, detail)
         VALUES (v_tenant, v_operator, 'tenant.provision',
                 jsonb_build_object('slug', p_slug, 'owner_email', lower(p_owner_email)));
  END IF;

  RETURN v_tenant;
END
$$;

-- Suspending a live tenant is support access by any other name, so with an
-- operator published it demands the same live grant log_operator_action() does.
CREATE OR REPLACE FUNCTION set_tenant_state(p_tenant_id uuid, p_state text) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_operator uuid;
BEGIN
  IF p_state NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'unknown tenant state: %', p_state USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF app_current_operator() IS NOT NULL THEN
    v_operator := require_operator();
    IF NOT app_support_access(p_tenant_id) THEN
      RAISE EXCEPTION 'no active support grant for this tenant'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  UPDATE tenants SET state = p_state WHERE id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant not found' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_operator IS NOT NULL THEN
    INSERT INTO audit_log (tenant_id, operator_id, action, reason, detail)
         VALUES (p_tenant_id, v_operator, 'tenant.state',
                 app_support_reason(p_tenant_id), jsonb_build_object('state', p_state));
  END IF;
END
$$;

-- -------------------------------------------------------- function privilege --
-- Same discipline 0003 established: Postgres grants EXECUTE on a new function
-- to PUBLIC, which on a SECURITY DEFINER function is a privilege escalation.
-- None of these is granted back to app_user — the operator lane runs on the
-- privileged connection, and the tenant half of feature 5 is a SELECT policy,
-- not a function call.
REVOKE ALL ON FUNCTION audit_log_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_support_access(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_support_reason(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION require_operator() FROM PUBLIC;
REVOKE ALL ON FUNCTION grant_support_access(uuid, text, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_support_access(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION log_operator_action(uuid, text, jsonb) FROM PUBLIC;
