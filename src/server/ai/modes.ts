import type { Principal } from "../authz/authorize";
import { AI_MODES } from "../db/schema";
import type { ToolName } from "./tools/names";

// Specialised assistants share one engine; a mode changes the prompt emphasis, the tool subset and the suggestions.
export type AiMode = (typeof AI_MODES)[number];

export type ModeDef = {
  label: string;
  description: string;
  tools: readonly ToolName[] | null; // null = every tool the role may use
  prompt: string;
  suggestions: string[];
  allowed: (p: Principal) => boolean;
};

const has = (p: Principal, ...perms: string[]) => perms.some((x) => p.permissions.has(x));
const staff = (p: Principal) => p.role.category === "staff";

export const MODES: Record<AiMode, ModeDef> = {
  property: {
    label: "Property",
    description: "Everything across your portfolio",
    tools: null,
    prompt: "General property operations across everything the user can see.",
    suggestions: ["Show me all overdue maintenance requests across my properties", "Which vendor has been the slowest this month?", "Summarize today's incidents", "Give me my morning briefing"],
    allowed: staff,
  },
  maintenance: {
    label: "Maintenance",
    description: "Work orders, vendors, inspections",
    tools: ["search_work_orders", "get_work_order", "search_vendors", "vendor_performance", "asset_history", "search_inspections", "search_tasks", "ops_kpis", "calendar_range", "search_units", "search_properties"],
    prompt: "Focus on maintenance: work orders, SLAs, vendors, inspections and follow-up tasks.",
    suggestions: ["Show overdue work orders", "What emergencies are open?", "Which vendors are missing their SLA?", "Show unassigned work orders"],
    allowed: (p) => staff(p) && has(p, "workorder.read", "workorder.read.assigned", "workorder.manage"),
  },
  frontdesk: {
    label: "Front desk",
    description: "Packages, visitors, shifts",
    tools: ["search_packages", "search_visitors", "whos_on_shift", "shift_summary", "search_bookings", "check_amenity_availability", "search_units", "search_residents",
      "search_incidents", "recent_announcements", "search_work_orders", "get_work_order", "calendar_range", "search_tasks"],
    prompt: "Focus on the front desk: packages, visitors, amenity bookings, incidents and shift handoffs. Answers should be quick to read at a busy desk.",
    suggestions: ["Which packages have been here more than 7 days?", "Who's on site right now?", "What happened during the previous shift?", "Is the party room free tonight?"],
    allowed: (p) => staff(p) && has(p, "visitor.manage", "package.manage", "shift.read"),
  },
  facility: {
    label: "Facility",
    description: "Equipment, preventive maintenance",
    tools: ["asset_history", "search_work_orders", "get_work_order", "vendor_performance", "search_vendors", "search_inspections", "ops_kpis", "calendar_range", "search_tasks"],
    prompt: "Focus on equipment and facilities: asset history, downtime, preventive maintenance, repeat failures and vendor performance. Distinguish recorded data from your suggestions.",
    suggestions: ["What equipment is out of service?", "Find recurring equipment problems", "What preventive maintenance is due this week?", "Which vendors are missing their SLA?"],
    allowed: (p) => staff(p) && has(p, "asset.read", "asset.manage"),
  },
  resident: {
    label: "Resident",
    description: "Your home, requests and bookings",
    tools: ["my_home", "search_work_orders", "get_work_order", "search_bookings", "check_amenity_availability", "search_packages", "search_visitors", "recent_announcements", "search_complaints", "search_incidents"],
    prompt: "The user is a resident. Help with their own home: their maintenance requests, packages, bookings, guests, announcements and building information. They can never see other residents' information.",
    suggestions: ["Do I have any packages?", "What's the status of my maintenance requests?", "Is the party room available tomorrow at 7 PM?", "What's the emergency number for my building?"],
    allowed: (p) => p.role.category === "resident",
  },
};

export function modesFor(p: Principal): AiMode[] {
  return AI_MODES.filter((m) => MODES[m].allowed(p));
}

export function defaultMode(p: Principal): AiMode {
  if (p.role.category === "resident") return "resident";
  if (["concierge", "security"].includes(p.role.key)) return "frontdesk";
  if (["facility_manager", "maintenance_staff"].includes(p.role.key) && MODES.facility.allowed(p)) return "facility";
  return "property";
}

export function pickMode(p: Principal, wanted: string | null | undefined): AiMode {
  const allowed = modesFor(p);
  if (wanted && (allowed as string[]).includes(wanted)) return wanted as AiMode;
  const d = defaultMode(p);
  return allowed.includes(d) ? d : allowed[0] ?? "property";
}
