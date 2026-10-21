// Events customers can subscribe to (Iteration 10). Each maps an internal outbox event to a public type and the API
// object it carries, serialized exactly like GET /api/v1/... returns it.
export type PublicEvent = { type: string; source: string; object: "work_order" | "incident" | "complaint" | "booking" | "package"; idKey: string; description: string };

export const PUBLIC_EVENTS: PublicEvent[] = [
  { type: "work_order.created", source: "workorder.created", object: "work_order", idKey: "workOrderId", description: "A work order was created — in the app, by the assistant, by an automation rule or through the API." },
  { type: "work_order.status_changed", source: "workorder.status_changed", object: "work_order", idKey: "workOrderId", description: "A work order moved to another status (including scheduling)." },
  { type: "work_order.assigned", source: "workorder.assigned", object: "work_order", idKey: "workOrderId", description: "A work order was assigned to a staff member or vendor." },
  { type: "work_order.sla_breached", source: "workorder.sla_breached", object: "work_order", idKey: "workOrderId", description: "A work order missed its resolution target." },
  { type: "incident.created", source: "incident.created", object: "incident", idKey: "incidentId", description: "An incident was reported." },
  { type: "complaint.created", source: "complaint.created", object: "complaint", idKey: "complaintId", description: "A complaint was submitted." },
  { type: "booking.created", source: "booking.created", object: "booking", idKey: "bookingId", description: "An amenity booking was made or requested." },
  { type: "package.arrived", source: "package.arrived", object: "package", idKey: "packageId", description: "A package was logged at the front desk." },
];

export const PUBLIC_EVENT_TYPES = PUBLIC_EVENTS.map((e) => e.type);
export const publicEventFor = (source: string) => PUBLIC_EVENTS.find((e) => e.source === source) ?? null;
export const TEST_EVENT_TYPE = "ping";
