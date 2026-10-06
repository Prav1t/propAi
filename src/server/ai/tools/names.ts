// tool names are a stable contract between the registry, the demo model, the eval suite and stored logs
export const TOOL_NAMES = [
  "search_work_orders", "get_work_order", "search_properties", "search_units", "search_residents", "my_home",
  "search_vendors", "vendor_performance", "search_bookings", "check_amenity_availability", "search_packages",
  "search_visitors", "search_incidents", "search_complaints", "search_tasks", "search_inspections", "asset_history",
  "whos_on_shift", "shift_summary", "ops_kpis", "calendar_range", "recent_announcements",
  // actions (Iteration 7): prepared as plans, run after approval or when a policy allows
  "create_work_order", "assign_work_order", "update_work_order_status", "comment_on_work_order", "create_task", "schedule_inspection",
  "create_booking", "cancel_booking", "log_package", "register_visitor", "create_incident", "send_announcement", "message_resident",
] as const;
export const ACTION_TOOL_NAMES = [
  "create_work_order", "assign_work_order", "update_work_order_status", "comment_on_work_order", "create_task", "schedule_inspection",
  "create_booking", "cancel_booking", "log_package", "register_visitor", "create_incident", "send_announcement", "message_resident",
] as const satisfies readonly (typeof TOOL_NAMES)[number][];
export type ToolName = (typeof TOOL_NAMES)[number];
export const isToolName = (v: string): v is ToolName => (TOOL_NAMES as readonly string[]).includes(v);
