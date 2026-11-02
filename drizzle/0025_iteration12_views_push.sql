CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_ck" CHECK ("push_subscriptions"."endpoint" like 'https://%' or "push_subscriptions"."endpoint" like 'http://127.0.0.1:%')
);
--> statement-breakpoint
CREATE TABLE "recent_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"title" text NOT NULL,
	"href" text NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"page" text NOT NULL,
	"name" text NOT NULL,
	"query" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_views_name_ck" CHECK (length("saved_views"."name") between 1 and 60),
	CONSTRAINT "saved_views_query_ck" CHECK (length("saved_views"."query") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "consents" DROP CONSTRAINT "consents_channel_ck";--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "client_ref" text;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recent_views" ADD CONSTRAINT "recent_views_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recent_views" ADD CONSTRAINT "recent_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_uq" ON "push_subscriptions" USING btree ("org_id","endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recent_views_entity_uq" ON "recent_views" USING btree ("org_id","user_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "recent_views_user_idx" ON "recent_views" USING btree ("org_id","user_id","viewed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_views_name_uq" ON "saved_views" USING btree ("org_id","user_id","page","name");--> statement-breakpoint
CREATE UNIQUE INDEX "work_orders_client_ref_uq" ON "work_orders" USING btree ("org_id","submitted_by_user_id","client_ref") WHERE "work_orders"."client_ref" is not null;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_channel_ck" CHECK ("consents"."channel" in ('email','sms','push'));