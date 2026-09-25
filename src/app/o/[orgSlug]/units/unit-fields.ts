import type { FieldDef } from "@/components/ui/schema-form";
import { opts, UNIT_STATUS, UNIT_TYPE_LABEL } from "@/lib/labels";

type U = { number?: string; floorId?: string | null; type?: string; status?: string; bedrooms?: number | null; bathrooms?: string | null; areaSqft?: number | null };

// shared create/edit field set for units
export function unitFields(floors: { id: string; name: string }[], u: U = {}): FieldDef[] {
  return [
    { name: "number", label: "Unit number", required: true, defaultValue: u.number, placeholder: "1204" },
    { name: "floorId", label: "Floor", type: "select", defaultValue: u.floorId ?? "", options: [{ value: "", label: "—" }, ...floors.map((f) => ({ value: f.id, label: f.name }))] },
    { name: "type", label: "Type", type: "select", options: opts(UNIT_TYPE_LABEL), defaultValue: u.type ?? "residential" },
    { name: "status", label: "Status", type: "select", options: Object.entries(UNIT_STATUS).map(([value, v]) => ({ value, label: v.label })), defaultValue: u.status ?? "vacant" },
    { name: "bedrooms", label: "Bedrooms", type: "number", defaultValue: u.bedrooms ?? "" },
    { name: "bathrooms", label: "Bathrooms", type: "number", step: "0.5", defaultValue: u.bathrooms ?? "" },
    { name: "areaSqft", label: "Area (sq ft)", type: "number", defaultValue: u.areaSqft ?? "" },
  ];
}
