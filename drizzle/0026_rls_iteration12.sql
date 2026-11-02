-- Iteration 12: saved views, recently viewed records and push subscriptions belong to one person in one organization.
-- People reach only their own rows; the system context (push delivery, privacy export and erasure, retention) reaches
-- every row within one organization after its own permission checks.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['saved_views','recent_views','push_subscriptions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_only ON %I USING (org_id = app_org() AND (user_id = app_user() OR app_system())) WITH CHECK (org_id = app_org() AND (user_id = app_user() OR app_system()))', t);
  END LOOP;
END $$;
