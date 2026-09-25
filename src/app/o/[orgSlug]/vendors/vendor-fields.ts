import type { FieldDef } from "@/components/ui/schema-form";
import { VENDOR_STATUS } from "@/lib/labels";

type V = { name?: string; legalName?: string | null; email?: string | null; phone?: string | null; website?: string | null; categories?: string[]; serviceAreas?: string[]; status?: string; licenseNumber?: string | null; insuranceExpiresOn?: string | null; hourlyRate?: string | null; slaResponseHours?: number | null; notes?: string | null };

// shared create/edit field set for vendors
export function vendorFields(categories: readonly string[], v: V = {}): FieldDef[] {
  return [
    { name: "name", label: "Company name", required: true, defaultValue: v.name, autoFocus: !v.name },
    { name: "legalName", label: "Legal name", defaultValue: v.legalName },
    { name: "email", label: "Dispatch email", type: "email", defaultValue: v.email },
    { name: "phone", label: "Phone", type: "tel", defaultValue: v.phone },
    { name: "categories", label: "Trades", defaultValue: v.categories?.join(", "), span: 2, hint: `Comma-separated: ${categories.join(", ")}` },
    { name: "serviceAreas", label: "Service areas", defaultValue: v.serviceAreas?.join(", "), placeholder: "Vancouver, Burnaby" },
    { name: "website", label: "Website", type: "url", defaultValue: v.website, placeholder: "https://" },
    { name: "status", label: "Status", type: "select", defaultValue: v.status ?? "active", options: Object.entries(VENDOR_STATUS).map(([value, s]) => ({ value, label: s.label })) },
    { name: "slaResponseHours", label: "Response SLA (hours)", type: "number", defaultValue: v.slaResponseHours ?? "" },
    { name: "hourlyRate", label: "Hourly rate (CAD)", type: "number", step: "0.01", defaultValue: v.hourlyRate ?? "" },
    { name: "licenseNumber", label: "Licence number", defaultValue: v.licenseNumber },
    { name: "insuranceExpiresOn", label: "Insurance expires", type: "date", defaultValue: v.insuranceExpiresOn },
    { name: "notes", label: "Notes", type: "textarea", defaultValue: v.notes, span: 2 },
  ];
}
