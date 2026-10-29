-- Phase 21: recorder node. What a recorder records of a station, and the files on recorder nodes.
ALTER TABLE "stations" ADD COLUMN "recording" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL REFERENCES "nodes"("id") ON DELETE cascade,
	"station_id" uuid NOT NULL REFERENCES "stations"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"file" text NOT NULL,
	"content_type" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"open" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_node_file_idx" ON "recordings" USING btree ("node_id","file");--> statement-breakpoint
CREATE INDEX "recordings_station_idx" ON "recordings" USING btree ("station_id","kind","started_at");
