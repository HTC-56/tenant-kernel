-- 0003_lifecycle — provision, invite/accept, role change, suspend/resume, and
-- the entitlement gates.
--
-- SPEC.md feature 4 asks for the lifecycle AND for entitlement flags "enforced
-- at the data layer — constraints and policies, not UI checks". So nothing here
-- is an application rule: a seat cap is a trigger, a suspended tenant is a
-- RESTRICTIVE policy, a feature toggle is a RESTRICTIVE policy, and "a tenant
-- keeps at least one owner" is a trigger. The TypeScript layer only calls them.
--
-- Two new shapes appear in this file:
--
--   * RESTRICTIVE policies. The policies in 0001/0002 are permissive: they OR
--     together, so each one can only ever widen access. A restrictive policy
--     ANDs instead, which is how a new rule can narrow an existing table
--     without editing the committed migration that created it.
--   * SECURITY DEFINER entry points for the operations that are cross-tenant by
--     nature. Provisioning a tenant and accepting an invite both act on a
--     tenant the caller is not (yet) scoped to, so they cannot be plain SQL
--     under RLS. They are narrow, argument-checked doors instead — and every
--     one of them REVOKEs the EXECUTE that Postgres grants to PUBLIC by
--     default, which is the whole reason SECURITY DEFINER is usually a bug.

-- ---------------------------------------------------------- request context --
-- Is the acting tenant usable? Reads `tenants`, which stays readable to a
-- suspended tenant precisely so the app can render "you are suspended". No
-- tenant published -> EXISTS is false -> refused. Fail closed.
CREATE FUNCTION app_tenant_active() RETURNS boolean
  LANGUAGE sql
  STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM tenants t
     WHERE t.id = app_current_tenant()
       AND t.state = 'active'
  )
$$;

-- Feature toggles are default-ON: a flag counts as disabled only when the
-- tenant's entitlements say exactly `false`. Comparing jsonb to jsonb rather
-- than casting ->> means a malformed flag value can never raise mid-policy.
CREATE FUNCTION app_feature_enabled(flag text) RETURNS boolean
  LANGUAGE sql
  STABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM entitlements e
     WHERE e.tenant_id = app_current_tenant()
       AND e.features -> flag = 'false'::jsonb
  )
$$;

-- ------------------------------------------------- suspension: the dark gate --
-- A suspended tenant loses its data, not its identity: every tenant-scoped
-- table goes dark, while the `tenants` row itself stays readable. `users` needs
-- no policy of its own here — its 0002 policy is an EXISTS over `memberships`,
-- which is now dark too, so the people disappear with the rest.
CREATE POLICY projects_tenant_active ON projects
  AS RESTRICTIVE FOR ALL
  USING (app_tenant_active())
  WITH CHECK (app_tenant_active());

CREATE POLICY memberships_tenant_active ON memberships
  AS RESTRICTIVE FOR ALL
  USING (app_tenant_active())
  WITH CHECK (app_tenant_active());

CREATE POLICY invites_tenant_active ON invites
  AS RESTRICTIVE FOR ALL
  USING (app_tenant_active())
  WITH CHECK (app_tenant_active());

CREATE POLICY entitlements_tenant_active ON entitlements
  AS RESTRICTIVE FOR ALL
  USING (app_tenant_active())
  WITH CHECK (app_tenant_active());

-- ---------------------------------------------------- projects: the default --
-- 0001 created `projects` before 0002 established the pattern of defaulting
-- tenant_id to app_current_tenant(). Give it the same default, so the CRUD
-- layer feature 6 adds never has to name a tenant either — and so a project
-- INSERT that forgets one is refused by the policy rather than by NOT NULL.
ALTER TABLE projects ALTER COLUMN tenant_id SET DEFAULT app_current_tenant();

-- ------------------------------------------- entitlements: the feature gate --
-- FOR INSERT so an entitlement that is switched off stops new work without
-- hiding the work already done — a tenant whose `projects` feature is revoked
-- can still read and clean up what it has.
CREATE POLICY projects_feature_enabled ON projects
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_feature_enabled('projects'));

-- ------------------------------------------------ entitlements: the seat cap --
-- The reservation Phase B recorded, now paid. SECURITY DEFINER because the
-- count must be the true one: a policy that hid rows would make the cap read
-- LOW, which is the one direction a cap must never be wrong in.
CREATE FUNCTION enforce_seat_cap() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  cap  integer;
  used integer;
BEGIN
  SELECT seat_cap INTO cap FROM entitlements WHERE tenant_id = NEW.tenant_id;
  IF cap IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO used FROM memberships WHERE tenant_id = NEW.tenant_id;
  IF used > cap THEN
    RAISE EXCEPTION 'seat cap reached: this tenant allows % seats', cap
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

-- AFTER, not BEFORE: the row has to be in the table before count(*) can tell
-- the truth about how many seats it takes.
CREATE TRIGGER memberships_seat_cap
  AFTER INSERT ON memberships
  FOR EACH ROW
  EXECUTE FUNCTION enforce_seat_cap();

-- --------------------------------------------------- role change: last owner --
-- Demoting or removing the last owner would strand the tenant with nobody who
-- can administer it. The guard on `tenants` is what lets DELETE FROM tenants
-- cascade: when the tenant itself is going away, an ownerless moment is fine.
CREATE FUNCTION enforce_last_owner() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  owners integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = OLD.tenant_id) THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO owners
    FROM memberships
   WHERE tenant_id = OLD.tenant_id AND role = 'owner';

  IF owners = 0 THEN
    RAISE EXCEPTION 'last owner: a tenant must keep at least one owner'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER memberships_last_owner
  AFTER UPDATE OR DELETE ON memberships
  FOR EACH ROW
  WHEN (OLD.role = 'owner')
  EXECUTE FUNCTION enforce_last_owner();

-- ------------------------------------------------------------ invite accept --
-- The invitee holds a token and nothing else: no membership in the inviting
-- tenant, so no context the memberships policy would accept. The token IS the
-- capability, which is why every other precondition is checked here explicitly
-- rather than left to RLS.
CREATE FUNCTION accept_invite(p_token text, p_user_id uuid) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  inv invites%ROWTYPE;
BEGIN
  SELECT * INTO inv FROM invites WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invite not found' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF inv.state <> 'pending' THEN
    RAISE EXCEPTION 'invite already %', inv.state USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF inv.expires_at <= now() THEN
    RAISE EXCEPTION 'invite expired' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'invite user not found' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = inv.tenant_id AND state = 'active') THEN
    RAISE EXCEPTION 'invite tenant is suspended' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Already a member: the invite is still consumed, but the existing role is
  -- left alone. An invite may add a person; it may not quietly re-rank one.
  INSERT INTO memberships (tenant_id, user_id, role)
       VALUES (inv.tenant_id, p_user_id, inv.role)
  ON CONFLICT (tenant_id, user_id) DO NOTHING;

  UPDATE invites SET state = 'accepted' WHERE id = inv.id;
  RETURN inv.tenant_id;
END
$$;

-- ---------------------------------------------------------------- provision --
-- Creating a tenant is cross-tenant by definition, so this is an operator door,
-- not a tenant one: the GRANT below deliberately stops at app_user. Feature 5
-- gives the operator lane its identity, its reason-and-TTL grant, and its audit
-- row; until then only a privileged connection can call this.
CREATE FUNCTION provision_tenant(
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
  v_tenant uuid;
  v_user   uuid;
BEGIN
  INSERT INTO tenants (slug, name) VALUES (p_slug, p_name) RETURNING id INTO v_tenant;

  -- Users are global, so an owner may already exist. The no-op DO UPDATE is
  -- what makes RETURNING fire on the conflicting row as well as the new one.
  INSERT INTO users (email, display_name)
       VALUES (lower(p_owner_email), p_owner_name)
  ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
    RETURNING id INTO v_user;

  INSERT INTO memberships (tenant_id, user_id, role) VALUES (v_tenant, v_user, 'owner');
  RETURN v_tenant;
END
$$;

-- ----------------------------------------------------------- suspend/resume --
-- One door for both directions, so the state vocabulary lives in exactly one
-- place. Operator-only for the same reason provision_tenant is.
CREATE FUNCTION set_tenant_state(p_tenant_id uuid, p_state text) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_state NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'unknown tenant state: %', p_state USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE tenants SET state = p_state WHERE id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant not found' USING ERRCODE = 'invalid_parameter_value';
  END IF;
END
$$;

-- --------------------------------------------------------- function privilege --
-- Postgres grants EXECUTE on a new function to PUBLIC. On a SECURITY DEFINER
-- function that is a privilege escalation waiting to happen, so every one of
-- them — including the trigger function 0002 created — is revoked here and then
-- granted back only where a tenant genuinely needs it.
REVOKE ALL ON FUNCTION tenant_default_entitlements() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_seat_cap() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_last_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION accept_invite(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION provision_tenant(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_tenant_state(uuid, text) FROM PUBLIC;

-- The one door a tenant request may open for itself.
GRANT EXECUTE ON FUNCTION accept_invite(text, uuid) TO app_user;
