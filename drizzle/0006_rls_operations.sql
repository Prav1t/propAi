-- system context: only the background worker sets app.system = 'on' (outbox delivery, SLA monitor)
CREATE OR REPLACE FUNCTION app_system() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.system', true), 'off') = 'on' $$;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_counters','sla_policies','triage_rules','work_orders','timeline_events','tasks','task_checklist_items',
                           'inspection_templates','inspections','inspection_items','incidents','complaints','files']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_org() OR app_platform_admin() OR app_system()) WITH CHECK (org_id = app_org())', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- notifications: inside an org, a user sees only their own; the worker (system) writes for anyone in the org
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY notifications_select ON notifications FOR SELECT
  USING (org_id = app_org() AND (user_id = app_user() OR app_system()));
--> statement-breakpoint
CREATE POLICY notifications_insert ON notifications FOR INSERT WITH CHECK (org_id = app_org());
--> statement-breakpoint
CREATE POLICY notifications_update ON notifications FOR UPDATE
  USING (org_id = app_org() AND (user_id = app_user() OR app_system()))
  WITH CHECK (org_id = app_org() AND (user_id = app_user() OR app_system()));
--> statement-breakpoint
CREATE POLICY notifications_delete ON notifications FOR DELETE USING (org_id = app_org() AND user_id = app_user());
--> statement-breakpoint

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY notification_prefs_all ON notification_preferences
  USING (org_id = app_org() AND (user_id = app_user() OR app_system()))
  WITH CHECK (org_id = app_org() AND user_id = app_user());
--> statement-breakpoint

-- outbox: written in org context; read across orgs only by the worker
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY outbox_select ON outbox_events FOR SELECT USING (org_id = app_org() OR app_system());
--> statement-breakpoint
CREATE POLICY outbox_insert ON outbox_events FOR INSERT WITH CHECK (org_id = app_org());
--> statement-breakpoint
CREATE POLICY outbox_update ON outbox_events FOR UPDATE USING (app_system() AND org_id = app_org()) WITH CHECK (org_id = app_org());
--> statement-breakpoint

-- memberships/users must be readable by the worker to resolve recipients (memberships already RLS'd)
DROP POLICY memberships_select ON memberships;
--> statement-breakpoint
CREATE POLICY memberships_select ON memberships FOR SELECT
  USING (org_id = app_org() OR app_platform_admin()
         OR (app_org() IS NULL AND user_id = app_user()));
