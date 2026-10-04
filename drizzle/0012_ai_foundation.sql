CREATE TABLE "ai_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text DEFAULT 'New conversation' NOT NULL,
	"mode" text DEFAULT 'property' NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_conversations_mode_ck" CHECK ("ai_conversations"."mode" in ('property','maintenance','frontdesk','facility','resident'))
);
--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"tool_calls" jsonb,
	"tool_call_id" text,
	"tool_name" text,
	"is_error" boolean DEFAULT false NOT NULL,
	"provider" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_messages_role_ck" CHECK ("ai_messages"."role" in ('user','assistant','tool'))
);
--> statement-breakpoint
CREATE TABLE "ai_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"conversation_id" uuid,
	"turn_id" uuid NOT NULL,
	"call_id" text NOT NULL,
	"tool" text NOT NULL,
	"risk_class" integer DEFAULT 1 NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" text NOT NULL,
	"error_message" text,
	"summary" text,
	"result_count" integer,
	"display" jsonb,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_tool_calls_outcome_ck" CHECK ("ai_tool_calls"."outcome" in ('ok','denied','invalid','not_found','ambiguous','error','unknown_tool')),
	CONSTRAINT "ai_tool_calls_risk_ck" CHECK ("ai_tool_calls"."risk_class" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"conversation_id" uuid,
	"turn_id" uuid NOT NULL,
	"feature" text DEFAULT 'chat' NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"model_calls" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"est_cost_usd" numeric(12, 6),
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_outcome_ck" CHECK ("ai_usage"."outcome" in ('ok','error','timeout','step_limit','cap_reached','disabled'))
);
--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_conversations_user_idx" ON "ai_conversations" USING btree ("org_id","user_id","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_messages_seq_uq" ON "ai_messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "ai_messages_turn_idx" ON "ai_messages" USING btree ("conversation_id","turn_id");--> statement-breakpoint
CREATE INDEX "ai_tool_calls_org_idx" ON "ai_tool_calls" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_tool_calls_turn_idx" ON "ai_tool_calls" USING btree ("conversation_id","turn_id");--> statement-breakpoint
CREATE INDEX "ai_usage_org_idx" ON "ai_usage" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_user_idx" ON "ai_usage" USING btree ("org_id","user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_turn_uq" ON "ai_usage" USING btree ("turn_id");