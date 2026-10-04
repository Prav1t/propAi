import type { FieldDef } from "@/components/ui/schema-form";
import { AMENITY_KINDS } from "@/server/db/schema";
import { AMENITY_KIND } from "@/lib/community-labels";
import { fmtMinute } from "@/server/modules/amenities/rules";

type A = Partial<{
  name: string; kind: string; propertyId: string; buildingId: string | null; description: string | null; location: string | null; rules: string | null; capacity: number | null;
  maxConcurrent: number; opensAtMinute: number; closesAtMinute: number; slotMinutes: number; minDurationMinutes: number; maxDurationMinutes: number; minNoticeHours: number;
  maxAdvanceDays: number; limitCount: number | null; limitPeriodDays: number | null; cancellationHours: number; requiresApproval: boolean; feeCents: number; depositCents: number;
  eligibleRoles: string[]; active: boolean;
}>;

const eligibility = (roles?: string[]) => (!roles?.length ? "all" : roles.length === 1 ? "owners" : "owners_tenants");

// shared create/edit fields; durations are in minutes, money in dollars
export function amenityFields(props: { id: string; name: string }[], blds: { id: string; name: string; propertyName: string }[], a: A = {}): FieldDef[] {
  return [
    { name: "name", label: "Name", defaultValue: a.name, autoFocus: !a.name, placeholder: "Party Room" },
    { name: "kind", label: "Type", type: "select", defaultValue: a.kind ?? "party_room", options: AMENITY_KINDS.map((k) => ({ value: k, label: AMENITY_KIND[k] })) },
    { name: "propertyId", label: "Property", type: "select", defaultValue: a.propertyId ?? props[0]?.id, options: props.map((p) => ({ value: p.id, label: p.name })) },
    { name: "buildingId", label: "Building (optional)", type: "select", defaultValue: a.buildingId ?? "", options: [{ value: "", label: "Shared by the whole property" }, ...blds.map((b) => ({ value: b.id, label: `${b.propertyName} · ${b.name}` }))] },
    { name: "location", label: "Location", defaultValue: a.location, placeholder: "Level 2, east wing" },
    { name: "capacity", label: "Max people per booking", type: "number", defaultValue: a.capacity ?? "" },
    { name: "description", label: "Description", type: "textarea", defaultValue: a.description, span: 2, rows: 2 },
    { name: "rules", label: "House rules shown before booking", type: "textarea", defaultValue: a.rules, span: 2, rows: 3, hint: "Your own policy text, shown as written." },
    { name: "opensAt", label: "Opens", type: "time", defaultValue: fmtMinute(a.opensAtMinute ?? 480) },
    { name: "closesAt", label: "Closes (HH:MM)", placeholder: "22:00", defaultValue: a.closesAtMinute === 1440 ? "24:00" : fmtMinute(a.closesAtMinute ?? 1320), hint: "Use 24:00 for midnight." },
    { name: "slotMinutes", label: "Time step (minutes)", type: "number", defaultValue: a.slotMinutes ?? 30 },
    { name: "maxConcurrent", label: "Bookings allowed at once", type: "number", defaultValue: a.maxConcurrent ?? 1, hint: "1 = exclusive use (party room); more for shared spaces (gym)." },
    { name: "minDurationMinutes", label: "Shortest booking (minutes)", type: "number", defaultValue: a.minDurationMinutes ?? 60 },
    { name: "maxDurationMinutes", label: "Longest booking (minutes)", type: "number", defaultValue: a.maxDurationMinutes ?? 240 },
    { name: "minNoticeHours", label: "Book at least (hours ahead)", type: "number", defaultValue: a.minNoticeHours ?? 24 },
    { name: "maxAdvanceDays", label: "Book up to (days ahead)", type: "number", defaultValue: a.maxAdvanceDays ?? 60 },
    { name: "limitCount", label: "Limit per unit (optional)", type: "number", defaultValue: a.limitCount ?? "" },
    { name: "limitPeriodDays", label: "…within (days)", type: "number", defaultValue: a.limitPeriodDays ?? "" },
    { name: "cancellationHours", label: "Residents can cancel until (hours before)", type: "number", defaultValue: a.cancellationHours ?? 48 },
    { name: "eligibility", label: "Who can book", type: "select", defaultValue: eligibility(a.eligibleRoles), options: [{ value: "all", label: "All residents" }, { value: "owners", label: "Owners only" }, { value: "owners_tenants", label: "Owners and tenants" }] },
    { name: "fee", label: "Fee ($)", type: "number", step: "0.01", defaultValue: a.feeCents ? a.feeCents / 100 : "" },
    { name: "deposit", label: "Refundable deposit ($)", type: "number", step: "0.01", defaultValue: a.depositCents ? a.depositCents / 100 : "" },
    { name: "requiresApproval", label: "Management approves each booking", type: "checkbox", defaultValue: a.requiresApproval ?? true },
    { name: "active", label: "Taking bookings", type: "checkbox", defaultValue: a.active ?? true },
  ];
}
