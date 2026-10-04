import "server-only";
import { z } from "zod";
import type { Principal } from "../../authz/authorize";
import type { TenantCtx } from "../../modules/context";
import type { ToolSpec } from "../types";
import type { ToolName } from "./names";
import type { Tone } from "@/lib/labels";

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
};
export type ToolErrCode = "FORBIDDEN" | "NOT_FOUND" | "AMBIGUOUS" | "INVALID" | "ERROR" | "UNKNOWN_TOOL";
export type ToolErr = { ok: false; code: ToolErrCode; message: string; options?: string[] };
export type ToolResult = ToolOk | ToolErr;

// what the UI renders for a tool call — built from the same data, never from model text
export type RecordCard = { ref: string; title: string; sub?: string; href: string; badges?: { label: string; tone: Tone }[] };
export type ToolDisplay = { records?: RecordCard[]; metrics?: { label: string; value: string; tone?: Tone }[]; more?: { label: string; href: string } };

export type ToolEnv = { now: Date; today: string; timeZone: string; orgSlug: string; href: (path: string) => string };

export type ToolOutput = { result: ToolResult; display?: ToolDisplay };

export type ToolDef<S extends z.ZodType = z.ZodType> = {
  name: ToolName;
  title: string; // status label shown while it runs: "Looking up work orders"
  description: string; // for the model
  input: S;
  available: (p: Principal) => boolean; // coarse gate: is the tool offered to this principal at all
  riskClass: 1 | 2 | 3 | 4 | 5; // every Iteration 6 tool is class 1 (read-only)
  sensitive?: boolean; // reads personal data → an audit entry per call
  execute: (ctx: TenantCtx, args: z.infer<S>, env: ToolEnv) => Promise<ToolOutput>;
};

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export const anyPerm = (...perms: string[]) => (p: Principal) => perms.some((x) => p.permissions.has(x));

// JSON Schema the providers receive; zod 4 converts natively
export function toolSpec(t: ToolDef): ToolSpec {
  const schema = z.toJSONSchema(t.input, { target: "draft-7", io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete schema.$schema;
  return { name: t.name, description: t.description, inputSchema: schema };
}

export const ok = (summary: string, rest: Omit<ToolOk, "ok" | "summary"> = {}): ToolOk => ({ ok: true, summary, ...rest });
export const err = (code: ToolErrCode, message: string, options?: string[]): ToolErr => ({ ok: false, code, message, ...(options ? { options } : {}) });

// "1 work order" / "3 work orders"
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
