import "server-only";
import { z } from "zod";
import { zonedToUtc } from "@/lib/time";
import { addDaysIso } from "../demo/dates";
import type { TenantCtx } from "../../modules/context";
import { resolvePlace, isErr, type Place } from "./resolve";
import type { ToolEnv, ToolErr } from "./registry";

// shared argument shapes (descriptions are what the model reads)
export const locationArg = z.string().trim().min(1).max(120).optional()
  .describe("Property or building name or code to narrow to, e.g. 'Harbour Centre' or 'Tower B'. Omit for everything you can see.");
export const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
export const limitArg = z.number().int().min(1).max(25).optional().describe("How many records to return (default 10, max 25).");

export const lim = (n: number | undefined, def = 10) => Math.min(25, Math.max(1, n ?? def));

// start of a calendar day in the org time zone, as a UTC instant
export const dayStart = (date: string, env: ToolEnv) => zonedToUtc(`${date}T00:00`, env.timeZone);
export const dayEnd = (date: string, env: ToolEnv) => zonedToUtc(`${addDaysIso(date, 1)}T00:00`, env.timeZone);

export const fmtWhen = (d: Date | null | undefined, env: ToolEnv) =>
  d ? d.toLocaleString("en-CA", { timeZone: env.timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
export const fmtDay = (d: Date | string | null | undefined, env: ToolEnv) =>
  !d ? null : typeof d === "string" ? new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })
    : d.toLocaleDateString("en-CA", { timeZone: env.timeZone, weekday: "short", month: "short", day: "numeric" });

export const label = (s: string | null | undefined) => (s ? s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "");

// "2 days" / "5 h"
export function ago(from: Date, now: Date): string {
  const h = (now.getTime() - from.getTime()) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} days`;
}

// resolves the optional location argument into filters; errors (ambiguous / not found) go straight back to the model
export async function placeFilter(ctx: TenantCtx, location: string | undefined): Promise<{ place: Place | null; propertyId?: string; buildingId?: string } | ToolErr> {
  if (!location) return { place: null };
  const place = await resolvePlace(ctx, location);
  if (isErr(place)) return place;
  if (!place) return { place: null };
  return { place, propertyId: place.propertyId ?? undefined, buildingId: place.buildingId ?? undefined };
}

export const where = (place: Place | null) => (place ? ` at ${place.label}` : "");

// ends a sentence without doubling the period after "p.m."
export const stop = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

// hours as people say them: "5.5 h", "3.2 days"
export const dur = (h: number | null) => (h === null ? "–" : h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round((h / 24) * 10) / 10} days`);
