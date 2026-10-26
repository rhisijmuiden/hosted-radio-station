CREATE TABLE "listener_hourly" (
	"hour" timestamp with time zone NOT NULL,
	"station_id" uuid NOT NULL,
	"target" text NOT NULL,
	"avg" double precision NOT NULL,
	"peak" integer NOT NULL,
	"minutes" integer NOT NULL,
	CONSTRAINT "listener_hourly_station_id_target_hour_pk" PRIMARY KEY("station_id","target","hour")
);
--> statement-breakpoint
CREATE TABLE "listener_samples" (
	"at" timestamp with time zone NOT NULL,
	"station_id" uuid NOT NULL,
	"target" text NOT NULL,
	"avg" double precision NOT NULL,
	"peak" integer NOT NULL,
	CONSTRAINT "listener_samples_station_id_target_at_pk" PRIMARY KEY("station_id","target","at")
);
--> statement-breakpoint
CREATE TABLE "listener_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mount_path" text NOT NULL,
	"output_id" uuid,
	"via" text NOT NULL,
	"client_key" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"ip" text,
	"listener_hash" text,
	"country" text,
	"region" text,
	"city" text,
	"latitude" double precision,
	"longitude" double precision,
	"asn" integer,
	"network" text,
	"user_agent" text,
	"device" text,
	"player" text,
	"os" text,
	"referrer" text
);
--> statement-breakpoint
CREATE TABLE "song_plays" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"station_id" uuid NOT NULL,
	"mount_path" text NOT NULL,
	"title" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"listeners_start" integer DEFAULT 0 NOT NULL,
	"listeners_peak" integer DEFAULT 0 NOT NULL,
	"listeners_end" integer
);
--> statement-breakpoint
ALTER TABLE "listener_hourly" ADD CONSTRAINT "listener_hourly_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listener_samples" ADD CONSTRAINT "listener_samples_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listener_sessions" ADD CONSTRAINT "listener_sessions_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listener_sessions" ADD CONSTRAINT "listener_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listener_sessions" ADD CONSTRAINT "listener_sessions_output_id_station_outputs_id_fk" FOREIGN KEY ("output_id") REFERENCES "public"."station_outputs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "song_plays" ADD CONSTRAINT "song_plays_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listener_hourly_hour_idx" ON "listener_hourly" USING btree ("hour");--> statement-breakpoint
CREATE INDEX "listener_samples_at_idx" ON "listener_samples" USING btree ("at");--> statement-breakpoint
CREATE INDEX "listener_sessions_station_start_idx" ON "listener_sessions" USING btree ("station_id","started_at");--> statement-breakpoint
CREATE INDEX "listener_sessions_station_end_idx" ON "listener_sessions" USING btree ("station_id","ended_at");--> statement-breakpoint
CREATE INDEX "listener_sessions_tenant_start_idx" ON "listener_sessions" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE INDEX "listener_sessions_start_idx" ON "listener_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "listener_sessions_open_idx" ON "listener_sessions" USING btree ("station_id","client_key") WHERE ended_at is null;--> statement-breakpoint
CREATE INDEX "song_plays_station_idx" ON "song_plays" USING btree ("station_id","started_at");