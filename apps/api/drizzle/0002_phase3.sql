CREATE TYPE "public"."audio_format" AS ENUM('mp3', 'aac', 'opus', 'vorbis');--> statement-breakpoint
CREATE TYPE "public"."domain_status" AS ENUM('pending', 'verified', 'failed');--> statement-breakpoint
CREATE TYPE "public"."mount_kind" AS ENUM('source', 'transcode');--> statement-breakpoint
CREATE TYPE "public"."output_type" AS ENUM('local', 'icecast', 'shoutcast1', 'shoutcast2');--> statement-breakpoint
CREATE TYPE "public"."station_edition" AS ENUM('distribution', 'station');--> statement-breakpoint
CREATE TABLE "live_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" uuid NOT NULL,
	"mount_id" uuid,
	"mount_path" text NOT NULL,
	"account_id" uuid,
	"account_name" text NOT NULL,
	"via" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"bitrate_kbps" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"bytes_in" bigint DEFAULT 0 NOT NULL,
	"end_reason" text
);
--> statement-breakpoint
CREATE TABLE "station_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" uuid NOT NULL,
	"username" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"password_hash" text NOT NULL,
	"user_id" uuid,
	"can_broadcast" boolean DEFAULT true NOT NULL,
	"can_upload" boolean DEFAULT false NOT NULL,
	"mount_ids" uuid[] DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "station_mounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" uuid NOT NULL,
	"path" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"kind" "mount_kind" DEFAULT 'source' NOT NULL,
	"source_mount_id" uuid,
	"format" "audio_format" DEFAULT 'mp3' NOT NULL,
	"bitrate_kbps" integer DEFAULT 128 NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"fallback_mount_id" uuid,
	"max_listeners" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "station_outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" uuid NOT NULL,
	"type" "output_type" NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"mount_id" uuid,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"edition" "station_edition" DEFAULT 'distribution' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"genre" text DEFAULT '' NOT NULL,
	"website" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_listeners" integer NOT NULL,
	"icecast_port" integer NOT NULL,
	"legacy_port" integer,
	"legacy_mount_id" uuid,
	"icecast_admin_password" text NOT NULL,
	"icecast_source_password" text NOT NULL,
	"storage_bytes" bigint DEFAULT 0 NOT NULL,
	"storage_scanned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stations_slug_unique" UNIQUE("slug"),
	CONSTRAINT "stations_icecast_port_unique" UNIQUE("icecast_port"),
	CONSTRAINT "stations_legacy_port_unique" UNIQUE("legacy_port")
);
--> statement-breakpoint
CREATE TABLE "tenant_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"panel_host" text NOT NULL,
	"ingest_host" text NOT NULL,
	"status" "domain_status" DEFAULT 'pending' NOT NULL,
	"verified_manually" boolean DEFAULT false NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_domains_panel_host_unique" UNIQUE("panel_host"),
	CONSTRAINT "tenant_domains_ingest_host_unique" UNIQUE("ingest_host")
);
--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_mount_id_station_mounts_id_fk" FOREIGN KEY ("mount_id") REFERENCES "public"."station_mounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_account_id_station_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."station_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_accounts" ADD CONSTRAINT "station_accounts_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_accounts" ADD CONSTRAINT "station_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_mounts" ADD CONSTRAINT "station_mounts_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_outputs" ADD CONSTRAINT "station_outputs_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_outputs" ADD CONSTRAINT "station_outputs_mount_id_station_mounts_id_fk" FOREIGN KEY ("mount_id") REFERENCES "public"."station_mounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stations" ADD CONSTRAINT "stations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "live_sessions_station_idx" ON "live_sessions" USING btree ("station_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "station_accounts_username_idx" ON "station_accounts" USING btree ("station_id","username");--> statement-breakpoint
CREATE INDEX "station_accounts_user_idx" ON "station_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "station_mounts_path_idx" ON "station_mounts" USING btree ("station_id","path");--> statement-breakpoint
CREATE INDEX "station_outputs_station_idx" ON "station_outputs" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "stations_tenant_idx" ON "stations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tenant_domains_tenant_idx" ON "tenant_domains" USING btree ("tenant_id");