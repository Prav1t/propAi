import "server-only";
import { eq } from "drizzle-orm";
import type { Tx } from "../db/client";
import { amenities, bookings, buildings, complaints, documents, incidents, inspections, packages, properties, units, workOrders } from "../db/schema";
import type { Subject, SubjectType, TriggerType } from "@/lib/automation";
import { subjectOf } from "@/lib/automation";
import { WO_CATEGORY, PRIORITY, WO_STATUS, COMPLAINT_CATEGORY, INCIDENT_TYPE, SEVERITY, INSPECTION_KIND } from "@/lib/ops-labels";
import { AMENITY_KIND, DOCUMENT_CATEGORY } from "@/lib/community-labels";

// The record behind an event, normalised so conditions, templates and actions read it the same way for every trigger.

export const SUBJECT_ID_KEY: Record<SubjectType, string> = {
  work_order: "workOrderId", complaint: "complaintId", incident: "incidentId", inspection: "inspectionId", booking: "bookingId", package: "packageId", document: "documentId",
};

async function place(tx: Tx, propertyId: string | null, buildingId: string | null, unitId: string | null) {
  const [prop] = propertyId ? await tx.select({ name: properties.name }).from(properties).where(eq(properties.id, propertyId)) : [];
  const [bld] = buildingId ? await tx.select({ name: buildings.name }).from(buildings).where(eq(buildings.id, buildingId)) : [];
  const [unit] = unitId ? await tx.select({ number: units.number }).from(units).where(eq(units.id, unitId)) : [];
  return { propertyId, propertyName: prop?.name ?? null, buildingId, buildingName: bld?.name ?? null, unitLabel: unit?.number ?? null };
}

// payload: the outbox event's payload (or { <idKey>: id } for dry runs)
export async function loadSubject(tx: Tx, trigger: TriggerType, payload: Record<string, unknown>): Promise<Subject | null> {
  const type = subjectOf(trigger);
  if (!type) return null;
  const id = payload[SUBJECT_ID_KEY[type]];
  if (typeof id !== "string") return null;
  switch (type) {
    case "work_order": {
      const [w] = await tx.select().from(workOrders).where(eq(workOrders.id, id));
      if (!w) return null;
      return {
        type, id: w.id, ref: `WO-${w.number}`, title: w.title, href: `/maintenance/${w.id}`, ...(await place(tx, w.propertyId, w.buildingId, w.unitId)),
        fields: {
          emergency: w.isEmergency, category: w.category, priority: w.priority, status: w.status, new_status: typeof payload.to === "string" ? payload.to : w.status,
          unassigned: !w.assignedMembershipId && !w.vendorId, source: w.source === "resident", title: w.title,
          // for templates
          category_label: WO_CATEGORY[w.category] ?? w.category, priority_label: PRIORITY[w.priority]?.label ?? w.priority, status_label: WO_STATUS[w.status]?.label ?? w.status,
        },
        submitterUserId: w.submittedByUserId, assigneeMembershipId: w.assignedMembershipId,
      };
    }
    case "complaint": {
      const [c] = await tx.select().from(complaints).where(eq(complaints.id, id));
      if (!c) return null;
      return {
        type, id: c.id, ref: `C-${c.number}`, title: c.subject, href: `/complaints/${c.id}`, ...(await place(tx, c.propertyId, c.buildingId, c.unitId)),
        fields: { category: c.category, priority: c.priority, status: c.status, title: c.subject, category_label: COMPLAINT_CATEGORY[c.category] ?? c.category, priority_label: PRIORITY[c.priority]?.label ?? c.priority, status_label: c.status },
        submitterUserId: c.submittedByUserId, assigneeMembershipId: c.assignedMembershipId,
      };
    }
    case "incident": {
      const [i] = await tx.select().from(incidents).where(eq(incidents.id, id));
      if (!i) return null;
      const severity = typeof payload.severity === "string" ? payload.severity : i.severity; // as reported, not as edited later
      return {
        type, id: i.id, ref: `INC-${i.number}`, title: i.title, href: `/incidents/${i.id}`, ...(await place(tx, i.propertyId, i.buildingId, i.unitId)),
        fields: { type: i.type, severity, status: i.status, title: i.title, category_label: INCIDENT_TYPE[i.type] ?? i.type, priority_label: SEVERITY[severity]?.label ?? severity, status_label: i.status },
        submitterUserId: i.reportedByUserId, assigneeMembershipId: null,
      };
    }
    case "inspection": {
      const [n] = await tx.select().from(inspections).where(eq(inspections.id, id));
      if (!n) return null;
      return {
        type, id: n.id, ref: "Inspection", title: n.title, href: `/inspections/${n.id}`, ...(await place(tx, n.propertyId, n.buildingId, n.unitId)),
        fields: { kind: n.kind, failed_items: typeof payload.failed === "number" ? payload.failed : 0, status: n.status, category_label: INSPECTION_KIND[n.kind] ?? n.kind, status_label: n.result ?? n.status },
        submitterUserId: null, assigneeMembershipId: n.inspectorMembershipId,
      };
    }
    case "booking": {
      const [b] = await tx.select({ b: bookings, amenity: amenities.name, kind: amenities.kind }).from(bookings).innerJoin(amenities, eq(amenities.id, bookings.amenityId)).where(eq(bookings.id, id));
      if (!b) return null;
      return {
        type, id: b.b.id, ref: `B-${b.b.number}`, title: `${b.amenity} booking`, href: `/amenities/bookings/${b.b.id}`, ...(await place(tx, b.b.propertyId, b.b.buildingId, b.b.unitId)),
        fields: { amenity_kind: b.kind, needs_approval: b.b.status === "requested", status: b.b.status, category_label: AMENITY_KIND[b.kind] ?? b.kind, status_label: b.b.status },
        submitterUserId: b.b.bookedByUserId, assigneeMembershipId: null,
      };
    }
    case "package": {
      const [k] = await tx.select().from(packages).where(eq(packages.id, id));
      if (!k) return null;
      return {
        type, id: k.id, ref: "Package", title: `${k.carrier ? `${k.carrier} package` : "Package"}${k.perishable ? " (perishable)" : ""}`, href: `/packages/${k.id}`, ...(await place(tx, k.propertyId, k.buildingId, k.unitId)),
        fields: { perishable: k.perishable, size: k.size, carrier: k.carrier ?? "", status: k.status, category_label: k.size, status_label: k.status },
        submitterUserId: null, assigneeMembershipId: null,
      };
    }
    case "document": {
      const [d] = await tx.select().from(documents).where(eq(documents.id, id));
      if (!d) return null;
      return {
        type, id: d.id, ref: "Document", title: d.title, href: `/documents/${d.id}`, ...(await place(tx, d.propertyId, d.buildingId, null)),
        fields: { category: d.category, title: d.title, audience: d.audience, category_label: DOCUMENT_CATEGORY[d.category] ?? d.category, status_label: d.status },
        submitterUserId: null, assigneeMembershipId: null,
      };
    }
  }
}

// a label for run lists: "WO-1042 Elevator stuck between floors"
export const subjectLabel = (s: Subject) => (s.ref && !["Inspection", "Package", "Document"].includes(s.ref) ? `${s.ref} ${s.title}` : s.title);
