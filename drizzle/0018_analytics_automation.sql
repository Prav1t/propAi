CREATE TABLE "daily_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"brief_date" date NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_version" integer NOT NULL,
	"event_id" uuid,
	"scheduled_for" timestamp with time zone,
	"trigger_type" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"entity_label" text,
	"property_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_role" text,
	"approval_step" integer,
	"approval_requested_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_runs_status_ck" CHECK ("workflow_runs"."status" in ('running','waiting_approval','completed','failed','rejected'))
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"trigger_type" text NOT NULL,
	"schedule" jsonb,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"owner_user_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"run_count" integer DEFAULT 0 NOT NULL,
	"paused_reason" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflows_trigger_ck" CHECK ("workflows"."trigger_type" in ('workorder.created','workorder.status_changed','workorder.assigned','workorder.sla_approaching','workorder.sla_breached','complaint.created','incident.created','inspection.failed','booking.created','package.arrived','document.uploaded','schedule')),
	CONSTRAINT "workflows_schedule_ck" CHECK (("workflows"."trigger_type" = 'schedule') = ("workflows"."schedule" is not null))
);
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_source_ck";--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "workflow_run_id" uuid;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "automation_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "caused_by_run_id" uuid;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "caused_by_workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "chain_depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "sla_warned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "daily_briefs" ADD CONSTRAINT "daily_briefs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_briefs" ADD CONSTRAINT "daily_briefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_briefs_user_date_uq" ON "daily_briefs" USING btree ("org_id","user_id","brief_date");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_event_uq" ON "workflow_runs" USING btree ("workflow_id","event_id") WHERE "workflow_runs"."event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_slot_uq" ON "workflow_runs" USING btree ("workflow_id","scheduled_for") WHERE "workflow_runs"."scheduled_for" is not null;--> statement-breakpoint
CREATE INDEX "workflow_runs_org_idx" ON "workflow_runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_workflow_idx" ON "workflow_runs" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_waiting_idx" ON "workflow_runs" USING btree ("org_id","status") WHERE "workflow_runs"."status" = 'waiting_approval';--> statement-breakpoint
CREATE INDEX "workflow_runs_entity_idx" ON "workflow_runs" USING btree ("org_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "workflows_trigger_idx" ON "workflows" USING btree ("org_id","trigger_type") WHERE "workflows"."enabled";--> statement-breakpoint
CREATE INDEX "workflows_schedule_idx" ON "workflows" USING btree ("next_run_at") WHERE "workflows"."enabled" and "workflows"."trigger_type" = 'schedule';--> statement-breakpoint
CREATE INDEX "outbox_automation_pending_idx" ON "outbox_events" USING btree ("created_at") WHERE "outbox_events"."automation_at" is null;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_ck" CHECK ("tasks"."source" in ('manual','work_order','inspection','incident','complaint','recurring','system','automation'));--> statement-breakpoint
-- events raised before automation existed are not replayed through new rules
UPDATE "outbox_events" SET "automation_at" = coalesce("processed_at", now());
