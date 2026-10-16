-- Analytics & automation (Iteration 9): tenant RLS on rules, runs and delivered briefs
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workflows','workflow_runs','daily_briefs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_org() OR app_platform_admin() OR app_system()) WITH CHECK (org_id = app_org())', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- analytics: completion and arrival times drive most period metrics
CREATE INDEX IF NOT EXISTS work_orders_completed_idx ON work_orders (org_id, completed_at) WHERE completed_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS work_orders_sla_watch_idx ON work_orders (resolve_due_at) WHERE sla_warned_at IS NULL AND completed_at IS NULL AND cancelled_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS packages_received_idx ON packages (org_id, received_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bookings_starts_idx ON bookings (org_id, starts_at);
