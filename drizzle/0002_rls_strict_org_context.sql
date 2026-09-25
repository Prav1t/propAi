-- Fix: "own membership" visibility must only apply when NO org context is set.
-- Previously, inside org A a user could see their own memberships/roles/orgs from org B.
DROP POLICY memberships_select ON memberships;
--> statement-breakpoint
CREATE POLICY memberships_select ON memberships FOR SELECT
  USING (org_id = app_org() OR app_platform_admin()
         OR (app_org() IS NULL AND user_id = app_user()));
--> statement-breakpoint
DROP POLICY organizations_select ON organizations;
--> statement-breakpoint
CREATE POLICY organizations_select ON organizations FOR SELECT
  USING (id = app_org() OR app_platform_admin()
         OR (app_org() IS NULL AND id IN (SELECT m.org_id FROM memberships m WHERE m.user_id = app_user())));
--> statement-breakpoint
DROP POLICY roles_select ON roles;
--> statement-breakpoint
CREATE POLICY roles_select ON roles FOR SELECT
  USING (org_id IS NULL OR org_id = app_org() OR app_platform_admin()
         OR (app_org() IS NULL AND org_id IN (SELECT m.org_id FROM memberships m WHERE m.user_id = app_user())));
--> statement-breakpoint
DROP POLICY invitations_select ON invitations;
--> statement-breakpoint
CREATE POLICY invitations_select ON invitations FOR SELECT
  USING (org_id = app_org() OR (app_org() IS NULL AND token_hash = nullif(current_setting('app.invite_token_hash', true), '')));
--> statement-breakpoint
DROP POLICY invitations_update ON invitations;
--> statement-breakpoint
CREATE POLICY invitations_update ON invitations FOR UPDATE
  USING (org_id = app_org() OR (app_org() IS NULL AND token_hash = nullif(current_setting('app.invite_token_hash', true), '')))
  WITH CHECK (org_id = app_org() OR (app_org() IS NULL AND token_hash = nullif(current_setting('app.invite_token_hash', true), '')));
--> statement-breakpoint
DROP POLICY audit_select ON audit_logs;
--> statement-breakpoint
CREATE POLICY audit_select ON audit_logs FOR SELECT
  USING (org_id = app_org() OR app_platform_admin() OR (app_org() IS NULL AND org_id IS NULL AND actor_user_id = app_user()));
