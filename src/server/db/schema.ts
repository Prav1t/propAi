import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  date,
  numeric,
} from "drizzle-orm/pg-core";

// shared column helpers
const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/* ───────────────────────── Global identity (no RLS) ───────────────────────── */

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(), // always stored lower-cased
    name: text("name").notNull(),
    passwordHash: text("password_hash"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    status: text("status").notNull().default("active"),
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    mfaSecretEnc: text("mfa_secret_enc"), // AES-256-GCM encrypted TOTP secret
    mfaPendingSecretEnc: text("mfa_pending_secret_enc"), // during enrollment
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("users_email_uq").on(t.email),
    check("users_status_ck", sql`${t.status} in ('active','deactivated')`),
    check("users_email_lower_ck", sql`${t.email} = lower(${t.email})`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // sha256(token) hex
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const emailTokens = pgTable(
  "email_tokens",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("email_tokens_hash_uq").on(t.tokenHash),
    index("email_tokens_user_idx").on(t.userId, t.purpose),
    check("email_tokens_purpose_ck", sql`${t.purpose} in ('verify_email','reset_password')`),
  ],
);

export const mfaChallenges = pgTable("mfa_challenges", {
  id: text("id").primaryKey(), // sha256(token) hex
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const mfaRecoveryCodes = pgTable(
  "mfa_recovery_codes",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("mfa_recovery_user_idx").on(t.userId)],
);

export const loginEvents = pgTable(
  "login_events",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    success: boolean("success").notNull(),
    reason: text("reason"), // bad_password, locked, mfa_failed, ok, ...
    suspicious: boolean("suspicious").notNull().default(false),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("login_events_user_idx").on(t.userId, t.createdAt)],
);

export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: id(),
    to: text("to").notNull(),
    subject: text("subject").notNull(),
    text: text("text").notNull(),
    html: text("html"),
    template: text("template").notNull(),
    status: text("status").notNull().default("queued"),
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("email_outbox_to_idx").on(t.to, t.createdAt),
    check("email_outbox_status_ck", sql`${t.status} in ('queued','sent','failed','logged')`),
  ],
);

// catalog of permission keys, synced from code on every migrate
export const permissions = pgTable("permissions", {
  key: text("key").primaryKey(),
  module: text("module").notNull(),
  description: text("description").notNull(),
});

/* ───────────────────────── Tenant-owned (RLS) ───────────────────────── */

export const organizations = pgTable(
  "organizations",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: text("status").notNull().default("active"),
    kind: text("kind").notNull().default("property_management"),
    timezone: text("timezone").notNull().default("America/Vancouver"),
    planKey: text("plan_key").notNull().default("trial"),
    settings: jsonb("settings").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("organizations_slug_uq").on(t.slug),
    check("organizations_status_ck", sql`${t.status} in ('active','suspended')`),
    check(
      "organizations_kind_ck",
      sql`${t.kind} in ('property_management','strata','rental','facility','concierge','owner_operator')`,
    ),
  ],
);

export const roles = pgTable(
  "roles",
  {
    id: id(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }), // null = system role
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    category: text("category").notNull(), // platform | resident
    scopeLevel: text("scope_level").notNull(), // org | scoped | occupant | assigned
    isSystem: boolean("is_system").notNull().default(false),
    permissions: text("permissions").array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("roles_org_key_uq").on(sql`coalesce(${t.orgId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.key),
    check("roles_scope_ck", sql`${t.scopeLevel} in ('org','scoped','occupant','assigned')`),
    check("roles_category_ck", sql`${t.category} in ('staff','resident','external')`),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").notNull().references(() => roles.id),
    status: text("status").notNull().default("active"),
    title: text("title"),
    vendorId: uuid("vendor_id").references((): AnyPgColumn => vendors.id, { onDelete: "set null" }), // vendor users only
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("memberships_org_user_uq").on(t.orgId, t.userId),
    index("memberships_user_idx").on(t.userId),
    check("memberships_status_ck", sql`${t.status} in ('active','deactivated')`),
  ],
);

export const portfolios = pgTable(
  "portfolios",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("portfolios_org_idx").on(t.orgId)],
);

export const properties = pgTable(
  "properties",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    portfolioId: uuid("portfolio_id").references(() => portfolios.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    type: text("type").notNull().default("residential"),
    addressLine1: text("address_line1"),
    city: text("city"),
    region: text("region"),
    postalCode: text("postal_code"),
    country: text("country").notNull().default("CA"),
    timezone: text("timezone").notNull().default("America/Vancouver"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("properties_org_idx").on(t.orgId),
    index("properties_portfolio_idx").on(t.portfolioId),
    uniqueIndex("properties_org_code_uq").on(t.orgId, t.code),
    check("properties_type_ck", sql`${t.type} in ('residential','commercial','mixed_use','strata','rental','industrial')`),
  ],
);

export const buildings = pgTable(
  "buildings",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    yearBuilt: integer("year_built"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("buildings_org_property_idx").on(t.orgId, t.propertyId),
    uniqueIndex("buildings_property_code_uq").on(t.propertyId, t.code),
  ],
);

export const floors = pgTable(
  "floors",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id").notNull().references(() => buildings.id, { onDelete: "cascade" }),
    level: integer("level").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("floors_org_building_idx").on(t.orgId, t.buildingId),
    uniqueIndex("floors_building_level_uq").on(t.buildingId, t.level),
  ],
);

export const units = pgTable(
  "units",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id").notNull().references(() => buildings.id, { onDelete: "cascade" }),
    floorId: uuid("floor_id").references(() => floors.id, { onDelete: "set null" }),
    number: text("number").notNull(),
    type: text("type").notNull().default("residential"),
    bedrooms: integer("bedrooms"),
    bathrooms: numeric("bathrooms", { precision: 3, scale: 1 }),
    areaSqft: integer("area_sqft"),
    status: text("status").notNull().default("occupied"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("units_org_property_idx").on(t.orgId, t.propertyId),
    index("units_building_idx").on(t.buildingId),
    uniqueIndex("units_building_number_uq").on(t.buildingId, t.number),
    check("units_type_ck", sql`${t.type} in ('residential','commercial','storage','amenity','other')`),
    check("units_status_ck", sql`${t.status} in ('occupied','vacant','notice','renovation','unavailable')`),
  ],
);

// people who live in / own units; may or may not have a login (user_id)
export const residents = pgTable(
  "residents",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email"),
    phone: text("phone"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("residents_org_idx").on(t.orgId),
    uniqueIndex("residents_org_user_uq").on(t.orgId, t.userId),
  ],
);

export const unitOccupancies = pgTable(
  "unit_occupancies",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id").notNull().references(() => units.id, { onDelete: "cascade" }),
    residentId: uuid("resident_id").notNull().references(() => residents.id, { onDelete: "cascade" }),
    relationship: text("relationship").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    createdAt: createdAt(),
  },
  (t) => [
    index("occupancies_org_unit_idx").on(t.orgId, t.unitId),
    index("occupancies_resident_idx").on(t.residentId),
    check("occupancies_rel_ck", sql`${t.relationship} in ('resident','tenant','owner','occupant')`),
  ],
);

export const membershipScopes = pgTable(
  "membership_scopes",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id").notNull().references(() => memberships.id, { onDelete: "cascade" }),
    portfolioId: uuid("portfolio_id").references(() => portfolios.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id").references(() => buildings.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("membership_scopes_membership_idx").on(t.membershipId),
    check(
      "membership_scopes_one_ck",
      sql`num_nonnulls(${t.portfolioId}, ${t.propertyId}, ${t.buildingId}) = 1`,
    ),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    roleId: uuid("role_id").notNull().references(() => roles.id),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "cascade" }),
    residentId: uuid("resident_id").references((): AnyPgColumn => residents.id, { onDelete: "cascade" }), // resident app invite
    vendorId: uuid("vendor_id").references((): AnyPgColumn => vendors.id, { onDelete: "cascade" }), // vendor user invite
    tokenHash: text("token_hash").notNull(),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("invitations_token_uq").on(t.tokenHash),
    index("invitations_org_idx").on(t.orgId, t.createdAt),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
    aiGenerated: boolean("ai_generated").notNull().default(false),
    approvalId: uuid("approval_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_org_created_idx").on(t.orgId, t.createdAt),
    index("audit_logs_entity_idx").on(t.orgId, t.entityType, t.entityId),
  ],
);

export const vendors = pgTable(
  "vendors",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    email: text("email"),
    phone: text("phone"),
    website: text("website"),
    categories: text("categories").array().notNull().default(sql`'{}'::text[]`),
    serviceAreas: text("service_areas").array().notNull().default(sql`'{}'::text[]`),
    status: text("status").notNull().default("active"),
    licenseNumber: text("license_number"),
    insuranceExpiresOn: date("insurance_expires_on"),
    hourlyRate: numeric("hourly_rate", { precision: 10, scale: 2 }),
    slaResponseHours: integer("sla_response_hours"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("vendors_org_idx").on(t.orgId, t.name),
    uniqueIndex("vendors_org_name_uq").on(t.orgId, sql`lower(${t.name})`),
    check("vendors_status_ck", sql`${t.status} in ('active','inactive','blocked')`),
  ],
);

export const vendorContacts = pgTable(
  "vendor_contacts",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id").notNull().references(() => vendors.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    title: text("title"),
    email: text("email"),
    phone: text("phone"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("vendor_contacts_vendor_idx").on(t.orgId, t.vendorId)],
);

// which properties a vendor is approved to work at
export const vendorProperties = pgTable(
  "vendor_properties",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id").notNull().references(() => vendors.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("vendor_properties_uq").on(t.vendorId, t.propertyId),
    index("vendor_properties_property_idx").on(t.orgId, t.propertyId),
  ],
);

// staff directory details layered on a membership
export const staffProfiles = pgTable(
  "staff_profiles",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id").notNull().references(() => memberships.id, { onDelete: "cascade" }),
    phone: text("phone"),
    skills: text("skills").array().notNull().default(sql`'{}'::text[]`),
    employmentType: text("employment_type").notNull().default("full_time"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("staff_profiles_membership_uq").on(t.membershipId),
    index("staff_profiles_org_idx").on(t.orgId),
    check("staff_profiles_type_ck", sql`${t.employmentType} in ('full_time','part_time','contract','on_call')`),
  ],
);

export type User = typeof users.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
