import type { FieldDef } from "@/components/ui/schema-form";
import { KNOWLEDGE_CATEGORIES } from "@/server/db/schema";
import { DOCUMENT_AUDIENCE, KNOWLEDGE_CATEGORY } from "@/lib/community-labels";

type Options = { properties: { id: string; name: string }[]; buildings: { id: string; name: string; propertyName: string }[]; orgWide: boolean };
type Values = { title?: string; body?: string; category?: string; audience?: string; propertyId?: string | null; buildingId?: string | null };

// the same fields for a new entry and for a new version of one
export function entryFields(o: Options, v: Values = {}, editing = false): FieldDef[] {
  return [
    { name: "title", label: "Title", span: 2, defaultValue: v.title ?? "", placeholder: "Party room booking rules" },
    { name: "category", label: "Category", type: "select", defaultValue: v.category ?? "rules", options: KNOWLEDGE_CATEGORIES.map((c) => ({ value: c, label: KNOWLEDGE_CATEGORY[c] })) },
    { name: "audience", label: "Who can see it", type: "select", defaultValue: v.audience ?? "residents", options: Object.entries(DOCUMENT_AUDIENCE).map(([value, label]) => ({ value, label })),
      hint: "Staff always see entries for their properties. Residents and owners only get what's addressed to them." },
    { name: "propertyId", label: "Property", type: "select", defaultValue: v.propertyId ?? (o.orgWide ? "" : o.properties[0]?.id),
      options: [...(o.orgWide ? [{ value: "", label: "All properties" }] : []), ...o.properties.map((p) => ({ value: p.id, label: p.name }))] },
    { name: "buildingId", label: "Building (optional)", type: "select", defaultValue: v.buildingId ?? "", options: [{ value: "", label: "Whole property" }, ...o.buildings.map((b) => ({ value: b.id, label: `${b.propertyName} · ${b.name}` }))] },
    { name: "body", label: "Content", type: "textarea", span: 2, rows: 16, defaultValue: v.body ?? "",
      placeholder: "## Booking\nBook in the app at least 48 hours ahead…\n\n## Fees and deposit\n…",
      hint: "Write it the way you'd explain it. Start sections with “## Heading” — answers cite the section they come from. Facts only: the assistant quotes this to people." },
    { name: "notes", label: editing ? "What changed? (optional)" : "Note (optional)", span: 2, placeholder: editing ? "Deposit raised to $300 (council, Oct 2026)" : "Source: council resolution 2026-04" },
  ];
}
