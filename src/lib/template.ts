// {{variable}} templates for messages and announcements (shared by client and server)
export const TEMPLATE_VARIABLES = {
  resident_name: "Resident's full name",
  resident_first_name: "Resident's first name",
  unit: "Unit number",
  building: "Building name",
  property: "Property name",
  org_name: "Management company",
  staff_name: "Your name",
  today: "Today's date",
} as const;
export type TemplateVariable = keyof typeof TEMPLATE_VARIABLES;

const VAR = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function templateVariables(body: string): string[] {
  return [...new Set([...body.matchAll(VAR)].map((m) => m[1]))];
}

// unknown variables are left untouched and reported; known-but-empty ones are blanked and reported as missing
export function renderTemplate(body: string, vars: Partial<Record<TemplateVariable, string | null | undefined>>) {
  const unknown = new Set<string>();
  const missing = new Set<string>();
  const text = body.replace(VAR, (whole, name: string) => {
    if (!(name in TEMPLATE_VARIABLES)) { unknown.add(name); return whole; }
    const v = vars[name as TemplateVariable];
    if (v === null || v === undefined || v === "") { missing.add(name); return ""; }
    return v;
  });
  return { text, unknown: [...unknown], missing: [...missing] };
}
