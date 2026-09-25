-- RLS for Iteration 2 tenant tables
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vendors','vendor_contacts','vendor_properties','staff_profiles']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_org() OR app_platform_admin()) WITH CHECK (org_id = app_org())', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- array_to_string is only STABLE; this wrapper is safe to mark IMMUTABLE for text[]
CREATE OR REPLACE FUNCTION immutable_array_join(text[]) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT array_to_string($1, ' ') $$;
--> statement-breakpoint

-- Full-text search: generated tsvector columns ('simple' config keeps names, codes and unit numbers intact)
ALTER TABLE properties ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(code,'') || ' ' || coalesce(address_line1,'') || ' ' || coalesce(city,'') || ' ' || coalesce(postal_code,''))
) STORED;
--> statement-breakpoint
ALTER TABLE buildings ADD COLUMN search tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(code,''))) STORED;
--> statement-breakpoint
ALTER TABLE units ADD COLUMN search tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(number,''))) STORED;
--> statement-breakpoint
ALTER TABLE residents ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector('simple', coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' || coalesce(email,'') || ' ' || regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g'))
) STORED;
--> statement-breakpoint
ALTER TABLE vendors ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(legal_name,'') || ' ' || coalesce(email,'') || ' ' || immutable_array_join(categories))
) STORED;
--> statement-breakpoint
CREATE INDEX properties_search_idx ON properties USING gin (search);
--> statement-breakpoint
CREATE INDEX buildings_search_idx ON buildings USING gin (search);
--> statement-breakpoint
CREATE INDEX units_search_idx ON units USING gin (search);
--> statement-breakpoint
CREATE INDEX residents_search_idx ON residents USING gin (search);
--> statement-breakpoint
CREATE INDEX vendors_search_idx ON vendors USING gin (search);
--> statement-breakpoint
CREATE INDEX memberships_vendor_idx ON memberships (vendor_id);
