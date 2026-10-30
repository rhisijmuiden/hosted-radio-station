-- Phase 21 step 3: uploads of recordings to FTP, FTPS, SFTP or OneDrive, and shows as on-demand items.
ALTER TABLE "recordings" ADD COLUMN "ondemand_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "recording_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "backup_target_type" NOT NULL,
	"config" jsonb NOT NULL,
	"kinds" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recording_destinations" ADD CONSTRAINT "recording_destinations_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "recording_destinations_station_idx" ON "recording_destinations" USING btree ("station_id");
--> statement-breakpoint
CREATE TABLE "recording_deliveries" (
	"recording_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_at" timestamp with time zone,
	"error" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recording_deliveries_recording_id_destination_id_pk" PRIMARY KEY("recording_id","destination_id")
);
--> statement-breakpoint
ALTER TABLE "recording_deliveries" ADD CONSTRAINT "recording_deliveries_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recording_deliveries" ADD CONSTRAINT "recording_deliveries_destination_id_recording_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."recording_destinations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "recording_deliveries_destination_idx" ON "recording_deliveries" USING btree ("destination_id","state");
