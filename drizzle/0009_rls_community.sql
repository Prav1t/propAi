-- RLS for Iteration 4 community tables (same rule as operations: own org, platform admin read, worker system read)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['amenities','amenity_blackouts','bookings','packages','announcements','announcement_reads',
                           'message_threads','messages','message_reads','message_templates','documents','document_versions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_org() OR app_platform_admin() OR app_system()) WITH CHECK (org_id = app_org())', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- exclusive amenities can never hold two overlapping live bookings, even under concurrent requests
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (amenity_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
  WHERE (exclusive AND status IN ('requested', 'approved'));
--> statement-breakpoint

-- document library search
ALTER TABLE documents ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(description,'') || ' ' || category)
) STORED;
--> statement-breakpoint
CREATE INDEX documents_search_idx ON documents USING gin (search);
