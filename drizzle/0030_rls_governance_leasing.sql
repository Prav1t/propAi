-- Iteration 13: meetings, motions, votes, leases and rent belong to one organization. Which property's meetings or
-- leases a person may open is decided by the services (property scope); the database guarantees the organization.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['meetings','meeting_agenda_items','meeting_motions','meeting_votes','leases','rent_charges']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_org() OR app_platform_admin() OR app_system()) WITH CHECK (org_id = app_org() OR app_system())', t);
  END LOOP;
END $$;
