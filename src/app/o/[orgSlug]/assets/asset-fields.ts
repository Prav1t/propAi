import type { FieldDef } from "@/components/ui/schema-form";
import { ASSET_CATEGORIES } from "@/server/db/schema";
import { ASSET_CATEGORY, CRITICALITY } from "@/lib/facility-labels";

type Opt = { value: string; label: string };
type AssetLike = Partial<Record<"propertyId" | "buildingId" | "location" | "name" | "tag" | "category" | "make" | "model" | "serialNumber" | "installedOn" | "warrantyUntil" | "criticality" | "vendorId" | "replacementCost" | "notes", string | null>> & { expectedLifeYears?: number | null };

// shared create/edit fields for an asset
export function assetFields(o: { properties: Opt[]; buildings: Opt[]; vendors: Opt[] }, a: AssetLike = {}): FieldDef[] {
  return [
    { name: "name", label: "Name", required: true, defaultValue: a.name ?? "", placeholder: "Rooftop unit RTU-4", span: 2 },
    { name: "category", label: "Category", type: "select", options: ASSET_CATEGORIES.map((c) => ({ value: c, label: ASSET_CATEGORY[c] })), defaultValue: a.category ?? "hvac" },
    { name: "criticality", label: "Criticality", type: "select", options: Object.entries(CRITICALITY).map(([value, v]) => ({ value, label: v.label })), defaultValue: a.criticality ?? "medium" },
    { name: "propertyId", label: "Property", type: "select", options: o.properties, defaultValue: a.propertyId ?? o.properties[0]?.value },
    { name: "buildingId", label: "Building", type: "select", options: [{ value: "", label: "Site-wide" }, ...o.buildings], defaultValue: a.buildingId ?? "" },
    { name: "location", label: "Location", defaultValue: a.location ?? "", placeholder: "Roof, east side" },
    { name: "tag", label: "Asset tag", defaultValue: a.tag ?? "", placeholder: "HBC-RTU-04" },
    { name: "make", label: "Make", defaultValue: a.make ?? "" }, { name: "model", label: "Model", defaultValue: a.model ?? "" },
    { name: "serialNumber", label: "Serial number", defaultValue: a.serialNumber ?? "" },
    { name: "vendorId", label: "Service vendor", type: "select", options: [{ value: "", label: "None" }, ...o.vendors], defaultValue: a.vendorId ?? "" },
    { name: "installedOn", label: "Installed", type: "date", defaultValue: a.installedOn ?? "" },
    { name: "warrantyUntil", label: "Warranty until", type: "date", defaultValue: a.warrantyUntil ?? "" },
    { name: "expectedLifeYears", label: "Expected life (years)", type: "number", defaultValue: a.expectedLifeYears ?? "" },
    { name: "replacementCost", label: "Replacement cost ($)", type: "number", step: "0.01", defaultValue: a.replacementCost ?? "" },
    { name: "notes", label: "Notes", type: "textarea", span: 2, defaultValue: a.notes ?? "" },
  ];
}
