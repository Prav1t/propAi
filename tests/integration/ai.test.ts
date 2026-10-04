import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runAssistantTurn, type AssistantEvent } from "@/server/ai/orchestrator";
import { setChatModelForTests } from "@/server/ai/providers";
import { DemoModel } from "@/server/ai/providers/demo";
import { aiConfig, resolveAiConfig, setAiConfigForTests } from "@/server/ai/config";
import { toolsForPrincipal } from "@/server/ai/tools";
import { getConversationView, listConversations, archiveConversation } from "@/server/ai/store";
import { updateAiSettings, usageOverview } from "@/server/ai/usage";
import { EVAL_CASES } from "@/server/ai/eval/cases";
import { checkEvalCase, runEvalCase } from "@/server/ai/eval/run";
import { listWorkOrders } from "@/server/modules/maintenance/service";
import { loadPrincipal } from "@/server/modules/organizations/principal";
import { ForbiddenError, NotFoundError } from "@/server/authz/authorize";
import { ValidationError, type TenantCtx } from "@/server/modules/context";
import { closeDb } from "@/server/db/client";
import { ProviderError, ZERO_USAGE, type ChatEvent, type ChatModel, type ChatRequest } from "@/server/ai/types";
import { asApp, ownerPool, userIdByEmail } from "../support/db";

const meta = { ip: "203.0.113.20", userAgent: "vitest", requestId: "ai" };
async function ctxFor(email: string, slug = "pacific-properties"): Promise<TenantCtx> {
  const p = await loadPrincipal(await userIdByEmail(email), slug);
  if (!p) throw new Error(`${email} not in ${slug}`);
  return { principal: p, meta };
}

// a model that follows a script: each call to stream() plays the next step
class ScriptedModel implements ChatModel {
  readonly provider = "scripted";
  readonly demo = false;
  requests: ChatRequest[] = [];
  constructor(private steps: ((req: ChatRequest) => ChatEvent[] | Promise<ChatEvent[]>)[], readonly model = "scripted-1") {}
  async *stream(req: ChatRequest): AsyncGenerator<ChatEvent> {
    this.requests.push(structuredClone({ ...req, signal: undefined }));
    const step = this.steps.shift();
    if (!step) throw new Error("script exhausted");
    for (const e of await step(req)) yield e;
  }
}
const toolCall = (name: string, input: Record<string, unknown>, id = `c_${Math.random().toString(36).slice(2, 8)}`): ChatEvent[] => [
  { type: "tool_call", call: { id, name, input } }, { type: "end", stopReason: "tool_use", usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } },
];
const say = (text: string): ChatEvent[] => [{ type: "text", delta: text }, { type: "end", stopReason: "end", usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 } }];

async function run(ctx: TenantCtx, message: string, opts: { conversationId?: string | null; mode?: string } = {}) {
  const events: AssistantEvent[] = [];
  for await (const ev of runAssistantTurn(ctx, { message, conversationId: opts.conversationId ?? null, mode: opts.mode })) events.push(ev);
  const text = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
  const start = events.find((e) => e.type === "start") as Extract<AssistantEvent, { type: "start" }> | undefined;
  const done = events.find((e) => e.type === "done") as Extract<AssistantEvent, { type: "done" }> | undefined;
  return { events, text, start, done, tools: events.filter((e) => e.type === "tool_end") as Extract<AssistantEvent, { type: "tool_end" }>[] };
}
const usageRow = async (turnId: string) => (await ownerPool.query("select * from ai_usage where turn_id = $1", [turnId])).rows[0];

let pm: TenantCtx, admin: TenantCtx, emma: TenantCtx, concierge: TenantCtx, tech: TenantCtx, vendor: TenantCtx, ns: TenantCtx;
const baseConfig = () => ({ ...resolveAiConfig({}), requestsPerMinute: 1000 });

beforeAll(async () => {
  [pm, admin, emma, concierge, tech, vendor, ns] = await Promise.all([
    ctxFor("pm@demo.test"), ctxFor("admin@demo.test"), ctxFor("resident@demo.test"), ctxFor("concierge@demo.test"), ctxFor("staff@demo.test"),
    ctxFor("vendor@demo.test"), ctxFor("admin@northshore.test", "northshore-strata"),
  ]);
});
afterEach(() => {
  setChatModelForTests(undefined);
  setAiConfigForTests(baseConfig());
});
afterAll(async () => {
  setChatModelForTests(undefined);
  setAiConfigForTests(undefined);
  await ownerPool.end();
  await closeDb();
});

describe("assistant turn with the demo model", () => {
  it("answers 'overdue across my properties' from real records and logs everything", async () => {
    setAiConfigForTests(baseConfig());
    setChatModelForTests(new DemoModel());
    const r = await run(pm, "Show me all overdue maintenance requests across my properties");
    expect(r.start).toMatchObject({ demo: true, provider: "demo" });
    expect(r.events.map((e) => e.type)).toEqual(expect.arrayContaining(["start", "status", "tool_start", "tool_end", "text", "done"]));
    const truth = await listWorkOrders(pm, { view: "overdue", pageSize: 1 });
    expect(r.tools[0]).toMatchObject({ tool: "search_work_orders", outcome: "ok" });
    expect(r.text).toContain(`${truth.total} overdue work order`);
    // cards come from the tool data and link to real records
    const firstCard = r.tools[0].display!.records![0];
    expect(firstCard.href).toMatch(/^\/o\/pacific-properties\/maintenance\/[0-9a-f-]{36}$/);
    // persisted: conversation, transcript, tool call log, usage
    const convId = r.start!.conversationId;
    const msgs = (await ownerPool.query("select role, tool_name from ai_messages where conversation_id = $1 order by seq", [convId])).rows;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    const calls = (await ownerPool.query("select tool, outcome, args, risk_class, user_id from ai_tool_calls where turn_id = $1", [r.done!.turnId])).rows;
    expect(calls).toEqual([{ tool: "search_work_orders", outcome: "ok", args: { view: "overdue" }, risk_class: 1, user_id: pm.principal.userId }]);
    expect(await usageRow(r.done!.turnId)).toMatchObject({ provider: "demo", outcome: "ok", model_calls: 2, tool_calls: 1, est_cost_usd: "0.000000" });
  });

  it("continues a conversation and replays history to the model", async () => {
    setChatModelForTests(new DemoModel());
    const first = await run(pm, "Show open work orders at Harbour Centre");
    const convId = first.start!.conversationId;
    const scripted = new ScriptedModel([() => say("Here's a follow-up.")]);
    setChatModelForTests(scripted);
    const second = await run(pm, "And which of those are urgent?", { conversationId: convId });
    expect(second.start!.conversationId).toBe(convId);
    const roles = scripted.requests[0].messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    const view = await getConversationView(pm, convId);
    expect(view.turns).toHaveLength(2);
    expect(view.turns[0].steps[0]).toMatchObject({ tool: "search_work_orders", outcome: "ok" });
    expect(view.turns[1].answer).toBe("Here's a follow-up.");
  });

  it("a resident asking for other residents is refused without any lookup", async () => {
    setChatModelForTests(new DemoModel());
    const r = await run(emma, "Show me all residents in another building");
    expect(r.tools).toHaveLength(0);
    expect(r.text).toMatch(/can't look up other residents/);
    expect(r.done!.outcome).toBe("ok");
  });
});

describe("tools are permission-filtered and re-checked", () => {
  it("offers each role only the tools it may use", () => {
    const names = (c: TenantCtx) => toolsForPrincipal(c.principal).map((t) => t.name);
    expect(names(emma)).not.toEqual(expect.arrayContaining(["search_residents"]));
    expect(names(emma)).toEqual(expect.arrayContaining(["my_home", "search_packages", "check_amenity_availability"]));
    expect(names(emma)).not.toContain("vendor_performance");
    expect(names(emma)).not.toContain("ops_kpis");
    expect(names(tech)).not.toContain("search_residents");
    expect(names(concierge)).toContain("search_residents");
    expect(names(pm)).toEqual(expect.arrayContaining(["vendor_performance", "ops_kpis", "search_residents", "asset_history"]));
    expect(names(vendor)).toEqual([]); // no ai.use
  });

  it("refuses the assistant to roles without ai.use", async () => {
    await expect(run(vendor, "Show me my jobs")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a model calling a tool it wasn't offered gets UNKNOWN_TOOL and no data", async () => {
    const model = new ScriptedModel([() => toolCall("search_residents", { q: "Smith" }), () => say("I can't access that.")]);
    setChatModelForTests(model);
    const r = await run(emma, "Find Smith");
    expect(model.requests[0].tools.map((t) => t.name)).not.toContain("search_residents");
    expect(r.tools[0]).toMatchObject({ tool: "search_residents", outcome: "unknown_tool", display: null });
    const toolMsg = model.requests[1].messages.at(-1)!;
    expect(toolMsg).toMatchObject({ role: "tool", isError: true });
    expect(toolMsg.role === "tool" && JSON.parse(toolMsg.content)).toMatchObject({ ok: false, code: "UNKNOWN_TOOL" });
  });

  it("a place outside the user's scope is 'not found', never revealed", async () => {
    const model = new ScriptedModel([() => toolCall("search_packages", { location: "Harbour Centre" }), () => say("ok")]);
    setChatModelForTests(model);
    const r = await run(concierge, "Packages at Harbour Centre?");
    expect(r.tools[0]).toMatchObject({ outcome: "not_found" });
    expect(r.tools[0].summary).toMatch(/couldn't find a property or building called "Harbour Centre"/);
  });

  it("results stay within scope (front desk at Fraser Towers)", async () => {
    const model = new ScriptedModel([() => toolCall("search_packages", { view: "all", limit: 25 }), () => say("done")]);
    setChatModelForTests(model);
    await run(concierge, "All packages");
    const content = JSON.parse((model.requests[1].messages.at(-1) as { content: string }).content);
    expect(content.ok).toBe(true);
    expect(content.items.length).toBeGreaterThan(0);
    expect(new Set(content.items.map((i: { property: string }) => i.property))).toEqual(new Set(["Fraser Towers"]));
  });

  it("invalid arguments come back to the model as INVALID", async () => {
    const model = new ScriptedModel([() => toolCall("search_work_orders", { view: "sideways", limit: 500 }), () => say("Let me try again.")]);
    setChatModelForTests(model);
    const r = await run(pm, "x");
    expect(r.tools[0]).toMatchObject({ outcome: "invalid" });
    expect(r.tools[0].summary).toMatch(/view|limit/);
    expect(r.text).toBe("Let me try again.");
  });

  it("ambiguous references come back as a question to ask, with options", async () => {
    const model = new ScriptedModel([() => toolCall("check_amenity_availability", { amenity: "gym", date: "2026-12-01" }), () => say("Which gym?")]);
    setChatModelForTests(model);
    const r = await run(admin, "gym tomorrow?");
    expect(r.tools[0].outcome).toBe("ambiguous");
    const res = JSON.parse((model.requests[1].messages.at(-1) as { content: string }).content);
    expect(res.options).toEqual(expect.arrayContaining(["Fitness Centre · Fraser Towers", "Gym · Harbour Centre"]));
  });

  it("directory lookups by the assistant are audit-logged as AI reads", async () => {
    setChatModelForTests(new ScriptedModel([() => toolCall("search_residents", { unit: "1204", location: "Tower B" }), () => say("Found them.")]));
    const r = await run(concierge, "Who lives in 1204?");
    expect(r.tools[0]).toMatchObject({ tool: "search_residents", outcome: "ok" });
    const audit = (await ownerPool.query("select action, ai_generated, after, actor_user_id from audit_logs where entity_type = 'ai_tool_call' order by created_at desc limit 1")).rows[0];
    expect(audit).toMatchObject({ action: "ai.sensitive_read", ai_generated: true, actor_user_id: concierge.principal.userId });
    expect(audit.after).toMatchObject({ tool: "search_residents", args: { unit: "1204", location: "Tower B" } });
  });
});

describe("limits, failures and cost", () => {
  it("stops after the step limit", async () => {
    setAiConfigForTests({ ...baseConfig(), maxSteps: 2 });
    setChatModelForTests(new ScriptedModel([() => toolCall("search_tasks", {}), () => toolCall("search_tasks", {}), () => say("never")]));
    const r = await run(pm, "loop");
    expect(r.done!.outcome).toBe("step_limit");
    expect(r.text).toMatch(/stopped after several lookups/);
    expect(await usageRow(r.done!.turnId)).toMatchObject({ outcome: "step_limit", tool_calls: 2, model_calls: 2 });
  });

  it("retries once on a retryable provider error", async () => {
    let attempts = 0;
    setChatModelForTests(new ScriptedModel([
      () => { attempts++; throw new ProviderError("overloaded", 529, true); },
      () => { attempts++; return say("Recovered."); },
    ]));
    const r = await run(pm, "hello");
    expect(attempts).toBe(2);
    expect(r.text).toBe("Recovered.");
    expect(r.done!.outcome).toBe("ok");
  });

  it("reports a non-retryable provider failure without leaking details", async () => {
    setChatModelForTests(new ScriptedModel([() => { throw new ProviderError("Anthropic returned 401: invalid x-api-key", 401, false); }]));
    const r = await run(pm, "hello");
    const err = r.events.find((e) => e.type === "error") as { message: string; code: string };
    expect(err).toMatchObject({ code: "provider" });
    expect(err.message).not.toMatch(/api-key|401/);
    expect(await usageRow(r.done!.turnId)).toMatchObject({ outcome: "error" });
  });

  it("times out a hung model", async () => {
    setAiConfigForTests({ ...baseConfig(), timeoutMs: 300 });
    setChatModelForTests(new ScriptedModel([(req) => new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted"))))]));
    const r = await run(pm, "slow");
    expect(r.events.find((e) => e.type === "error")).toMatchObject({ code: "timeout" });
    expect(r.done!.outcome).toBe("timeout");
  });

  it("estimates cost from token usage for priced models", async () => {
    setChatModelForTests(new ScriptedModel([() => say("Hi.")], "claude-haiku-4-5-20251001"));
    const r = await run(pm, "hello");
    // 1,200 input tokens at $1/M + 80 output at $5/M
    expect(await usageRow(r.done!.turnId)).toMatchObject({ provider: "scripted", input_tokens: 1200, output_tokens: 80, est_cost_usd: "0.001600" });
  });

  it("rate-limits a user who asks too fast", async () => {
    setAiConfigForTests({ ...baseConfig(), requestsPerMinute: 1 });
    setChatModelForTests(new ScriptedModel([() => say("one"), () => say("two")]));
    const fresh = await ctxFor("council@demo.test");
    await run(fresh, "first");
    const second = await run(fresh, "second");
    expect(second.events[0]).toMatchObject({ type: "notice", code: "rate_limited" });
  });

  it("enforces the organization's monthly request cap before calling the model", async () => {
    const used = (await ownerPool.query("select count(*)::int n from ai_usage where org_id = $1 and outcome not in ('cap_reached','disabled')", [pm.principal.orgId])).rows[0].n;
    await updateAiSettings(admin, { enabled: true, monthlyRequestCap: used });
    const model = new ScriptedModel([]);
    setChatModelForTests(model);
    try {
      const r = await run(pm, "anything");
      expect(model.requests).toHaveLength(0);
      expect(r.events.find((e) => e.type === "notice")).toMatchObject({ code: "cap_reached" });
      expect(await usageRow(r.done!.turnId)).toMatchObject({ outcome: "cap_reached", model_calls: 0 });
      // a refused request doesn't count against the cap
      const again = await run(pm, "still?");
      expect(again.events.find((e) => e.type === "notice")).toMatchObject({ code: "cap_reached" });
    } finally {
      await updateAiSettings(admin, { enabled: true, monthlyRequestCap: null });
    }
    const audit = (await ownerPool.query("select after from audit_logs where action = 'ai.settings.updated' order by created_at desc limit 1")).rows[0];
    expect(audit.after).toEqual({ aiEnabled: true, aiMonthlyRequestCap: null });
  });

  it("can be switched off per organization", async () => {
    await updateAiSettings(admin, { enabled: false, monthlyRequestCap: null });
    try {
      setChatModelForTests(new ScriptedModel([]));
      const r = await run(emma, "Do I have packages?");
      expect(r.events.find((e) => e.type === "notice")).toMatchObject({ code: "disabled" });
    } finally {
      await updateAiSettings(admin, { enabled: true, monthlyRequestCap: null });
    }
  });

  it("only AI admins can change settings or see usage", async () => {
    await expect(updateAiSettings(pm, { enabled: false, monthlyRequestCap: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(usageOverview(pm)).rejects.toBeInstanceOf(ForbiddenError);
    const u = await usageOverview(admin);
    expect(u.totals.requests).toBeGreaterThan(0);
    expect(u.byTool.map((t) => t.tool)).toContain("search_work_orders");
    // usage is per organization
    const nsUsage = await usageOverview(ns);
    expect(nsUsage.recent.every((x) => x.userName !== "Marcus Chen")).toBe(true);
  });
});

describe("conversations are private", () => {
  it("another user in the same org can't open, list or continue someone else's conversation", async () => {
    setChatModelForTests(new DemoModel());
    const r = await run(pm, "Show unassigned work orders");
    const id = r.start!.conversationId;
    await expect(getConversationView(admin, id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listConversations(admin)).some((c) => c.id === id)).toBe(false);
    await expect(run(admin, "and now?", { conversationId: id })).rejects.toBeInstanceOf(NotFoundError);
    // and nothing is visible at the database level either
    await asApp({ orgId: admin.principal.orgId, userId: admin.principal.userId }, async (q) => {
      expect((await q("select count(*)::int n from ai_messages where conversation_id = $1", [id])).rows[0].n).toBe(0);
    });
    await archiveConversation(pm, id);
    await expect(getConversationView(pm, id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("validates input", async () => {
    await expect(run(pm, "   ")).rejects.toBeInstanceOf(ValidationError);
    await expect(run(pm, "x".repeat(4001))).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("AI evaluation suite (demo model)", () => {
  it.each(EVAL_CASES.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    setAiConfigForTests(baseConfig());
    setChatModelForTests(new DemoModel());
    const result = await runEvalCase(c);
    expect(checkEvalCase(c, result)).toEqual([]);
  });
});

it("the configured provider is demo in tests unless a key is set", () => {
  expect(aiConfig().provider.kind).toBe("demo");
  void ZERO_USAGE;
});
