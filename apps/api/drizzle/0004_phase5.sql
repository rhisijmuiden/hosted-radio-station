CREATE TYPE "public"."request_status" AS ENUM('pending', 'accepted', 'played', 'rejected');--> statement-breakpoint
CREATE TABLE "artwork_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"file" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ondemand_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" uuid NOT NULL,
	"source" text NOT NULL,
	"file" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"host" text DEFAULT '' NOT NULL,
	"live_session_id" uuid,
	"content_type" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"duration_seconds" integer,
	"recorded_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"plays" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "song_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" uuid NOT NULL,
	"artist" text NOT NULL,
	"title" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"requester_name" text DEFAULT '' NOT NULL,
	"requester_hash" text NOT NULL,
	"status" "request_status" DEFAULT 'pending' NOT NULL,
	"handled_by" text,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "public_page" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "logo_file" text;--> statement-breakpoint
ALTER TABLE "ondemand_items" ADD CONSTRAINT "ondemand_items_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ondemand_items" ADD CONSTRAINT "ondemand_items_live_session_id_live_sessions_id_fk" FOREIGN KEY ("live_session_id") REFERENCES "public"."live_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "song_requests" ADD CONSTRAINT "song_requests_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ondemand_items_file_idx" ON "ondemand_items" USING btree ("station_id","file");--> statement-breakpoint
CREATE INDEX "ondemand_items_station_idx" ON "ondemand_items" USING btree ("station_id","created_at");--> statement-breakpoint
CREATE INDEX "song_requests_station_idx" ON "song_requests" USING btree ("station_id","created_at");--> statement-breakpoint
CREATE INDEX "song_requests_hash_idx" ON "song_requests" USING btree ("station_id","requester_hash","created_at");