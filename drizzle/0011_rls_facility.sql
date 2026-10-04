-- RLS for Iteration 5 front-desk and facility tables (own org; platform admin and worker may read)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['visitors','parking_spaces','vehicles','parking_permits','parking_violations',
                           'shifts','shift_handoffs','assets','pm_schedules','asset_downtime']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_org() OR app_platform_admin() OR app_system()) WITH CHECK (org_id = app_org())', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- the public guest-pass page may read exactly one visitor: the one whose pass token hash it presents (no org context)
CREATE POLICY visitor_pass ON visitors FOR SELECT
  USING (app_org() IS NULL AND pass_token_hash IS NOT NULL AND pass_token_hash = nullif(current_setting('app.pass_token_hash', true), ''));
--> statement-breakpoint

-- one live permit per parking space at a time (null valid_until = open-ended)
ALTER TABLE parking_permits ADD CONSTRAINT parking_permits_space_no_overlap
  EXCLUDE USING gist (space_id WITH =, tstzrange(valid_from, valid_until, '[)') WITH &&)
  WHERE (status = 'active' AND space_id IS NOT NULL);
--> statement-breakpoint

-- nobody can be scheduled for two overlapping shifts
ALTER TABLE shifts ADD CONSTRAINT shifts_no_overlap
  EXCLUDE USING gist (membership_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
  WHERE (status = 'scheduled');
--> statement-breakpoint

-- asset registry search (name, tag, make/model, serial, location)
ALTER TABLE assets ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(tag,'') || ' ' || coalesce(make,'') || ' ' || coalesce(model,'') || ' ' ||
    coalesce(serial_number,'') || ' ' || coalesce(location,'') || ' ' || category)
) STORED;
--> statement-breakpoint
CREATE INDEX assets_search_idx ON assets USING gin (search);
