CREATE TABLE "api_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"property_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"requests_per_minute" integer DEFAULT 120 NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_used_ip" text,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "billing_events_status_ck" CHECK ("billing_events"."status" in ('received','processed','ignored','failed'))
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"org_id" uuid,
	"enabled" boolean NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credentials_enc" text,
	"last_used_at" timestamp with time zone,
	"last_error" text,
	"connected_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrations_status_ck" CHECK ("integrations"."status" in ('connected','error'))
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" text NOT NULL,
	"provider" text NOT NULL,
	"provider_invoice_id" text NOT NULL,
	"status" text NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"total_cents" integer NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"hosted_url" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_status_ck" CHECK ("invoices"."status" in ('open','paid','void','uncollectible'))
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"plan_key" text NOT NULL,
	"interval" text DEFAULT 'month' NOT NULL,
	"status" text NOT NULL,
	"provider" text DEFAULT 'none' NOT NULL,
	"provider_customer_id" text,
	"provider_subscription_id" text,
	"trial_ends_at" timestamp with time zone,
	"trial_notice_sent_at" timestamp with time zone,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"pending_plan_key" text,
	"pending_interval" text,
	"past_due_since" timestamp with time zone,
	"limit_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_paid_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_plan_ck" CHECK ("subscriptions"."plan_key" in ('starter','professional','enterprise')),
	CONSTRAINT "subscriptions_pending_plan_ck" CHECK ("subscriptions"."pending_plan_key" is null or "subscriptions"."pending_plan_key" in ('starter','professional','enterprise')),
	CONSTRAINT "subscriptions_interval_ck" CHECK ("subscriptions"."interval" in ('month','year')),
	CONSTRAINT "subscriptions_status_ck" CHECK ("subscriptions"."status" in ('trialing','active','past_due','cancelled','expired')),
	CONSTRAINT "subscriptions_provider_ck" CHECK ("subscriptions"."provider" in ('none','mock','stripe','manual'))
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"day" date NOT NULL,
	"quantity" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_records_metric_ck" CHECK ("usage_records"."metric" in ('properties','units','active_residents','staff_seats','ai_requests','api_requests','webhook_deliveries'))
);
--> statement-breakpoint
CREATE TABLE "webhook_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"status_code" integer,
	"error" text,
	"response_snippet" text,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_id" uuid,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"last_status_code" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"replay_of" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_status_ck" CHECK ("webhook_deliveries"."status" in ('pending','succeeded','failed'))
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"secret_enc" text NOT NULL,
	"events" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"disabled_reason" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_status_ck" CHECK ("webhook_endpoints"."status" in ('active','disabled'))
);
--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "plan_key" SET DEFAULT 'professional';--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "webhooks_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_idempotency" ADD CONSTRAINT "api_idempotency_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_idempotency" ADD CONSTRAINT "api_idempotency_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_attempts" ADD CONSTRAINT "webhook_attempts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_attempts" ADD CONSTRAINT "webhook_attempts_delivery_id_webhook_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."webhook_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_idempotency_uq" ON "api_idempotency" USING btree ("api_key_id","key");--> statement-breakpoint
CREATE INDEX "api_idempotency_created_idx" ON "api_idempotency" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_uq" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_uq" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_uq" ON "billing_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "billing_events_org_idx" ON "billing_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_global_uq" ON "feature_flags" USING btree ("key") WHERE "feature_flags"."org_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_org_uq" ON "feature_flags" USING btree ("key","org_id") WHERE "feature_flags"."org_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_org_provider_uq" ON "integrations" USING btree ("org_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_provider_uq" ON "invoices" USING btree ("provider","provider_invoice_id");--> statement-breakpoint
CREATE INDEX "invoices_org_idx" ON "invoices" USING btree ("org_id","issued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_org_uq" ON "subscriptions" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_provider_sub_uq" ON "subscriptions" USING btree ("provider","provider_subscription_id") WHERE "subscriptions"."provider_subscription_id" is not null;--> statement-breakpoint
CREATE INDEX "subscriptions_customer_idx" ON "subscriptions" USING btree ("provider","provider_customer_id");--> statement-breakpoint
CREATE INDEX "subscriptions_period_idx" ON "subscriptions" USING btree ("current_period_end") WHERE "subscriptions"."status" in ('active','past_due');--> statement-breakpoint
CREATE INDEX "subscriptions_trial_idx" ON "subscriptions" USING btree ("trial_ends_at") WHERE "subscriptions"."status" = 'trialing';--> statement-breakpoint
CREATE UNIQUE INDEX "usage_records_uq" ON "usage_records" USING btree ("org_id","metric","day");--> statement-breakpoint
CREATE INDEX "webhook_attempts_delivery_idx" ON "webhook_attempts" USING btree ("delivery_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_uq" ON "webhook_deliveries" USING btree ("endpoint_id","event_id") WHERE "webhook_deliveries"."event_id" is not null;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("next_attempt_at") WHERE "webhook_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_idx" ON "webhook_deliveries" USING btree ("endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_org_idx" ON "webhook_endpoints" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "outbox_webhooks_pending_idx" ON "outbox_events" USING btree ("created_at") WHERE "outbox_events"."webhooks_at" is null;