import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { withContext } from "./db/client";
import { auditChainHeads, auditCheckpoints } from "./db/schema";
import { authorize } from "./authz/authorize";
import { tenantTx, type TenantCtx } from "./modules/context";
import { log } from "./log";

// Tamper evidence for the audit log (Iteration 11). Each organization's entries form a hash chain kept by a database
// trigger (migration 0024); audit_verify() recomputes it. Checkpoints copy each chain's head into a table and into
// the application logs once a day, so rewriting history would also have to rewrite logs shipped elsewhere.
export type ChainCheck = { checked: number; firstSeq: number | null; lastSeq: number | null; problemSeq: number | null; problem: string | null };

type Row = { checked: string; first_seq: string | null; last_seq: string | null; problem_seq: string | null; problem: string | null };
const toCheck = (r: Row): ChainCheck => ({
  checked: Number(r.checked), firstSeq: r.first_seq === null ? null : Number(r.first_seq), lastSeq: r.last_seq === null ? null : Number(r.last_seq),
  problemSeq: r.problem_seq === null ? null : Number(r.problem_seq), problem: r.problem,
});

export async function verifyOrgAuditChain(ctx: TenantCtx): Promise<ChainCheck & { checkpoint: { seq: number; hash: string; at: Date } | null }> {
  authorize(ctx.principal, "audit.read");
  return tenantTx(ctx, async (tx) => {
    const { rows } = await tx.execute<Row>(sql`select * from audit_verify(${ctx.principal.orgId}::text)`);
    const [cp] = await tx.select().from(auditCheckpoints).where(eq(auditCheckpoints.chainKey, ctx.principal.orgId)).orderBy(desc(auditCheckpoints.createdAt)).limit(1);
    return { ...toCheck(rows[0]), checkpoint: cp ? { seq: cp.seq, hash: cp.hash, at: cp.createdAt } : null };
  });
}

// platform console: every chain
export async function verifyAllAuditChains(): Promise<(ChainCheck & { chainKey: string })[]> {
  return withContext({ platformAdmin: true }, async (tx) => {
    const heads = await tx.select({ chainKey: auditChainHeads.chainKey }).from(auditChainHeads);
    const out = [];
    for (const h of heads) {
      const { rows } = await tx.execute<Row>(sql`select * from audit_verify(${h.chainKey})`);
      out.push({ chainKey: h.chainKey, ...toCheck(rows[0]) });
    }
    return out;
  });
}

// worker, hourly: a checkpoint per chain that moved since its last one, at most daily
export async function checkpointAuditChains(now = new Date()): Promise<number> {
  return withContext({ system: true }, async (tx) => {
    const { rows } = await tx.execute<{ chain_key: string; seq: string; hash: string; last_seq: string | null; last_at: Date | null }>(sql`
      select h.chain_key, h.seq, h.hash, c.seq as last_seq, c.created_at as last_at
      from audit_chain_heads h
      left join lateral (select seq, created_at from audit_checkpoints where chain_key = h.chain_key order by created_at desc limit 1) c on true`);
    let n = 0;
    for (const r of rows) {
      const moved = r.last_seq === null || Number(r.last_seq) < Number(r.seq);
      const due = !r.last_at || now.getTime() - new Date(r.last_at).getTime() >= 24 * 3600_000;
      if (!moved || !due) continue;
      await tx.insert(auditCheckpoints).values({ chainKey: r.chain_key, seq: Number(r.seq), hash: r.hash });
      log.info("audit.checkpoint", { chain: r.chain_key, seq: Number(r.seq), hash: r.hash }); // the external anchor
      n++;
    }
    return n;
  });
}
