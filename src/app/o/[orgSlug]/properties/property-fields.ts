import type { FieldDef } from "@/components/ui/schema-form";
import { opts, PROPERTY_TYPE_LABEL, TIMEZONE_OPTIONS } from "@/lib/labels";

type P = { name?: string; code?: string; type?: string; portfolioId?: string | null; addressLine1?: string | null; city?: string | null; region?: string | null; postalCode?: string | null; timezone?: string; emergencyPhone?: string | null; emergencyInfo?: string | null; officeHours?: string | null };

// shared create/edit field set for properties
export function propertyFields(portfolios: { id: string; name: string }[], p: P = {}, allowNoPortfolio = true): FieldDef[] {
  return [
    { name: "name", label: "Property name", required: true, defaultValue: p.name, autoFocus: !p.name, span: 2 },
    { name: "code", label: "Code", required: true, defaultValue: p.code, hint: "Short unique code, e.g. HBC", placeholder: "HBC" },
    { name: "type", label: "Type", type: "select", options: opts(PROPERTY_TYPE_LABEL), defaultValue: p.type ?? "residential" },
    {
      name: "portfolioId", label: "Portfolio", type: "select", defaultValue: p.portfolioId ?? "",
      options: [...(allowNoPortfolio ? [{ value: "", label: "No portfolio" }] : []), ...portfolios.map((x) => ({ value: x.id, label: x.name }))],
    },
    { name: "timezone", label: "Time zone", type: "select", options: TIMEZONE_OPTIONS, defaultValue: p.timezone ?? "America/Vancouver" },
    { name: "addressLine1", label: "Street address", defaultValue: p.addressLine1, span: 2 },
    { name: "city", label: "City", defaultValue: p.city },
    { name: "region", label: "Province / state", defaultValue: p.region ?? "BC" },
    { name: "postalCode", label: "Postal code", defaultValue: p.postalCode },
    { name: "emergencyPhone", label: "24/7 emergency line", type: "tel", defaultValue: p.emergencyPhone, hint: "Shown to residents on their home screen." },
    { name: "officeHours", label: "Office / front desk hours", defaultValue: p.officeHours, placeholder: "Mon–Fri 9–5, desk 24/7" },
    { name: "emergencyInfo", label: "Emergency information for residents", type: "textarea", defaultValue: p.emergencyInfo, span: 2,
      hint: "Your building's approved procedure (shut-off valves, muster point…). Shown as written; never generated." },
  ];
}
