CREATE TABLE "asset_downtime" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"reason" text NOT NULL,
	"work_order_id" uuid,
	"started_by_user_id" uuid,
	"ended_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_downtime_window_ck" CHECK ("asset_downtime"."ended_at" is null or "asset_downtime"."ended_at" >= "asset_downtime"."started_at")
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"building_id" uuid,
	"unit_id" uuid,
	"location" text,
	"name" text NOT NULL,
	"tag" text,
	"category" text DEFAULT 'other' NOT NULL,
	"make" text,
	"model" text,
	"serial_number" text,
	"installed_on" date,
	"warranty_until" date,
	"expected_life_years" integer,
	"criticality" text DEFAULT 'medium' NOT NULL,
	"status" text DEFAULT 'operational' NOT NULL,
	"vendor_id" uuid,
	"replacement_cost" numeric(12, 2),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_criticality_ck" CHECK ("assets"."criticality" in ('low','medium','high','critical')),
	CONSTRAINT "assets_status_ck" CHECK ("assets"."status" in ('operational','needs_attention','down','retired'))
);
--> statement-breakpoint
CREATE TABLE "parking_permits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"property_id" uuid NOT NULL,
	"kind" text DEFAULT 'resident' NOT NULL,
	"plate" text NOT NULL,
	"vehicle_id" uuid,
	"unit_id" uuid,
	"space_id" uuid,
	"visitor_id" uuid,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"issued_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parking_permits_kind_ck" CHECK ("parking_permits"."kind" in ('resident','visitor','contractor','staff')),
	CONSTRAINT "parking_permits_status_ck" CHECK ("parking_permits"."status" in ('active','revoked')),
	CONSTRAINT "parking_permits_window_ck" CHECK ("parking_permits"."valid_until" is null or "parking_permits"."valid_until" > "parking_permits"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "parking_spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"building_id" uuid,
	"code" text NOT NULL,
	"level" text,
	"kind" text DEFAULT 'resident' NOT NULL,
	"assigned_unit_id" uuid,
	"status" text DEFAULT 'available' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parking_spaces_kind_ck" CHECK ("parking_spaces"."kind" in ('resident','visitor','accessible','ev','loading','motorcycle','reserved')),
	CONSTRAINT "parking_spaces_status_ck" CHECK ("parking_spaces"."status" in ('available','out_of_service'))
);
--> statement-breakpoint
CREATE TABLE "parking_violations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"property_id" uuid NOT NULL,
	"building_id" uuid,
	"space_id" uuid,
	"plate" text NOT NULL,
	"location" text,
	"kind" text NOT NULL,
	"description" text,
	"observed_at" timestamp with time zone NOT NULL,
	"source" text DEFAULT 'staff' NOT NULL,
	"confidence" numeric(4, 3),
	"status" text DEFAULT 'reported' NOT NULL,
	"reported_by_user_id" uuid,
	"vehicle_id" uuid,
	"unit_id" uuid,
	"had_valid_permit" boolean,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"warned_at" timestamp with time zone,
	"warning_text" text,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parking_violations_kind_ck" CHECK ("parking_violations"."kind" in ('no_permit','expired_permit','wrong_space','visitor_overstay','fire_lane','accessible','blocking','other')),
	CONSTRAINT "parking_violations_source_ck" CHECK ("parking_violations"."source" in ('staff','resident','detection')),
	CONSTRAINT "parking_violations_status_ck" CHECK ("parking_violations"."status" in ('reported','confirmed','dismissed','warned','resolved'))
);
--> statement-breakpoint
CREATE TABLE "pm_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"title" text NOT NULL,
	"instructions" text,
	"interval_unit" text DEFAULT 'month' NOT NULL,
	"interval_count" integer DEFAULT 1 NOT NULL,
	"next_due_on" date NOT NULL,
	"lead_days" integer DEFAULT 7 NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"assign_vendor_id" uuid,
	"assign_membership_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"last_generated_at" timestamp with time zone,
	"last_work_order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pm_interval_unit_ck" CHECK ("pm_schedules"."interval_unit" in ('day','week','month','year')),
	CONSTRAINT "pm_interval_count_ck" CHECK ("pm_schedules"."interval_count" between 1 and 366),
	CONSTRAINT "pm_lead_days_ck" CHECK ("pm_schedules"."lead_days" between 0 and 90),
	CONSTRAINT "pm_priority_ck" CHECK ("pm_schedules"."priority" in ('low','normal','high','urgent'))
);
--> statement-breakpoint
CREATE TABLE "shift_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"building_id" uuid,
	"shift_id" uuid,
	"author_user_id" uuid,
	"notes" text NOT NULL,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"acknowledged_by_user_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"building_id" uuid,
	"membership_id" uuid NOT NULL,
	"position" text DEFAULT 'front_desk' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"on_call" boolean DEFAULT false NOT NULL,
	"notes" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"clocked_in_at" timestamp with time zone,
	"clocked_out_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shifts_position_ck" CHECK ("shifts"."position" in ('front_desk','security','maintenance','cleaning','management','other')),
	CONSTRAINT "shifts_status_ck" CHECK ("shifts"."status" in ('scheduled','cancelled')),
	CONSTRAINT "shifts_window_ck" CHECK ("shifts"."ends_at" > "shifts"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"resident_id" uuid,
	"plate" text NOT NULL,
	"region" text,
	"make" text,
	"model" text,
	"color" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"unit_id" uuid,
	"host_resident_id" uuid,
	"invited_by_user_id" uuid,
	"name" text NOT NULL,
	"company" text,
	"phone" text,
	"kind" text DEFAULT 'guest' NOT NULL,
	"purpose" text,
	"expected_from" timestamp with time zone NOT NULL,
	"expected_until" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'expected' NOT NULL,
	"pass_token_hash" text,
	"plate" text,
	"needs_parking" boolean DEFAULT false NOT NULL,
	"work_order_id" uuid,
	"checked_in_at" timestamp with time zone,
	"checked_in_by_user_id" uuid,
	"checked_out_at" timestamp with time zone,
	"checked_out_by_user_id" uuid,
	"denied_reason" text,
	"cancelled_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visitors_kind_ck" CHECK ("visitors"."kind" in ('guest','delivery','contractor','service','other')),
	CONSTRAINT "visitors_status_ck" CHECK ("visitors"."status" in ('expected','checked_in','checked_out','cancelled','denied')),
	CONSTRAINT "visitors_window_ck" CHECK ("visitors"."expected_until" > "visitors"."expected_from")
);
--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "asset_id" uuid;--> statement-breakpoint
ALTER TABLE "asset_downtime" ADD CONSTRAINT "asset_downtime_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_downtime" ADD CONSTRAINT "asset_downtime_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_downtime" ADD CONSTRAINT "asset_downtime_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_downtime" ADD CONSTRAINT "asset_downtime_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_downtime" ADD CONSTRAINT "asset_downtime_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_downtime" ADD CONSTRAINT "asset_downtime_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_permits" ADD CONSTRAINT "parking_permits_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_permits" ADD CONSTRAINT "parking_permits_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_permits" ADD CONSTRAINT "parking_permits_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_permits" ADD CONSTRAINT "parking_permits_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_permits" ADD CONSTRAINT "parking_permits_space_id_parking_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."parking_spaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_permits" ADD CONSTRAINT "parking_permits_visitor_id_visitors_id_fk" FOREIGN KEY ("visitor_id") REFERENCES "public"."visitors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_permits" ADD CONSTRAINT "parking_permits_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_permits" ADD CONSTRAINT "parking_permits_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_spaces" ADD CONSTRAINT "parking_spaces_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_spaces" ADD CONSTRAINT "parking_spaces_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_spaces" ADD CONSTRAINT "parking_spaces_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_spaces" ADD CONSTRAINT "parking_spaces_assigned_unit_id_units_id_fk" FOREIGN KEY ("assigned_unit_id") REFERENCES "public"."units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_violations" ADD CONSTRAINT "parking_violations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_violations" ADD CONSTRAINT "parking_violations_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_violations" ADD CONSTRAINT "parking_violations_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_violations" ADD CONSTRAINT "parking_violations_space_id_parking_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."parking_spaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_violations" ADD CONSTRAINT "parking_violations_reported_by_user_id_users_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_violations" ADD CONSTRAINT "parking_violations_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_violations" ADD CONSTRAINT "parking_violations_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parking_violations" ADD CONSTRAINT "parking_violations_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_schedules" ADD CONSTRAINT "pm_schedules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_schedules" ADD CONSTRAINT "pm_schedules_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_schedules" ADD CONSTRAINT "pm_schedules_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_schedules" ADD CONSTRAINT "pm_schedules_assign_vendor_id_vendors_id_fk" FOREIGN KEY ("assign_vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_schedules" ADD CONSTRAINT "pm_schedules_assign_membership_id_memberships_id_fk" FOREIGN KEY ("assign_membership_id") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_schedules" ADD CONSTRAINT "pm_schedules_last_work_order_id_work_orders_id_fk" FOREIGN KEY ("last_work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_handoffs" ADD CONSTRAINT "shift_handoffs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_handoffs" ADD CONSTRAINT "shift_handoffs_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_handoffs" ADD CONSTRAINT "shift_handoffs_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_handoffs" ADD CONSTRAINT "shift_handoffs_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_handoffs" ADD CONSTRAINT "shift_handoffs_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_handoffs" ADD CONSTRAINT "shift_handoffs_acknowledged_by_user_id_users_id_fk" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_resident_id_residents_id_fk" FOREIGN KEY ("resident_id") REFERENCES "public"."residents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_host_resident_id_residents_id_fk" FOREIGN KEY ("host_resident_id") REFERENCES "public"."residents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_checked_in_by_user_id_users_id_fk" FOREIGN KEY ("checked_in_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_checked_out_by_user_id_users_id_fk" FOREIGN KEY ("checked_out_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_downtime_asset_idx" ON "asset_downtime" USING btree ("org_id","asset_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_downtime_open_uq" ON "asset_downtime" USING btree ("asset_id") WHERE "asset_downtime"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_tag_uq" ON "assets" USING btree ("org_id","tag");--> statement-breakpoint
CREATE INDEX "assets_org_idx" ON "assets" USING btree ("org_id","property_id","status");--> statement-breakpoint
CREATE INDEX "assets_category_idx" ON "assets" USING btree ("org_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "parking_permits_number_uq" ON "parking_permits" USING btree ("org_id","number");--> statement-breakpoint
CREATE INDEX "parking_permits_plate_idx" ON "parking_permits" USING btree ("org_id","plate");--> statement-breakpoint
CREATE INDEX "parking_permits_unit_idx" ON "parking_permits" USING btree ("org_id","unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "parking_spaces_code_uq" ON "parking_spaces" USING btree ("property_id","code");--> statement-breakpoint
CREATE INDEX "parking_spaces_org_idx" ON "parking_spaces" USING btree ("org_id","property_id","kind");--> statement-breakpoint
CREATE INDEX "parking_spaces_unit_idx" ON "parking_spaces" USING btree ("assigned_unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "parking_violations_number_uq" ON "parking_violations" USING btree ("org_id","number");--> statement-breakpoint
CREATE INDEX "parking_violations_org_idx" ON "parking_violations" USING btree ("org_id","property_id","status");--> statement-breakpoint
CREATE INDEX "parking_violations_plate_idx" ON "parking_violations" USING btree ("org_id","plate");--> statement-breakpoint
CREATE INDEX "parking_violations_unit_idx" ON "parking_violations" USING btree ("org_id","unit_id");--> statement-breakpoint
CREATE INDEX "pm_schedules_due_idx" ON "pm_schedules" USING btree ("active","next_due_on");--> statement-breakpoint
CREATE INDEX "pm_schedules_asset_idx" ON "pm_schedules" USING btree ("org_id","asset_id");--> statement-breakpoint
CREATE INDEX "shift_handoffs_org_idx" ON "shift_handoffs" USING btree ("org_id","property_id","created_at");--> statement-breakpoint
CREATE INDEX "shifts_org_idx" ON "shifts" USING btree ("org_id","property_id","starts_at");--> statement-breakpoint
CREATE INDEX "shifts_member_idx" ON "shifts" USING btree ("membership_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicles_plate_active_uq" ON "vehicles" USING btree ("org_id","plate") WHERE "vehicles"."active";--> statement-breakpoint
CREATE INDEX "vehicles_unit_idx" ON "vehicles" USING btree ("org_id","unit_id");--> statement-breakpoint
CREATE INDEX "visitors_org_idx" ON "visitors" USING btree ("org_id","property_id","status","expected_from");--> statement-breakpoint
CREATE INDEX "visitors_unit_idx" ON "visitors" USING btree ("org_id","unit_id","expected_from");--> statement-breakpoint
CREATE UNIQUE INDEX "visitors_pass_uq" ON "visitors" USING btree ("pass_token_hash");--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_orders_asset_idx" ON "work_orders" USING btree ("asset_id");