import "server-only";
import { z } from "zod";
import { ROUTES } from "./routes";
import { ERROR_TYPES } from "./errors";
import { API_SCOPES } from "@/lib/api-scopes";
import { BRAND } from "@/config/brand";
import { PUBLIC_EVENTS } from "../../webhooks/catalog";

// OpenAPI 3.1 document generated from the route table and its Zod schemas (Iteration 10).

type Json = Record<string, unknown>;

// JSON Schema for one Zod schema; named schemas ($defs) are lifted into components
function toSchema(s: z.ZodType, components: Json, io: "input" | "output" = "output"): Json {
  const raw = z.toJSONSchema(s, { io, unrepresentable: "any" }) as Json;
  const defs = (raw.$defs ?? {}) as Json;
  delete raw.$defs;
  const fix = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === "object") {
      const o = { ...(v as Json) };
      delete o.$schema;
      delete o.$id;
      if (o.format === "uuid") delete o.pattern; // the format says it; the regex is noise in docs
      if (typeof o.$ref === "string") o.$ref = (o.$ref as string).replace("#/$defs/", "#/components/schemas/");
      for (const k of Object.keys(o)) o[k] = fix(o[k]);
      return o;
    }
    return v;
  };
  for (const [k, v] of Object.entries(defs)) components[k] = fix(v);
  return fix(raw) as Json;
}

let cached: Json | null = null;

export function buildOpenApi(serverUrl: string): Json {
  if (cached && (cached.servers as { url: string }[])[0].url === `${serverUrl}/api/v1`) return cached;
  const schemas: Json = {};
  const paths: Record<string, Json> = {};
  for (const r of ROUTES) {
    const pathParams = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string", format: "uuid" } }));
    const queryParams = r.query ? Object.entries(r.query.shape).map(([name, field]) => {
      const sch = toSchema(field as z.ZodType, schemas, "input");
      const description = sch.description;
      delete sch.description;
      return { name, in: "query", required: false, ...(description ? { description } : {}), schema: sch };
    }) : [];
    const op: Json = {
      operationId: r.operationId, summary: r.summary, tags: [r.tag], ...(r.description ? { description: r.description } : {}),
      "x-required-permission": r.scope, security: [{ apiKey: [] }],
      parameters: [...pathParams, ...queryParams, ...(r.method === "POST" ? [{ name: "Idempotency-Key", in: "header", required: false, description: "Retry safely: the same key returns the first response for 24 hours.", schema: { type: "string", maxLength: 255 } }] : [])],
      ...(r.body ? { requestBody: { required: true, content: { "application/json": { schema: toSchema(r.body, schemas, "input") } } } } : {}),
      responses: {
        [String(r.status ?? 200)]: { description: "OK", content: { "application/json": { schema: toSchema(r.response, schemas) } } },
        default: { description: "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
    };
    paths[r.path] = { ...(paths[r.path] ?? {}), [r.method.toLowerCase()]: op };
  }
  schemas.Error = {
    type: "object", required: ["error"],
    properties: { error: { type: "object", required: ["type", "message", "request_id"], properties: {
      type: { type: "string", enum: Object.keys(ERROR_TYPES) }, message: { type: "string" },
      details: { type: "array", items: { type: "object", properties: { field: { type: "string" }, message: { type: "string" } } } }, request_id: { type: "string" },
    } } },
  };
  cached = {
    openapi: "3.1.0",
    info: {
      title: `${BRAND.name} API`, version: "v1",
      description: [
        "Authenticate with an API key from Organization → Developers: `Authorization: Bearer ak_…`. A key acts for the person who created it, limited to the permissions (and properties) chosen for it.",
        "Lists use cursor pagination: pass `next_cursor` as `cursor` until `has_more` is false. Writes accept an `Idempotency-Key` header.",
        "Every response carries `X-Request-Id`; rate-limit headers report the per-key budget (per minute).",
        `Errors: ${Object.entries(ERROR_TYPES).map(([k, v]) => `\`${k}\` (${v.status})`).join(", ")}.`,
        `Webhook events: ${PUBLIC_EVENTS.map((e) => `\`${e.type}\``).join(", ")}.`,
      ].join("\n\n"),
    },
    servers: [{ url: `${serverUrl}/api/v1` }],
    tags: [...new Set(ROUTES.map((r) => r.tag))].map((name) => ({ name })),
    components: { securitySchemes: { apiKey: { type: "http", scheme: "bearer", description: "API key (ak_…)" } }, schemas },
    paths,
    "x-permissions": API_SCOPES.map((s) => ({ permission: s.perm, label: s.label, access: s.access })),
  };
  return cached;
}
