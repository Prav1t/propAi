-- Billing, developer platform and integrations (Iteration 10): tenant RLS, API-key lookup, global feature flags, backfills
CREATE OR REPLACE FUNCTION app_api_key_hash() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.api_key_hash', true), '') $$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscriptions','invoices','usage_records','api_keys','api_idempotency','webhook_endpoints','webhook_deliveries','webhook_attempts','integrations']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_org() OR app_platform_admin() OR app_system()) WITH CHECK (org_id = app_org())', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- an API request knows only the presented key's hash until the key is found; that one row is visible to it
CREATE POLICY api_key_lookup ON api_keys FOR SELECT USING (key_hash = app_api_key_hash());
--> statement-breakpoint
-- provider webhooks arrive before the organization is known: the system context records them, the org reads its own
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON billing_events USING (org_id = app_org() OR app_platform_admin() OR app_system()) WITH CHECK (app_system() OR org_id = app_org());
--> statement-breakpoint
-- feature flags: everyone reads global rows and their own organization's; only platform admins change them
ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY feature_flags_read ON feature_flags FOR SELECT USING (org_id IS NULL OR org_id = app_org() OR app_platform_admin() OR app_system());
--> statement-breakpoint
CREATE POLICY feature_flags_write ON feature_flags FOR INSERT WITH CHECK (app_platform_admin());
--> statement-breakpoint
CREATE POLICY feature_flags_update ON feature_flags FOR UPDATE USING (app_platform_admin()) WITH CHECK (app_platform_admin());
--> statement-breakpoint
CREATE POLICY feature_flags_delete ON feature_flags FOR DELETE USING (app_platform_admin());
--> statement-breakpoint
-- organizations that existed before billing keep working: an active Professional subscription managed by the platform
INSERT INTO subscriptions (org_id, plan_key, interval, status, provider, current_period_start, current_period_end)
SELECT id, 'professional', 'month', 'active', 'manual', now(), now() + interval '1 month' FROM organizations
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE organizations SET plan_key = 'professional' WHERE plan_key NOT IN ('starter','professional','enterprise');
--> statement-breakpoint
-- events raised before webhooks existed are history, not something to deliver
UPDATE outbox_events SET webhooks_at = now() WHERE webhooks_at IS NULL;
