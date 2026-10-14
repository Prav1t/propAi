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
  vector,
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
    // shown to residents on their home screen (Iteration 4)
    emergencyPhone: text("emergency_phone"),
    emergencyInfo: text("emergency_info"),
    officeHours: text("office_hours"),
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

/* ───────────────────────── Operations (Iteration 3, RLS) ───────────────────────── */

const ts = (name: string) => timestamp(name, { withTimezone: true });

// per-org human-friendly sequences (WO-1024, INC-12, CMP-7)
export const orgCounters = pgTable(
  "org_counters",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: integer("value").notNull().default(0),
  },
  (t) => [uniqueIndex("org_counters_pk").on(t.orgId, t.key)],
);

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

// response/resolution targets per priority; property_id null = org default
export const slaPolicies = pgTable(
  "sla_policies",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "cascade" }),
    priority: text("priority").notNull(),
    respondMinutes: integer("respond_minutes").notNull(),
    resolveMinutes: integer("resolve_minutes").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("sla_policies_scope_uq").on(t.orgId, sql`coalesce(${t.propertyId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.priority),
    check("sla_priority_ck", sql`${t.priority} in ('low','normal','high','urgent')`),
    check("sla_minutes_ck", sql`${t.respondMinutes} > 0 and ${t.resolveMinutes} >= ${t.respondMinutes}`),
  ],
);

// configurable triage: keyword/category match → priority, emergency flag, default assignee, resident instructions
export const triageRules = pgTable(
  "triage_rules",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keywords: text("keywords").array().notNull().default(sql`'{}'::text[]`),
    category: text("category"),
    setPriority: text("set_priority"),
    setEmergency: boolean("set_emergency").notNull().default(false),
    setCategory: text("set_category"),
    assignMembershipId: uuid("assign_membership_id").references(() => memberships.id, { onDelete: "set null" }),
    assignVendorId: uuid("assign_vendor_id").references(() => vendors.id, { onDelete: "set null" }),
    residentInstructions: text("resident_instructions"),
    position: integer("position").notNull().default(100),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("triage_rules_org_idx").on(t.orgId, t.position)],
);

export const workOrders = pgTable(
  "work_orders",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id").references(() => buildings.id, { onDelete: "set null" }),
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "set null" }),
    area: text("area"),
    category: text("category").notNull(),
    priority: text("priority").notNull().default("normal"),
    isEmergency: boolean("is_emergency").notNull().default(false),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("new"),
    source: text("source").notNull().default("staff"),
    submittedByUserId: uuid("submitted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    residentId: uuid("resident_id").references(() => residents.id, { onDelete: "set null" }),
    assignedMembershipId: uuid("assigned_membership_id").references(() => memberships.id, { onDelete: "set null" }),
    vendorId: uuid("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
    permissionToEnter: boolean("permission_to_enter").notNull().default(false),
    entryNotes: text("entry_notes"),
    scheduledStart: ts("scheduled_start"),
    scheduledEnd: ts("scheduled_end"),
    respondDueAt: ts("respond_due_at"),
    resolveDueAt: ts("resolve_due_at"),
    firstResponseAt: ts("first_response_at"),
    completedAt: ts("completed_at"),
    closedAt: ts("closed_at"),
    cancelledAt: ts("cancelled_at"),
    slaBreachedAt: ts("sla_breached_at"),
    cost: numeric("cost", { precision: 12, scale: 2 }),
    resolutionNotes: text("resolution_notes"),
    triageRuleId: uuid("triage_rule_id").references(() => triageRules.id, { onDelete: "set null" }),
    sourceType: text("source_type"), // inspection | incident | complaint | booking | pm_schedule
    sourceId: uuid("source_id"),
    assetId: uuid("asset_id").references((): AnyPgColumn => assets.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("work_orders_org_number_uq").on(t.orgId, t.number),
    index("work_orders_asset_idx").on(t.assetId),
    index("work_orders_org_status_idx").on(t.orgId, t.status),
    index("work_orders_property_idx").on(t.orgId, t.propertyId, t.createdAt),
    index("work_orders_vendor_idx").on(t.vendorId),
    index("work_orders_assignee_idx").on(t.assignedMembershipId),
    index("work_orders_submitter_idx").on(t.submittedByUserId),
    index("work_orders_unit_idx").on(t.unitId),
    check("wo_status_ck", sql`${t.status} in ('new','acknowledged','assigned','scheduled','in_progress','awaiting_vendor','awaiting_resident','completed','closed','cancelled')`),
    check("wo_priority_ck", sql`${t.priority} in ('low','normal','high','urgent')`),
    check("wo_source_ck", sql`${t.source} in ('resident','staff','inspection','incident','complaint','system')`),
    check("wo_cost_ck", sql`${t.cost} is null or ${t.cost} >= 0`),
  ],
);

// shared activity timeline for work orders, tasks, incidents, complaints and inspections
export const timelineEvents = pgTable(
  "timeline_events",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    kind: text("kind").notNull(), // created | status | assigned | comment | scheduled | attachment | escalated | rule
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    body: text("body"),
    visibility: text("visibility").notNull().default("internal"), // public | vendor | internal
    createdAt: createdAt(),
  },
  (t) => [
    index("timeline_entity_idx").on(t.orgId, t.entityType, t.entityId, t.createdAt),
    check("timeline_visibility_ck", sql`${t.visibility} in ('public','vendor','internal')`),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id").references(() => buildings.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("open"),
    priority: text("priority").notNull().default("normal"),
    dueAt: ts("due_at"),
    assignedMembershipId: uuid("assigned_membership_id").references(() => memberships.id, { onDelete: "set null" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    source: text("source").notNull().default("manual"),
    sourceType: text("source_type"),
    sourceId: uuid("source_id"),
    recurrence: text("recurrence").notNull().default("none"),
    blockedByTaskId: uuid("blocked_by_task_id").references((): AnyPgColumn => tasks.id, { onDelete: "set null" }),
    completedAt: ts("completed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tasks_org_status_idx").on(t.orgId, t.status, t.dueAt),
    index("tasks_assignee_idx").on(t.assignedMembershipId),
    check("tasks_status_ck", sql`${t.status} in ('open','in_progress','blocked','done','cancelled')`),
    check("tasks_priority_ck", sql`${t.priority} in ('low','normal','high','urgent')`),
    check("tasks_recurrence_ck", sql`${t.recurrence} in ('none','daily','weekly','monthly')`),
    check("tasks_source_ck", sql`${t.source} in ('manual','work_order','inspection','incident','complaint','recurring','system')`),
  ],
);

export const taskChecklistItems = pgTable(
  "task_checklist_items",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    done: boolean("done").notNull().default(false),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("task_checklist_task_idx").on(t.taskId, t.position)],
);

export const INSPECTION_KINDS = ["unit", "property", "equipment", "safety", "move_in", "move_out", "amenity"] as const;

export const inspectionTemplates = pgTable(
  "inspection_templates",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    items: jsonb("items").$type<{ section: string; label: string }[]>().notNull().default([]),
    repeatEveryDays: integer("repeat_every_days"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("inspection_templates_org_idx").on(t.orgId)],
);

export const inspections = pgTable(
  "inspections",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    templateId: uuid("template_id").references(() => inspectionTemplates.id, { onDelete: "set null" }),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id").references(() => buildings.id, { onDelete: "set null" }),
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    scheduledFor: date("scheduled_for").notNull(),
    status: text("status").notNull().default("scheduled"),
    inspectorMembershipId: uuid("inspector_membership_id").references(() => memberships.id, { onDelete: "set null" }),
    result: text("result"), // pass | fail
    summary: text("summary"),
    signedByName: text("signed_by_name"),
    completedAt: ts("completed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("inspections_org_idx").on(t.orgId, t.status, t.scheduledFor),
    check("inspections_status_ck", sql`${t.status} in ('scheduled','in_progress','completed','cancelled')`),
    check("inspections_result_ck", sql`${t.result} is null or ${t.result} in ('pass','fail')`),
  ],
);

export const inspectionItems = pgTable(
  "inspection_items",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    inspectionId: uuid("inspection_id").notNull().references(() => inspections.id, { onDelete: "cascade" }),
    section: text("section").notNull().default("General"),
    label: text("label").notNull(),
    position: integer("position").notNull().default(0),
    result: text("result"),
    severity: text("severity"),
    notes: text("notes"),
    workOrderId: uuid("work_order_id").references(() => workOrders.id, { onDelete: "set null" }),
  },
  (t) => [
    index("inspection_items_insp_idx").on(t.inspectionId, t.position),
    check("inspection_items_result_ck", sql`${t.result} is null or ${t.result} in ('pass','fail','na')`),
    check("inspection_items_sev_ck", sql`${t.severity} is null or ${t.severity} in ('low','medium','high','critical')`),
  ],
);

export const INCIDENT_TYPES = ["security", "water_damage", "fire", "equipment_failure", "resident", "injury", "property_damage", "unauthorized_access", "other"] as const;

export const incidents = pgTable(
  "incidents",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id").references(() => buildings.id, { onDelete: "set null" }),
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    severity: text("severity").notNull().default("medium"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    location: text("location"),
    occurredAt: ts("occurred_at").notNull(),
    status: text("status").notNull().default("open"),
    reportedByUserId: uuid("reported_by_user_id").references(() => users.id, { onDelete: "set null" }),
    peopleInvolved: text("people_involved"),
    externalReference: text("external_reference"),
    resolution: text("resolution"),
    resolvedAt: ts("resolved_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("incidents_org_number_uq").on(t.orgId, t.number),
    index("incidents_org_idx").on(t.orgId, t.status, t.occurredAt),
    check("incidents_status_ck", sql`${t.status} in ('open','investigating','resolved','closed')`),
    check("incidents_severity_ck", sql`${t.severity} in ('low','medium','high','critical')`),
  ],
);

export const COMPLAINT_CATEGORIES = ["noise", "parking", "pets", "smoking", "cleanliness", "neighbour", "amenity", "staff", "maintenance", "other"] as const;

export const complaints = pgTable(
  "complaints",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id").references(() => buildings.id, { onDelete: "set null" }),
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "set null" }),
    category: text("category").notNull(),
    priority: text("priority").notNull().default("normal"),
    subject: text("subject").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("new"),
    submittedByUserId: uuid("submitted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    residentId: uuid("resident_id").references(() => residents.id, { onDelete: "set null" }),
    assignedMembershipId: uuid("assigned_membership_id").references(() => memberships.id, { onDelete: "set null" }),
    relatedIncidentId: uuid("related_incident_id").references(() => incidents.id, { onDelete: "set null" }),
    resolution: text("resolution"),
    resolvedAt: ts("resolved_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("complaints_org_number_uq").on(t.orgId, t.number),
    index("complaints_org_idx").on(t.orgId, t.status, t.createdAt),
    check("complaints_status_ck", sql`${t.status} in ('new','acknowledged','investigating','resolved','closed','dismissed')`),
    check("complaints_priority_ck", sql`${t.priority} in ('low','normal','high','urgent')`),
  ],
);

// uploaded files; access always goes through the parent entity's permission check
export const files = pgTable(
  "files",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    visibility: text("visibility").notNull().default("internal"),
    scanStatus: text("scan_status").notNull().default("unscanned"),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("files_entity_idx").on(t.orgId, t.entityType, t.entityId),
    uniqueIndex("files_storage_key_uq").on(t.storageKey),
    check("files_visibility_ck", sql`${t.visibility} in ('public','vendor','internal')`),
    check("files_scan_ck", sql`${t.scanStatus} in ('unscanned','clean','infected','error')`),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    href: text("href"),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    eventId: uuid("event_id"),
    readAt: ts("read_at"),
    emailedAt: ts("emailed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_user_idx").on(t.orgId, t.userId, t.createdAt),
    uniqueIndex("notifications_event_user_uq").on(t.eventId, t.userId), // idempotent delivery
  ],
);

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    email: boolean("email").notNull(),
    inApp: boolean("in_app").notNull().default(true),
  },
  (t) => [uniqueIndex("notification_prefs_uq").on(t.orgId, t.userId, t.kind)],
);

// transactional outbox: domain events written with the change, delivered by the worker
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    actorUserId: uuid("actor_user_id"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    processedAt: ts("processed_at"),
    createdAt: createdAt(),
  },
  (t) => [index("outbox_pending_idx").on(t.createdAt).where(sql`${t.processedAt} is null`)],
);

/* ───────────────────────── Community (Iteration 4, RLS) ───────────────────────── */

export const AMENITY_KINDS = ["gym", "party_room", "pool", "rooftop", "meeting_room", "lounge", "court", "workspace", "guest_suite", "bbq", "theatre", "other"] as const;

// bookable shared spaces; booking rules live on the row and are evaluated by amenities/rules.ts
export const amenities = pgTable(
  "amenities",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id").references(() => buildings.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("other"),
    description: text("description"),
    location: text("location"),
    rules: text("rules"), // human-readable house rules shown before booking
    capacity: integer("capacity"), // max guests per booking
    maxConcurrent: integer("max_concurrent").notNull().default(1), // 1 = exclusive use
    opensAtMinute: integer("opens_at_minute").notNull().default(420),
    closesAtMinute: integer("closes_at_minute").notNull().default(1320),
    slotMinutes: integer("slot_minutes").notNull().default(30),
    minDurationMinutes: integer("min_duration_minutes").notNull().default(30),
    maxDurationMinutes: integer("max_duration_minutes").notNull().default(240),
    minNoticeHours: integer("min_notice_hours").notNull().default(0),
    maxAdvanceDays: integer("max_advance_days").notNull().default(60),
    limitCount: integer("limit_count"), // per unit, within limitPeriodDays
    limitPeriodDays: integer("limit_period_days"),
    cancellationHours: integer("cancellation_hours").notNull().default(24),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    feeCents: integer("fee_cents").notNull().default(0),
    depositCents: integer("deposit_cents").notNull().default(0),
    eligibleRoles: text("eligible_roles").array().notNull().default(sql`'{}'::text[]`), // empty = every resident role
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("amenities_org_property_idx").on(t.orgId, t.propertyId),
    check("amenities_hours_ck", sql`${t.opensAtMinute} >= 0 and ${t.closesAtMinute} <= 1440 and ${t.closesAtMinute} > ${t.opensAtMinute}`),
    check("amenities_duration_ck", sql`${t.minDurationMinutes} > 0 and ${t.maxDurationMinutes} >= ${t.minDurationMinutes} and ${t.slotMinutes} between 5 and 240`),
    check("amenities_concurrency_ck", sql`${t.maxConcurrent} >= 1 and (${t.capacity} is null or ${t.capacity} >= 1)`),
    check("amenities_money_ck", sql`${t.feeCents} >= 0 and ${t.depositCents} >= 0`),
    check("amenities_limit_ck", sql`(${t.limitCount} is null) = (${t.limitPeriodDays} is null)`),
  ],
);

// closures (maintenance, private events, holidays)
export const amenityBlackouts = pgTable(
  "amenity_blackouts",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    amenityId: uuid("amenity_id").notNull().references(() => amenities.id, { onDelete: "cascade" }),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    reason: text("reason").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("amenity_blackouts_idx").on(t.orgId, t.amenityId, t.startsAt),
    check("amenity_blackouts_range_ck", sql`${t.endsAt} > ${t.startsAt}`),
  ],
);

export const BOOKING_STATUSES = ["requested", "approved", "declined", "cancelled"] as const;

// exclusive amenities also get an EXCLUDE constraint (migration 0009) so overlapping holds are impossible
export const bookings = pgTable(
  "bookings",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    amenityId: uuid("amenity_id").notNull().references(() => amenities.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id").references(() => buildings.id, { onDelete: "set null" }),
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "set null" }),
    residentId: uuid("resident_id").references(() => residents.id, { onDelete: "set null" }),
    bookedByUserId: uuid("booked_by_user_id").references(() => users.id, { onDelete: "set null" }),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    guests: integer("guests").notNull().default(1),
    purpose: text("purpose"),
    status: text("status").notNull().default("requested"),
    exclusive: boolean("exclusive").notNull().default(true),
    feeCents: integer("fee_cents").notNull().default(0),
    depositCents: integer("deposit_cents").notNull().default(0),
    feeStatus: text("fee_status").notNull().default("none"),
    depositStatus: text("deposit_status").notNull().default("none"),
    decisionNote: text("decision_note"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, { onDelete: "set null" }),
    decidedAt: ts("decided_at"),
    cancelledAt: ts("cancelled_at"),
    cancelReason: text("cancel_reason"),
    damageNotes: text("damage_notes"),
    damageWorkOrderId: uuid("damage_work_order_id").references(() => workOrders.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("bookings_org_number_uq").on(t.orgId, t.number),
    index("bookings_amenity_time_idx").on(t.orgId, t.amenityId, t.startsAt),
    index("bookings_unit_idx").on(t.orgId, t.unitId, t.startsAt),
    index("bookings_status_idx").on(t.orgId, t.status, t.startsAt),
    check("bookings_range_ck", sql`${t.endsAt} > ${t.startsAt}`),
    check("bookings_status_ck", sql`${t.status} in ('requested','approved','declined','cancelled')`),
    check("bookings_fee_status_ck", sql`${t.feeStatus} in ('none','due','paid','waived')`),
    check("bookings_deposit_status_ck", sql`${t.depositStatus} in ('none','due','held','refunded','withheld')`),
    check("bookings_guests_ck", sql`${t.guests} >= 1`),
  ],
);

export const PACKAGE_SIZES = ["envelope", "small", "medium", "large", "oversize"] as const;

export const packages = pgTable(
  "packages",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id").notNull().references(() => buildings.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id").notNull().references(() => units.id, { onDelete: "cascade" }),
    residentId: uuid("resident_id").references(() => residents.id, { onDelete: "set null" }),
    recipientName: text("recipient_name"),
    carrier: text("carrier"),
    trackingNumber: text("tracking_number"),
    size: text("size").notNull().default("small"),
    perishable: boolean("perishable").notNull().default(false),
    shelfLocation: text("shelf_location"),
    notes: text("notes"),
    status: text("status").notNull().default("waiting"),
    pickupCode: text("pickup_code").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
    receivedByUserId: uuid("received_by_user_id").references(() => users.id, { onDelete: "set null" }),
    pickedUpAt: ts("picked_up_at"),
    pickedUpByName: text("picked_up_by_name"),
    releasedByUserId: uuid("released_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reminderSentAt: ts("reminder_sent_at"),
    returnedAt: ts("returned_at"),
    returnReason: text("return_reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("packages_org_status_idx").on(t.orgId, t.status, t.receivedAt),
    index("packages_unit_idx").on(t.orgId, t.unitId, t.status),
    index("packages_tracking_idx").on(t.orgId, t.trackingNumber),
    check("packages_status_ck", sql`${t.status} in ('waiting','picked_up','returned')`),
    check("packages_size_ck", sql`${t.size} in ('envelope','small','medium','large','oversize')`),
  ],
);

export const ANNOUNCEMENT_CATEGORIES = ["general", "maintenance", "event", "policy", "emergency"] as const;

// property_id null = organization-wide; empty building_ids = the whole property
export const announcements = pgTable(
  "announcements",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "cascade" }),
    buildingIds: uuid("building_ids").array().notNull().default(sql`'{}'::uuid[]`),
    audience: text("audience").notNull().default("everyone"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    category: text("category").notNull().default("general"),
    pinned: boolean("pinned").notNull().default(false),
    notify: boolean("notify").notNull().default(true),
    status: text("status").notNull().default("draft"),
    publishAt: ts("publish_at"),
    publishedAt: ts("published_at"),
    expiresAt: ts("expires_at"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("announcements_org_idx").on(t.orgId, t.status, t.publishedAt),
    check("announcements_status_ck", sql`${t.status} in ('draft','scheduled','published','archived')`),
    check("announcements_audience_ck", sql`${t.audience} in ('everyone','residents','staff')`),
    check("announcements_category_ck", sql`${t.category} in ('general','maintenance','event','policy','emergency')`),
  ],
);

export const announcementReads = pgTable(
  "announcement_reads",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    announcementId: uuid("announcement_id").notNull().references(() => announcements.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    readAt: ts("read_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("announcement_reads_uq").on(t.announcementId, t.userId)],
);

export const THREAD_CATEGORIES = ["general", "maintenance", "amenities", "parking", "packages", "billing", "other"] as const;

// resident ↔ management conversations
export const messageThreads = pgTable(
  "message_threads",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id").references(() => buildings.id, { onDelete: "set null" }),
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "set null" }),
    residentId: uuid("resident_id").references(() => residents.id, { onDelete: "set null" }),
    residentUserId: uuid("resident_user_id").references(() => users.id, { onDelete: "set null" }),
    subject: text("subject").notNull(),
    category: text("category").notNull().default("general"),
    status: text("status").notNull().default("open"),
    assignedMembershipId: uuid("assigned_membership_id").references(() => memberships.id, { onDelete: "set null" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    lastMessageAt: ts("last_message_at").notNull().defaultNow(),
    lastMessagePreview: text("last_message_preview"),
    lastFromStaff: boolean("last_from_staff").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("threads_org_idx").on(t.orgId, t.status, t.lastMessageAt),
    index("threads_resident_user_idx").on(t.orgId, t.residentUserId),
    check("threads_status_ck", sql`${t.status} in ('open','closed')`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").notNull().references(() => messageThreads.id, { onDelete: "cascade" }),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    fromStaff: boolean("from_staff").notNull().default(false),
    internal: boolean("internal").notNull().default(false), // staff-only note
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("messages_thread_idx").on(t.orgId, t.threadId, t.createdAt)],
);

export const messageReads = pgTable(
  "message_reads",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").notNull().references(() => messageThreads.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    lastReadAt: ts("last_read_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("message_reads_uq").on(t.threadId, t.userId)],
);

// reusable text with {{variables}}; property_id null = organization-wide
export const messageTemplates = pgTable(
  "message_templates",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    body: text("body").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("message_templates_org_idx").on(t.orgId)],
);

export const DOCUMENT_CATEGORIES = ["bylaws", "rules", "policy", "minutes", "notice", "insurance", "manual", "lease", "form", "financial", "other"] as const;

// property_id null = organization-wide; unit_id = a unit's private documents (e.g. lease)
export const documents = pgTable(
  "documents",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id").references(() => buildings.id, { onDelete: "set null" }),
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    category: text("category").notNull().default("other"),
    audience: text("audience").notNull().default("residents"),
    important: boolean("important").notNull().default(false),
    status: text("status").notNull().default("active"),
    currentVersion: integer("current_version").notNull().default(0),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("documents_org_idx").on(t.orgId, t.status, t.category),
    index("documents_unit_idx").on(t.orgId, t.unitId),
    check("documents_audience_ck", sql`${t.audience} in ('staff','residents','owners')`),
    check("documents_status_ck", sql`${t.status} in ('active','archived')`),
  ],
);

export const documentVersions = pgTable(
  "document_versions",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "restrict" }),
    notes: text("notes"),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("document_versions_uq").on(t.documentId, t.version)],
);

/* ───────────────────────── Front desk & facility (Iteration 5) ───────────────────────── */

export const VISITOR_KINDS = ["guest", "delivery", "contractor", "service", "other"] as const;
export const VISITOR_STATUSES = ["expected", "checked_in", "checked_out", "cancelled", "denied"] as const;

// a guest pass: residents pre-register, the desk checks in by QR (token hash only) or by name/unit
export const visitors = pgTable(
  "visitors",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id").notNull().references(() => buildings.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "cascade" }),
    hostResidentId: uuid("host_resident_id").references(() => residents.id, { onDelete: "set null" }),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    company: text("company"),
    phone: text("phone"),
    kind: text("kind").notNull().default("guest"),
    purpose: text("purpose"),
    expectedFrom: ts("expected_from").notNull(),
    expectedUntil: ts("expected_until").notNull(),
    status: text("status").notNull().default("expected"),
    passTokenHash: text("pass_token_hash"),
    plate: text("plate"),
    needsParking: boolean("needs_parking").notNull().default(false),
    workOrderId: uuid("work_order_id").references(() => workOrders.id, { onDelete: "set null" }),
    checkedInAt: ts("checked_in_at"),
    checkedInByUserId: uuid("checked_in_by_user_id").references(() => users.id, { onDelete: "set null" }),
    checkedOutAt: ts("checked_out_at"),
    checkedOutByUserId: uuid("checked_out_by_user_id").references(() => users.id, { onDelete: "set null" }),
    deniedReason: text("denied_reason"),
    cancelledAt: ts("cancelled_at"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("visitors_org_idx").on(t.orgId, t.propertyId, t.status, t.expectedFrom),
    index("visitors_unit_idx").on(t.orgId, t.unitId, t.expectedFrom),
    uniqueIndex("visitors_pass_uq").on(t.passTokenHash),
    check("visitors_kind_ck", sql`${t.kind} in ('guest','delivery','contractor','service','other')`),
    check("visitors_status_ck", sql`${t.status} in ('expected','checked_in','checked_out','cancelled','denied')`),
    check("visitors_window_ck", sql`${t.expectedUntil} > ${t.expectedFrom}`),
  ],
);

export const PARKING_SPACE_KINDS = ["resident", "visitor", "accessible", "ev", "loading", "motorcycle", "reserved"] as const;
export const PARKING_VIOLATION_KINDS = ["no_permit", "expired_permit", "wrong_space", "visitor_overstay", "fire_lane", "accessible", "blocking", "other"] as const;

export const parkingSpaces = pgTable(
  "parking_spaces",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id").references(() => buildings.id, { onDelete: "set null" }),
    code: text("code").notNull(), // stored upper-case
    level: text("level"),
    kind: text("kind").notNull().default("resident"),
    assignedUnitId: uuid("assigned_unit_id").references(() => units.id, { onDelete: "set null" }),
    status: text("status").notNull().default("available"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("parking_spaces_code_uq").on(t.propertyId, t.code),
    index("parking_spaces_org_idx").on(t.orgId, t.propertyId, t.kind),
    index("parking_spaces_unit_idx").on(t.assignedUnitId),
    check("parking_spaces_kind_ck", sql`${t.kind} in ('resident','visitor','accessible','ev','loading','motorcycle','reserved')`),
    check("parking_spaces_status_ck", sql`${t.status} in ('available','out_of_service')`),
  ],
);

// residents' registered vehicles; a plate can be active on only one record per organization
export const vehicles = pgTable(
  "vehicles",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id").notNull().references(() => units.id, { onDelete: "cascade" }),
    residentId: uuid("resident_id").references(() => residents.id, { onDelete: "set null" }),
    plate: text("plate").notNull(), // normalised: upper-case letters and digits
    region: text("region"),
    make: text("make"),
    model: text("model"),
    color: text("color"),
    active: boolean("active").notNull().default(true),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("vehicles_plate_active_uq").on(t.orgId, t.plate).where(sql`${t.active}`),
    index("vehicles_unit_idx").on(t.orgId, t.unitId),
  ],
);

export const parkingPermits = pgTable(
  "parking_permits",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("resident"),
    plate: text("plate").notNull(),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id, { onDelete: "set null" }),
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "set null" }),
    spaceId: uuid("space_id").references(() => parkingSpaces.id, { onDelete: "set null" }),
    visitorId: uuid("visitor_id").references(() => visitors.id, { onDelete: "set null" }),
    validFrom: ts("valid_from").notNull(),
    validUntil: ts("valid_until"), // null = open-ended
    status: text("status").notNull().default("active"),
    notes: text("notes"),
    issuedByUserId: uuid("issued_by_user_id").references(() => users.id, { onDelete: "set null" }),
    revokedAt: ts("revoked_at"),
    revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, { onDelete: "set null" }),
    revokeReason: text("revoke_reason"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("parking_permits_number_uq").on(t.orgId, t.number),
    index("parking_permits_plate_idx").on(t.orgId, t.plate),
    index("parking_permits_unit_idx").on(t.orgId, t.unitId),
    check("parking_permits_kind_ck", sql`${t.kind} in ('resident','visitor','contractor','staff')`),
    check("parking_permits_status_ck", sql`${t.status} in ('active','revoked')`),
    check("parking_permits_window_ck", sql`${t.validUntil} is null or ${t.validUntil} > ${t.validFrom}`),
  ],
);

// reports and detections are never conclusions: a person reviews before any notice goes out
export const parkingViolations = pgTable(
  "parking_violations",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id").references(() => buildings.id, { onDelete: "set null" }),
    spaceId: uuid("space_id").references(() => parkingSpaces.id, { onDelete: "set null" }),
    plate: text("plate").notNull(),
    location: text("location"),
    kind: text("kind").notNull(),
    description: text("description"),
    observedAt: ts("observed_at").notNull(),
    source: text("source").notNull().default("staff"),
    confidence: numeric("confidence", { precision: 4, scale: 3 }), // detections only
    status: text("status").notNull().default("reported"),
    reportedByUserId: uuid("reported_by_user_id").references(() => users.id, { onDelete: "set null" }),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id, { onDelete: "set null" }),
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "set null" }),
    hadValidPermit: boolean("had_valid_permit"),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: ts("reviewed_at"),
    reviewNote: text("review_note"),
    warnedAt: ts("warned_at"),
    warningText: text("warning_text"),
    resolvedAt: ts("resolved_at"),
    resolution: text("resolution"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("parking_violations_number_uq").on(t.orgId, t.number),
    index("parking_violations_org_idx").on(t.orgId, t.propertyId, t.status),
    index("parking_violations_plate_idx").on(t.orgId, t.plate),
    index("parking_violations_unit_idx").on(t.orgId, t.unitId),
    check("parking_violations_kind_ck", sql`${t.kind} in ('no_permit','expired_permit','wrong_space','visitor_overstay','fire_lane','accessible','blocking','other')`),
    check("parking_violations_source_ck", sql`${t.source} in ('staff','resident','detection')`),
    check("parking_violations_status_ck", sql`${t.status} in ('reported','confirmed','dismissed','warned','resolved')`),
  ],
);

export const SHIFT_POSITIONS = ["front_desk", "security", "maintenance", "cleaning", "management", "other"] as const;

export const shifts = pgTable(
  "shifts",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id").references(() => buildings.id, { onDelete: "set null" }),
    membershipId: uuid("membership_id").notNull().references(() => memberships.id, { onDelete: "cascade" }),
    position: text("position").notNull().default("front_desk"),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    onCall: boolean("on_call").notNull().default(false),
    notes: text("notes"),
    status: text("status").notNull().default("scheduled"),
    clockedInAt: ts("clocked_in_at"),
    clockedOutAt: ts("clocked_out_at"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("shifts_org_idx").on(t.orgId, t.propertyId, t.startsAt),
    index("shifts_member_idx").on(t.membershipId, t.startsAt),
    check("shifts_position_ck", sql`${t.position} in ('front_desk','security','maintenance','cleaning','management','other')`),
    check("shifts_status_ck", sql`${t.status} in ('scheduled','cancelled')`),
    check("shifts_window_ck", sql`${t.endsAt} > ${t.startsAt}`),
  ],
);

export const shiftHandoffs = pgTable(
  "shift_handoffs",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id").references(() => buildings.id, { onDelete: "set null" }),
    shiftId: uuid("shift_id").references(() => shifts.id, { onDelete: "set null" }),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes").notNull(),
    snapshot: jsonb("snapshot").notNull().default({}),
    acknowledgedByUserId: uuid("acknowledged_by_user_id").references(() => users.id, { onDelete: "set null" }),
    acknowledgedAt: ts("acknowledged_at"),
    createdAt: createdAt(),
  },
  (t) => [index("shift_handoffs_org_idx").on(t.orgId, t.propertyId, t.createdAt)],
);

export const ASSET_CATEGORIES = ["hvac", "elevator", "plumbing", "electrical", "fire_safety", "roofing", "security", "generator", "pool", "appliance", "doors_access", "other"] as const;
export const ASSET_STATUSES = ["operational", "needs_attention", "down", "retired"] as const;

export const assets = pgTable(
  "assets",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id").references(() => buildings.id, { onDelete: "set null" }),
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "set null" }),
    location: text("location"),
    name: text("name").notNull(),
    tag: text("tag"),
    category: text("category").notNull().default("other"),
    make: text("make"),
    model: text("model"),
    serialNumber: text("serial_number"),
    installedOn: date("installed_on"),
    warrantyUntil: date("warranty_until"),
    expectedLifeYears: integer("expected_life_years"),
    criticality: text("criticality").notNull().default("medium"),
    status: text("status").notNull().default("operational"),
    vendorId: uuid("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
    replacementCost: numeric("replacement_cost", { precision: 12, scale: 2 }),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("assets_tag_uq").on(t.orgId, t.tag),
    index("assets_org_idx").on(t.orgId, t.propertyId, t.status),
    index("assets_category_idx").on(t.orgId, t.category),
    check("assets_criticality_ck", sql`${t.criticality} in ('low','medium','high','critical')`),
    check("assets_status_ck", sql`${t.status} in ('operational','needs_attention','down','retired')`),
  ],
);

// calendar-based preventive maintenance: the worker opens a work order lead_days before next_due_on
export const pmSchedules = pgTable(
  "pm_schedules",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    instructions: text("instructions"),
    intervalUnit: text("interval_unit").notNull().default("month"),
    intervalCount: integer("interval_count").notNull().default(1),
    nextDueOn: date("next_due_on").notNull(),
    leadDays: integer("lead_days").notNull().default(7),
    priority: text("priority").notNull().default("normal"),
    assignVendorId: uuid("assign_vendor_id").references(() => vendors.id, { onDelete: "set null" }),
    assignMembershipId: uuid("assign_membership_id").references(() => memberships.id, { onDelete: "set null" }),
    active: boolean("active").notNull().default(true),
    lastGeneratedAt: ts("last_generated_at"),
    lastWorkOrderId: uuid("last_work_order_id").references((): AnyPgColumn => workOrders.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("pm_schedules_due_idx").on(t.active, t.nextDueOn),
    index("pm_schedules_asset_idx").on(t.orgId, t.assetId),
    check("pm_interval_unit_ck", sql`${t.intervalUnit} in ('day','week','month','year')`),
    check("pm_interval_count_ck", sql`${t.intervalCount} between 1 and 366`),
    check("pm_lead_days_ck", sql`${t.leadDays} between 0 and 90`),
    check("pm_priority_ck", sql`${t.priority} in ('low','normal','high','urgent')`),
  ],
);

export const assetDowntime = pgTable(
  "asset_downtime",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
    startedAt: ts("started_at").notNull(),
    endedAt: ts("ended_at"),
    reason: text("reason").notNull(),
    workOrderId: uuid("work_order_id").references((): AnyPgColumn => workOrders.id, { onDelete: "set null" }),
    startedByUserId: uuid("started_by_user_id").references(() => users.id, { onDelete: "set null" }),
    endedByUserId: uuid("ended_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("asset_downtime_asset_idx").on(t.orgId, t.assetId, t.startedAt),
    uniqueIndex("asset_downtime_open_uq").on(t.assetId).where(sql`${t.endedAt} is null`),
    check("asset_downtime_window_ck", sql`${t.endedAt} is null or ${t.endedAt} >= ${t.startedAt}`),
  ],
);

/* ───────────────────────── AI assistant (Iteration 6) ───────────────────────── */

export const AI_MODES = ["property", "maintenance", "frontdesk", "facility", "resident"] as const;
export const AI_TOOL_OUTCOMES = ["ok", "denied", "invalid", "not_found", "ambiguous", "error", "unknown_tool", "pending", "executed", "policy_denied"] as const;
export const AI_APPROVAL_STATUSES = ["pending", "executing", "executed", "failed", "partially_failed", "rejected", "expired", "superseded"] as const;
export const AI_POLICY_MODES = ["auto", "confirm", "deny"] as const;
export const AI_USAGE_OUTCOMES = ["ok", "error", "timeout", "step_limit", "cap_reached", "disabled"] as const;

// a user's private conversation with the assistant (RLS: own org AND own user)
export const aiConversations = pgTable(
  "ai_conversations",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New conversation"),
    mode: text("mode").notNull().default("property"),
    lastMessageAt: ts("last_message_at").notNull().defaultNow(),
    archivedAt: ts("archived_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("ai_conversations_user_idx").on(t.orgId, t.userId, t.lastMessageAt),
    check("ai_conversations_mode_ck", sql`${t.mode} in ('property','maintenance','frontdesk','facility','resident')`),
  ],
);

// provider-neutral transcript: user text, assistant text + tool calls, tool results (as given to the model)
export const aiMessages = pgTable(
  "ai_messages",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => aiConversations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id").notNull(), // correlation id shared by everything one user message caused
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull().default(""),
    toolCalls: jsonb("tool_calls"), // assistant: [{ id, name, input }]
    toolCallId: text("tool_call_id"), // tool: the call this result answers
    toolName: text("tool_name"),
    isError: boolean("is_error").notNull().default(false),
    provider: text("provider"),
    model: text("model"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("ai_messages_seq_uq").on(t.conversationId, t.seq),
    index("ai_messages_turn_idx").on(t.conversationId, t.turnId),
    check("ai_messages_role_ck", sql`${t.role} in ('user','assistant','tool')`),
  ],
);

// every tool the assistant ran: who, what arguments, outcome, how long, what the UI showed
export const aiToolCalls = pgTable(
  "ai_tool_calls",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    conversationId: uuid("conversation_id").references(() => aiConversations.id, { onDelete: "set null" }),
    turnId: uuid("turn_id").notNull(),
    callId: text("call_id").notNull(),
    tool: text("tool").notNull(),
    riskClass: integer("risk_class").notNull().default(1),
    args: jsonb("args").notNull().default({}),
    outcome: text("outcome").notNull(),
    errorMessage: text("error_message"),
    summary: text("summary"),
    resultCount: integer("result_count"),
    display: jsonb("display"), // record cards / metrics rendered from the tool result, never from model text
    durationMs: integer("duration_ms").notNull().default(0),
    approvalId: uuid("approval_id").references((): AnyPgColumn => aiApprovals.id, { onDelete: "set null" }), // action steps: the plan they belong to
    createdAt: createdAt(),
  },
  (t) => [
    index("ai_tool_calls_org_idx").on(t.orgId, t.createdAt),
    index("ai_tool_calls_turn_idx").on(t.conversationId, t.turnId),
    index("ai_tool_calls_approval_idx").on(t.approvalId),
    check("ai_tool_calls_outcome_ck", sql`${t.outcome} in ('ok','denied','invalid','not_found','ambiguous','error','unknown_tool','pending','executed','policy_denied')`),
    check("ai_tool_calls_risk_ck", sql`${t.riskClass} between 1 and 5`),
  ],
);

// one row per assistant request: tokens, estimated cost, outcome (drives caps and the usage page)
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    conversationId: uuid("conversation_id").references(() => aiConversations.id, { onDelete: "set null" }),
    turnId: uuid("turn_id").notNull(),
    feature: text("feature").notNull().default("chat"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    modelCalls: integer("model_calls").notNull().default(0),
    toolCalls: integer("tool_calls").notNull().default(0),
    estCostUsd: numeric("est_cost_usd", { precision: 12, scale: 6 }),
    latencyMs: integer("latency_ms").notNull().default(0),
    outcome: text("outcome").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("ai_usage_org_idx").on(t.orgId, t.createdAt),
    index("ai_usage_user_idx").on(t.orgId, t.userId, t.createdAt),
    uniqueIndex("ai_usage_turn_uq").on(t.turnId),
    check("ai_usage_outcome_ck", sql`${t.outcome} in ('ok','error','timeout','step_limit','cap_reached','disabled')`),
  ],
);

/* ───────────────────────── AI actions (Iteration 7) ───────────────────────── */

// a dry-run plan of assistant actions: nothing in it runs until it's approved (or a policy allows it to run on its own)
export const aiApprovals = pgTable(
  "ai_approvals",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => aiConversations.id, { onDelete: "set null" }),
    turnId: uuid("turn_id").notNull(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
    mode: text("mode").notNull().default("confirm"), // confirm = a person approved it; auto = an org policy let it run
    status: text("status").notNull().default("pending"),
    steps: jsonb("steps").notNull().default([]), // [{ id, tool, riskClass, policyKeys, input, resolved, title, details, effects, confirm }]
    results: jsonb("results"), // [{ stepId, status, summary, record, verified, error }]
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, { onDelete: "set null" }),
    decidedAt: ts("decided_at"),
    executedAt: ts("executed_at"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("ai_approvals_user_idx").on(t.orgId, t.requestedByUserId, t.status, t.createdAt),
    index("ai_approvals_conversation_idx").on(t.conversationId),
    check("ai_approvals_mode_ck", sql`${t.mode} in ('confirm','auto')`),
    check("ai_approvals_status_ck", sql`${t.status} in ('pending','executing','executed','failed','partially_failed','rejected','expired','superseded')`),
  ],
);

// per-organization (or per-property) rules for what the assistant may do on its own, must ask about, or never do
export const aiPolicies = pgTable(
  "ai_policies",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "cascade" }), // null = whole organization
    action: text("action").notNull(), // policy key, e.g. "workorder.create"
    mode: text("mode").notNull(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ai_policies_org_uq").on(t.orgId, t.action).where(sql`${t.propertyId} is null`),
    uniqueIndex("ai_policies_property_uq").on(t.orgId, t.propertyId, t.action).where(sql`${t.propertyId} is not null`),
    check("ai_policies_mode_ck", sql`${t.mode} in ('auto','confirm','deny')`),
  ],
);

/* ───────────────────────── Knowledge base & retrieval (Iteration 8) ───────────────────────── */

export const KNOWLEDGE_CATEGORIES = ["rules", "amenities", "procedures", "emergency", "maintenance", "moving", "parking", "policy", "general"] as const;
export const KB_INDEX_STATUSES = ["queued", "indexing", "indexed", "failed", "unsupported", "empty"] as const;
export const EMBEDDING_DIMENSIONS = 512; // fixed by the vector column; providers are asked for this size

// what admins teach the assistant in their own words ("our after-hours flood procedure is …"); versioned like documents
export const knowledgeEntries = pgTable(
  "knowledge_entries",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "cascade" }), // null = whole organization
    buildingId: uuid("building_id").references(() => buildings.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    body: text("body").notNull(), // plain text / light markdown; "## headings" become citable sections
    category: text("category").notNull().default("general"),
    audience: text("audience").notNull().default("residents"), // staff | residents (staff + residents) | owners (staff + owners)
    status: text("status").notNull().default("active"),
    version: integer("version").notNull().default(1),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("knowledge_entries_org_idx").on(t.orgId, t.status, t.category),
    check("knowledge_entries_audience_ck", sql`${t.audience} in ('staff','residents','owners')`),
    check("knowledge_entries_status_ck", sql`${t.status} in ('active','disabled')`),
  ],
);

export const knowledgeEntryVersions = pgTable(
  "knowledge_entry_versions",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    entryId: uuid("entry_id").notNull().references(() => knowledgeEntries.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    category: text("category").notNull(),
    audience: text("audience").notNull(),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("knowledge_entry_versions_uq").on(t.entryId, t.version)],
);

// one row per indexable source (a document or a knowledge entry): the indexing queue and its status
export const kbSources = pgTable(
  "kb_sources",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(), // document | knowledge
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "cascade" }),
    entryId: uuid("entry_id").references(() => knowledgeEntries.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    version: integer("version").notNull(), // the version to index (current when queued)
    indexedVersion: integer("indexed_version"),
    chunkCount: integer("chunk_count").notNull().default(0),
    charCount: integer("char_count").notNull().default(0),
    embeddingModel: text("embedding_model"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    queuedAt: ts("queued_at").notNull().defaultNow(),
    startedAt: ts("started_at"),
    indexedAt: ts("indexed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("kb_sources_document_uq").on(t.documentId).where(sql`${t.documentId} is not null`),
    uniqueIndex("kb_sources_entry_uq").on(t.entryId).where(sql`${t.entryId} is not null`),
    index("kb_sources_queue_idx").on(t.status, t.queuedAt),
    index("kb_sources_org_idx").on(t.orgId, t.status),
    check("kb_sources_type_ck", sql`(${t.sourceType} = 'document' and ${t.documentId} is not null and ${t.entryId} is null) or (${t.sourceType} = 'knowledge' and ${t.entryId} is not null and ${t.documentId} is null)`),
    check("kb_sources_status_ck", sql`${t.status} in ('queued','indexing','indexed','failed','unsupported','empty')`),
  ],
);

// passages: the unit of retrieval and citation. A full-text `search` column and the HNSW index are added in migration 0017.
export const kbChunks = pgTable(
  "kb_chunks",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").notNull().references(() => kbSources.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "cascade" }),
    entryId: uuid("entry_id").references(() => knowledgeEntries.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    ordinal: integer("ordinal").notNull(),
    context: text("context").notNull(), // "Title › Section" — searched with the content and shown in citations
    heading: text("heading"),
    page: integer("page"),
    content: text("content").notNull(),
    tokenCount: integer("token_count").notNull().default(0),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    embeddingModel: text("embedding_model"),
    createdAt: createdAt(),
  },
  (t) => [
    index("kb_chunks_source_idx").on(t.sourceId, t.ordinal),
    index("kb_chunks_document_idx").on(t.documentId),
    index("kb_chunks_entry_idx").on(t.entryId),
    index("kb_chunks_org_idx").on(t.orgId),
  ],
);
