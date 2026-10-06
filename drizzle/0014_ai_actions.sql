CREATE TABLE "ai_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid,
	"turn_id" uuid NOT NULL,
	"requested_by_user_id" uuid,
	"mode" text DEFAULT 'confirm' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"results" jsonb,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_approvals_mode_ck" CHECK ("ai_approvals"."mode" in ('confirm','auto')),
	CONSTRAINT "ai_approvals_status_ck" CHECK ("ai_approvals"."status" in ('pending','executing','executed','failed','partially_failed','rejected','expired','superseded'))
);
--> statement-breakpoint
CREATE TABLE "ai_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"property_id" uuid,
	"action" text NOT NULL,
	"mode" text NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_policies_mode_ck" CHECK ("ai_policies"."mode" in ('auto','confirm','deny'))
);
--> statement-breakpoint
ALTER TABLE "ai_tool_calls" DROP CONSTRAINT "ai_tool_calls_outcome_ck";--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD COLUMN "approval_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_approvals" ADD CONSTRAINT "ai_approvals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_approvals" ADD CONSTRAINT "ai_approvals_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_approvals" ADD CONSTRAINT "ai_approvals_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_approvals" ADD CONSTRAINT "ai_approvals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_policies" ADD CONSTRAINT "ai_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_policies" ADD CONSTRAINT "ai_policies_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_policies" ADD CONSTRAINT "ai_policies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_approvals_user_idx" ON "ai_approvals" USING btree ("org_id","requested_by_user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "ai_approvals_conversation_idx" ON "ai_approvals" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_policies_org_uq" ON "ai_policies" USING btree ("org_id","action") WHERE "ai_policies"."property_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_policies_property_uq" ON "ai_policies" USING btree ("org_id","property_id","action") WHERE "ai_policies"."property_id" is not null;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_approval_id_ai_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."ai_approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_tool_calls_approval_idx" ON "ai_tool_calls" USING btree ("approval_id");--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_outcome_ck" CHECK ("ai_tool_calls"."outcome" in ('ok','denied','invalid','not_found','ambiguous','error','unknown_tool','pending','executed','policy_denied'));