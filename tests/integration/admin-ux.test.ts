// Iteration 12: custom roles, admin sign-out of members, and speech-to-text for the assistant.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPrincipal } from "@/server/modules/organizations/principal";
import { ValidationError, type TenantCtx } from "@/server/modules/context";
import { ForbiddenError, NotFoundError } from "@/server/authz/authorize";
import { closeDb } from "@/server/db/client";
import { createRole, deleteRole, STAFF_PERMISSIONS, updateRole } from "@/server/modules/members/roles";
import { changeMemberRole, inviteMember, listAssignableRoles } from "@/server/modules/members/service";
import { listMemberSessions, signOutMember } from "@/server/modules/members/sessions";
import { createSession } from "@/server/auth/service";
import { transcribe, transcriberFor, TranscribeRefused } from "@/server/ai/transcribe";
import { orgIdBySlug, ownerPool, userIdByEmail } from "../support/db";

const meta = { ip: "203.0.113.40", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Safari/605.1.15", requestId: "admin-ux" };
async function ctxFor(email: string, slug = "pacific-properties"): Promise<TenantCtx> {
  const p = await loadPrincipal(await userIdByEmail(email), slug);
  if (!p) throw new Error(`${email} not in ${slug}`);
  return { principal: p, meta };
}
const tag = `R${Math.random().toString(36).slice(2, 7)}`;
let admin: TenantCtx, pm: TenantCtx, staff: TenantCtx;
let org: string;

beforeAll(async () => {
  [admin, pm, staff] = await Promise.all(["admin", "pm", "staff"].map((u) => ctxFor(`${u}@demo.test`)));
  org = await orgIdBySlug("pacific-properties");
});
afterAll(async () => {
  await ownerPool.query("delete from invitations where email like $1", [`%${tag.toLowerCase()}%`]);
  await ownerPool.query("delete from roles where org_id = $1 and name like $2", [org, `${tag}%`]);
  await closeDb();
  await ownerPool.end();
});

describe("custom roles", () => {
  it("an admin defines a role with exactly the chosen permissions; it can be granted and changed", async () => {
    const role = await createRole(admin, { name: `${tag} Leasing`, description: "Leasing office", scopeLevel: "scoped", permissions: ["org.read", "unit.read", "resident.read", "document.read", "unit.read"] });
    expect(role).toMatchObject({ isSystem: false, category: "staff", scopeLevel: "scoped", orgId: org });
    expect(role.permissions).toEqual(["document.read", "org.read", "resident.read", "unit.read"]); // de-duplicated, sorted
    expect((await listAssignableRoles(admin)).some((r) => r.id === role.id)).toBe(true);
    const updated = await updateRole(admin, role.id, { name: `${tag} Leasing`, description: "", scopeLevel: "scoped", permissions: ["org.read", "unit.read"] });
    expect(updated).toMatchObject({ added: [], removed: ["document.read", "resident.read"] });
    const { rows } = await ownerPool.query("select action, after from audit_logs where entity_id = $1 order by created_at", [role.id]);
    expect(rows.map((r) => r.action)).toEqual(["role.created", "role.updated"]);
    await deleteRole(admin, role.id);
    expect((await ownerPool.query("select 1 from roles where id = $1", [role.id])).rowCount).toBe(0);
  });

  it("nobody can define a role with access they don't have, or wider than their own reach", async () => {
    // the property manager doesn't hold billing, security or role management
    await expect(createRole(pm, { name: `${tag} x`, description: "", scopeLevel: "scoped", permissions: ["org.read"] })).rejects.toBeInstanceOf(ForbiddenError); // no role.manage
    const pmPlus = { ...pm, principal: { ...pm.principal, permissions: new Set([...pm.principal.permissions, "role.manage"]) } };
    await expect(createRole(pmPlus, { name: `${tag} sneaky`, description: "", scopeLevel: "scoped", permissions: ["org.read", "billing.manage"] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createRole(pmPlus, { name: `${tag} wide`, description: "", scopeLevel: "org", permissions: ["org.read"] })).rejects.toThrow(/limited to properties/);
    const ok = await createRole(pmPlus, { name: `${tag} pm-made`, description: "", scopeLevel: "scoped", permissions: ["org.read", "workorder.read"] });
    // and can't then quietly edit a broader role the admin made
    const broad = await createRole(admin, { name: `${tag} broad`, description: "", scopeLevel: "org", permissions: ["org.read", "billing.manage"] });
    await expect(updateRole(pmPlus, broad.id, { name: `${tag} broad`, description: "", scopeLevel: "scoped", permissions: ["org.read"] })).rejects.toBeInstanceOf(ForbiddenError);
    await deleteRole(admin, ok.id);
    await deleteRole(admin, broad.id);
  });

  it("refuses unknown and resident-only permissions, duplicate names, and editing system roles", async () => {
    await expect(createRole(admin, { name: `${tag} y`, description: "", scopeLevel: "scoped", permissions: ["org.read", "root.everything"] })).rejects.toBeInstanceOf(ValidationError);
    expect(STAFF_PERMISSIONS).not.toContain("workorder.read.own");
    await expect(createRole(admin, { name: `${tag} y`, description: "", scopeLevel: "scoped", permissions: ["workorder.read.own"] })).rejects.toBeInstanceOf(ValidationError);
    await expect(createRole(admin, { name: "Property Manager", description: "", scopeLevel: "scoped", permissions: ["org.read"] })).rejects.toThrow(/already exists/);
    const { rows: [sys] } = await ownerPool.query("select id from roles where key = 'staff' and org_id is null");
    await expect(updateRole(admin, sys.id, { name: "Staff", description: "", scopeLevel: "scoped", permissions: ["org.read"] })).rejects.toBeInstanceOf(NotFoundError); // not this org's role
    await expect(deleteRole(admin, sys.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a role people hold keeps where it applies and can't be deleted until they move", async () => {
    const role = await createRole(admin, { name: `${tag} Night desk`, description: "", scopeLevel: "scoped", permissions: ["org.read", "package.manage", "visitor.manage"] });
    const { rows: [prop] } = await ownerPool.query("select id from properties where code = 'FRT'");
    await inviteMember(admin, { email: `night-${tag.toLowerCase()}@example.test`, roleId: role.id, propertyId: prop.id });
    await expect(deleteRole(admin, role.id)).rejects.toThrow(/Move the person/);
    // give an existing member the role, then try to widen it
    const { rows: [m] } = await ownerPool.query("select m.id from memberships m join users u on u.id = m.user_id where u.email = 'staff@demo.test' and m.org_id = $1", [org]);
    const { rows: [original] } = await ownerPool.query("select role_id from memberships where id = $1", [m.id]);
    const { rows: scopes } = await ownerPool.query("select org_id, portfolio_id, property_id, building_id from membership_scopes where membership_id = $1", [m.id]);
    await changeMemberRole(admin, { membershipId: m.id, roleId: role.id, propertyId: prop.id });
    await expect(updateRole(admin, role.id, { name: `${tag} Night desk`, description: "", scopeLevel: "org", permissions: ["org.read"] })).rejects.toThrow(/Create a new role/);
    // permission changes do reach the member at once
    await updateRole(admin, role.id, { name: `${tag} Night desk`, description: "", scopeLevel: "scoped", permissions: ["org.read", "package.manage"] });
    const after = await loadPrincipal(await userIdByEmail("staff@demo.test"), "pacific-properties");
    expect(after?.permissions.has("visitor.manage")).toBe(false);
    expect(after?.permissions.has("package.manage")).toBe(true);
    // put the demo staff member back exactly as seeded (role and scopes): later suites rely on them
    await ownerPool.query("update memberships set role_id = $1 where id = $2", [original.role_id, m.id]);
    await ownerPool.query("delete from membership_scopes where membership_id = $1", [m.id]);
    for (const s of scopes) await ownerPool.query("insert into membership_scopes (org_id, membership_id, portfolio_id, property_id, building_id) values ($1, $2, $3, $4, $5)", [s.org_id, m.id, s.portfolio_id, s.property_id, s.building_id]);
  });
});

describe("signing members out", () => {
  it("lists active sessions per member and ends all of them for someone who only uses this organization", async () => {
    const staffUser = staff.principal.userId;
    await createSession(staffUser, { ip: "198.51.100.7", userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/140.0 Mobile", requestId: null });
    const list = await listMemberSessions(admin);
    const mine = list.find((m) => m.userId === staffUser)!;
    expect(mine.sessions.length).toBeGreaterThanOrEqual(1);
    expect(mine.elsewhere).toBe(false);
    const r = await signOutMember(admin, mine.membershipId);
    expect(r.ended).toBeGreaterThanOrEqual(1);
    expect(r.kept).toBe(0);
    expect((await ownerPool.query("select count(*)::int n from sessions where user_id = $1", [staffUser])).rows[0].n).toBe(0);
    expect((await ownerPool.query("select count(*)::int n from audit_logs where action = 'session.revoked_by_admin' and entity_id = $1", [mine.membershipId])).rows[0].n).toBe(1);
  });

  it("only ends sessions from this organization's SSO for people who use other organizations too", async () => {
    // admin@demo.test is also a council member at Northshore; Northshore's admin can't sign them out of Pacific
    const ns = await ctxFor("admin@northshore.test", "northshore-strata");
    const adminUser = admin.principal.userId;
    await createSession(adminUser, { ip: "198.51.100.8", userAgent: "x", requestId: null });
    const { rows: [m] } = await ownerPool.query("select id from memberships where user_id = $1 and org_id = (select id from organizations where slug = 'northshore-strata')", [adminUser]);
    const before = (await ownerPool.query("select count(*)::int n from sessions where user_id = $1", [adminUser])).rows[0].n;
    const r = await signOutMember(ns, m.id);
    expect(r.ended).toBe(0);
    expect(r.kept).toBe(before);
    expect((await ownerPool.query("select count(*)::int n from sessions where user_id = $1", [adminUser])).rows[0].n).toBe(before);
  });

  it("needs the security permission, and never targets the admin's own sessions", async () => {
    await expect(listMemberSessions(pm)).rejects.toBeInstanceOf(ForbiddenError);
    const { rows: [self] } = await ownerPool.query("select id from memberships where user_id = $1 and org_id = $2", [admin.principal.userId, org]);
    await expect(signOutMember(admin, self.id)).rejects.toThrow(/your own devices/);
    await expect(signOutMember(admin, crypto.randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("speech to text for the assistant", () => {
  let server: Server;
  let port = 0;
  const seen: { auth?: string; model?: string; bytes: number }[] = [];
  beforeAll(async () => {
    // an OpenAI-compatible /audio/transcriptions endpoint
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("latin1");
        seen.push({ auth: req.headers.authorization, model: body.match(/name="model"\r\n\r\n([^\r]+)/)?.[1], bytes: body.length });
        if (body.includes("SILENCE")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ text: " " })); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: " Show overdue work orders " }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
    process.env.AI_TRANSCRIBE_BASE_URL = `http://127.0.0.1:${port}/v1`;
    process.env.AI_TRANSCRIBE_API_KEY = "test-transcribe-key";
  });
  afterAll(async () => {
    delete process.env.AI_TRANSCRIBE_BASE_URL;
    delete process.env.AI_TRANSCRIBE_API_KEY;
    await new Promise<void>((r) => server.close(() => r()));
  });
  const audio = (content = "RIFF....WAVEfmt fake audio", type = "audio/webm") => new File([content], "dictation.webm", { type });

  it("is off without a provider, and picks up an OpenAI-compatible one from the environment", () => {
    expect(transcriberFor({})).toBeNull();
    expect(transcriberFor({ AI_TRANSCRIBE_BASE_URL: "https://stt.example/v1/", AI_TRANSCRIBE_MODEL: "large-v3" })).toMatchObject({ baseUrl: "https://stt.example/v1", model: "large-v3" });
  });

  it("turns a recording into text and counts it as one assistant request", async () => {
    const before = (await ownerPool.query("select count(*)::int n from ai_usage where org_id = $1 and feature = 'transcribe'", [org])).rows[0].n;
    expect(await transcribe(pm, audio())).toBe("Show overdue work orders");
    expect(seen.at(-1)).toMatchObject({ auth: "Bearer test-transcribe-key", model: "whisper-1" });
    const after = (await ownerPool.query("select count(*)::int n from ai_usage where org_id = $1 and feature = 'transcribe' and outcome = 'ok'", [org])).rows[0].n;
    expect(after).toBe(before + 1);
  });

  it("refuses other formats, empty and oversized recordings, silence, and people without the assistant", async () => {
    await expect(transcribe(pm, audio("x", "application/pdf"))).rejects.toMatchObject({ status: 415 });
    await expect(transcribe(pm, audio(""))).rejects.toMatchObject({ status: 413 });
    await expect(transcribe(pm, new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.webm", { type: "audio/webm" }))).rejects.toMatchObject({ status: 413 });
    await expect(transcribe(pm, audio("SILENCE"))).rejects.toMatchObject({ status: 422 });
    const vendor = await ctxFor("vendor@demo.test");
    if (!vendor.principal.permissions.has("ai.use")) await expect(transcribe(vendor, audio())).rejects.toBeInstanceOf(TranscribeRefused);
  });
});
