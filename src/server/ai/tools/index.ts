import "server-only";
import type { Principal } from "../../authz/authorize";
import type { ToolDef } from "./registry";
import type { ToolName } from "./names";
import { getWorkOrderTool, searchWorkOrders } from "./maintenance";
import { myHome, searchProperties, searchResidents, searchUnits } from "./people";
import { searchVendors, vendorPerformanceTool } from "./vendors";
import { checkAmenityAvailability, recentAnnouncements, searchBookings, searchPackages } from "./community";
import { searchVisitors, shiftSummary, whosOnShift } from "./frontdesk";
import { calendarRange, opsKpis, searchComplaints, searchIncidents, searchInspections, searchTasks } from "./ops";
import { assetHistory } from "./facility";
import { retrievePolicyTool, searchDocumentsTool, searchKnowledgeTool } from "./knowledge";
import { assignWorkOrderAction, commentOnWorkOrderAction, createWorkOrderAction, updateWorkOrderStatusAction } from "./actions-maintenance";
import { createIncidentAction, createTaskAction, scheduleInspectionAction } from "./actions-ops";
import { cancelBookingAction, createBookingAction, logPackageAction, messageResidentAction, registerVisitorAction, sendAnnouncementAction } from "./actions-community";

// the complete registry: read tools (risk class 1) run immediately; actions are prepared as plans
export const ALL_TOOLS: ToolDef[] = [
  searchWorkOrders, getWorkOrderTool, searchProperties, searchUnits, searchResidents, myHome, searchVendors, vendorPerformanceTool,
  searchBookings, checkAmenityAvailability, searchPackages, searchVisitors, searchIncidents, searchComplaints, searchTasks, searchInspections,
  assetHistory, whosOnShift, shiftSummary, opsKpis, calendarRange, recentAnnouncements,
  searchKnowledgeTool, retrievePolicyTool, searchDocumentsTool,
  createWorkOrderAction, assignWorkOrderAction, updateWorkOrderStatusAction, commentOnWorkOrderAction, createTaskAction, scheduleInspectionAction,
  createBookingAction, cancelBookingAction, logPackageAction, registerVisitorAction, createIncidentAction, sendAnnouncementAction, messageResidentAction,
] as ToolDef[];

const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));
export const toolByName = (name: string) => BY_NAME.get(name as ToolName);

// tools offered to this principal — a tool the role can't use is never even described to the model
export function toolsForPrincipal(p: Principal, subset?: readonly ToolName[]): ToolDef[] {
  if (!p.permissions.has("ai.use")) return [];
  return ALL_TOOLS.filter((t) => (!subset || subset.includes(t.name)) && t.available(p));
}
