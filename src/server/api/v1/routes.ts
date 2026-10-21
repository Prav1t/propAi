import "server-only";
import { z } from "zod";
import { WO_CATEGORIES, PRIORITY_ORDER, WO_STATUSES } from "../../modules/maintenance/rules";
import { assignSchema, createWorkOrder, transitionSchema, transitionWorkOrder, assignWorkOrder } from "../../modules/maintenance/service";
import { createIncident, incidentSchema, SEVERITIES, INCIDENT_STATUSES } from "../../modules/incidents/service";
import { INCIDENT_TYPES } from "../../db/schema";
import { tenantTx, type TenantCtx } from "../../modules/context";
import * as R from "./resources";
import type { ApiCaller } from "../keys";

// API v1 route table (Iteration 10). The router, the OpenAPI document and the reference page are all built from this
// list, so the docs can't drift from what the server accepts.

const uuid = z.string().uuid();
const date = z.string().datetime({ offset: true });

export const pagination = {
  limit: z.coerce.number().int().min(1).max(100).default(25).describe("Page size (1–100, default 25)."),
  cursor: z.string().max(200).optional().describe("next_cursor from the previous page."),
  order: z.enum(["desc", "asc"]).default("desc").describe("Sort by creation time: newest first (desc, default) or oldest first."),
};
const listQuery = (extra: z.ZodRawShape = {}) => z.object({ ...pagination, ...extra }).strict();
const listOf = (item: z.ZodType) => z.object({ object: z.literal("list"), data: z.array(item), has_more: z.boolean(), next_cursor: z.string().nullable() });

/* ───────────── response shapes (documentation; the serializers produce exactly these) ───────────── */

const stamps = { created_at: date, updated_at: date };
const Property = z.object({
  object: z.literal("property"), id: uuid, name: z.string(), code: z.string(), type: z.string(), portfolio_id: uuid.nullable(), city: z.string().nullable(),
  region: z.string().nullable(), postal_code: z.string().nullable(), country: z.string().nullable(), timezone: z.string(), ...stamps,
  buildings: z.array(z.object({ id: uuid, name: z.string(), code: z.string().nullable() })).optional().describe("Only on GET /properties/{id}."),
}).meta({ id: "Property" });
const Unit = z.object({
  object: z.literal("unit"), id: uuid, property_id: uuid, building_id: uuid, floor_id: uuid.nullable(), number: z.string(), type: z.string(),
  bedrooms: z.number().nullable(), bathrooms: z.number().nullable(), area_sqft: z.number().nullable(), status: z.string(), ...stamps,
}).meta({ id: "Unit" });
const Resident = z.object({
  object: z.literal("resident"), id: uuid, first_name: z.string(), last_name: z.string(), email: z.string().nullable(), phone: z.string().nullable(), has_app_account: z.boolean(),
  units: z.array(z.object({ unit_id: uuid, property_id: uuid, relationship: z.string(), is_primary: z.boolean(), starts_on: z.string().nullable(), ends_on: z.string().nullable() })), ...stamps,
}).meta({ id: "Resident" });
const WorkOrder = z.object({
  object: z.literal("work_order"), id: uuid, number: z.number().int(), property_id: uuid, building_id: uuid.nullable(), unit_id: uuid.nullable(), area: z.string().nullable(),
  category: z.enum(WO_CATEGORIES), priority: z.enum(PRIORITY_ORDER), is_emergency: z.boolean(), title: z.string(), description: z.string(), status: z.enum(WO_STATUSES),
  source: z.string(), vendor_id: uuid.nullable(), assigned_member_id: uuid.nullable(), permission_to_enter: z.boolean(),
  scheduled_start: date.nullable(), scheduled_end: date.nullable(), respond_due_at: date.nullable(), resolve_due_at: date.nullable(), first_response_at: date.nullable(),
  completed_at: date.nullable(), closed_at: date.nullable(), cancelled_at: date.nullable(), sla_breached: z.boolean(), cost: z.number().nullable(), resolution_notes: z.string().nullable(), ...stamps,
}).meta({ id: "WorkOrder" });
const Vendor = z.object({
  object: z.literal("vendor"), id: uuid, name: z.string(), email: z.string().nullable(), phone: z.string().nullable(), website: z.string().nullable(), categories: z.array(z.string()),
  service_areas: z.array(z.string()), status: z.string(), license_number: z.string().nullable(), insurance_expires_on: z.string().nullable(), sla_response_hours: z.number().nullable(), ...stamps,
}).meta({ id: "Vendor" });
const Incident = z.object({
  object: z.literal("incident"), id: uuid, number: z.number().int(), property_id: uuid, building_id: uuid.nullable(), unit_id: uuid.nullable(), type: z.enum(INCIDENT_TYPES),
  severity: z.enum(SEVERITIES), title: z.string(), description: z.string(), location: z.string().nullable(), occurred_at: date, status: z.enum(INCIDENT_STATUSES),
  resolution: z.string().nullable(), resolved_at: date.nullable(), ...stamps,
}).meta({ id: "Incident" });
const Complaint = z.object({
  object: z.literal("complaint"), id: uuid, number: z.number().int(), property_id: uuid, building_id: uuid.nullable(), unit_id: uuid.nullable(), category: z.string(),
  priority: z.string(), subject: z.string(), description: z.string(), status: z.string(), resolution: z.string().nullable(), resolved_at: date.nullable(), ...stamps,
}).meta({ id: "Complaint" });
const Booking = z.object({
  object: z.literal("booking"), id: uuid, number: z.number().int(), amenity_id: uuid, amenity_name: z.string().nullable(), property_id: uuid, building_id: uuid.nullable(),
  unit_id: uuid.nullable(), starts_at: date, ends_at: date, guests: z.number().int().nullable(), status: z.string(), fee_cents: z.number().int(), deposit_cents: z.number().int(), ...stamps,
}).meta({ id: "Booking" });
const Package = z.object({
  object: z.literal("package"), id: uuid, property_id: uuid, building_id: uuid.nullable(), unit_id: uuid.nullable(), recipient_name: z.string().nullable(), carrier: z.string().nullable(),
  tracking_number: z.string().nullable(), size: z.string().nullable(), perishable: z.boolean(), status: z.string(), received_at: date, picked_up_at: date.nullable(), created_at: date,
}).meta({ id: "Package" });
const Me = z.object({
  object: z.literal("api_key"), id: uuid, name: z.string(), prefix: z.string(), organization: z.object({ id: uuid, slug: z.string() }),
  permissions: z.array(z.string()).describe("Effective permissions: the key's scopes that its creator still has."),
  property_ids: z.array(uuid).describe("Empty when the key isn't limited to particular properties."), rate_limit_per_minute: z.number().int(), expires_at: date.nullable(),
}).meta({ id: "ApiKey" });

export const SCHEMAS = { Property, Unit, Resident, WorkOrder, Vendor, Incident, Complaint, Booking, Package, ApiKey: Me };

/* ───────────── request bodies ───────────── */

export const CreateWorkOrderBody = z.object({
  property_id: uuid, building_id: uuid.optional(), unit_id: uuid.optional(),
  title: z.string().trim().min(3).max(160), description: z.string().max(5000).default(""), category: z.enum(WO_CATEGORIES),
  priority: z.enum(PRIORITY_ORDER).optional().describe("Leave out to let the property's triage rules and SLA decide."),
  is_emergency: z.boolean().default(false), area: z.string().max(120).optional(), permission_to_enter: z.boolean().default(false),
}).strict().meta({ id: "CreateWorkOrder" });
export const StatusBody = z.object({
  status: z.enum(WO_STATUSES), note: z.string().max(2000).optional(), cost: z.number().min(0).max(10_000_000).optional(), resolution_notes: z.string().max(4000).optional(),
}).strict().meta({ id: "ChangeWorkOrderStatus" });
export const AssignBody = z.object({ member_id: uuid.nullable().optional(), vendor_id: uuid.nullable().optional() }).strict().meta({ id: "AssignWorkOrder" });
export const CreateIncidentBody = z.object({
  building_id: uuid, unit_id: uuid.optional(), type: z.enum(INCIDENT_TYPES), severity: z.enum(SEVERITIES).default("medium"),
  title: z.string().trim().min(3).max(160), description: z.string().max(10_000).default(""), location: z.string().max(200).optional(), occurred_at: date,
  external_reference: z.string().max(120).optional(),
}).strict().meta({ id: "CreateIncident" });

/* ───────────── the routes ───────────── */

export type RouteArgs = { params: Record<string, string>; query: Record<string, unknown>; body: unknown; caller: ApiCaller };
export type Route = {
  method: "GET" | "POST"; path: string; operationId: string; tag: string; summary: string; description?: string;
  scope: string | null; query?: z.ZodObject; body?: z.ZodType; response: z.ZodType; status?: number;
  run: (ctx: TenantCtx, a: RouteArgs) => Promise<unknown>;
};

const q = <T,>(a: RouteArgs) => a.query as T & R.ListQuery;
const statusList = (v: unknown) => (typeof v === "string" && v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

export const ROUTES: Route[] = [
  {
    method: "GET", path: "/me", operationId: "getApiKey", tag: "Keys", summary: "The key making the request", scope: null, response: Me,
    run: async (ctx, a) => ({
      object: "api_key", id: a.caller.key.id, name: a.caller.key.name, prefix: a.caller.key.prefix, organization: { id: ctx.principal.orgId, slug: a.caller.orgSlug },
      permissions: [...ctx.principal.permissions].sort(), property_ids: a.caller.key.propertyIds, rate_limit_per_minute: a.caller.key.requestsPerMinute,
      expires_at: a.caller.key.expiresAt?.toISOString() ?? null,
    }),
  },
  { method: "GET", path: "/properties", operationId: "listProperties", tag: "Portfolio", summary: "List properties", scope: "property.read", query: listQuery(), response: listOf(Property),
    run: (ctx, a) => R.listProperties(ctx, q(a)) },
  { method: "GET", path: "/properties/{id}", operationId: "getProperty", tag: "Portfolio", summary: "Get a property with its buildings", scope: "property.read", response: Property,
    run: (ctx, a) => R.getProperty(ctx, a.params.id) },
  { method: "GET", path: "/units", operationId: "listUnits", tag: "Portfolio", summary: "List units", scope: "unit.read",
    query: listQuery({ property_id: uuid.optional(), building_id: uuid.optional(), status: z.string().max(40).optional() }), response: listOf(Unit),
    run: (ctx, a) => R.listUnits(ctx, { ...q<{ property_id?: string; building_id?: string; status?: string }>(a), propertyId: a.query.property_id as string | undefined, buildingId: a.query.building_id as string | undefined }) },
  { method: "GET", path: "/units/{id}", operationId: "getUnit", tag: "Portfolio", summary: "Get a unit", scope: "unit.read", response: Unit, run: (ctx, a) => R.getUnit(ctx, a.params.id) },
  { method: "GET", path: "/residents", operationId: "listResidents", tag: "People", summary: "List residents with their units", scope: "resident.read",
    query: listQuery({ property_id: uuid.optional(), unit_id: uuid.optional() }), response: listOf(Resident),
    run: (ctx, a) => R.listResidents(ctx, { ...q(a), propertyId: a.query.property_id as string | undefined, unitId: a.query.unit_id as string | undefined }) },
  { method: "GET", path: "/residents/{id}", operationId: "getResident", tag: "People", summary: "Get a resident", scope: "resident.read", response: Resident, run: (ctx, a) => R.getResident(ctx, a.params.id) },
  { method: "GET", path: "/vendors", operationId: "listVendors", tag: "People", summary: "List vendors", scope: "vendor.read",
    query: listQuery({ status: z.string().max(40).optional(), category: z.string().max(40).optional() }), response: listOf(Vendor),
    run: (ctx, a) => R.listVendors(ctx, { ...q(a), status: a.query.status as string | undefined, category: a.query.category as string | undefined }) },
  { method: "GET", path: "/vendors/{id}", operationId: "getVendor", tag: "People", summary: "Get a vendor", scope: "vendor.read", response: Vendor, run: (ctx, a) => R.getVendor(ctx, a.params.id) },
  {
    method: "GET", path: "/work-orders", operationId: "listWorkOrders", tag: "Maintenance", summary: "List work orders", scope: "workorder.read",
    query: listQuery({
      status: z.string().max(300).optional().describe("One status, or several separated by commas."), property_id: uuid.optional(), priority: z.enum(PRIORITY_ORDER).optional(),
      category: z.enum(WO_CATEGORIES).optional(), updated_since: date.optional().describe("Only work orders changed at or after this time (for syncing)."),
    }), response: listOf(WorkOrder),
    run: (ctx, a) => R.listWorkOrders(ctx, { ...q(a), status: statusList(a.query.status), propertyId: a.query.property_id as string | undefined, priority: a.query.priority as string | undefined,
      category: a.query.category as string | undefined, updatedSince: a.query.updated_since ? new Date(a.query.updated_since as string) : undefined }),
  },
  { method: "GET", path: "/work-orders/{id}", operationId: "getWorkOrder", tag: "Maintenance", summary: "Get a work order", scope: "workorder.read", response: WorkOrder, run: (ctx, a) => R.getWorkOrder(ctx, a.params.id) },
  {
    method: "POST", path: "/work-orders", operationId: "createWorkOrder", tag: "Maintenance", summary: "Create a work order", status: 201,
    description: "Runs the property's triage rules and SLA targets like a request made in the app, notifies the managers, triggers automation rules and webhooks. Send an Idempotency-Key to retry safely.",
    scope: "workorder.create", body: CreateWorkOrderBody, response: WorkOrder,
    run: async (ctx, a) => {
      const b = a.body as z.output<typeof CreateWorkOrderBody>;
      const r = await createWorkOrder(ctx, {
        title: b.title, description: b.description, category: b.category, priority: b.priority ?? null, isEmergency: b.is_emergency, unitId: b.unit_id ?? null,
        buildingId: b.building_id ?? null, unitNumber: null, propertyId: b.property_id, area: b.area ?? null, permissionToEnter: b.permission_to_enter, entryNotes: null,
      }, { source: "api", sourceType: "api_key", sourceId: a.caller.key.id });
      return R.getWorkOrder(ctx, r.workOrder.id);
    },
  },
  {
    method: "POST", path: "/work-orders/{id}/status", operationId: "changeWorkOrderStatus", tag: "Maintenance", summary: "Move a work order to another status",
    description: "Follows the same rules as the app (for example, cancelled requests can't be reopened).", scope: "workorder.manage", body: StatusBody, response: WorkOrder,
    run: async (ctx, a) => {
      const b = a.body as z.output<typeof StatusBody>;
      await tenantTx(ctx, (tx) => R.loadWorkOrderFor(tx, ctx.principal, a.params.id));
      await transitionWorkOrder(ctx, a.params.id, transitionSchema.parse({ to: b.status, note: b.note ?? "", cost: b.cost ?? "", resolutionNotes: b.resolution_notes ?? "" }));
      return R.getWorkOrder(ctx, a.params.id);
    },
  },
  {
    method: "POST", path: "/work-orders/{id}/assignment", operationId: "assignWorkOrder", tag: "Maintenance", summary: "Assign a work order to a staff member and/or vendor",
    scope: "workorder.manage", body: AssignBody, response: WorkOrder,
    run: async (ctx, a) => {
      const b = a.body as z.output<typeof AssignBody>;
      await tenantTx(ctx, (tx) => R.loadWorkOrderFor(tx, ctx.principal, a.params.id));
      await assignWorkOrder(ctx, a.params.id, assignSchema.parse({ membershipId: b.member_id ?? "", vendorId: b.vendor_id ?? "" }));
      return R.getWorkOrder(ctx, a.params.id);
    },
  },
  { method: "GET", path: "/incidents", operationId: "listIncidents", tag: "Operations", summary: "List incidents", scope: "incident.read",
    query: listQuery({ status: z.enum(INCIDENT_STATUSES).optional(), severity: z.enum(SEVERITIES).optional(), property_id: uuid.optional(), since: date.optional().describe("Occurred at or after.") }),
    response: listOf(Incident),
    run: (ctx, a) => R.listIncidents(ctx, { ...q(a), status: a.query.status as string | undefined, severity: a.query.severity as string | undefined, propertyId: a.query.property_id as string | undefined,
      since: a.query.since ? new Date(a.query.since as string) : undefined }) },
  { method: "GET", path: "/incidents/{id}", operationId: "getIncident", tag: "Operations", summary: "Get an incident", scope: "incident.read", response: Incident, run: (ctx, a) => R.getIncident(ctx, a.params.id) },
  {
    method: "POST", path: "/incidents", operationId: "createIncident", tag: "Operations", summary: "Report an incident", status: 201, scope: "incident.create", body: CreateIncidentBody, response: Incident,
    run: async (ctx, a) => {
      const b = a.body as z.output<typeof CreateIncidentBody>;
      const input = incidentSchema.parse({ type: b.type, severity: b.severity, title: b.title, description: b.description, buildingId: b.building_id, unitId: b.unit_id ?? "",
        location: b.location ?? "", occurredAt: b.occurred_at, externalReference: b.external_reference ?? "" });
      const i = await createIncident(ctx, input, new Date(b.occurred_at));
      return R.getIncident(ctx, i.id);
    },
  },
  { method: "GET", path: "/complaints", operationId: "listComplaints", tag: "Operations", summary: "List complaints", scope: "complaint.read",
    query: listQuery({ status: z.string().max(40).optional(), property_id: uuid.optional() }), response: listOf(Complaint),
    run: (ctx, a) => R.listComplaints(ctx, { ...q(a), status: a.query.status as string | undefined, propertyId: a.query.property_id as string | undefined }) },
  { method: "GET", path: "/complaints/{id}", operationId: "getComplaint", tag: "Operations", summary: "Get a complaint", scope: "complaint.read", response: Complaint, run: (ctx, a) => R.getComplaint(ctx, a.params.id) },
  { method: "GET", path: "/bookings", operationId: "listBookings", tag: "Community", summary: "List amenity bookings", scope: "booking.manage",
    query: listQuery({ status: z.string().max(40).optional(), amenity_id: uuid.optional(), property_id: uuid.optional(), from: date.optional().describe("Bookings ending after."), to: date.optional().describe("Bookings starting before.") }),
    response: listOf(Booking),
    run: (ctx, a) => R.listBookings(ctx, { ...q(a), status: a.query.status as string | undefined, amenityId: a.query.amenity_id as string | undefined, propertyId: a.query.property_id as string | undefined,
      from: a.query.from ? new Date(a.query.from as string) : undefined, to: a.query.to ? new Date(a.query.to as string) : undefined }) },
  { method: "GET", path: "/packages", operationId: "listPackages", tag: "Community", summary: "List packages", scope: "package.manage",
    query: listQuery({ status: z.string().max(40).optional(), property_id: uuid.optional(), unit_id: uuid.optional() }), response: listOf(Package),
    run: (ctx, a) => R.listPackages(ctx, { ...q(a), status: a.query.status as string | undefined, propertyId: a.query.property_id as string | undefined, unitId: a.query.unit_id as string | undefined }) },
];

// "/work-orders/{id}" ↔ "/work-orders/0b1c…"
export function matchRoute(method: string, path: string): { route: Route; params: Record<string, string> } | { allowed: string[] } | null {
  const segs = path.split("/").filter(Boolean);
  const allowed: string[] = [];
  for (const r of ROUTES) {
    const rs = r.path.split("/").filter(Boolean);
    if (rs.length !== segs.length) continue;
    const params: Record<string, string> = {};
    if (!rs.every((s, i) => (s.startsWith("{") ? ((params[s.slice(1, -1)] = decodeURIComponent(segs[i])), true) : s === segs[i]))) continue;
    if (r.method === method) return { route: r, params };
    allowed.push(r.method);
  }
  return allowed.length ? { allowed } : null;
}
