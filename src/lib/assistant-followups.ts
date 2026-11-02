// Suggested next questions after an answer, from the tools that answer actually used. Every suggestion is a phrasing
// the assistant understands in demo mode too, so a click always gets a real answer. Questions already asked in the
// conversation aren't offered again; the mode's starter questions fill any gap.

export const FOLLOW_UPS: Record<string, { staff?: string[]; resident?: string[] }> = {
  search_work_orders: { staff: ["What emergencies are open?", "Which work orders are unassigned?", "Which vendors are missing their SLA?"], resident: ["Do I have any packages?", "Show my bookings"] },
  get_work_order: { staff: ["Show overdue work orders", "Which vendors are missing their SLA?"], resident: ["Show my requests"] },
  vendor_performance: { staff: ["Show overdue work orders", "What emergencies are open?"] },
  search_vendors: { staff: ["Which vendors are missing their SLA?"] },
  ops_kpis: { staff: ["Show overdue work orders", "Give me my morning briefing"] },
  daily_brief: { staff: ["Show overdue work orders", "What emergencies are open?", "Which vendors are missing their SLA?"] },
  query_metrics: { staff: ["Which property has the highest complaint volume?", "Give me my morning briefing"] },
  compare_periods: { staff: ["Which property has the highest complaint volume?", "Show overdue work orders"] },
  property_health: { staff: ["Show overdue work orders", "Which property has the highest complaint volume?"] },
  search_packages: { staff: ["Which packages have been here more than 7 days?", "Who's on site right now?"], resident: ["Show my bookings", "Show my requests"] },
  search_visitors: { staff: ["Who is on shift right now?", "Which packages have been here more than 7 days?"], resident: ["Do I have any packages?"] },
  whos_on_shift: { staff: ["What happened during the previous shift?", "Who's on site right now?"] },
  shift_summary: { staff: ["Which packages have been here more than 7 days?", "Show open incidents"] },
  search_incidents: { staff: ["Show open complaints", "What happened during the previous shift?"] },
  search_complaints: { staff: ["Which property has the highest complaint volume?", "Show open incidents"], resident: ["Show my requests"] },
  asset_history: { staff: ["What equipment is out of service?", "What preventive maintenance is due this week?", "Find recurring equipment problems"] },
  search_inspections: { staff: ["Show overdue inspections", "What equipment is out of service?"] },
  search_tasks: { staff: ["Show my overdue tasks", "Show overdue work orders"] },
  search_bookings: { staff: ["Show bookings waiting for approval"], resident: ["What are the rules for booking the party room?", "Do I have any packages?"] },
  check_amenity_availability: { resident: ["What are the rules for booking the party room?", "Show my bookings"], staff: ["Show bookings waiting for approval"] },
  my_home: { resident: ["Do I have any packages?", "Show my requests", "What are the rules for booking the party room?"] },
  search_knowledge: { resident: ["Do I have any packages?", "Show my requests"], staff: ["Show overdue work orders"] },
  retrieve_policy: { resident: ["Show my bookings", "Do I have any packages?"] },
  recent_announcements: { resident: ["Do I have any packages?", "Show my requests"], staff: ["Give me my morning briefing"] },
};

const norm = (s: string) => s.trim().toLowerCase().replace(/[?.!]+$/, "");

export function followUps(opts: { tools: string[]; asked: string[]; resident: boolean; starters: string[]; limit?: number; available?: (q: string) => boolean }): string[] {
  const { tools, asked, resident, starters, limit = 3 } = opts;
  const seen = new Set(asked.map(norm));
  const out: string[] = [];
  const add = (q: string) => {
    if (out.length >= limit || seen.has(norm(q)) || (opts.available && !opts.available(q))) return;
    seen.add(norm(q));
    out.push(q);
  };
  for (const t of tools) for (const q of (resident ? FOLLOW_UPS[t]?.resident : FOLLOW_UPS[t]?.staff) ?? []) add(q);
  for (const q of starters) add(q);
  return out;
}
