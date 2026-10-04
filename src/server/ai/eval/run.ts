import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { aiMessages, aiToolCalls, organizations, users } from "../../db/schema";
import { db } from "../../db/client";
import { ForbiddenError } from "../../authz/authorize";
import { tenantTx, type TenantCtx } from "../../modules/context";
import { loadPrincipal } from "../../modules/organizations/principal";
import { runAssistantTurn, type AssistantEvent } from "../orchestrator";
import { ungroundedNumbers } from "./grounding";
import type { ArgCheck, EvalCase } from "./cases";

export type EvalRun = {
  forbidden: boolean;
  answer: string;
  events: AssistantEvent[];
  calls: { tool: string; args: Record<string, unknown>; outcome: string }[];
  results: { tool: string; content: string }[];
  today: string;
  ms: number;
};

export async function runEvalCase(c: EvalCase): Promise<EvalRun> {
  const t0 = Date.now();
  const [u] = await db().select({ id: users.id }).from(users).where(eq(users.email, c.as));
  if (!u) throw new Error(`eval: unknown user ${c.as}`);
  const principal = await loadPrincipal(u.id, c.org ?? "pacific-properties");
  if (!principal) throw new Error(`eval: ${c.as} is not in ${c.org ?? "pacific-properties"}`);
  const ctx: TenantCtx = { principal, meta: null };
  const [org] = await tenantTx(ctx, (tx) => tx.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, principal.orgId)));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: org.tz }).format(new Date());
  const events: AssistantEvent[] = [];
  let answer = "";
  let turnId: string | null = null;
  try {
    for await (const ev of runAssistantTurn(ctx, { message: c.question, mode: c.mode })) {
      events.push(ev);
      if (ev.type === "text") answer += ev.delta;
      if (ev.type === "notice" || ev.type === "error") answer += ev.message;
      if (ev.type === "start") turnId = ev.turnId;
    }
  } catch (e) {
    if (e instanceof ForbiddenError) return { forbidden: true, answer: "", events, calls: [], results: [], today, ms: Date.now() - t0 };
    throw e;
  }
  const { calls, results } = turnId
    ? await tenantTx(ctx, async (tx) => ({
        calls: await tx.select({ tool: aiToolCalls.tool, args: aiToolCalls.args, outcome: aiToolCalls.outcome }).from(aiToolCalls)
          .where(eq(aiToolCalls.turnId, turnId!)).orderBy(asc(aiToolCalls.createdAt)),
        results: await tx.select({ tool: aiMessages.toolName, content: aiMessages.content }).from(aiMessages)
          .where(and(eq(aiMessages.turnId, turnId!), eq(aiMessages.role, "tool"))).orderBy(asc(aiMessages.seq)),
      }))
    : { calls: [], results: [] };
  return {
    forbidden: false, answer, events, today, ms: Date.now() - t0,
    calls: calls.map((x) => ({ tool: x.tool, args: (x.args ?? {}) as Record<string, unknown>, outcome: x.outcome })),
    results: results.map((x) => ({ tool: x.tool ?? "", content: x.content })),
  };
}

const argOk = (want: ArgCheck, got: unknown, today: string) =>
  typeof want === "function" ? (want as (v: unknown, c: { today: string }) => boolean)(got, { today }) : JSON.stringify(want) === JSON.stringify(got);

// returns the list of failed expectations (empty = pass)
export function checkEvalCase(c: EvalCase, r: EvalRun): string[] {
  const e = c.expect;
  const fail: string[] = [];
  if (e.forbidden) {
    if (!r.forbidden) fail.push("expected the assistant to be unavailable to this user");
    return fail;
  }
  if (r.forbidden) return ["the assistant refused this user entirely"];
  for (const want of e.tools ?? []) {
    const match = r.calls.find((call) => call.tool === want.name && Object.entries(want.args ?? {}).every(([k, v]) => argOk(v, call.args[k], r.today)));
    if (!match) fail.push(`expected ${want.name}${want.args ? ` with ${Object.keys(want.args).join(", ")}` : ""}; got ${r.calls.map((x) => `${x.tool}(${JSON.stringify(x.args)})`).join(", ") || "no tool calls"}`);
  }
  if (e.anyTool && !r.calls.some((x) => e.anyTool!.includes(x.tool as never))) fail.push(`expected one of ${e.anyTool.join(", ")}`);
  for (const t of e.forbidTools ?? []) if (r.calls.some((x) => x.tool === t && x.outcome === "ok")) fail.push(`${t} must not return data here`);
  if (e.noSuccessfulTools && r.calls.some((x) => x.outcome === "ok")) fail.push(`no tool should return data, but ${r.calls.filter((x) => x.outcome === "ok").map((x) => x.tool).join(", ")} did`);
  for (const o of e.outcomes ?? []) if (!r.calls.some((x) => x.outcome === o)) fail.push(`expected a tool outcome "${o}"`);
  for (const re of e.answerMatches ?? []) if (!re.test(r.answer)) fail.push(`answer should match ${re}`);
  for (const re of e.answerExcludes ?? []) if (re.test(r.answer)) fail.push(`answer must not match ${re}`);
  if (e.asksQuestion && !/\?\s*$/.test(r.answer.trim())) fail.push("answer should end by asking the user a question");
  if (e.resultsOnlyAt) {
    for (const res of r.results) {
      try {
        const items = (JSON.parse(res.content).items ?? []) as { property?: string }[];
        const foreign = items.filter((i) => i.property && i.property !== e.resultsOnlyAt);
        if (foreign.length) fail.push(`${res.tool} returned records from ${[...new Set(foreign.map((f) => f.property))].join(", ")}`);
      } catch {
        /* non-JSON tool output has no items */
      }
    }
  }
  if (e.grounded !== false) {
    const bad = ungroundedNumbers(r.answer, [...r.results.map((x) => x.content), c.question]);
    if (bad.length) fail.push(`numbers not found in any tool result: ${bad.join(", ")}`);
  }
  if (r.events.some((ev) => ev.type === "error")) fail.push(`the turn ended with an error: ${r.events.filter((ev) => ev.type === "error").map((ev) => (ev as { message: string }).message).join("; ")}`);
  return fail;
}
