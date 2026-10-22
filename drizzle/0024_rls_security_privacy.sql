-- Security and privacy (Iteration 11): tenant RLS for the new tables, a tamper-evident hash chain on audit_logs
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_security_policies','sso_connections','sso_domains','privacy_requests','legal_holds','retention_policies','consents']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_org() OR app_platform_admin() OR app_system()) WITH CHECK (org_id = app_org() OR app_system())', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- assistant conversations stay owner-only for people; privacy requests and retention (system context, after their own
-- permission checks) can reach them within one organization
DROP POLICY owner_only ON ai_conversations;
--> statement-breakpoint
CREATE POLICY owner_only ON ai_conversations USING (org_id = app_org() AND (user_id = app_user() OR app_system())) WITH CHECK (org_id = app_org() AND user_id = app_user());
--> statement-breakpoint
DROP POLICY owner_only ON ai_messages;
--> statement-breakpoint
CREATE POLICY owner_only ON ai_messages USING (org_id = app_org() AND (user_id = app_user() OR app_system())) WITH CHECK (org_id = app_org() AND user_id = app_user());
--> statement-breakpoint
-- chain heads are written only by the audit trigger (SECURITY DEFINER); checkpoints by the worker
ALTER TABLE audit_chain_heads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_heads_read ON audit_chain_heads FOR SELECT USING (app_platform_admin() OR app_system());
--> statement-breakpoint
ALTER TABLE audit_checkpoints ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_checkpoints_read ON audit_checkpoints FOR SELECT USING (app_platform_admin() OR app_system() OR chain_key = app_org()::text);
--> statement-breakpoint
CREATE POLICY audit_checkpoints_write ON audit_checkpoints FOR INSERT WITH CHECK (app_system());
--> statement-breakpoint
-- one entry's hash: sha256 over a canonical JSON of every field plus the previous entry's hash. JSON (not a joined
-- string) so no field can be shifted into another without changing the digest.
CREATE OR REPLACE FUNCTION audit_entry_hash(r audit_logs) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object(
    'id', r.id, 'seq', r.seq, 'org', r.org_id, 'actor', r.actor_user_id, 'action', r.action,
    'entity_type', r.entity_type, 'entity_id', r.entity_id, 'before', r.before, 'after', r.after,
    'ip', host(r.ip), 'user_agent', r.user_agent, 'request_id', r.request_id, 'ai', r.ai_generated,
    'approval', r.approval_id, 'run', r.workflow_run_id, 'api_key', r.api_key_id,
    'at', to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'prev', r.prev_hash
  )::text, 'UTF8')), 'hex')
$$;
--> statement-breakpoint
-- existing entries join the chain in the order they were written
DO $$
DECLARE r audit_logs; k text; prev text; n bigint; cur text := NULL;
BEGIN
  FOR r IN SELECT * FROM audit_logs ORDER BY coalesce(org_id::text, 'platform'), created_at, id LOOP
    k := coalesce(r.org_id::text, 'platform');
    IF cur IS DISTINCT FROM k THEN
      IF cur IS NOT NULL THEN
        INSERT INTO audit_chain_heads (chain_key, seq, hash) VALUES (cur, n, prev);
      END IF;
      cur := k; n := 0; prev := repeat('0', 64);
    END IF;
    n := n + 1;
    r.seq := n; r.prev_hash := prev;
    r.hash := audit_entry_hash(r);
    UPDATE audit_logs SET seq = r.seq, prev_hash = r.prev_hash, hash = r.hash WHERE id = r.id;
    prev := r.hash;
  END LOOP;
  IF cur IS NOT NULL THEN
    INSERT INTO audit_chain_heads (chain_key, seq, hash) VALUES (cur, n, prev);
  END IF;
END $$;
--> statement-breakpoint
-- every new entry is linked to its chain's head; the head row lock orders concurrent writers within a chain
CREATE OR REPLACE FUNCTION audit_chain_append() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k text := coalesce(NEW.org_id::text, 'platform'); h audit_chain_heads;
BEGIN
  INSERT INTO audit_chain_heads (chain_key, seq, hash) VALUES (k, 0, repeat('0', 64)) ON CONFLICT (chain_key) DO NOTHING;
  SELECT * INTO h FROM audit_chain_heads WHERE chain_key = k FOR UPDATE;
  NEW.created_at := coalesce(NEW.created_at, now());
  NEW.seq := h.seq + 1;
  NEW.prev_hash := h.hash;
  NEW.hash := audit_entry_hash(NEW);
  UPDATE audit_chain_heads SET seq = NEW.seq, hash = NEW.hash, updated_at = now() WHERE chain_key = k;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_chain BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_chain_append();
--> statement-breakpoint
-- entries never change (the app role has no UPDATE grant either; this also stops the table owner by accident)
CREATE OR REPLACE FUNCTION audit_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit log entries are immutable';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_immutable BEFORE UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_no_update();
--> statement-breakpoint
-- retention: removes an organization's entries older than the cutoff (never less than a year) and records the
-- boundary as a checkpoint, so the remaining chain still verifies from a known hash
CREATE OR REPLACE FUNCTION audit_prune(p_org uuid, p_before timestamptz) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE last_seq bigint; last_hash text; n bigint;
BEGIN
  IF p_before > now() - interval '365 days' THEN
    RAISE EXCEPTION 'audit entries are kept for at least 365 days';
  END IF;
  SELECT seq, hash INTO last_seq, last_hash FROM audit_logs WHERE org_id = p_org AND created_at < p_before ORDER BY seq DESC LIMIT 1;
  IF last_seq IS NULL THEN RETURN 0; END IF;
  INSERT INTO audit_checkpoints (chain_key, seq, hash) VALUES (p_org::text, last_seq, last_hash);
  DELETE FROM audit_logs WHERE org_id = p_org AND seq <= last_seq;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
--> statement-breakpoint
-- recomputes a chain: every hash, every link and the head. Returns the number of entries checked and the first
-- problem found (null when the chain is intact).
CREATE OR REPLACE FUNCTION audit_verify(p_chain text) RETURNS TABLE(checked bigint, first_seq bigint, last_seq bigint, problem_seq bigint, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r audit_logs; expected_prev text; expected_seq bigint; n bigint := 0; fseq bigint; lseq bigint; head audit_chain_heads;
BEGIN
  FOR r IN SELECT * FROM audit_logs WHERE coalesce(org_id::text, 'platform') = p_chain ORDER BY seq LOOP
    IF n = 0 THEN
      fseq := r.seq;
      IF r.seq = 1 THEN
        expected_prev := repeat('0', 64);
      ELSE
        -- entries before this one were pruned: the boundary checkpoint vouches for the link
        SELECT c.hash INTO expected_prev FROM audit_checkpoints c WHERE c.chain_key = p_chain AND c.seq = r.seq - 1 ORDER BY c.created_at DESC LIMIT 1;
        IF expected_prev IS NULL THEN
          RETURN QUERY SELECT n, fseq, r.seq, r.seq, 'entries before this one are missing and no checkpoint covers them'::text; RETURN;
        END IF;
      END IF;
      expected_seq := r.seq;
    END IF;
    IF r.seq <> expected_seq THEN
      RETURN QUERY SELECT n, fseq, r.seq, expected_seq, format('entry %s is missing', expected_seq); RETURN;
    END IF;
    IF r.prev_hash IS DISTINCT FROM expected_prev THEN
      RETURN QUERY SELECT n, fseq, r.seq, r.seq, 'link to the previous entry is broken'::text; RETURN;
    END IF;
    IF r.hash IS DISTINCT FROM audit_entry_hash(r) THEN
      RETURN QUERY SELECT n, fseq, r.seq, r.seq, 'content changed after it was written'::text; RETURN;
    END IF;
    n := n + 1; lseq := r.seq; expected_prev := r.hash; expected_seq := r.seq + 1;
  END LOOP;
  SELECT * INTO head FROM audit_chain_heads WHERE chain_key = p_chain;
  IF head.chain_key IS NOT NULL AND n > 0 AND (head.seq <> lseq OR head.hash <> expected_prev) THEN
    RETURN QUERY SELECT n, fseq, lseq, lseq, 'the newest entries are missing (the chain head is ahead)'::text; RETURN;
  END IF;
  RETURN QUERY SELECT n, fseq, lseq, NULL::bigint, NULL::text;
END $$;
