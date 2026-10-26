CREATE TABLE "clocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#FF6B57' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"clock_id" uuid,
	"live" boolean DEFAULT false NOT NULL,
	"account_ids" uuid[] DEFAULT '{}' NOT NULL,
	"days" integer[] DEFAULT '{}' NOT NULL,
	"date" text,
	"start_minute" integer NOT NULL,
	"duration_minutes" integer NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "autodj_state" ADD COLUMN "clock_hour" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "autodj_state" ADD COLUMN "clock_id" uuid;--> statement-breakpoint
ALTER TABLE "autodj_state" ADD COLUMN "clock_step" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "autodj_state" ADD COLUMN "clock_done" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "playlists" ADD COLUMN "rotation" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "queue_items" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "scheduler" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "clocks" ADD CONSTRAINT "clocks_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_entries" ADD CONSTRAINT "schedule_entries_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_entries" ADD CONSTRAINT "schedule_entries_clock_id_clocks_id_fk" FOREIGN KEY ("clock_id") REFERENCES "public"."clocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clocks_station_idx" ON "clocks" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "schedule_entries_station_idx" ON "schedule_entries" USING btree ("station_id");