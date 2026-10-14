-- Knowledge base (Iteration 8): tenant RLS, full-text search over passages, vector index
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['knowledge_entries','knowledge_entry_versions','kb_sources','kb_chunks']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_org() OR app_platform_admin() OR app_system()) WITH CHECK (org_id = app_org())', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- 'english' stems prose ("booking" matches "book"); the title/section context weighs more than the body
ALTER TABLE kb_chunks ADD COLUMN search tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(context, '')), 'A') || setweight(to_tsvector('english', coalesce(content, '')), 'B')
) STORED;
--> statement-breakpoint
CREATE INDEX kb_chunks_search_idx ON kb_chunks USING gin (search);
--> statement-breakpoint
CREATE INDEX kb_chunks_embedding_idx ON kb_chunks USING hnsw (embedding vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX knowledge_entries_search_idx ON knowledge_entries USING gin (to_tsvector('simple', title));
