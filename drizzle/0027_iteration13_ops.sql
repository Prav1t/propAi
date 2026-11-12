CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_tick_at" timestamp with time zone NOT NULL,
	"last_tick_ms" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
