import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { BRAND } from "@/config/brand";
import { env } from "@/server/env";
import { buildOpenApi } from "@/server/api/v1/openapi";
import { ROUTES } from "@/server/api/v1/routes";
import { ERROR_TYPES } from "@/server/api/v1/errors";
import { API_SCOPES } from "@/lib/api-scopes";
import { PUBLIC_EVENTS } from "@/server/webhooks/catalog";

export const metadata = { title: "API reference" };
export const dynamic = "force-dynamic";

type Json = Record<string, unknown>;
const typeOf = (s: Json): string => {
  if (s.$ref) return String(s.$ref).split("/").pop()!;
  if (Array.isArray(s.anyOf)) return (s.anyOf as Json[]).map(typeOf).join(" | ");
  if (s.enum) return (s.enum as string[]).map((v) => JSON.stringify(v)).join(" | ");
  if (s.const !== undefined) return JSON.stringify(s.const);
  const t = Array.isArray(s.type) ? (s.type as string[]).join(" | ") : String(s.type ?? "any");
  if (t.startsWith("array") && s.items) return `${typeOf(s.items as Json)}[]`;
  return s.format ? `${t} (${s.format})` : t;
};

function Fields({ schema, components }: { schema: Json; components: Json }) {
  const resolved = (schema.$ref ? components[String(schema.$ref).split("/").pop()!] : schema) as Json;
  const props = (resolved?.properties ?? {}) as Record<string, Json>;
  const required = new Set((resolved?.required as string[]) ?? []);
  if (!Object.keys(props).length) return null;
  return (
    <table className="mt-2 w-full text-left text-[13px]">
      <thead><tr className="text-muted"><th className="py-1 pr-4 font-medium">Field</th><th className="py-1 pr-4 font-medium">Type</th><th className="py-1 font-medium">Notes</th></tr></thead>
      <tbody>
        {Object.entries(props).map(([k, v]) => (
          <tr key={k} className="border-t border-border align-top">
            <td className="py-1 pr-4 font-mono text-[12px]">{k}{required.has(k) ? "" : <span className="text-faint">?</span>}</td>
            <td className="py-1 pr-4 font-mono text-[12px] text-muted">{typeOf(v)}</td>
            <td className="py-1 text-muted">{(v.description as string) ?? ""}{v.default !== undefined ? ` Default ${JSON.stringify(v.default)}.` : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// public reference generated from the same route table the server runs
export default function ApiReferencePage() {
  const doc = buildOpenApi(env().APP_URL);
  const components = ((doc.components as Json).schemas ?? {}) as Json;
  const paths = doc.paths as Record<string, Record<string, Json>>;
  const tags = [...new Set(ROUTES.map((r) => r.tag))];
  return (
    <div className="min-h-dvh">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <Link href="/"><Logo /></Link>
          <a className="text-sm text-accent underline" href="/api/v1/openapi.json">openapi.json</a>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">{BRAND.name} API v1</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted">A REST API for your own systems: properties, units, residents, vendors, work orders, incidents, complaints, bookings and packages. Base URL: <code className="font-mono">{env().APP_URL}/api/v1</code></p>

        <nav aria-label="Contents" className="mt-6 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {["Authentication", "Pagination", "Errors", "Idempotency", "Rate limits", ...tags, "Webhooks"].map((t) => <a key={t} className="text-accent underline" href={`#${t.toLowerCase().replace(/\s+/g, "-")}`}>{t}</a>)}
        </nav>

        <section id="authentication" className="mt-8 space-y-2 text-sm">
          <h2 className="text-lg font-semibold">Authentication</h2>
          <p>Create a key in Organization → Developers and send it on every request: <code className="font-mono">Authorization: Bearer ak_…</code>. A key acts for the person who created it, limited to the permissions (and properties) chosen for it — never more than that person can do today.</p>
          <ul className="list-disc pl-5 text-muted">{API_SCOPES.map((s) => <li key={s.perm}><code className="font-mono text-[12px]">{s.perm}</code> — {s.label} ({s.access})</li>)}</ul>
          <pre className="overflow-x-auto rounded-[var(--radius-md)] bg-subtle p-3 font-mono text-[12px]">{`curl ${env().APP_URL}/api/v1/work-orders?status=new,acknowledged&limit=10 \\\n  -H "Authorization: Bearer $API_KEY"`}</pre>
        </section>
        <section id="pagination" className="mt-8 space-y-2 text-sm">
          <h2 className="text-lg font-semibold">Pagination</h2>
          <p>Lists return <code className="font-mono">{`{ "object": "list", "data": [...], "has_more": true, "next_cursor": "…" }`}</code>. Pass <code className="font-mono">next_cursor</code> as <code className="font-mono">cursor</code> until <code className="font-mono">has_more</code> is false. <code className="font-mono">limit</code> is 1–100 (default 25); <code className="font-mono">order=asc|desc</code> sorts by creation time.</p>
        </section>
        <section id="errors" className="mt-8 space-y-2 text-sm">
          <h2 className="text-lg font-semibold">Errors</h2>
          <p>Every error has the same shape: <code className="font-mono">{`{ "error": { "type", "message", "details"?, "request_id" } }`}</code>.</p>
          <table className="w-full text-left text-[13px]"><tbody>{Object.entries(ERROR_TYPES).map(([k, v]) => <tr key={k} className="border-t border-border"><td className="py-1 pr-4 font-mono text-[12px]">{k}</td><td className="py-1 pr-4 tabular-nums">{v.status}</td><td className="py-1 text-muted">{v.description}</td></tr>)}</tbody></table>
        </section>
        <section id="idempotency" className="mt-8 space-y-2 text-sm">
          <h2 className="text-lg font-semibold">Idempotency</h2>
          <p>Send <code className="font-mono">Idempotency-Key: &lt;unique string&gt;</code> with a POST to retry it safely: for 24 hours the same key returns the first response (with <code className="font-mono">Idempotent-Replayed: true</code>) instead of acting twice. Reusing a key for a different request is refused.</p>
        </section>
        <section id="rate-limits" className="mt-8 space-y-2 text-sm">
          <h2 className="text-lg font-semibold">Rate limits</h2>
          <p>Each key has a per-minute budget (120 by default), reported in <code className="font-mono">X-RateLimit-Limit</code>, <code className="font-mono">X-RateLimit-Remaining</code> and <code className="font-mono">X-RateLimit-Reset</code>. Over the limit you get 429 with <code className="font-mono">Retry-After</code>.</p>
        </section>

        {tags.map((tag) => (
          <section key={tag} id={tag.toLowerCase()} className="mt-10">
            <h2 className="text-lg font-semibold">{tag}</h2>
            <div className="mt-3 space-y-6">
              {ROUTES.filter((r) => r.tag === tag).map((r) => {
                const op = paths[r.path][r.method.toLowerCase()] as Json;
                const params = (op.parameters as Json[]).filter((p) => p.in === "query");
                const body = (op.requestBody as Json | undefined)?.content as Json | undefined;
                const okResponse = Object.entries(op.responses as Json).find(([k]) => k !== "default")!;
                const resSchema = ((okResponse[1] as Json).content as Json)["application/json"] as Json;
                return (
                  <article key={r.operationId} id={r.operationId} className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
                    <h3 className="flex flex-wrap items-center gap-2 font-mono text-[13px]"><span className={r.method === "GET" ? "rounded bg-accent-soft px-1.5 py-0.5 text-accent" : "rounded bg-success-soft px-1.5 py-0.5 text-success"}>{r.method}</span>/api/v1{r.path}</h3>
                    <p className="mt-1 text-sm font-medium">{r.summary}</p>
                    {r.description ? <p className="mt-1 text-[13px] text-muted">{r.description}</p> : null}
                    {r.scope ? <p className="mt-1 text-[12px] text-faint">Needs <code className="font-mono">{r.scope}</code></p> : null}
                    {params.length ? <><h4 className="mt-3 text-[13px] font-medium">Query parameters</h4><Fields schema={{ type: "object", properties: Object.fromEntries(params.map((p) => [p.name as string, { ...(p.schema as Json), description: p.description }])) }} components={components} /></> : null}
                    {body ? <><h4 className="mt-3 text-[13px] font-medium">Body</h4><Fields schema={(body["application/json"] as Json).schema as Json} components={components} /></> : null}
                    <h4 className="mt-3 text-[13px] font-medium">Returns {okResponse[0]}</h4>
                    {(resSchema.schema as Json).properties && ((resSchema.schema as Json).properties as Json).data
                      ? <p className="text-[13px] text-muted">A list of <a className="text-accent underline" href={`#schema-${typeOf((((resSchema.schema as Json).properties as Json).data as Json).items as Json)}`}>{typeOf((((resSchema.schema as Json).properties as Json).data as Json).items as Json)}</a> objects.</p>
                      : <p className="text-[13px] text-muted">A <a className="text-accent underline" href={`#schema-${typeOf(resSchema.schema as Json)}`}>{typeOf(resSchema.schema as Json)}</a> object.</p>}
                  </article>
                );
              })}
            </div>
          </section>
        ))}

        <section id="objects" className="mt-10">
          <h2 className="text-lg font-semibold">Objects</h2>
          <div className="mt-3 space-y-6">
            {Object.entries(components).filter(([k]) => k !== "Error" && !k.startsWith("Create") && !k.startsWith("Change") && !k.startsWith("Assign")).map(([name, s]) => (
              <article key={name} id={`schema-${name}`} className="rounded-[var(--radius-lg)] border border-border bg-surface p-4">
                <h3 className="font-mono text-[13px] font-semibold">{name}</h3>
                <Fields schema={s as Json} components={components} />
              </article>
            ))}
          </div>
        </section>

        <section id="webhooks" className="mt-10 space-y-2 text-sm">
          <h2 className="text-lg font-semibold">Webhooks</h2>
          <p>Add an endpoint in Organization → Developers. Each event is POSTed as <code className="font-mono">{`{ "id", "type", "created_at", "api_version": "v1", "data": { "object": … } }`}</code>, where the object has the same shape as the API returns.</p>
          <p>Headers: <code className="font-mono">Webhook-Id</code>, <code className="font-mono">Webhook-Timestamp</code>, <code className="font-mono">Webhook-Signature: t=&lt;timestamp&gt;,v1=&lt;hex HMAC-SHA256 of &quot;timestamp.raw body&quot;&gt;</code>. Verify the signature with the endpoint&apos;s secret, reject timestamps older than five minutes, answer 2xx within ten seconds. Failed deliveries are retried after 1 minute, 5 minutes, 30 minutes, 2, 6, 12 and 24 hours; an endpoint is switched off after 20 failures in a row.</p>
          <ul className="list-disc pl-5 text-muted">{PUBLIC_EVENTS.map((e) => <li key={e.type}><code className="font-mono text-[12px]">{e.type}</code> — {e.description}</li>)}</ul>
        </section>
      </main>
    </div>
  );
}
