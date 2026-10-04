CREATE TABLE "amenities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"building_id" uuid,
	"name" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"description" text,
	"location" text,
	"rules" text,
	"capacity" integer,
	"max_concurrent" integer DEFAULT 1 NOT NULL,
	"opens_at_minute" integer DEFAULT 420 NOT NULL,
	"closes_at_minute" integer DEFAULT 1320 NOT NULL,
	"slot_minutes" integer DEFAULT 30 NOT NULL,
	"min_duration_minutes" integer DEFAULT 30 NOT NULL,
	"max_duration_minutes" integer DEFAULT 240 NOT NULL,
	"min_notice_hours" integer DEFAULT 0 NOT NULL,
	"max_advance_days" integer DEFAULT 60 NOT NULL,
	"limit_count" integer,
	"limit_period_days" integer,
	"cancellation_hours" integer DEFAULT 24 NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"deposit_cents" integer DEFAULT 0 NOT NULL,
	"eligible_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amenities_hours_ck" CHECK ("amenities"."opens_at_minute" >= 0 and "amenities"."closes_at_minute" <= 1440 and "amenities"."closes_at_minute" > "amenities"."opens_at_minute"),
	CONSTRAINT "amenities_duration_ck" CHECK ("amenities"."min_duration_minutes" > 0 and "amenities"."max_duration_minutes" >= "amenities"."min_duration_minutes" and "amenities"."slot_minutes" between 5 and 240),
	CONSTRAINT "amenities_concurrency_ck" CHECK ("amenities"."max_concurrent" >= 1 and ("amenities"."capacity" is null or "amenities"."capacity" >= 1)),
	CONSTRAINT "amenities_money_ck" CHECK ("amenities"."fee_cents" >= 0 and "amenities"."deposit_cents" >= 0),
	CONSTRAINT "amenities_limit_ck" CHECK (("amenities"."limit_count" is null) = ("amenities"."limit_period_days" is null))
);
--> statement-breakpoint
CREATE TABLE "amenity_blackouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"amenity_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amenity_blackouts_range_ck" CHECK ("amenity_blackouts"."ends_at" > "amenity_blackouts"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "announcement_reads" (
	"org_id" uuid NOT NULL,
	"announcement_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid,
	"building_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"audience" text DEFAULT 'everyone' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"notify" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"publish_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcements_status_ck" CHECK ("announcements"."status" in ('draft','scheduled','published','archived')),
	CONSTRAINT "announcements_audience_ck" CHECK ("announcements"."audience" in ('everyone','residents','staff')),
	CONSTRAINT "announcements_category_ck" CHECK ("announcements"."category" in ('general','maintenance','event','policy','emergency'))
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"amenity_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"building_id" uuid,
	"unit_id" uuid,
	"resident_id" uuid,
	"booked_by_user_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"guests" integer DEFAULT 1 NOT NULL,
	"purpose" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"exclusive" boolean DEFAULT true NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"deposit_cents" integer DEFAULT 0 NOT NULL,
	"fee_status" text DEFAULT 'none' NOT NULL,
	"deposit_status" text DEFAULT 'none' NOT NULL,
	"decision_note" text,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"damage_notes" text,
	"damage_work_order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_range_ck" CHECK ("bookings"."ends_at" > "bookings"."starts_at"),
	CONSTRAINT "bookings_status_ck" CHECK ("bookings"."status" in ('requested','approved','declined','cancelled')),
	CONSTRAINT "bookings_fee_status_ck" CHECK ("bookings"."fee_status" in ('none','due','paid','waived')),
	CONSTRAINT "bookings_deposit_status_ck" CHECK ("bookings"."deposit_status" in ('none','due','held','refunded','withheld')),
	CONSTRAINT "bookings_guests_ck" CHECK ("bookings"."guests" >= 1)
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"file_id" uuid NOT NULL,
	"notes" text,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid,
	"building_id" uuid,
	"unit_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"category" text DEFAULT 'other' NOT NULL,
	"audience" text DEFAULT 'residents' NOT NULL,
	"important" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_audience_ck" CHECK ("documents"."audience" in ('staff','residents','owners')),
	CONSTRAINT "documents_status_ck" CHECK ("documents"."status" in ('active','archived'))
);
--> statement-breakpoint
CREATE TABLE "message_reads" (
	"org_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"building_id" uuid,
	"unit_id" uuid,
	"resident_id" uuid,
	"resident_user_id" uuid,
	"subject" text NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assigned_membership_id" uuid,
	"created_by_user_id" uuid,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_preview" text,
	"last_from_staff" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threads_status_ck" CHECK ("message_threads"."status" in ('open','closed'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"author_user_id" uuid,
	"from_staff" boolean DEFAULT false NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"resident_id" uuid,
	"recipient_name" text,
	"carrier" text,
	"tracking_number" text,
	"size" text DEFAULT 'small' NOT NULL,
	"perishable" boolean DEFAULT false NOT NULL,
	"shelf_location" text,
	"notes" text,
	"status" text DEFAULT 'waiting' NOT NULL,
	"pickup_code" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_by_user_id" uuid,
	"picked_up_at" timestamp with time zone,
	"picked_up_by_name" text,
	"released_by_user_id" uuid,
	"reminder_sent_at" timestamp with time zone,
	"returned_at" timestamp with time zone,
	"return_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packages_status_ck" CHECK ("packages"."status" in ('waiting','picked_up','returned')),
	CONSTRAINT "packages_size_ck" CHECK ("packages"."size" in ('envelope','small','medium','large','oversize'))
);
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "emergency_phone" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "emergency_info" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "office_hours" text;--> statement-breakpoint
ALTER TABLE "amenities" ADD CONSTRAINT "amenities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amenities" ADD CONSTRAINT "amenities_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amenities" ADD CONSTRAINT "amenities_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amenity_blackouts" ADD CONSTRAINT "amenity_blackouts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amenity_blackouts" ADD CONSTRAINT "amenity_blackouts_amenity_id_amenities_id_fk" FOREIGN KEY ("amenity_id") REFERENCES "public"."amenities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amenity_blackouts" ADD CONSTRAINT "amenity_blackouts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_announcement_id_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_amenity_id_amenities_id_fk" FOREIGN KEY ("amenity_id") REFERENCES "public"."amenities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_resident_id_residents_id_fk" FOREIGN KEY ("resident_id") REFERENCES "public"."residents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_booked_by_user_id_users_id_fk" FOREIGN KEY ("booked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_damage_work_order_id_work_orders_id_fk" FOREIGN KEY ("damage_work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reads" ADD CONSTRAINT "message_reads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reads" ADD CONSTRAINT "message_reads_thread_id_message_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."message_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reads" ADD CONSTRAINT "message_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_resident_id_residents_id_fk" FOREIGN KEY ("resident_id") REFERENCES "public"."residents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_resident_user_id_users_id_fk" FOREIGN KEY ("resident_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_assigned_membership_id_memberships_id_fk" FOREIGN KEY ("assigned_membership_id") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_message_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."message_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_resident_id_residents_id_fk" FOREIGN KEY ("resident_id") REFERENCES "public"."residents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_received_by_user_id_users_id_fk" FOREIGN KEY ("received_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_released_by_user_id_users_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "amenities_org_property_idx" ON "amenities" USING btree ("org_id","property_id");--> statement-breakpoint
CREATE INDEX "amenity_blackouts_idx" ON "amenity_blackouts" USING btree ("org_id","amenity_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "announcement_reads_uq" ON "announcement_reads" USING btree ("announcement_id","user_id");--> statement-breakpoint
CREATE INDEX "announcements_org_idx" ON "announcements" USING btree ("org_id","status","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_org_number_uq" ON "bookings" USING btree ("org_id","number");--> statement-breakpoint
CREATE INDEX "bookings_amenity_time_idx" ON "bookings" USING btree ("org_id","amenity_id","starts_at");--> statement-breakpoint
CREATE INDEX "bookings_unit_idx" ON "bookings" USING btree ("org_id","unit_id","starts_at");--> statement-breakpoint
CREATE INDEX "bookings_status_idx" ON "bookings" USING btree ("org_id","status","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_uq" ON "document_versions" USING btree ("document_id","version");--> statement-breakpoint
CREATE INDEX "documents_org_idx" ON "documents" USING btree ("org_id","status","category");--> statement-breakpoint
CREATE INDEX "documents_unit_idx" ON "documents" USING btree ("org_id","unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_reads_uq" ON "message_reads" USING btree ("thread_id","user_id");--> statement-breakpoint
CREATE INDEX "message_templates_org_idx" ON "message_templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "threads_org_idx" ON "message_threads" USING btree ("org_id","status","last_message_at");--> statement-breakpoint
CREATE INDEX "threads_resident_user_idx" ON "message_threads" USING btree ("org_id","resident_user_id");--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("org_id","thread_id","created_at");--> statement-breakpoint
CREATE INDEX "packages_org_status_idx" ON "packages" USING btree ("org_id","status","received_at");--> statement-breakpoint
CREATE INDEX "packages_unit_idx" ON "packages" USING btree ("org_id","unit_id","status");--> statement-breakpoint
CREATE INDEX "packages_tracking_idx" ON "packages" USING btree ("org_id","tracking_number");