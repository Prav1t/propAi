-- Row-Level Security: tenant isolation enforced by Postgres for the least-privilege app role.
-- The app sets these transaction-local settings in withContext():
--   app.org_id, app.user_id, app.platform_admin ('on'/'off'), app.invite_token_hash
-- Table owners (migrations/seed) bypass RLS; the runtime role does not.

CREATE OR REPLACE FUNCTION app_org() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_user() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_platform_admin() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.platform_admin', true), 'off') = 'on' $$;
--> statement-breakpoint

-- simple org-owned tables: rows visible/writable only inside their org context
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['portfolios','properties','buildings','floors','units','residents','unit_occupancies','membership_scopes']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_org() OR app_platform_admin()) WITH CHECK (org_id = app_org())', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- memberships: own org, or the current user's own memberships (to list their orgs)
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY memberships_select ON memberships FOR SELECT
  USING (org_id = app_org() OR user_id = app_user() OR app_platform_admin());
--> statement-breakpoint
CREATE POLICY memberships_write ON memberships FOR ALL
  USING (org_id = app_org()) WITH CHECK (org_id = app_org());
--> statement-breakpoint

-- organizations: the current org, orgs the user belongs to, or platform admin
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY organizations_select ON organizations FOR SELECT
  USING (id = app_org() OR app_platform_admin()
         OR id IN (SELECT m.org_id FROM memberships m WHERE m.user_id = app_user()));
--> statement-breakpoint
CREATE POLICY organizations_insert ON organizations FOR INSERT WITH CHECK (id = app_org());
--> statement-breakpoint
CREATE POLICY organizations_update ON organizations FOR UPDATE
  USING (id = app_org() OR app_platform_admin()) WITH CHECK (id = app_org() OR app_platform_admin());
--> statement-breakpoint

-- roles: system roles (org_id null) readable by all; org roles only inside the org
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY roles_select ON roles FOR SELECT
  USING (org_id IS NULL OR org_id = app_org() OR app_platform_admin()
         OR org_id IN (SELECT m.org_id FROM memberships m WHERE m.user_id = app_user()));
--> statement-breakpoint
CREATE POLICY roles_write ON roles FOR ALL USING (org_id = app_org()) WITH CHECK (org_id = app_org());
--> statement-breakpoint

-- invitations: org context, or the single row whose token hash the caller presented
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY invitations_select ON invitations FOR SELECT
  USING (org_id = app_org() OR token_hash = nullif(current_setting('app.invite_token_hash', true), ''));
--> statement-breakpoint
CREATE POLICY invitations_update ON invitations FOR UPDATE
  USING (org_id = app_org() OR token_hash = nullif(current_setting('app.invite_token_hash', true), ''))
  WITH CHECK (org_id = app_org() OR token_hash = nullif(current_setting('app.invite_token_hash', true), ''));
--> statement-breakpoint
CREATE POLICY invitations_insert ON invitations FOR INSERT WITH CHECK (org_id = app_org());
--> statement-breakpoint
CREATE POLICY invitations_delete ON invitations FOR DELETE USING (org_id = app_org());
--> statement-breakpoint

-- audit logs: append-only for the app role; org rows in org context, personal rows for the actor
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_select ON audit_logs FOR SELECT
  USING (org_id = app_org() OR app_platform_admin() OR (org_id IS NULL AND actor_user_id = app_user()));
--> statement-breakpoint
CREATE POLICY audit_insert ON audit_logs FOR INSERT
  WITH CHECK (org_id = app_org() OR (org_id IS NULL AND actor_user_id = app_user()));
