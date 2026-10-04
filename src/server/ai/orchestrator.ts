import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { aiConversations, aiMessages, aiToolCalls, aiUsage, buildings, organizations, properties, units, users } from "../db/schema";
import type { Tx } from "../db/client";
import { ForbiddenError, NotFoundError } from "../authz/authorize";
import { tenantTx, ValidationError, type TenantCtx } from "../modules/context";
import { visiblePropertyIds } from "../modules/scope";
import { writeAudit } from "../audit";
import { log as logger } from "../log";
import { rateLimiter } from "../auth/rate-limit";
import { aiConfig } from "./config";
import { routeModel } from "./providers";
import { estimateCostUsd, priceFor } from "./pricing";
import { buildSystemPrompt } from "./prompt";
import { MODES, pickMode, type AiMode } from "./modes";
import { createConversation, historyForModel, loadConversation, maxSeq } from "./store";
import { readAiSettings, requestsThisMonth } from "./usage";
import { toolsForPrincipal } from "./tools";
import { err, toolSpec, type ToolDef, type ToolDisplay, type ToolEnv, type ToolResult } from "./tools/registry";
import { addUsage, ProviderError, ZERO_USAGE, type ChatMessage, type StopReason, type ToolCall, type Usage } from "./types";

export type AssistantEvent =
  | { type: "start"; conversationId: string; turnId: string; title: string; mode: AiMode; demo: boolean; provider: string; model: string }
  | { type: "status"; label: string }
  | { type: "tool_start"; callId: string; tool: string; title: string }
  | { type: "tool_end"; callId: string; tool: string; title: string; outcome: string; summary: string | null; display: ToolDisplay | null }
  | { type: "text"; delta: string }
  | { type: "notice"; code: "cap_reached" | "disabled" | "rate_limited"; message: string }
  | { type: "error"; code: "provider" | "timeout" | "internal"; message: string }
  | { type: "done"; turnId: string; outcome: string };

const MAX_RESULT_CHARS = 16_000;
const OUTCOME: Record<string, string> = { FORBIDDEN: "denied", NOT_FOUND: "not_found", AMBIGUOUS: "ambiguous", INVALID: "invalid", ERROR: "error", UNKNOWN_TOOL: "unknown_tool" };

const titleFrom = (m: string) => {
  const first = m.split("\n")[0].trim();
  return first.length > 80 ? `${first.slice(0, 77)}…` : first;
};

// tool output as the model sees it; long item lists are trimmed rather than cut mid-JSON
export function serializeResult(r: ToolResult): string {
  let s = JSON.stringify(r);
  if (s.length <= MAX_RESULT_CHARS || !r.ok || !r.items) return s.length <= MAX_RESULT_CHARS ? s : s.slice(0, MAX_RESULT_CHARS);
  let items = r.items;
  while (s.length > MAX_RESULT_CHARS && items.length > 1) {
    items = items.slice(0, Math.ceil(items.length / 2));
    s = JSON.stringify({ ...r, items, highlights: r.highlights?.slice(0, items.length), note: `Showing ${items.length} of ${r.count ?? "many"}.` });
  }
  return s;
}

export type ToolRun = { result: ToolResult; display: ToolDisplay | null; outcome: string; durationMs: number; args: unknown; def: ToolDef | null };

// validate → execute through the domain services → map errors to stable codes; never throws
export async function executeToolCall(ctx: TenantCtx, allowed: ToolDef[], call: ToolCall, env: ToolEnv): Promise<ToolRun> {
  const t0 = Date.now();
  const done = (result: ToolResult, display: ToolDisplay | null, def: ToolDef | null, args: unknown): ToolRun =>
    ({ result, display, def, args, durationMs: Date.now() - t0, outcome: result.ok ? "ok" : OUTCOME[result.code] ?? "error" });
  const def = allowed.find((t) => t.name === call.name) ?? null;
  if (!def) return done(err("UNKNOWN_TOOL", `No tool called "${call.name}" is available to this user.`), null, null, call.input);
  if ("__invalid" in call.input) return done(err("INVALID", "The tool arguments were not valid JSON."), null, def, call.input);
  const parsed = def.input.safeParse(call.input);
  if (!parsed.success) {
    const why = parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return done(err("INVALID", `Invalid arguments — ${why}`), null, def, call.input);
  }
  try {
    const out = await def.execute(ctx, parsed.data, env);
    return done(out.result, out.display ?? null, def, parsed.data);
  } catch (e) {
    if (e instanceof ForbiddenError) return done(err("FORBIDDEN", "You don't have access to that."), null, def, parsed.data);
    if (e instanceof NotFoundError) return done(err("NOT_FOUND", "Not found among the records you can see."), null, def, parsed.data);
    if (e instanceof ValidationError) return done(err("INVALID", e.message), null, def, parsed.data);
    logger.error("ai.tool_failed", { tool: call.name, error: e instanceof Error ? e.message : String(e) });
    return done(err("ERROR", "The lookup failed. Try again or ask differently."), null, def, parsed.data);
  }
}

async function placesFor(tx: Tx, ctx: TenantCtx): Promise<string[]> {
  const p = ctx.principal;
  if (p.role.category === "resident") {
    if (!p.unitIds.size) return [];
    const rows = await tx.select({ n: units.number, b: buildings.name, pr: properties.name }).from(units)
      .innerJoin(buildings, eq(buildings.id, units.buildingId)).innerJoin(properties, eq(properties.id, units.propertyId))
      .where(and(eq(units.orgId, p.orgId), inArray(units.id, [...p.unitIds]))).orderBy(asc(units.number));
    return rows.map((r) => `Unit ${r.n} · ${r.b} · ${r.pr}`);
  }
  const ids = visiblePropertyIds(p);
  const rows = await tx.select({ name: properties.name }).from(properties)
    .where(and(eq(properties.orgId, p.orgId), ids === null ? undefined : ids.length ? inArray(properties.id, ids) : sql`false`)).orderBy(asc(properties.name)).limit(40);
  return rows.map((r) => r.name);
}

export async function* runAssistantTurn(
  ctx: TenantCtx,
  input: { conversationId?: string | null; message: string; mode?: string | null },
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<AssistantEvent> {
  const p = ctx.principal;
  if (!p.permissions.has("ai.use")) throw new ForbiddenError();
  const message = input.message.trim();
  if (!message) throw new ValidationError("Type a question first.");
  if (message.length > 4000) throw new ValidationError("That message is too long — keep it under 4,000 characters.");
  const cfg = aiConfig();
  const turnId = randomUUID();
  const started = Date.now();
  const now = new Date();

  const limited = await rateLimiter().hit(`ai:${p.orgId}:${p.userId}`, cfg.requestsPerMinute, 60_000);
  if (!limited.allowed) {
    yield { type: "notice", code: "rate_limited", message: "You're sending questions faster than the assistant allows. Wait a minute and try again." };
    return;
  }

  const model = routeModel("chat", cfg);
  const setup = await tenantTx(ctx, async (tx) => {
    const [org] = await tx.select({ name: organizations.name, timezone: organizations.timezone, settings: organizations.settings }).from(organizations).where(eq(organizations.id, p.orgId));
    const [me] = await tx.select({ name: users.name }).from(users).where(eq(users.id, p.userId));
    const conv = input.conversationId
      ? await loadConversation(tx, ctx, input.conversationId)
      : await createConversation(tx, ctx, { mode: pickMode(p, input.mode), title: titleFrom(message) });
    const settings = readAiSettings(org.settings);
    let refusal: { code: "disabled" | "cap_reached"; message: string } | null = null;
    if (!settings.enabled) refusal = { code: "disabled", message: "The assistant is switched off for your organization. An administrator can turn it on in Organization → AI assistant." };
    else if (settings.monthlyRequestCap !== null && (await requestsThisMonth(tx, p.orgId, org.timezone)) >= settings.monthlyRequestCap) {
      refusal = { code: "cap_reached", message: `Your organization has used this month's ${settings.monthlyRequestCap.toLocaleString("en-CA")} assistant requests. An administrator can raise the limit in Organization → AI assistant.` };
    }
    const history = refusal ? [] : await historyForModel(tx, conv.id);
    const seq = (await maxSeq(tx, conv.id)) + 1;
    await tx.insert(aiMessages).values({ orgId: p.orgId, conversationId: conv.id, userId: p.userId, turnId, seq, role: "user", content: message });
    await tx.update(aiConversations).set({ lastMessageAt: now }).where(eq(aiConversations.id, conv.id));
    const places = refusal ? [] : await placesFor(tx, ctx);
    return { org, userName: me?.name ?? "the user", conv, refusal, history, seq, places };
  });

  const mode = pickMode(p, setup.conv.mode);
  yield { type: "start", conversationId: setup.conv.id, turnId, title: setup.conv.title, mode, demo: model.demo, provider: model.provider, model: model.model };

  let seq = setup.seq;
  const persist = (fn: (tx: Tx) => Promise<unknown>) => tenantTx(ctx, fn);
  const tz = setup.org.timezone;
  const usageRow = async (outcome: string, usage: Usage, modelCalls: number, toolCalls: number) => {
    const cost = model.demo ? 0 : estimateCostUsd(usage, priceFor(model.model, cfg.priceOverride));
    try {
      await persist(async (tx) => {
        await tx.insert(aiUsage).values({
          orgId: p.orgId, userId: p.userId, conversationId: setup.conv.id, turnId, provider: model.provider, model: model.model,
          inputTokens: usage.inputTokens + usage.cacheWriteTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cacheReadTokens,
          modelCalls, toolCalls, estCostUsd: cost === null ? null : cost.toFixed(6), latencyMs: Date.now() - started, outcome,
        });
        await tx.update(aiConversations).set({ lastMessageAt: new Date() }).where(eq(aiConversations.id, setup.conv.id));
      });
    } catch (e) {
      logger.error("ai.usage_write_failed", { error: e instanceof Error ? e.message : String(e) });
    }
  };

  if (setup.refusal) {
    await persist((tx) => tx.insert(aiMessages).values({ orgId: p.orgId, conversationId: setup.conv.id, userId: p.userId, turnId, seq: ++seq, role: "assistant", content: setup.refusal!.message, provider: "system", model: "policy" }));
    await usageRow(setup.refusal.code, { ...ZERO_USAGE }, 0, 0);
    yield { type: "notice", code: setup.refusal.code, message: setup.refusal.message };
    yield { type: "done", turnId, outcome: setup.refusal.code };
    return;
  }

  const tools = toolsForPrincipal(p, MODES[mode].tools ?? undefined);
  const specs = tools.map(toolSpec);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  const resident = p.role.category === "resident";
  const env: ToolEnv = { now, today, timeZone: tz, orgSlug: p.orgSlug, href: (path) => `/o/${p.orgSlug}${path}` };
  const system = buildSystemPrompt({ principal: p, userName: setup.userName, orgName: setup.org.name, timeZone: tz, now, mode, places: setup.places });
  const messages: ChatMessage[] = [...setup.history, { role: "user", content: message }];

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("timeout"));
  }, cfg.timeoutMs);
  const onAbort = () => controller.abort(opts.signal?.reason ?? new Error("client closed"));
  opts.signal?.addEventListener("abort", onAbort);

  let usage: Usage = { ...ZERO_USAGE };
  let modelCalls = 0;
  let toolCalls = 0;
  let outcome = "ok";
  try {
    for (let step = 0; ; step++) {
      if (step >= cfg.maxSteps) {
        outcome = "step_limit";
        const note = "I stopped after several lookups without reaching an answer. Try a narrower question.";
        yield { type: "text", delta: note };
        await persist((tx) => tx.insert(aiMessages).values({ orgId: p.orgId, conversationId: setup.conv.id, userId: p.userId, turnId, seq: ++seq, role: "assistant", content: note, provider: model.provider, model: model.model }));
        break;
      }
      yield { type: "status", label: step === 0 ? "Thinking" : "Reading the results" };
      let text = "";
      const calls: ToolCall[] = [];
      let stop: StopReason = "other";
      for (let attempt = 0; ; attempt++) {
        try {
          modelCalls++;
          for await (const ev of model.stream({ system, messages, tools: specs, maxTokens: cfg.maxOutputTokens, temperature: cfg.temperature, signal: controller.signal, hints: { today, timeZone: tz, resident, orgSlug: p.orgSlug } })) {
            if (ev.type === "text") {
              text += ev.delta;
              yield { type: "text", delta: ev.delta };
            } else if (ev.type === "tool_call") calls.push(ev.call);
            else {
              stop = ev.stopReason;
              usage = addUsage(usage, ev.usage);
            }
          }
          break;
        } catch (e) {
          // one retry for overloads/rate limits, only if nothing reached the user yet
          if (e instanceof ProviderError && e.retryable && attempt === 0 && !text && !calls.length && !controller.signal.aborted) {
            await new Promise((r) => setTimeout(r, 800));
            continue;
          }
          throw e;
        }
      }
      if (stop === "max_tokens" && !calls.length) text += text ? "\n\n(The answer was cut short.)" : "";
      const assistantSeq = ++seq;
      await persist((tx) => tx.insert(aiMessages).values({
        orgId: p.orgId, conversationId: setup.conv.id, userId: p.userId, turnId, seq: assistantSeq, role: "assistant", content: text,
        toolCalls: calls.length ? calls : null, provider: model.provider, model: model.model,
      }));
      messages.push({ role: "assistant", content: text, ...(calls.length ? { toolCalls: calls } : {}) });
      if (!calls.length) break;

      for (const call of calls) {
        toolCalls++;
        const def = tools.find((t) => t.name === call.name);
        const title = def?.title ?? "Looking something up";
        yield { type: "status", label: title };
        yield { type: "tool_start", callId: call.id, tool: call.name, title };
        const run = await executeToolCall(ctx, tools, call, env);
        const content = serializeResult(run.result);
        const resultSeq = ++seq;
        const summary = run.result.ok ? run.result.summary : run.result.message;
        await persist(async (tx) => {
          await tx.insert(aiMessages).values({
            orgId: p.orgId, conversationId: setup.conv.id, userId: p.userId, turnId, seq: resultSeq, role: "tool", content,
            toolCallId: call.id, toolName: call.name, isError: !run.result.ok,
          });
          const [row] = await tx.insert(aiToolCalls).values({
            orgId: p.orgId, userId: p.userId, conversationId: setup.conv.id, turnId, callId: call.id, tool: call.name, riskClass: run.def?.riskClass ?? 1,
            args: truncateJson(run.args), outcome: run.outcome, errorMessage: run.result.ok ? null : run.result.message.slice(0, 500),
            summary: summary.slice(0, 500), resultCount: run.result.ok ? run.result.count ?? null : null, display: run.display, durationMs: run.durationMs,
          }).returning({ id: aiToolCalls.id });
          // personal data read on the user's behalf is audited like any other access
          if (run.def?.sensitive && run.result.ok) {
            await writeAudit(tx, {
              orgId: p.orgId, actorUserId: p.userId, action: "ai.sensitive_read", entityType: "ai_tool_call", entityId: row.id,
              after: { tool: call.name, args: run.args, resultCount: run.result.count ?? null }, aiGenerated: true,
            }, ctx.meta);
          }
        });
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content, isError: !run.result.ok });
        yield { type: "tool_end", callId: call.id, tool: call.name, title, outcome: run.outcome, summary, display: run.display };
      }
    }
  } catch (e) {
    outcome = timedOut ? "timeout" : "error";
    const aborted = controller.signal.aborted && !timedOut;
    logger.error("ai.turn_failed", { turnId, provider: model.provider, error: e instanceof Error ? e.message : String(e), aborted });
    if (!aborted) {
      yield timedOut
        ? { type: "error", code: "timeout", message: "That took too long, so I stopped. Please try again." }
        : e instanceof ProviderError
          ? { type: "error", code: "provider", message: "The AI service returned an error. Please try again in a moment." }
          : { type: "error", code: "internal", message: "Something went wrong while answering. Please try again." };
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    await usageRow(outcome, usage, modelCalls, toolCalls);
  }
  yield { type: "done", turnId, outcome };
}

function truncateJson(v: unknown): unknown {
  try {
    const s = JSON.stringify(v ?? {});
    return s.length <= 2000 ? JSON.parse(s) : { truncated: s.slice(0, 2000) };
  } catch {
    return {};
  }
}
