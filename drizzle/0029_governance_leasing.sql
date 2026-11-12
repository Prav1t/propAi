CREATE TABLE "leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"resident_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"rent_cents" integer NOT NULL,
	"deposit_cents" integer DEFAULT 0 NOT NULL,
	"due_day" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notice_given_on" date,
	"move_out_on" date,
	"notes" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leases_status_ck" CHECK ("leases"."status" in ('active','notice','ended')),
	CONSTRAINT "leases_money_ck" CHECK ("leases"."rent_cents" > 0 and "leases"."deposit_cents" >= 0),
	CONSTRAINT "leases_due_day_ck" CHECK ("leases"."due_day" between 1 and 28),
	CONSTRAINT "leases_dates_ck" CHECK ("leases"."ends_on" is null or "leases"."ends_on" >= "leases"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "meeting_agenda_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"minutes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_motions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"text" text NOT NULL,
	"moved_by" text,
	"seconded_by" text,
	"threshold" text DEFAULT 'majority' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"votes_for" integer DEFAULT 0 NOT NULL,
	"votes_against" integer DEFAULT 0 NOT NULL,
	"votes_abstain" integer DEFAULT 0 NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_motions_threshold_ck" CHECK ("meeting_motions"."threshold" in ('majority','three_quarters','unanimous')),
	CONSTRAINT "meeting_motions_status_ck" CHECK ("meeting_motions"."status" in ('open','carried','defeated','withdrawn','tabled')),
	CONSTRAINT "meeting_motions_counts_ck" CHECK ("meeting_motions"."votes_for" >= 0 and "meeting_motions"."votes_against" >= 0 and "meeting_motions"."votes_abstain" >= 0)
);
--> statement-breakpoint
CREATE TABLE "meeting_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"motion_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"choice" text NOT NULL,
	"cast_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_votes_choice_ck" CHECK ("meeting_votes"."choice" in ('for','against','abstain'))
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"kind" text DEFAULT 'council' NOT NULL,
	"title" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"location" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"attendees" text,
	"quorum_met" boolean,
	"minutes" text,
	"minutes_approved_at" timestamp with time zone,
	"minutes_approved_by_user_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meetings_kind_ck" CHECK ("meetings"."kind" in ('council','agm','sgm','committee')),
	CONSTRAINT "meetings_status_ck" CHECK ("meetings"."status" in ('scheduled','held','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "rent_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"period" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"due_on" date NOT NULL,
	"paid_cents" integer DEFAULT 0 NOT NULL,
	"paid_on" date,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rent_charges_money_ck" CHECK ("rent_charges"."amount_cents" > 0 and "rent_charges"."paid_cents" >= 0 and "rent_charges"."paid_cents" <= "rent_charges"."amount_cents")
);
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_source_ck";--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_resident_id_residents_id_fk" FOREIGN KEY ("resident_id") REFERENCES "public"."residents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_agenda_items" ADD CONSTRAINT "meeting_agenda_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_agenda_items" ADD CONSTRAINT "meeting_agenda_items_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_motions" ADD CONSTRAINT "meeting_motions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_motions" ADD CONSTRAINT "meeting_motions_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_motions" ADD CONSTRAINT "meeting_motions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_votes" ADD CONSTRAINT "meeting_votes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_votes" ADD CONSTRAINT "meeting_votes_motion_id_meeting_motions_id_fk" FOREIGN KEY ("motion_id") REFERENCES "public"."meeting_motions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_votes" ADD CONSTRAINT "meeting_votes_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_minutes_approved_by_user_id_users_id_fk" FOREIGN KEY ("minutes_approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_charges" ADD CONSTRAINT "rent_charges_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_charges" ADD CONSTRAINT "rent_charges_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leases_org_property_idx" ON "leases" USING btree ("org_id","property_id","status");--> statement-breakpoint
CREATE INDEX "leases_resident_idx" ON "leases" USING btree ("resident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leases_unit_in_force_uq" ON "leases" USING btree ("unit_id") WHERE "leases"."status" in ('active','notice');--> statement-breakpoint
CREATE INDEX "meeting_agenda_meeting_idx" ON "meeting_agenda_items" USING btree ("meeting_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_motions_number_uq" ON "meeting_motions" USING btree ("meeting_id","number");--> statement-breakpoint
CREATE INDEX "meeting_motions_open_idx" ON "meeting_motions" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_votes_member_uq" ON "meeting_votes" USING btree ("motion_id","membership_id");--> statement-breakpoint
CREATE INDEX "meetings_org_property_idx" ON "meetings" USING btree ("org_id","property_id","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rent_charges_period_uq" ON "rent_charges" USING btree ("lease_id","period");--> statement-breakpoint
CREATE INDEX "rent_charges_unpaid_idx" ON "rent_charges" USING btree ("org_id","due_on") WHERE "rent_charges"."paid_cents" < "rent_charges"."amount_cents";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_ck" CHECK ("tasks"."source" in ('manual','work_order','inspection','incident','complaint','recurring','system','automation','meeting'));