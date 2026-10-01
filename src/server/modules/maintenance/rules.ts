// pure maintenance rules: no I/O, fully unit-tested

export const WO_STATUSES = ["new", "acknowledged", "assigned", "scheduled", "in_progress", "awaiting_vendor", "awaiting_resident", "completed", "closed", "cancelled"] as const;
export type WoStatus = (typeof WO_STATUSES)[number];
export const OPEN_STATUSES: WoStatus[] = ["new", "acknowledged", "assigned", "scheduled", "in_progress", "awaiting_vendor", "awaiting_resident"];

export const WO_CATEGORIES = [
  "plumbing", "electrical", "hvac", "appliance", "elevator", "doors_locks", "pest", "cleaning", "structural",
  "exterior", "fire_safety", "parking", "general",
] as const;
export const PRIORITY_ORDER = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITY_ORDER)[number];

// allowed next states
const TRANSITIONS: Record<WoStatus, WoStatus[]> = {
  new: ["acknowledged", "assigned", "scheduled", "in_progress", "cancelled"],
  acknowledged: ["assigned", "scheduled", "in_progress", "cancelled"],
  assigned: ["acknowledged", "scheduled", "in_progress", "awaiting_vendor", "cancelled"],
  scheduled: ["in_progress", "awaiting_vendor", "awaiting_resident", "assigned", "cancelled"],
  in_progress: ["scheduled", "awaiting_vendor", "awaiting_resident", "completed"],
  awaiting_vendor: ["scheduled", "in_progress", "completed", "cancelled"],
  awaiting_resident: ["scheduled", "in_progress", "completed", "cancelled"],
  completed: ["closed", "in_progress"],
  closed: ["in_progress"],
  cancelled: [],
};

// the people doing the work may only move it along; triage, cancel, close and reopen belong to managers
const WORKER_TARGETS: WoStatus[] = ["scheduled", "in_progress", "awaiting_vendor", "awaiting_resident", "completed"];

export type WoActor = "manager" | "worker" | "requester";

export function allowedTransitions(from: WoStatus, actor: WoActor): WoStatus[] {
  const next = TRANSITIONS[from] ?? [];
  if (actor === "manager") return next;
  if (actor === "worker") {
    // reopening completed work is a manager decision
    if (from === "completed" || from === "closed") return [];
    return next.filter((s) => WORKER_TARGETS.includes(s));
  }
  // requesters can withdraw a request before work starts
  return ["new", "acknowledged"].includes(from) ? next.filter((s) => s === "cancelled") : [];
}

export function canTransition(from: WoStatus, to: WoStatus, actor: WoActor): boolean {
  return allowedTransitions(from, actor).includes(to);
}

export const isOpen = (s: string) => (OPEN_STATUSES as string[]).includes(s);

/* ───── triage ───── */

export type TriageRule = {
  id: string; name: string; keywords: string[]; category: string | null; propertyId: string | null;
  setPriority: string | null; setEmergency: boolean; setCategory: string | null;
  assignMembershipId: string | null; assignVendorId: string | null; residentInstructions: string | null; position: number; active: boolean;
};

export type TriageOutcome = {
  priority: Priority | null; isEmergency: boolean; category: string | null;
  assignMembershipId: string | null; assignVendorId: string | null; instructions: string[]; matched: { id: string; name: string }[];
};

const norm = (s: string) => ` ${s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim()} `;

// keyword match on whole words/phrases; a rule matches when its category (if set) matches and any keyword (if set) matches
export function ruleMatches(rule: TriageRule, text: string, category: string, propertyId: string): boolean {
  if (!rule.active) return false;
  if (rule.propertyId && rule.propertyId !== propertyId) return false;
  if (rule.category && rule.category !== category) return false;
  if (rule.keywords.length === 0) return !!rule.category;
  const hay = norm(text);
  return rule.keywords.some((k) => {
    const n = norm(k);
    return n.trim().length > 0 && hay.includes(n);
  });
}

// applies matching rules in order: property-specific before org-wide, then by position; highest priority and any emergency win
export function evaluateTriage(rules: TriageRule[], text: string, category: string, propertyId: string): TriageOutcome {
  const ordered = [...rules].sort((a, b) => Number(!!b.propertyId) - Number(!!a.propertyId) || a.position - b.position);
  const out: TriageOutcome = { priority: null, isEmergency: false, category: null, assignMembershipId: null, assignVendorId: null, instructions: [], matched: [] };
  for (const r of ordered) {
    if (!ruleMatches(r, text, category, propertyId)) continue;
    out.matched.push({ id: r.id, name: r.name });
    if (r.setPriority && (!out.priority || PRIORITY_ORDER.indexOf(r.setPriority as Priority) > PRIORITY_ORDER.indexOf(out.priority))) out.priority = r.setPriority as Priority;
    if (r.setEmergency) out.isEmergency = true;
    out.category ??= r.setCategory;
    if (!out.assignMembershipId && !out.assignVendorId) {
      out.assignMembershipId = r.assignMembershipId;
      out.assignVendorId = r.assignVendorId;
    }
    if (r.residentInstructions) out.instructions.push(r.residentInstructions);
  }
  if (out.isEmergency) out.priority = "urgent";
  return out;
}

/* ───── SLA ───── */

export type SlaPolicy = { propertyId: string | null; priority: string; respondMinutes: number; resolveMinutes: number };

// built-in defaults used when an org hasn't configured policies
export const DEFAULT_SLA: Record<Priority, { respond: number; resolve: number }> = {
  urgent: { respond: 60, resolve: 24 * 60 },
  high: { respond: 4 * 60, resolve: 3 * 24 * 60 },
  normal: { respond: 24 * 60, resolve: 7 * 24 * 60 },
  low: { respond: 3 * 24 * 60, resolve: 14 * 24 * 60 },
};

export function slaFor(policies: SlaPolicy[], propertyId: string, priority: Priority) {
  const p = policies.find((x) => x.propertyId === propertyId && x.priority === priority)
    ?? policies.find((x) => x.propertyId === null && x.priority === priority);
  return p ? { respond: p.respondMinutes, resolve: p.resolveMinutes } : DEFAULT_SLA[priority];
}

export function dueDates(createdAt: Date, sla: { respond: number; resolve: number }) {
  return { respondDueAt: new Date(createdAt.getTime() + sla.respond * 60_000), resolveDueAt: new Date(createdAt.getTime() + sla.resolve * 60_000) };
}

export const isOverdue = (status: string, resolveDueAt: Date | null, now = new Date()) => isOpen(status) && !!resolveDueAt && resolveDueAt < now;
