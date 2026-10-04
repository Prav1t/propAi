import type { FieldDef } from "@/components/ui/schema-form";
import { ANNOUNCEMENT_CATEGORIES } from "@/server/db/schema";
import { ANNOUNCEMENT_CATEGORY, AUDIENCE } from "@/lib/community-labels";

type A = Partial<{ title: string; body: string; category: string; propertyId: string | null; buildingIds: string[]; audience: string; pinned: boolean; notify: boolean; status: string; publishAt: string; expiresOn: string }>;

export function announcementFields(opts: { properties: { id: string; name: string }[]; buildings: { id: string; name: string; propertyId: string }[]; orgWide: boolean }, a: A = {}, locked = false): FieldDef[] {
  const placeLocked = locked; // a published announcement keeps its audience
  return [
    { name: "title", label: "Title", defaultValue: a.title, autoFocus: !a.title, span: 2, maxLength: 140 },
    { name: "body", label: "Message", type: "textarea", defaultValue: a.body, span: 2, rows: 8, hint: "You can use {{property}}, {{org_name}} and {{today}}." },
    { name: "category", label: "Category", type: "select", defaultValue: a.category ?? "general", options: ANNOUNCEMENT_CATEGORIES.map((c) => ({ value: c, label: ANNOUNCEMENT_CATEGORY[c].label })) },
    ...(placeLocked ? [] : [
      { name: "audience", label: "Audience", type: "select" as const, defaultValue: a.audience ?? "everyone", options: Object.entries(AUDIENCE).map(([value, label]) => ({ value, label })) },
      { name: "propertyId", label: "Property", type: "select" as const, defaultValue: a.propertyId ?? (opts.orgWide ? "" : opts.properties[0]?.id), options: [...(opts.orgWide ? [{ value: "", label: "All properties" }] : []), ...opts.properties.map((p) => ({ value: p.id, label: p.name }))] },
      ...(opts.buildings.length ? [{ name: "buildingIds", label: "Only these buildings (optional)", type: "checkboxes" as const, span: 2 as const, checked: a.buildingIds ?? [],
        options: opts.buildings.map((b) => ({ value: b.id, label: `${opts.properties.find((p) => p.id === b.propertyId)?.name ?? ""} · ${b.name}` })), hint: "Leave all unticked for the whole property. Buildings must belong to the property chosen above." }] : []),
      { name: "mode", label: "When", type: "select" as const, defaultValue: a.status === "scheduled" ? "schedule" : a.status === "draft" ? "draft" : "publish", options: [{ value: "publish", label: "Publish now" }, { value: "schedule", label: "Schedule" }, { value: "draft", label: "Save as draft" }] },
      { name: "publishAt", label: "Publish at (when scheduling)", type: "datetime-local" as const, defaultValue: a.publishAt ?? "" },
    ]),
    { name: "expiresOn", label: "Hide after (optional)", type: "date", defaultValue: a.expiresOn ?? "" },
    { name: "pinned", label: "Pin to the top", type: "checkbox", defaultValue: a.pinned ?? false },
    ...(placeLocked ? [] : [{ name: "notify", label: "Notify the audience (in-app and email, per their settings)", type: "checkbox" as const, defaultValue: a.notify ?? true, span: 2 as const }]),
  ];
}
