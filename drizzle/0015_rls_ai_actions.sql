-- RLS for assistant plans and AI policies (Iteration 7): own org only (platform admin and the worker may read)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_approvals','ai_policies']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_org() OR app_platform_admin() OR app_system()) WITH CHECK (org_id = app_org())', t);
  END LOOP;
END $$;
