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
    sourceType: text("source_type"), // inspection | incident | complaint
    sourceId: uuid("source_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("work_orders_org_number_uq").on(t.orgId, t.number),
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
