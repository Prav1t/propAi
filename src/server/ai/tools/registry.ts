import "server-only";
import { z } from "zod";
import type { Principal } from "../../authz/authorize";
import type { TenantCtx } from "../../modules/context";
import type { ToolSpec } from "../types";
import type { ToolName } from "./names";
import type { Tone } from "@/lib/labels";
import type { PolicyKey, RiskClass } from "../policy";

export type { Tone };

// What a tool returns to the model. Everything in it comes from the database through the domain services.
export type ToolOk = {
  ok: true;
  summary: string; // one factual sentence built from the data ("3 overdue work orders across 2 properties.")
  count?: number; // total matches, which may exceed the items shown
  items?: Record<string, unknown>[]; // compact rows, each with a ref and an href the answer can link to
  facts?: Record<string, unknown>; // aggregates, rules, opening hours…
  highlights?: string[]; // ready-to-read lines (markdown links allowed) — the demo model answers with these
  note?: string;
  status?: "awaiting_approval" | "executed"; // action tools only
  record?: { ref: string; title: string; href: string }; // action tools: what was created or changed
};
export type ToolErrCode = "FORBIDDEN" | "NOT_FOUND" | "AMBIGUOUS" | "INVALID" | "ERROR" | "UNKNOWN_TOOL" | "POLICY_DENIED";
export type ToolErr = { ok: false; code: ToolErrCode; message: string; options?: string[] };
export type ToolResult = ToolOk | ToolErr;

// what the UI renders for a tool call — built from the same data, never from model text
export type RecordCard = { ref: string; title: string; sub?: string; href: string; badges?: { label: string; tone: Tone }[] };
export type ToolDisplay = { records?: RecordCard[]; metrics?: { label: string; value: string; tone?: Tone }[]; more?: { label: string; href: string } };

export type ToolEnv = { now: Date; today: string; timeZone: string; orgSlug: string; href: (path: string) => string };

export function makeToolEnv(orgSlug: string, timeZone: string, now = new Date()): ToolEnv {
  return { now, today: new Intl.DateTimeFormat("en-CA", { timeZone }).format(now), timeZone, orgSlug, href: (path) => `/o/${orgSlug}${path}` };
}

export type ToolOutput = { result: ToolResult; display?: ToolDisplay };

// read tools (risk class 1) run immediately
export type ReadToolDef<S extends z.ZodType = z.ZodType> = {
  kind?: "read";
  name: ToolName;
  title: string; // status label shown while it runs: "Looking up work orders"
  description: string; // for the model
  input: S;
  available: (p: Principal) => boolean; // coarse gate: is the tool offered to this principal at all
  riskClass: 1;
  sensitive?: boolean; // reads personal data → an audit entry per call
  execute: (ctx: TenantCtx, args: z.infer<S>, env: ToolEnv) => Promise<ToolOutput>;
};

/* ───────────── action tools (Iteration 7) ───────────── */

// a field the user may change on a prepared step before approving it (keys are tool input keys)
export type EditableField = {
  key: string; label: string; type: "text" | "textarea" | "date" | "time" | "number" | "select";
  options?: { value: string; label: string }[];
};

// what prepare() works out without changing anything
export type PreparedStep = {
  title: string; // "Create work order “Broken elevator”"
  details: string[]; // facts the approver should see: where, when, who
  effects: string[]; // side effects: "Summit Elevator Services is notified"
  resolved: Record<string, unknown>; // ids and normalised values execute() will use — never re-resolved from text
  propertyId: string | null; // for property-level policy rules
  draft?: { title?: string; body: string }; // communications are shown in full
};

// warning: the main change happened but a follow-on part didn't (e.g. created, but the assignment failed)
export type ActionOutcome = { summary: string; record?: { ref: string; title: string; href: string }; check?: Record<string, unknown>; warning?: string };

export type ActionDef<S extends z.ZodType = z.ZodType> = {
  kind: "action";
  name: ToolName;
  title: string; // status label while preparing: "Preparing a work order"
  description: string;
  input: S;
  available: (p: Principal) => boolean;
  riskClass: (args: z.infer<S>, p: Principal) => RiskClass;
  policyKeys: (args: z.infer<S>, p: Principal) => PolicyKey[];
  editable: EditableField[];
  // resolve and validate (incl. dry runs of the real rules); no writes
  prepare: (ctx: TenantCtx, args: z.infer<S>, env: ToolEnv) => Promise<{ ok: true; step: PreparedStep } | ToolErr>;
  // run the same domain services as the UI, with ctx.ai set so audit rows say the assistant did it
  execute: (ctx: TenantCtx, resolved: Record<string, unknown>, env: ToolEnv) => Promise<ActionOutcome>;
  // re-read what was written and confirm it matches the plan
  verify: (ctx: TenantCtx, outcome: ActionOutcome, resolved: Record<string, unknown>, env: ToolEnv) => Promise<{ ok: boolean; summary: string }>;
};

export type ToolDef = ReadToolDef | ActionDef;
export const isAction = (t: ToolDef): t is ActionDef => t.kind === "action";

export function defineTool<S extends z.ZodType>(def: ReadToolDef<S>): ReadToolDef<S> {
  return def;
}
export function defineAction<S extends z.ZodType>(def: Omit<ActionDef<S>, "kind">): ActionDef<S> {
  return { kind: "action", ...def };
}

export const anyPerm = (...perms: string[]) => (p: Principal) => perms.some((x) => p.permissions.has(x));

// JSON Schema the providers receive; zod 4 converts natively
export function toolSpec(t: { name: string; description: string; input: z.ZodType }): ToolSpec {
  const schema = z.toJSONSchema(t.input, { target: "draft-7", io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete schema.$schema;
  return { name: t.name, description: t.description, inputSchema: schema };
}

export const ok = (summary: string, rest: Omit<ToolOk, "ok" | "summary"> = {}): ToolOk => ({ ok: true, summary, ...rest });
export const err = (code: ToolErrCode, message: string, options?: string[]): ToolErr => ({ ok: false, code, message, ...(options ? { options } : {}) });

// "1 work order" / "3 work orders"
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
