-- RLS for the AI assistant (Iteration 6)
-- conversations and transcripts are private to their author: own org AND own user, nobody else (not even platform admins)
ALTER TABLE ai_conversations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_only ON ai_conversations USING (org_id = app_org() AND user_id = app_user()) WITH CHECK (org_id = app_org() AND user_id = app_user());
--> statement-breakpoint
ALTER TABLE ai_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_only ON ai_messages USING (org_id = app_org() AND user_id = app_user()) WITH CHECK (org_id = app_org() AND user_id = app_user());
--> statement-breakpoint
-- tool-call logs and usage are org records (admins review them through the service layer)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_tool_calls','ai_usage']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_org() OR app_platform_admin() OR app_system()) WITH CHECK (org_id = app_org())', t);
  END LOOP;
END $$;
