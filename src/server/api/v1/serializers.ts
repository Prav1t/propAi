import "server-only";
import type { bookings, complaints, incidents, packages, properties, residents, units, vendors, workOrders } from "../../db/schema";

// Public JSON shapes for API v1 and webhooks (snake_case, ISO dates). Fields that are secrets or private notes
// (pickup codes, entry instructions, people involved in incidents, vendor rates) are never included.

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const num = (v: string | number | null | undefined) => (v === null || v === undefined ? null : Number(v));

export const serializeProperty = (r: typeof properties.$inferSelect, buildings?: { id: string; name: string; code: string | null }[]) => ({
  object: "property" as const, id: r.id, name: r.name, code: r.code, type: r.type, portfolio_id: r.portfolioId, city: r.city, region: r.region,
  postal_code: r.postalCode, country: r.country, timezone: r.timezone, created_at: iso(r.createdAt), updated_at: iso(r.updatedAt),
  ...(buildings ? { buildings: buildings.map((b) => ({ id: b.id, name: b.name, code: b.code })) } : {}),
});

export const serializeUnit = (r: typeof units.$inferSelect) => ({
  object: "unit" as const, id: r.id, property_id: r.propertyId, building_id: r.buildingId, floor_id: r.floorId, number: r.number, type: r.type,
  bedrooms: r.bedrooms, bathrooms: num(r.bathrooms), area_sqft: r.areaSqft, status: r.status, created_at: iso(r.createdAt), updated_at: iso(r.updatedAt),
});

export type OccupancyLite = { unitId: string; propertyId: string; relationship: string; isPrimary: boolean; startsOn: string | null; endsOn: string | null };
export const serializeResident = (r: typeof residents.$inferSelect, occ: OccupancyLite[]) => ({
  object: "resident" as const, id: r.id, first_name: r.firstName, last_name: r.lastName, email: r.email, phone: r.phone, has_app_account: !!r.userId,
  units: occ.map((o) => ({ unit_id: o.unitId, property_id: o.propertyId, relationship: o.relationship, is_primary: o.isPrimary, starts_on: o.startsOn, ends_on: o.endsOn })),
  created_at: iso(r.createdAt), updated_at: iso(r.updatedAt),
});

export const serializeWorkOrder = (r: typeof workOrders.$inferSelect) => ({
  object: "work_order" as const, id: r.id, number: r.number, property_id: r.propertyId, building_id: r.buildingId, unit_id: r.unitId, area: r.area,
  category: r.category, priority: r.priority, is_emergency: r.isEmergency, title: r.title, description: r.description, status: r.status, source: r.source,
  vendor_id: r.vendorId, assigned_member_id: r.assignedMembershipId, permission_to_enter: r.permissionToEnter,
  scheduled_start: iso(r.scheduledStart), scheduled_end: iso(r.scheduledEnd), respond_due_at: iso(r.respondDueAt), resolve_due_at: iso(r.resolveDueAt),
  first_response_at: iso(r.firstResponseAt), completed_at: iso(r.completedAt), closed_at: iso(r.closedAt), cancelled_at: iso(r.cancelledAt),
  sla_breached: !!r.slaBreachedAt, cost: num(r.cost), resolution_notes: r.resolutionNotes, created_at: iso(r.createdAt), updated_at: iso(r.updatedAt),
});

export const serializeVendor = (r: typeof vendors.$inferSelect) => ({
  object: "vendor" as const, id: r.id, name: r.name, email: r.email, phone: r.phone, website: r.website, categories: r.categories, service_areas: r.serviceAreas,
  status: r.status, license_number: r.licenseNumber, insurance_expires_on: r.insuranceExpiresOn, sla_response_hours: r.slaResponseHours,
  created_at: iso(r.createdAt), updated_at: iso(r.updatedAt),
});

export const serializeIncident = (r: typeof incidents.$inferSelect) => ({
  object: "incident" as const, id: r.id, number: r.number, property_id: r.propertyId, building_id: r.buildingId, unit_id: r.unitId, type: r.type, severity: r.severity,
  title: r.title, description: r.description, location: r.location, occurred_at: iso(r.occurredAt), status: r.status, resolution: r.resolution,
  resolved_at: iso(r.resolvedAt), created_at: iso(r.createdAt), updated_at: iso(r.updatedAt),
});

export const serializeComplaint = (r: typeof complaints.$inferSelect) => ({
  object: "complaint" as const, id: r.id, number: r.number, property_id: r.propertyId, building_id: r.buildingId, unit_id: r.unitId, category: r.category,
  priority: r.priority, subject: r.subject, description: r.description, status: r.status, resolution: r.resolution, resolved_at: iso(r.resolvedAt),
  created_at: iso(r.createdAt), updated_at: iso(r.updatedAt),
});

export const serializeBooking = (r: typeof bookings.$inferSelect, amenityName: string | null) => ({
  object: "booking" as const, id: r.id, number: r.number, amenity_id: r.amenityId, amenity_name: amenityName, property_id: r.propertyId, building_id: r.buildingId,
  unit_id: r.unitId, starts_at: iso(r.startsAt), ends_at: iso(r.endsAt), guests: r.guests, status: r.status, fee_cents: r.feeCents, deposit_cents: r.depositCents,
  created_at: iso(r.createdAt), updated_at: iso(r.updatedAt),
});

export const serializePackage = (r: typeof packages.$inferSelect) => ({
  object: "package" as const, id: r.id, property_id: r.propertyId, building_id: r.buildingId, unit_id: r.unitId, recipient_name: r.recipientName,
  carrier: r.carrier, tracking_number: r.trackingNumber, size: r.size, perishable: r.perishable, status: r.status, received_at: iso(r.receivedAt),
  picked_up_at: iso(r.pickedUpAt), created_at: iso(r.createdAt),
});
