// tool names are a stable contract between the registry, the demo model, the eval suite and stored logs
export const TOOL_NAMES = [
  "search_work_orders", "get_work_order", "search_properties", "search_units", "search_residents", "my_home",
  "search_vendors", "vendor_performance", "search_bookings", "check_amenity_availability", "search_packages",
  "search_visitors", "search_incidents", "search_complaints", "search_tasks", "search_inspections", "asset_history",
  "whos_on_shift", "shift_summary", "ops_kpis", "calendar_range", "recent_announcements",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export const isToolName = (v: string): v is ToolName => (TOOL_NAMES as readonly string[]).includes(v);
