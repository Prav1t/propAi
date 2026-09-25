import "server-only";
import { and, asc, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { invitations, memberships, organizations, properties, roles, users, vendorContacts, vendorProperties, vendors } from "../../db/schema";
import { authorize, can, ForbiddenError, NotFoundError, type Principal } from "../../authz/authorize";
import { auditAs, blankToNull, ConflictError, friendlyUnique, tenantTx, ValidationError, type TenantCtx } from "../context";
import { matches, pageArgs, toPage, toPrefixQuery, visiblePropertyIds, type Page } from "../scope";
import { generateToken, hashToken } from "../../auth/crypto";
import { emailSchema } from "../../auth/service";
import { sendEmail } from "../../mail/mailer";
import { invitationTemplate } from "../../mail/templates";
import { env } from "../../env";
import type { Tx } from "../../db/client";

export const VENDOR_CATEGORIES = [
  "plumbing", "electrical", "hvac", "elevator", "cleaning", "landscaping", "pest_control", "security", "fire_safety",
  "roofing", "painting", "general_contractor", "appliance_repair", "locksmith", "snow_removal", "other",
] as const;
export const VENDOR_STATUSES = ["active", "inactive", "blocked"] as const;

const optText = (max = 200) => z.string().trim().max(max).optional().transform(blankToNull);
const csv = (allowed?: readonly string[]) =>
  z.string().max(1000).optional().transform((v, c) => {
    const items = [...new Set((v ?? "").split(",").map((s) => s.trim().toLowerCase().replace(/\s+/g, "_")).filter(Boolean))].slice(0, 20);
    if (allowed) {
      const bad = items.filter((i) => !allowed.includes(i));
      if (bad.length) c.addIssue({ code: "custom", message: `Unknown: ${bad.join(", ")}` });
    }
    return items;
  });

export const vendorSchema = z.object({
  name: z.string().trim().min(2, "Enter the company name.").max(160),
  legalName: optText(200),
  email: z.union([z.literal(""), z.string().trim().toLowerCase().email("Enter a valid email.")]).optional().transform((v) => (v ? v : null)),
  phone: optText(40),
  website: z.union([z.literal(""), z.string().trim().url("Enter a full URL, e.g. https://…").refine((u) => /^https?:\/\//i.test(u), "Use http(s).")]).optional().transform((v) => (v ? v : null)),
  categories: csv(VENDOR_CATEGORIES),
  serviceAreas: z.string().max(1000).optional().transform((v) => [...new Set((v ?? "").split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 30)),
  status: z.enum(VENDOR_STATUSES),
  licenseNumber: optText(80),
  insuranceExpiresOn: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")]).optional().transform((v) => (v ? v : null)),
  hourlyRate: z.union([z.literal(""), z.coerce.number().min(0).max(100000)]).optional().transform((v) => (v === "" || v === undefined ? null : v.toFixed(2))),
  slaResponseHours: z.union([z.literal(""), z.coerce.number().int().min(1).max(720)]).optional().transform((v) => (v === "" || v === undefined ? null : v)),
  notes: optText(4000),
});
export type VendorInput = z.infer<typeof vendorSchema>;

export const contactSchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(120),
  title: optText(120),
  email: z.union([z.literal(""), z.string().trim().toLowerCase().email("Enter a valid email.")]).optional().transform((v) => (v ? v : null)),
  phone: optText(40),
  isPrimary: z.union([z.literal("on"), z.literal("")]).optional().transform((v) => v === "on"),
});

const VENDOR_UNIQUE = { vendors_org_name_uq: ["A vendor with this name already exists.", "name"] } as Record<string, [string, string]>;

// vendors are an org directory: org-wide roles manage all; scoped managers manage vendors serving their properties
function canManageVendor(p: Principal, vendorPropertyIds: string[]): boolean {
  if (!p.permissions.has("vendor.manage")) return false;
  if (p.role.scopeLevel === "org") return true;
  return vendorPropertyIds.some((id) => can(p, "vendor.manage", { orgId: p.orgId, propertyId: id }));
}

async function loadVendor(tx: Tx, orgId: string, id: string) {
  const [v] = await tx.select().from(vendors).where(and(eq(vendors.id, id), eq(vendors.orgId, orgId)));
  if (!v) throw new NotFoundError();
  const props = await tx.select({ propertyId: vendorProperties.propertyId }).from(vendorProperties).where(eq(vendorProperties.vendorId, id));
  return { vendor: v, propertyIds: props.map((x) => x.propertyId) };
}

async function assertManage(ctx: TenantCtx, tx: Tx, id: string) {
  const loaded = await loadVendor(tx, ctx.principal.orgId, id);
  if (!canManageVendor(ctx.principal, loaded.propertyIds)) throw new ForbiddenError("You can only manage vendors assigned to your properties.");
  return loaded;
}

export type VendorRow = {
  id: string; name: string; categories: string[]; status: string; phone: string | null; email: string | null;
  insuranceExpiresOn: string | null; propertyCount: number; primaryContact: string | null;
};

export async function listVendors(ctx: TenantCtx, opts: { q?: string; category?: string; status?: string; propertyId?: string; page?: number }): Promise<Page<VendorRow>> {
  const p = ctx.principal;
  authorize(p, "vendor.read");
  const { page, pageSize, offset } = pageArgs(opts.page);
  const tsq = toPrefixQuery(opts.q);
  return tenantTx(ctx, async (tx) => {
    const where = and(
      eq(vendors.orgId, p.orgId),
      tsq ? matches("vendors", tsq) : undefined,
      opts.category && (VENDOR_CATEGORIES as readonly string[]).includes(opts.category) ? sql`${opts.category} = any(${vendors.categories})` : undefined,
      opts.status && (VENDOR_STATUSES as readonly string[]).includes(opts.status) ? eq(vendors.status, opts.status) : undefined,
      opts.propertyId ? sql`exists (select 1 from vendor_properties vp where vp.vendor_id = vendors.id and vp.property_id = ${opts.propertyId})` : undefined,
    );
    const [{ n }] = await tx.select({ n: count() }).from(vendors).where(where);
    const rows = await tx
      .select({
        id: vendors.id, name: vendors.name, categories: vendors.categories, status: vendors.status, phone: vendors.phone, email: vendors.email,
        insuranceExpiresOn: vendors.insuranceExpiresOn,
        propertyCount: sql<number>`(select count(*)::int from vendor_properties vp where vp.vendor_id = vendors.id)`,
        primaryContact: sql<string | null>`(select c.name from vendor_contacts c where c.vendor_id = vendors.id order by c.is_primary desc, c.created_at limit 1)`,
      })
      .from(vendors).where(where).orderBy(asc(vendors.name)).limit(pageSize).offset(offset);
    return toPage(rows, n, page, pageSize);
  });
}

export async function getVendor(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  authorize(p, "vendor.read");
  const visible = visiblePropertyIds(p);
  return tenantTx(ctx, async (tx) => {
    const { vendor, propertyIds } = await loadVendor(tx, p.orgId, id);
    const contacts = await tx.select().from(vendorContacts).where(eq(vendorContacts.vendorId, id)).orderBy(sql`${vendorContacts.isPrimary} desc`, asc(vendorContacts.name));
    // only show assigned properties the viewer can see
    const assigned = await tx.select({ id: properties.id, name: properties.name, code: properties.code }).from(vendorProperties)
      .innerJoin(properties, eq(properties.id, vendorProperties.propertyId))
      .where(and(eq(vendorProperties.vendorId, id), visible ? (visible.length ? inArray(properties.id, visible) : sql`false`) : undefined))
      .orderBy(asc(properties.name));
    const assignable = await tx.select({ id: properties.id, name: properties.name }).from(properties)
      .where(and(eq(properties.orgId, p.orgId), visible ? (visible.length ? inArray(properties.id, visible) : sql`false`) : undefined)).orderBy(asc(properties.name));
    const appUsers = p.permissions.has("member.read")
      ? await tx.select({ membershipId: memberships.id, name: users.name, email: users.email, status: memberships.status })
          .from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.vendorId, id))
      : [];
    const pendingInvites = await tx.select({ id: invitations.id, email: invitations.email }).from(invitations)
      .where(and(eq(invitations.vendorId, id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())));
    const manage = canManageVendor(p, propertyIds);
    return {
      vendor, contacts, properties: assigned,
      assignableProperties: assignable.filter((a) => !propertyIds.includes(a.id) && can(p, "vendor.manage", { orgId: p.orgId, propertyId: a.id })),
      appUsers, pendingInvites, canManage: manage, canDelete: manage && p.role.scopeLevel === "org",
      canUnassign: (propertyId: string) => can(p, "vendor.manage", { orgId: p.orgId, propertyId }),
    };
  });
}

export async function createVendor(ctx: TenantCtx, input: VendorInput, propertyId: string | null) {
  const p = ctx.principal;
  authorize(p, "vendor.read");
  if (p.role.scopeLevel !== "org") {
    if (!propertyId) throw new ValidationError("Choose one of your properties for this vendor.", "propertyId");
    authorize(p, "vendor.manage", { orgId: p.orgId, propertyId });
  } else authorize(p, "vendor.manage");
  return friendlyUnique(() => tenantTx(ctx, async (tx) => {
    const [row] = await tx.insert(vendors).values({ orgId: p.orgId, ...input }).returning();
    if (propertyId) {
      const [prop] = await tx.select({ id: properties.id }).from(properties).where(and(eq(properties.id, propertyId), eq(properties.orgId, p.orgId)));
      if (!prop) throw new ValidationError("Property not found.", "propertyId");
      await tx.insert(vendorProperties).values({ orgId: p.orgId, vendorId: row.id, propertyId });
    }
    await auditAs(tx, ctx, "vendor.created", "vendor", row.id, undefined, { ...row, propertyId });
    return row;
  }), VENDOR_UNIQUE);
}

export async function updateVendor(ctx: TenantCtx, id: string, input: VendorInput) {
  return friendlyUnique(() => tenantTx(ctx, async (tx) => {
    const { vendor: before } = await assertManage(ctx, tx, id);
    const [after] = await tx.update(vendors).set(input).where(eq(vendors.id, id)).returning();
    await auditAs(tx, ctx, "vendor.updated", "vendor", id, before, after);
    return after;
  }), VENDOR_UNIQUE);
}

export async function deleteVendor(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  if (p.role.scopeLevel !== "org") throw new ForbiddenError("Only organization-wide roles can delete vendors.");
  authorize(p, "vendor.manage");
  await tenantTx(ctx, async (tx) => {
    const { vendor } = await loadVendor(tx, p.orgId, id);
    // vendor users lose their link (and with it all access to assigned work)
    await tx.update(memberships).set({ status: "deactivated" }).where(eq(memberships.vendorId, id));
    await tx.delete(vendors).where(eq(vendors.id, id));
    await auditAs(tx, ctx, "vendor.deleted", "vendor", id, vendor);
  });
}

export async function addContact(ctx: TenantCtx, vendorId: string, input: z.infer<typeof contactSchema>) {
  return tenantTx(ctx, async (tx) => {
    await assertManage(ctx, tx, vendorId);
    if (input.isPrimary) await tx.update(vendorContacts).set({ isPrimary: false }).where(eq(vendorContacts.vendorId, vendorId));
    const [row] = await tx.insert(vendorContacts).values({ orgId: ctx.principal.orgId, vendorId, ...input }).returning();
    await auditAs(tx, ctx, "vendor.contact_added", "vendor_contact", row.id, undefined, row);
    return row;
  });
}

export async function removeContact(ctx: TenantCtx, contactId: string) {
  return tenantTx(ctx, async (tx) => {
    const [c] = await tx.select().from(vendorContacts).where(and(eq(vendorContacts.id, contactId), eq(vendorContacts.orgId, ctx.principal.orgId)));
    if (!c) throw new NotFoundError();
    await assertManage(ctx, tx, c.vendorId);
    await tx.delete(vendorContacts).where(eq(vendorContacts.id, contactId));
    await auditAs(tx, ctx, "vendor.contact_removed", "vendor_contact", contactId, c);
    return c.vendorId;
  });
}

// approving a vendor for a property requires vendor.manage on that property
export async function assignVendorProperty(ctx: TenantCtx, vendorId: string, propertyId: string) {
  const p = ctx.principal;
  authorize(p, "vendor.manage", { orgId: p.orgId, propertyId });
  await tenantTx(ctx, async (tx) => {
    await loadVendor(tx, p.orgId, vendorId);
    const [prop] = await tx.select({ id: properties.id }).from(properties).where(and(eq(properties.id, propertyId), eq(properties.orgId, p.orgId)));
    if (!prop) throw new NotFoundError();
    const inserted = await tx.insert(vendorProperties).values({ orgId: p.orgId, vendorId, propertyId }).onConflictDoNothing().returning();
    if (inserted.length) await auditAs(tx, ctx, "vendor.property_assigned", "vendor", vendorId, undefined, { propertyId });
  });
}

export async function unassignVendorProperty(ctx: TenantCtx, vendorId: string, propertyId: string) {
  const p = ctx.principal;
  authorize(p, "vendor.manage", { orgId: p.orgId, propertyId });
  await tenantTx(ctx, async (tx) => {
    await loadVendor(tx, p.orgId, vendorId);
    const del = await tx.delete(vendorProperties).where(and(eq(vendorProperties.vendorId, vendorId), eq(vendorProperties.propertyId, propertyId))).returning();
    if (del.length) await auditAs(tx, ctx, "vendor.property_unassigned", "vendor", vendorId, { propertyId });
  });
}

// invites a vendor employee as a "vendor" user linked to this company
export async function inviteVendorUser(ctx: TenantCtx, vendorId: string, rawEmail: string) {
  const p = ctx.principal;
  const email = emailSchema.parse(rawEmail);
  const token = generateToken();
  const { orgName, vendorName } = await tenantTx(ctx, async (tx) => {
    const { vendor } = await assertManage(ctx, tx, vendorId);
    const [role] = await tx.select().from(roles).where(and(isNull(roles.orgId), eq(roles.key, "vendor")));
    const [existing] = await tx.select({ id: memberships.id }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, p.orgId), eq(users.email, email)));
    if (existing) throw new ConflictError("This person is already a member of the organization.");
    await tx.update(invitations).set({ revokedAt: new Date() }).where(and(eq(invitations.orgId, p.orgId), eq(invitations.email, email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
    const [inv] = await tx.insert(invitations).values({
      orgId: p.orgId, email, roleId: role.id, vendorId, tokenHash: hashToken(token), invitedBy: p.userId, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
    }).returning();
    await auditAs(tx, ctx, "vendor.user_invited", "invitation", inv.id, undefined, { vendorId, email });
    const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, p.orgId));
    return { orgName: org.name, vendorName: vendor.name };
  });
  await sendEmail(email, invitationTemplate(orgName, `Vendor (${vendorName})`, "Your property management team", `${env().APP_URL}/invite/${token}`));
}
