CREATE TYPE "public"."autodj_queue" AS ENUM('q1', 'q2');--> statement-breakpoint
CREATE TYPE "public"."media_source_type" AS ENUM('local', 'smb', 'nfs');--> statement-breakpoint
CREATE TYPE "public"."playlist_order" AS ENUM('shuffle', 'random', 'sequential');--> statement-breakpoint
CREATE TYPE "public"."queue_state" AS ENUM('queued', 'cued', 'playing');--> statement-breakpoint
CREATE TABLE "autodj_state" (
	"station_id" uuid PRIMARY KEY NOT NULL,
	"last_queue" "autodj_queue",
	"streak" integer DEFAULT 0 NOT NULL,
	"seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "media_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" uuid NOT NULL,
	"source_id" uuid,
	"location" text NOT NULL,
	"path" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"mtime_ms" bigint DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"artist" text DEFAULT '' NOT NULL,
	"album" text DEFAULT '' NOT NULL,
	"genre" text DEFAULT '' NOT NULL,
	"year" integer,
	"duration_seconds" double precision,
	"bitrate_kbps" integer,
	"gain_db" double precision,
	"edited" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"play_count" integer DEFAULT 0 NOT NULL,
	"last_played_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "media_source_type" NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" jsonb,
	"file_count" integer DEFAULT 0 NOT NULL,
	"scanned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playlist_items" (
	"playlist_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playlist_items_playlist_id_media_id_pk" PRIMARY KEY("playlist_id","media_id")
);
--> statement-breakpoint
CREATE TABLE "playlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" uuid NOT NULL,
	"name" text NOT NULL,
	"queue" "autodj_queue" DEFAULT 'q1' NOT NULL,
	"weight" integer DEFAULT 5 NOT NULL,
	"order" "playlist_order" DEFAULT 'shuffle' NOT NULL,
	"folders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"cursor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" uuid NOT NULL,
	"queue" "autodj_queue" NOT NULL,
	"media_id" uuid NOT NULL,
	"position" double precision NOT NULL,
	"state" "queue_state" DEFAULT 'queued' NOT NULL,
	"origin" text NOT NULL,
	"playlist_id" uuid,
	"request_id" uuid,
	"added_by" text,
	"cued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "song_requests" ADD COLUMN "media_id" uuid;--> statement-breakpoint
ALTER TABLE "stations" ADD COLUMN "autodj" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "autodj_state" ADD CONSTRAINT "autodj_state_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_source_id_media_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."media_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_sources" ADD CONSTRAINT "media_sources_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_items" ADD CONSTRAINT "playlist_items_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_items" ADD CONSTRAINT "playlist_items_media_id_media_files_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_items" ADD CONSTRAINT "queue_items_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_items" ADD CONSTRAINT "queue_items_media_id_media_files_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_items" ADD CONSTRAINT "queue_items_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_items" ADD CONSTRAINT "queue_items_request_id_song_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."song_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_files_path_idx" ON "media_files" USING btree ("station_id","location","path");--> statement-breakpoint
CREATE INDEX "media_files_artist_idx" ON "media_files" USING btree ("station_id","artist");--> statement-breakpoint
CREATE INDEX "media_files_played_idx" ON "media_files" USING btree ("station_id","last_played_at");--> statement-breakpoint
CREATE INDEX "media_sources_station_idx" ON "media_sources" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "playlist_items_media_idx" ON "playlist_items" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "playlists_station_idx" ON "playlists" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "queue_items_station_idx" ON "queue_items" USING btree ("station_id","queue","position");--> statement-breakpoint
ALTER TABLE "song_requests" ADD CONSTRAINT "song_requests_media_id_media_files_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_files"("id") ON DELETE set null ON UPDATE no action;